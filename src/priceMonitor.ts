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
    this.gateway = new ethers.Contract(
      config.gatewayAddress,
      GATEWAY_ABI,
      provider,
    );
  }

  async getPriceData(stablecoin: StablecoinConfig): Promise<PriceData> {
    const testAmount = ethers.parseUnits("10000", stablecoin.decimals);
    const testVusdAmount = ethers.parseUnits("10000", 18);

    const [
      gatewayMintOutput,
      gatewayRedeemOutput,
      mintFeeBps,
      redeemFeeBps,
      dexSellQuote,
      dexBuyQuote,
    ] = await Promise.all([
      this.gateway.previewDeposit(
        stablecoin.address,
        testAmount,
      ) as Promise<bigint>,
      this.gateway.previewRedeem(
        stablecoin.address,
        testVusdAmount,
      ) as Promise<bigint>,
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
      gatewayRedeemOutput,
      mintFeeBps: Number(mintFeeBps),
      redeemFeeBps: Number(redeemFeeBps),
      stablecoin,
    };
  }

  async getCapacity(
    stablecoin: StablecoinConfig,
  ): Promise<{maxMint: bigint; maxWithdraw: bigint}> {
    const [maxMint, maxWithdraw] = await Promise.all([
      this.gateway.maxMint() as Promise<bigint>,
      this.gateway.maxWithdraw(stablecoin.address) as Promise<bigint>,
    ]);
    return {maxMint, maxWithdraw};
  }

  /**
   * Fetch VUSD DEX price using a fallback chain:
   * Aggregator APIs (Paraswap → 1inch → 0x → LiFi) → Uniswap V3 → Curve → default 1.0
   *
   * @param vusdIsInput true = sell direction (VUSD→stablecoin), false = buy direction (stablecoin→VUSD)
   */
  private async fetchDexQuote(
    stablecoin: StablecoinConfig,
    vusdIsInput: boolean,
  ): Promise<DexQuoteResult> {
    const dirLabel = vusdIsInput ? "sell" : "buy";

    // For sell: quote 1000 VUSD → stablecoin, price = stablecoin_out / 1000
    // For buy:  quote 1000 stablecoin → VUSD, price = 1000 / vusd_out (cost per VUSD)
    const srcDecimals = vusdIsInput ? 18 : stablecoin.decimals;
    const destDecimals = vusdIsInput ? stablecoin.decimals : 18;
    const srcToken = vusdIsInput ? this.config.vusdAddress : stablecoin.address;
    const destToken = vusdIsInput ? stablecoin.address : this.config.vusdAddress;
    const quoteAmount = ethers.parseUnits("1000", srcDecimals);

    // 1. Try each aggregator adapter in order
    for (const adapter of this.aggregators) {
      try {
        const destAmount = await adapter.getQuote({
          srcToken,
          destToken,
          amount: quoteAmount,
          srcDecimals,
          destDecimals,
          chainId: this.config.chainId,
        });

        if (destAmount !== null && destAmount > 0n) {
          const price = this.computeVusdPrice(
            quoteAmount, destAmount, srcDecimals, destDecimals, vusdIsInput,
          );
          console.log(
            `  [${stablecoin.symbol}] DEX ${dirLabel} price via ${adapter.name}: ${price.toFixed(6)}`,
          );
          return {price, source: adapter.name};
        }
      } catch (error) {
        // Adapter failed, try next
      }
    }

    // 2. Try Uniswap V3 on-chain quoter
    if (this.config.enableUniswapV3) {
      const uniQuote = await this.dexQuoter.quoteUniswapV3(
        srcToken,
        destToken,
        quoteAmount,
        destDecimals,
        srcDecimals,
      );
      if (uniQuote) {
        // For buy direction, convert the raw ratio to cost-per-VUSD
        const price = vusdIsInput
          ? uniQuote.price
          : 1000 / (uniQuote.price * 1000);
        console.log(
          `  [${stablecoin.symbol}] DEX ${dirLabel} price via uniswap_v3 (fee ${uniQuote.feeTier}): ${price.toFixed(6)}`,
        );
        return {...uniQuote, price};
      }
    }

    // 3. Try Curve on-chain quoter (direct pool)
    if (this.config.enableCurve) {
      const curveQuote = await this.dexQuoter.quoteCurve(
        stablecoin.address,
        quoteAmount,
        destDecimals,
        srcDecimals,
        vusdIsInput,
      );
      if (curveQuote) {
        const price = vusdIsInput
          ? curveQuote.price
          : 1000 / (curveQuote.price * 1000);
        console.log(
          `  [${stablecoin.symbol}] DEX ${dirLabel} price via curve: ${price.toFixed(6)}`,
        );
        return {...curveQuote, price};
      }
    }

    // 4. Try Curve Router (multi-hop via crvUSD)
    if (this.config.enableCurveRouter) {
      const curveRouterQuote = await this.dexQuoter.quoteCurveRouter(
        stablecoin.address,
        quoteAmount,
        destDecimals,
        srcDecimals,
        vusdIsInput,
      );
      if (curveRouterQuote) {
        const price = vusdIsInput
          ? curveRouterQuote.price
          : 1000 / (curveRouterQuote.price * 1000);
        console.log(
          `  [${stablecoin.symbol}] DEX ${dirLabel} price via curve_router: ${price.toFixed(6)}`,
        );
        return {...curveRouterQuote, price};
      }
    }

    // 5. All sources failed
    console.warn(
      `  [${stablecoin.symbol}] All DEX ${dirLabel} price sources failed, defaulting to 1.0`,
    );
    return {price: 1.0, source: "default"};
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
