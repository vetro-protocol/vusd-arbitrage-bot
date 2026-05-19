import {ethers} from "ethers";
import {CurveRouterRoute} from "./products";
import {DexQuoteResult, SwapParams} from "./types";

/** Curve Router NG v1.2 — supports up to 5 hops in one call */
const CURVE_ROUTER_ABI = [
  "function get_dy(address[11] _route, uint256[5][5] _swap_params, uint256 _amount) view returns (uint256)",
  "function exchange(address[11] _route, uint256[5][5] _swap_params, uint256 _amount, uint256 _min_dy) payable returns (uint256)",
];

const ROUTE_LEN = 11;
const PARAMS_LEN = 5;

export class DexQuoter {
  private curveRouter: ethers.Contract;

  constructor(
    provider: ethers.Provider,
    private curveRouterAddress: string,
    /** Pegged token address (VUSD or vetBTC) */
    private peggedTokenAddress: string,
    /** Curve Router routes keyed by lowercase underlying token address */
    private curveRouterRoutes: Record<string, CurveRouterRoute>,
  ) {
    this.curveRouter = new ethers.Contract(curveRouterAddress, CURVE_ROUTER_ABI, provider);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Curve Router (1–5 hops)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Build address[11] route and uint256[5][5] swap_params arrays.
   * Supports 1–5 hops. Pads remaining slots with zero.
   */
  private buildRouteArrays(
    underlyingAddress: string,
    routeConfig: CurveRouterRoute,
    peggedIsInput: boolean,
  ): {route: string[]; swapParams: number[][]} {
    const Z = ethers.ZeroAddress;
    const route: string[] = new Array(ROUTE_LEN).fill(Z);
    const swapParams: number[][] = Array.from({length: PARAMS_LEN}, () => [0, 0, 0, 0, 0]);

    const hops = routeConfig.hops;
    const intermediates = routeConfig.intermediateTokens;
    const N = hops.length;

    if (!peggedIsInput) {
      // BUY: underlying → … → pegged
      route[0] = underlyingAddress;
      for (let h = 0; h < N; h++) {
        const hop = hops[h];
        route[1 + 2 * h] = hop.pool;
        route[2 + 2 * h] = h < N - 1 ? intermediates[h] : this.peggedTokenAddress;
        swapParams[h] = [hop.i, hop.j, hop.swapType, hop.poolType, hop.nCoins];
      }
    } else {
      // SELL: pegged → … → underlying (reverse hop order, swap i/j)
      route[0] = this.peggedTokenAddress;
      for (let h = 0; h < N; h++) {
        const hop = hops[N - 1 - h];
        route[1 + 2 * h] = hop.pool;
        route[2 + 2 * h] = h < N - 1 ? intermediates[N - 2 - h] : underlyingAddress;
        swapParams[h] = [hop.j, hop.i, hop.swapType, hop.poolType, hop.nCoins];
      }
    }

    return {route, swapParams};
  }

  /**
   * Quote via Curve Router get_dy() for a single underlying.
   * @param peggedIsInput true = SELL direction, false = BUY direction
   */
  async quoteCurveRouter(
    underlyingAddress: string,
    amountIn: bigint,
    destDecimals: number,
    srcDecimals: number,
    peggedIsInput: boolean,
  ): Promise<DexQuoteResult | null> {
    const routeConfig = this.curveRouterRoutes[underlyingAddress.toLowerCase()];
    if (!routeConfig) return null;

    try {
      const {route, swapParams} = this.buildRouteArrays(underlyingAddress, routeConfig, peggedIsInput);
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
    underlyingAddress: string,
    amountIn: bigint,
    minAmountOut: bigint,
    peggedIsInput: boolean,
  ): SwapParams {
    const routeConfig = this.curveRouterRoutes[underlyingAddress.toLowerCase()];
    if (!routeConfig) {
      throw new Error(`No Curve Router route configured for underlying ${underlyingAddress}`);
    }

    const {route, swapParams} = this.buildRouteArrays(underlyingAddress, routeConfig, peggedIsInput);

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
