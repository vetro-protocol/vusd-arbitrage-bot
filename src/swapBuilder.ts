import {ethers} from "ethers";
import {Config} from "./config";
import {DexQuoteResult, SwapParams, StablecoinConfig} from "./types";
import {AggregatorAdapter} from "./aggregators";
import {DexQuoter} from "./dexQuoter";

export class SwapBuilder {
  /** Aggregator adapters keyed by DexSource name for quick lookup */
  private adapterMap: Map<string, AggregatorAdapter>;

  constructor(
    private config: Config,
    aggregators: AggregatorAdapter[],
    private dexQuoter: DexQuoter,
  ) {
    this.adapterMap = new Map(aggregators.map((a) => [a.name, a]));
  }

  /**
   * Build SwapParams for selling VUSD for stablecoin (MINT_AND_SELL direction).
   * Routes through the same DEX that provided the price quote.
   */
  async buildSellVusdSwap(
    vusdAmount: bigint,
    stablecoin: StablecoinConfig,
    dexQuote: DexQuoteResult,
  ): Promise<SwapParams> {
    return this.buildSwap(
      this.config.vusdAddress,
      18,
      stablecoin.address,
      stablecoin.decimals,
      vusdAmount,
      dexQuote,
      true, // vusdIsInput
    );
  }

  /**
   * Build SwapParams for buying VUSD with stablecoin (BUY_AND_REDEEM direction).
   * Routes through the same DEX that provided the price quote.
   */
  async buildBuyVusdSwap(
    stablecoinAmount: bigint,
    stablecoin: StablecoinConfig,
    dexQuote: DexQuoteResult,
  ): Promise<SwapParams> {
    return this.buildSwap(
      stablecoin.address,
      stablecoin.decimals,
      this.config.vusdAddress,
      18,
      stablecoinAmount,
      dexQuote,
      false, // stablecoin is input
    );
  }

  private async buildSwap(
    srcToken: string,
    srcDecimals: number,
    destToken: string,
    destDecimals: number,
    amount: bigint,
    dexQuote: DexQuoteResult,
    vusdIsInput: boolean,
  ): Promise<SwapParams> {
    const {source} = dexQuote;

    // Aggregator sources — use the adapter's buildSwap
    const adapter = this.adapterMap.get(source);
    if (adapter) {
      return adapter.buildSwap({
        srcToken,
        destToken,
        amount,
        srcDecimals,
        destDecimals,
        chainId: this.config.chainId,
        receiver: this.config.vusdArbitrageAddress,
        slippageBps: this.config.slippageBps,
      });
    }

    // Uniswap V3 — build calldata locally
    if (source === "uniswap_v3") {
      if (!dexQuote.feeTier) {
        throw new Error("Uniswap V3 quote missing feeTier");
      }

      // Get a fresh quote for the exact swap amount
      const freshQuote = await this.dexQuoter.quoteUniswapV3(srcToken, destToken, amount, destDecimals, srcDecimals);
      if (!freshQuote) {
        throw new Error("Uniswap V3 fresh quote failed");
      }

      const expectedOut = BigInt(
        Math.floor(((freshQuote.price * Number(amount)) / 10 ** srcDecimals) * 10 ** destDecimals),
      );
      const minAmountOut = (expectedOut * BigInt(10000 - this.config.slippageBps)) / 10000n;

      return this.dexQuoter.buildUniswapV3Swap(
        srcToken,
        destToken,
        amount,
        dexQuote.feeTier,
        minAmountOut,
        this.config.vusdArbitrageAddress,
      );
    }

    // Curve — build calldata locally
    if (source === "curve") {
      if (!dexQuote.poolAddress || dexQuote.vusdIndex === undefined || dexQuote.stablecoinIndex === undefined) {
        throw new Error("Curve quote missing pool config");
      }

      // Determine correct indices based on swap direction
      const i = vusdIsInput ? dexQuote.vusdIndex : dexQuote.stablecoinIndex;
      const j = vusdIsInput ? dexQuote.stablecoinIndex : dexQuote.vusdIndex;

      // Get a fresh quote for the exact swap amount
      const stablecoinAddress = vusdIsInput ? destToken : srcToken;
      const freshQuote = await this.dexQuoter.quoteCurve(
        stablecoinAddress,
        amount,
        destDecimals,
        srcDecimals,
        vusdIsInput,
      );
      if (!freshQuote) {
        throw new Error("Curve fresh quote failed");
      }

      const expectedOut = BigInt(
        Math.floor(((freshQuote.price * Number(amount)) / 10 ** srcDecimals) * 10 ** destDecimals),
      );
      const minAmountOut = (expectedOut * BigInt(10000 - this.config.slippageBps)) / 10000n;

      return this.dexQuoter.buildCurveSwap(dexQuote.poolAddress, i, j, amount, minAmountOut);
    }

    // Curve Router — multi-hop via crvUSD, build calldata locally
    if (source === "curve_router") {
      const stablecoinAddress = vusdIsInput ? destToken : srcToken;

      // Get a fresh quote for the exact swap amount
      const freshQuote = await this.dexQuoter.quoteCurveRouter(
        stablecoinAddress,
        amount,
        destDecimals,
        srcDecimals,
        vusdIsInput,
      );
      if (!freshQuote) {
        throw new Error("Curve Router fresh quote failed");
      }

      const expectedOut = BigInt(
        Math.floor(((freshQuote.price * Number(amount)) / 10 ** srcDecimals) * 10 ** destDecimals),
      );
      const minAmountOut = (expectedOut * BigInt(10000 - this.config.slippageBps)) / 10000n;

      return this.dexQuoter.buildCurveRouterSwap(stablecoinAddress, amount, minAmountOut, vusdIsInput);
    }

    throw new Error(`Cannot build swap for source "${source}" — no DEX route available`);
  }
}
