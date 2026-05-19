import {ethers} from "ethers";
import {Config} from "./config";
import {UnderlyingToken} from "./products";
import {DexQuoteResult, SwapParams} from "./types";
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
   * Build SwapParams for selling pegged token for underlying (MINT_AND_SELL).
   */
  async buildSellPeggedSwap(
    peggedAmount: bigint,
    underlying: UnderlyingToken,
    dexQuote: DexQuoteResult,
  ): Promise<SwapParams> {
    return this.buildSwap(
      this.config.peggedTokenAddress,
      this.config.product.peggedToken.decimals,
      underlying.address,
      underlying.decimals,
      peggedAmount,
      dexQuote,
      true, // peggedIsInput
    );
  }

  /**
   * Build SwapParams for buying pegged token with underlying (BUY_AND_REDEEM).
   */
  async buildBuyPeggedSwap(
    underlyingAmount: bigint,
    underlying: UnderlyingToken,
    dexQuote: DexQuoteResult,
  ): Promise<SwapParams> {
    return this.buildSwap(
      underlying.address,
      underlying.decimals,
      this.config.peggedTokenAddress,
      this.config.product.peggedToken.decimals,
      underlyingAmount,
      dexQuote,
      false, // underlying is input
    );
  }

  private async buildSwap(
    srcToken: string,
    srcDecimals: number,
    destToken: string,
    destDecimals: number,
    amount: bigint,
    dexQuote: DexQuoteResult,
    peggedIsInput: boolean,
  ): Promise<SwapParams> {
    const {source} = dexQuote;

    // Aggregator sources — delegate to the adapter
    const adapter = this.adapterMap.get(source);
    if (adapter) {
      return adapter.buildSwap({
        srcToken,
        destToken,
        amount,
        srcDecimals,
        destDecimals,
        chainId: this.config.chainId,
        receiver: this.config.arbitrageAddress,
        slippageBps: this.config.slippageBps,
      });
    }

    // Curve Router — build calldata locally with a fresh quote
    if (source === "curve_router") {
      const underlyingAddress = peggedIsInput ? destToken : srcToken;

      const freshQuote = await this.dexQuoter.quoteCurveRouter(
        underlyingAddress,
        amount,
        destDecimals,
        srcDecimals,
        peggedIsInput,
      );
      if (!freshQuote) {
        throw new Error("Curve Router fresh quote failed");
      }

      const expectedOut = BigInt(
        Math.floor(((freshQuote.price * Number(amount)) / 10 ** srcDecimals) * 10 ** destDecimals),
      );
      const minAmountOut = (expectedOut * BigInt(10000 - this.config.slippageBps)) / 10000n;

      return this.dexQuoter.buildCurveRouterSwap(underlyingAddress, amount, minAmountOut, peggedIsInput);
    }

    throw new Error(`Cannot build swap for source "${source}" — no DEX route available`);
  }
}
