import {ethers} from "ethers";
import {CurveRouterRouteConfig, DexQuoteResult, SwapParams} from "./types";

// Curve Router v1.2 — multi-hop swaps via route encoding
const CURVE_ROUTER_ABI = [
  "function get_dy(address[11] _route, uint256[5][5] _swap_params, uint256 _amount) view returns (uint256)",
  "function exchange(address[11] _route, uint256[5][5] _swap_params, uint256 _amount, uint256 _min_dy) payable returns (uint256)",
];

export class DexQuoter {
  private curveRouter: ethers.Contract;

  constructor(
    provider: ethers.Provider,
    private curveRouterAddress: string,
    private vusdAddress: string,
    private curveRouterRoutes: Record<string, CurveRouterRouteConfig>,
  ) {
    this.curveRouter = new ethers.Contract(curveRouterAddress, CURVE_ROUTER_ABI, provider);
  }

  // ---------------------------------------------------------------------------
  // Curve Router (multi-hop via crvUSD)
  // ---------------------------------------------------------------------------

  /**
   * Build the address[11] route and uint256[5][5] swap_params arrays
   * for the Curve Router, given a direction.
   */
  private buildRouteArrays(
    stablecoinAddress: string,
    routeConfig: CurveRouterRouteConfig,
    vusdIsInput: boolean,
  ): {route: string[]; swapParams: number[][]} {
    const Z = ethers.ZeroAddress;
    const [hop1, hop2] = routeConfig.hops;

    if (vusdIsInput) {
      // SELL: VUSD → crvUSD → stablecoin (reverse hop order, swap i/j)
      return {
        route: [
          this.vusdAddress,
          hop2.pool,
          routeConfig.intermediateToken,
          hop1.pool,
          stablecoinAddress,
          Z, Z, Z, Z, Z, Z,
        ],
        swapParams: [
          [hop2.j, hop2.i, hop2.swapType, hop2.poolType, hop2.nCoins],
          [hop1.j, hop1.i, hop1.swapType, hop1.poolType, hop1.nCoins],
          [0, 0, 0, 0, 0],
          [0, 0, 0, 0, 0],
          [0, 0, 0, 0, 0],
        ],
      };
    } else {
      // BUY: stablecoin → crvUSD → VUSD (forward hop order)
      return {
        route: [
          stablecoinAddress,
          hop1.pool,
          routeConfig.intermediateToken,
          hop2.pool,
          this.vusdAddress,
          Z, Z, Z, Z, Z, Z,
        ],
        swapParams: [
          [hop1.i, hop1.j, hop1.swapType, hop1.poolType, hop1.nCoins],
          [hop2.i, hop2.j, hop2.swapType, hop2.poolType, hop2.nCoins],
          [0, 0, 0, 0, 0],
          [0, 0, 0, 0, 0],
          [0, 0, 0, 0, 0],
        ],
      };
    }
  }

  /**
   * Quote via Curve Router's get_dy() for multi-hop routes.
   */
  async quoteCurveRouter(
    stablecoinAddress: string,
    amountIn: bigint,
    destDecimals: number,
    srcDecimals: number,
    vusdIsInput: boolean,
  ): Promise<DexQuoteResult | null> {
    const routeConfig = this.curveRouterRoutes[stablecoinAddress.toLowerCase()];
    if (!routeConfig) return null;

    try {
      const {route, swapParams} = this.buildRouteArrays(stablecoinAddress, routeConfig, vusdIsInput);

      const amountOut: bigint = await this.curveRouter.get_dy(route, swapParams, amountIn);

      const price = Number(amountOut) / 10 ** destDecimals / (Number(amountIn) / 10 ** srcDecimals);

      return {price, source: "curve_router"};
    } catch (error) {
      console.warn(`  [curve_router] Quote failed:`, error instanceof Error ? error.message : error);
      return null;
    }
  }

  /**
   * Build SwapParams for Curve Router exchange().
   */
  buildCurveRouterSwap(
    stablecoinAddress: string,
    amountIn: bigint,
    minAmountOut: bigint,
    vusdIsInput: boolean,
  ): SwapParams {
    const routeConfig = this.curveRouterRoutes[stablecoinAddress.toLowerCase()];
    if (!routeConfig) {
      throw new Error(`No Curve Router route configured for ${stablecoinAddress}`);
    }

    const {route, swapParams} = this.buildRouteArrays(stablecoinAddress, routeConfig, vusdIsInput);

    const routerIface = new ethers.Interface(CURVE_ROUTER_ABI);
    const swapCalldata = routerIface.encodeFunctionData("exchange", [route, swapParams, amountIn, minAmountOut]);

    return {
      target: this.curveRouterAddress,
      approveTarget: this.curveRouterAddress,
      swapCalldata,
      minAmountOut,
    };
  }
}
