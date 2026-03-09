import { ethers } from "ethers";
import { CurvePoolConfig, DexQuoteResult, SwapParams } from "./types";

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

/** Fee tiers to try, ordered by likelihood for stablecoin pairs */
const UNI_V3_FEE_TIERS: number[] = [500, 3000, 100, 10000];

export class DexQuoter {
  private quoter: ethers.Contract;
  private routerAddress: string;

  constructor(
    private provider: ethers.Provider,
    quoterAddress: string,
    routerAddress: string,
    private curvePoolConfigs: Record<string, CurvePoolConfig>
  ) {
    this.quoter = new ethers.Contract(quoterAddress, QUOTER_V2_ABI, provider);
    this.routerAddress = routerAddress;
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
    srcDecimals: number
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
        return { fee, amountOut: result.amountOut as bigint };
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
      Number(bestAmountOut) / 10 ** destDecimals / (Number(amountIn) / 10 ** srcDecimals);

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
    recipient: string
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
    vusdIsInput: boolean
  ): Promise<DexQuoteResult | null> {
    const poolConfig = this.curvePoolConfigs[stablecoinAddress.toLowerCase()];
    if (!poolConfig) return null;

    try {
      const pool = new ethers.Contract(poolConfig.poolAddress, CURVE_POOL_ABI, this.provider);
      const i = vusdIsInput ? poolConfig.vusdIndex : poolConfig.stablecoinIndex;
      const j = vusdIsInput ? poolConfig.stablecoinIndex : poolConfig.vusdIndex;

      const amountOut: bigint = await pool.get_dy(i, j, amountIn);

      const price =
        Number(amountOut) / 10 ** destDecimals / (Number(amountIn) / 10 ** srcDecimals);

      return {
        price,
        source: "curve",
        poolAddress: poolConfig.poolAddress,
        vusdIndex: poolConfig.vusdIndex,
        stablecoinIndex: poolConfig.stablecoinIndex,
      };
    } catch {
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
    minAmountOut: bigint
  ): SwapParams {
    const poolIface = new ethers.Interface(CURVE_POOL_ABI);
    const swapCalldata = poolIface.encodeFunctionData("exchange", [i, j, amountIn, minAmountOut]);

    return {
      target: poolAddress,
      approveTarget: poolAddress,
      swapCalldata,
      minAmountOut,
    };
  }
}
