import {ethers} from "ethers";
import {Config} from "./config";
import {DexQuoteResult, PriceData, StablecoinConfig} from "./types";
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
    this.gateway = new ethers.Contract(config.gatewayAddress, GATEWAY_ABI, provider);
  }

  async getPriceData(stablecoin: StablecoinConfig): Promise<PriceData> {
    const testAmount = ethers.parseUnits("10000", stablecoin.decimals);

    const [gatewayMintOutput, mintFeeBps, redeemFeeBps, dexSellQuote, dexBuyQuote] = await Promise.all([
      this.gateway.previewDeposit(stablecoin.address, testAmount) as Promise<bigint>,
      this.gateway.mintFee(stablecoin.address) as Promise<bigint>,
      this.gateway.redeemFee(stablecoin.address) as Promise<bigint>,
      this.fetchDexQuote(stablecoin, true),
      this.fetchDexQuote(stablecoin, false),
    ]);

    return {
      vusdDexPrice: dexSellQuote.price,
      vusdDexBuyPrice: dexBuyQuote.price,
      dexQuote: dexSellQuote,
      dexBuyQuote,
      gatewayMintOutput,
      mintFeeBps: Number(mintFeeBps),
      redeemFeeBps: Number(redeemFeeBps),
      stablecoin,
    };
  }

  async getCapacity(stablecoin: StablecoinConfig): Promise<{maxMint: bigint; maxWithdraw: bigint}> {
    const [maxMint, maxWithdraw] = await Promise.all([
      this.gateway.maxMint() as Promise<bigint>,
      this.gateway.maxWithdraw(stablecoin.address) as Promise<bigint>,
    ]);
    return {maxMint, maxWithdraw};
  }

  /**
   * Fetch VUSD DEX price by querying all enabled sources in parallel and
   * picking the best price. Sources that fail or return no route are ignored.
   *
   * Best price:
   *   sell direction (VUSD→stablecoin): highest stablecoin-per-VUSD (more output)
   *   buy direction  (stablecoin→VUSD): lowest  stablecoin-per-VUSD (less cost)
   *
   * @param vusdIsInput true = sell direction (VUSD→stablecoin), false = buy direction (stablecoin→VUSD)
   */
  private async fetchDexQuote(stablecoin: StablecoinConfig, vusdIsInput: boolean): Promise<DexQuoteResult> {
    const dirLabel = vusdIsInput ? "sell" : "buy";

    // For sell: quote 1000 VUSD → stablecoin, price = stablecoin_out / 1000
    // For buy:  quote 1000 stablecoin → VUSD, price = 1000 / vusd_out (cost per VUSD)
    const srcDecimals = vusdIsInput ? 18 : stablecoin.decimals;
    const destDecimals = vusdIsInput ? stablecoin.decimals : 18;
    const srcToken = vusdIsInput ? this.config.vusdAddress : stablecoin.address;
    const destToken = vusdIsInput ? stablecoin.address : this.config.vusdAddress;
    const quoteAmount = ethers.parseUnits("1000", srcDecimals);

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
        const price = this.computeVusdPrice(quoteAmount, destAmount, srcDecimals, destDecimals, vusdIsInput);
        return {price, source: adapter.name};
      } catch {
        return null;
      }
    });

    const curveRouterQuote = (async (): Promise<DexQuoteResult | null> => {
      if (!this.config.enableCurveRouter) return null;
      try {
        const q = await this.dexQuoter.quoteCurveRouter(
          stablecoin.address,
          quoteAmount,
          destDecimals,
          srcDecimals,
          vusdIsInput,
        );
        if (!q) return null;
        const price = vusdIsInput ? q.price : 1000 / (q.price * 1000);
        return {...q, price};
      } catch {
        return null;
      }
    })();

    const results = await Promise.all([...aggregatorQuotes, curveRouterQuote]);
    const candidates = results.filter((q): q is DexQuoteResult => q !== null);

    if (candidates.length === 0) {
      console.warn(`  [${stablecoin.symbol}] All DEX ${dirLabel} price sources failed, defaulting to 1.0`);
      return {price: 1.0, source: "default"};
    }

    // sell: pick highest; buy: pick lowest
    const best = candidates.reduce((a, b) =>
      vusdIsInput ? (a.price > b.price ? a : b) : (a.price < b.price ? a : b),
    );

    const summary = candidates.map((c) => `${c.source}=${c.price.toFixed(6)}`).join(", ");
    console.log(
      `  [${stablecoin.symbol}] DEX ${dirLabel} quotes: ${summary} → using ${best.source} (${best.price.toFixed(6)})`,
    );

    return best;
  }

  /**
   * Convert raw quote amounts into a VUSD price (stablecoin per VUSD).
   * Sell: price = destAmount / 10^destDec / (srcAmount / 10^srcDec)
   * Buy:  price = srcAmount / 10^srcDec / (destAmount / 10^destDec)  (cost per VUSD)
   */
  private computeVusdPrice(
    srcAmount: bigint,
    destAmount: bigint,
    srcDecimals: number,
    destDecimals: number,
    vusdIsInput: boolean,
  ): number {
    const src = Number(srcAmount) / 10 ** srcDecimals;
    const dest = Number(destAmount) / 10 ** destDecimals;
    if (vusdIsInput) {
      // Sell: 1000 VUSD → X stablecoin → price = X/1000
      return dest / src;
    } else {
      // Buy: 1000 stablecoin → Y VUSD → cost per VUSD = 1000/Y
      return src / dest;
    }
  }
}
