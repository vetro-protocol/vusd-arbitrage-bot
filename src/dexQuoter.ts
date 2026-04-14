import {ethers} from "ethers";
import {
  CurvePoolConfig,
  CurveRouterRouteConfig,
  DexQuoteResult,
  SwapParams,
} from "./types";

// Uniswap V3 QuoterV2 — quoteExactInputSingle is NOT a view function,
// it reverts after computing. Must be called via staticCall.
const QUOTER_V2_ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

// Uniswap V3 SwapRouter02 — exactInputSingle for actual swaps
const SWAP_ROUTER_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)",
];

// Curve StableSwap pool
const CURVE_POOL_ABI = [
  "function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)",
  "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
];

// Curve Router v1.2 — multi-hop swaps via route encoding
const CURVE_ROUTER_ABI = [
  "function get_dy(address[11] _route, uint256[5][5] _swap_params, uint256 _amount) view returns (uint256)",
  "function exchange(address[11] _route, uint256[5][5] _swap_params, uint256 _amount, uint256 _min_dy) payable returns (uint256)",
];

/** Fee tiers to try, ordered by likelihood for stablecoin pairs */
const UNI_V3_FEE_TIERS: number[] = [500, 3000, 100, 10000];

export class DexQuoter {
  private quoter: ethers.Contract;
  private routerAddress: string;
  private curveRouter: ethers.Contract | null = null;

  constructor(
    private provider: ethers.Provider,
    quoterAddress: string,
    routerAddress: string,
    private curvePoolConfigs: Record<string, CurvePoolConfig>,
    private curveRouterAddress?: string,
    private vusdAddress?: string,
    private curveRouterRoutes?: Record<string, CurveRouterRouteConfig>,
  ) {
    this.quoter = new ethers.Contract(quoterAddress, QUOTER_V2_ABI, provider);
    this.routerAddress = routerAddress;

    if (curveRouterAddress) {
      this.curveRouter = new ethers.Contract(
        curveRouterAddress,
        CURVE_ROUTER_ABI,
        provider,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Uniswap V3
  // ---------------------------------------------------------------------------

  /**
   * Quote VUSD→stablecoin (or vice versa) via Uniswap V3 QuoterV2.
   * Tries all fee tiers; returns the best quote.
   */
  async quoteUniswapV3(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    destDecimals: number,
    srcDecimals: number,
  ): Promise<DexQuoteResult | null> {
    let bestAmountOut = 0n;
    let bestFeeTier = 0;

    const quotePromises = UNI_V3_FEE_TIERS.map(async (fee) => {
      try {
        const result = await this.quoter.quoteExactInputSingle.staticCall({
          tokenIn,
          tokenOut,
          amountIn,
          fee,
          sqrtPriceLimitX96: 0n,
        });
        return {fee, amountOut: result.amountOut as bigint};
      } catch {
        return null;
      }
    });

    const results = await Promise.all(quotePromises);

    for (const r of results) {
      if (r && r.amountOut > bestAmountOut) {
        bestAmountOut = r.amountOut;
        bestFeeTier = r.fee;
      }
    }

    if (bestAmountOut === 0n) return null;

    const price =
      Number(bestAmountOut) /
      10 ** destDecimals /
      (Number(amountIn) / 10 ** srcDecimals);

    return {
      price,
      source: "uniswap_v3",
      feeTier: bestFeeTier,
    };
  }

  /**
   * Build SwapParams for Uniswap V3 SwapRouter02.
   */
  buildUniswapV3Swap(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    feeTier: number,
    minAmountOut: bigint,
    recipient: string,
  ): SwapParams {
    const routerIface = new ethers.Interface(SWAP_ROUTER_ABI);
    const swapCalldata = routerIface.encodeFunctionData("exactInputSingle", [
      {
        tokenIn,
        tokenOut,
        fee: feeTier,
        recipient,
        amountIn,
        amountOutMinimum: minAmountOut,
        sqrtPriceLimitX96: 0n,
      },
    ]);

    return {
      target: this.routerAddress,
      approveTarget: this.routerAddress,
      swapCalldata,
      minAmountOut,
    };
  }

  // ---------------------------------------------------------------------------
  // Curve
  // ---------------------------------------------------------------------------

  /**
   * Quote via Curve pool's get_dy().
   * Requires a CurvePoolConfig for the stablecoin.
   */
  async quoteCurve(
    stablecoinAddress: string,
    amountIn: bigint,
    destDecimals: number,
    srcDecimals: number,
    /** true = VUSD is tokenIn (sell direction), false = stablecoin is tokenIn (buy direction) */
    vusdIsInput: boolean,
  ): Promise<DexQuoteResult | null> {
    const poolConfig = this.curvePoolConfigs[stablecoinAddress.toLowerCase()];
    if (!poolConfig) return null;

    try {
      const pool = new ethers.Contract(
        poolConfig.poolAddress,
        CURVE_POOL_ABI,
        this.provider,
      );
      const i = vusdIsInput ? poolConfig.vusdIndex : poolConfig.stablecoinIndex;
      const j = vusdIsInput ? poolConfig.stablecoinIndex : poolConfig.vusdIndex;

      const amountOut: bigint = await pool.get_dy(i, j, amountIn);

      const price =
        Number(amountOut) /
        10 ** destDecimals /
        (Number(amountIn) / 10 ** srcDecimals);

      return {
        price,
        source: "curve",
        poolAddress: poolConfig.poolAddress,
        vusdIndex: poolConfig.vusdIndex,
        stablecoinIndex: poolConfig.stablecoinIndex,
      };
    } catch (error) {
      console.warn(
        `  [curve] Quote failed:`,
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  }

  /**
   * Build SwapParams for a Curve pool exchange().
   */
  buildCurveSwap(
    poolAddress: string,
    i: number,
    j: number,
    amountIn: bigint,
    minAmountOut: bigint,
  ): SwapParams {
    const poolIface = new ethers.Interface(CURVE_POOL_ABI);
    const swapCalldata = poolIface.encodeFunctionData("exchange", [
      i,
      j,
      amountIn,
      minAmountOut,
    ]);

    return {
      target: poolAddress,
      approveTarget: poolAddress,
      swapCalldata,
      minAmountOut,
    };
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
          this.vusdAddress!,
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
          this.vusdAddress!,
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
    if (!this.curveRouter || !this.curveRouterRoutes || !this.vusdAddress) {
      return null;
    }

    const routeConfig =
      this.curveRouterRoutes[stablecoinAddress.toLowerCase()];
    if (!routeConfig) return null;

    try {
      const {route, swapParams} = this.buildRouteArrays(
        stablecoinAddress,
        routeConfig,
        vusdIsInput,
      );

      const amountOut: bigint = await this.curveRouter.get_dy(
        route,
        swapParams,
        amountIn,
      );

      const price =
        Number(amountOut) /
        10 ** destDecimals /
        (Number(amountIn) / 10 ** srcDecimals);

      return {
        price,
        source: "curve_router",
      };
    } catch (error) {
      console.warn(
        `  [curve_router] Quote failed:`,
        error instanceof Error ? error.message : error,
      );
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
    if (!this.curveRouterAddress || !this.curveRouterRoutes || !this.vusdAddress) {
      throw new Error("Curve Router not configured");
    }

    const routeConfig =
      this.curveRouterRoutes[stablecoinAddress.toLowerCase()];
    if (!routeConfig) {
      throw new Error(
        `No Curve Router route configured for ${stablecoinAddress}`,
      );
    }

    const {route, swapParams} = this.buildRouteArrays(
      stablecoinAddress,
      routeConfig,
      vusdIsInput,
    );

    const routerIface = new ethers.Interface(CURVE_ROUTER_ABI);
    const swapCalldata = routerIface.encodeFunctionData("exchange", [
      route,
      swapParams,
      amountIn,
      minAmountOut,
    ]);

    return {
      target: this.curveRouterAddress,
      approveTarget: this.curveRouterAddress,
      swapCalldata,
      minAmountOut,
    };
  }
}
