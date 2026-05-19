import {ethers} from "ethers";
import {Config} from "./config";
import {UnderlyingToken} from "./products";
import {DexQuoteResult, PriceData} from "./types";
import {AggregatorAdapter} from "./aggregators";
import {DexQuoter} from "./dexQuoter";

const GATEWAY_ABI = [
  "function previewDeposit(address tokenIn_, uint256 amountIn_) view returns (uint256)",
  "function previewRedeem(address tokenOut_, uint256 peggedTokenIn_) view returns (uint256)",
  "function mintFee(address token_) view returns (uint256)",
  "function redeemFee(address token_) view returns (uint256)",
  "function maxMint() view returns (uint256)",
  "function maxWithdraw(address tokenOut_) view returns (uint256)",
];

export class PriceMonitor {
  private gateway: ethers.Contract;

  constructor(
    private provider: ethers.Provider,
    private config: Config,
    private aggregators: AggregatorAdapter[],
    private dexQuoter: DexQuoter,
  ) {
    this.gateway = new ethers.Contract(config.product.gatewayAddress, GATEWAY_ABI, provider);
  }

  async getPriceData(underlying: UnderlyingToken): Promise<PriceData> {
    const testAmount = ethers.parseUnits("10000", underlying.decimals);

    const [gatewayMintOutput, mintFeeBps, redeemFeeBps, dexSellQuote, dexBuyQuote] = await Promise.all([
      this.gateway.previewDeposit(underlying.address, testAmount) as Promise<bigint>,
      this.gateway.mintFee(underlying.address) as Promise<bigint>,
      this.gateway.redeemFee(underlying.address) as Promise<bigint>,
      this.fetchDexQuote(underlying, true),
      this.fetchDexQuote(underlying, false),
    ]);

    return {
      peggedDexSellPrice: dexSellQuote.price,
      peggedDexBuyPrice: dexBuyQuote.price,
      dexSellQuote,
      dexBuyQuote,
      gatewayMintOutput,
      mintFeeBps: Number(mintFeeBps),
      redeemFeeBps: Number(redeemFeeBps),
      underlying,
    };
  }

  async getCapacity(underlying: UnderlyingToken): Promise<{maxMint: bigint; maxWithdraw: bigint}> {
    const [maxMint, maxWithdraw] = await Promise.all([
      this.gateway.maxMint() as Promise<bigint>,
      this.gateway.maxWithdraw(underlying.address) as Promise<bigint>,
    ]);
    return {maxMint, maxWithdraw};
  }

  /**
   * Fetch pegged-token DEX price by querying all enabled sources in parallel
   * and picking the best price. Sources that fail or return no route are ignored.
   *
   * Best price:
   *   sell direction (pegged → underlying): highest underlying-per-pegged (more output)
   *   buy direction  (underlying → pegged): lowest  underlying-per-pegged (less cost)
   *
   * @param peggedIsInput true = sell direction, false = buy direction
   */
  private async fetchDexQuote(underlying: UnderlyingToken, peggedIsInput: boolean): Promise<DexQuoteResult> {
    const dirLabel = peggedIsInput ? "sell" : "buy";

    // For sell: quote N pegged → underlying, price = underlying_out / N
    // For buy:  quote N underlying → pegged, price = N / pegged_out (cost per pegged)
    // N = product.priceQuoteAmount — sized to keep DEX price-impact reasonable.
    const srcDecimals = peggedIsInput ? this.config.product.peggedToken.decimals : underlying.decimals;
    const destDecimals = peggedIsInput ? underlying.decimals : this.config.product.peggedToken.decimals;
    const srcToken = peggedIsInput ? this.config.peggedTokenAddress : underlying.address;
    const destToken = peggedIsInput ? underlying.address : this.config.peggedTokenAddress;
    const quoteAmount = ethers.parseUnits(String(this.config.product.priceQuoteAmount), srcDecimals);

    const aggregatorQuotes = this.aggregators.map(async (adapter): Promise<DexQuoteResult | null> => {
      try {
        const destAmount = await adapter.getQuote({
          srcToken,
          destToken,
          amount: quoteAmount,
          srcDecimals,
          destDecimals,
          chainId: this.config.chainId,
        });
        if (destAmount === null || destAmount <= 0n) return null;
        const price = this.computePeggedPrice(quoteAmount, destAmount, srcDecimals, destDecimals, peggedIsInput);
        return {price, source: adapter.name};
      } catch {
        return null;
      }
    });

    const curveRouterQuote = (async (): Promise<DexQuoteResult | null> => {
      if (!this.config.enableCurveRouter) return null;
      try {
        const q = await this.dexQuoter.quoteCurveRouter(
          underlying.address,
          quoteAmount,
          destDecimals,
          srcDecimals,
          peggedIsInput,
        );
        if (!q) return null;
        const price = peggedIsInput ? q.price : 1000 / (q.price * 1000);
        return {...q, price};
      } catch {
        return null;
      }
    })();

    const results = await Promise.all([...aggregatorQuotes, curveRouterQuote]);
    const candidates = results.filter((q): q is DexQuoteResult => q !== null);

    if (candidates.length === 0) {
      console.warn(`  [${underlying.symbol}] All DEX ${dirLabel} price sources failed, defaulting to 1.0`);
      return {price: 1.0, source: "default"};
    }

    // sell: pick highest; buy: pick lowest
    const best = candidates.reduce((a, b) =>
      peggedIsInput ? (a.price > b.price ? a : b) : (a.price < b.price ? a : b),
    );

    const summary = candidates.map((c) => `${c.source}=${c.price.toFixed(6)}`).join(", ");
    console.log(
      `  [${underlying.symbol}] DEX ${dirLabel} quotes: ${summary} → using ${best.source} (${best.price.toFixed(6)})`,
    );

    return best;
  }

  /**
   * Convert raw quote amounts into a pegged-token price (underlying per pegged).
   * Sell: price = destAmount / 10^destDec / (srcAmount / 10^srcDec)
   * Buy:  price = srcAmount / 10^srcDec / (destAmount / 10^destDec)  (cost per pegged)
   */
  private computePeggedPrice(
    srcAmount: bigint,
    destAmount: bigint,
    srcDecimals: number,
    destDecimals: number,
    peggedIsInput: boolean,
  ): number {
    const src = Number(srcAmount) / 10 ** srcDecimals;
    const dest = Number(destAmount) / 10 ** destDecimals;
    return peggedIsInput ? dest / src : src / dest;
  }
}
