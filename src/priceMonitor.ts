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
      dexQuote,
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
      this.fetchDexQuote(stablecoin),
    ]);

    return {
      vusdDexPrice: dexQuote.price,
      dexQuote,
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
   */
  private async fetchDexQuote(
    stablecoin: StablecoinConfig,
  ): Promise<DexQuoteResult> {
    const vusdAmount = ethers.parseUnits("1000", 18);

    // 1. Try each aggregator adapter in order
    for (const adapter of this.aggregators) {
      try {
        const destAmount = await adapter.getQuote({
          srcToken: this.config.vusdAddress,
          destToken: stablecoin.address,
          amount: vusdAmount,
          srcDecimals: 18,
          destDecimals: stablecoin.decimals,
          chainId: this.config.chainId,
        });

        if (destAmount !== null && destAmount > 0n) {
          const price =
            Number(destAmount) /
            10 ** stablecoin.decimals /
            (Number(vusdAmount) / 10 ** 18);
          console.log(
            `  [${stablecoin.symbol}] DEX price via ${adapter.name}: ${price.toFixed(6)}`,
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
        this.config.vusdAddress,
        stablecoin.address,
        vusdAmount,
        stablecoin.decimals,
        18,
      );
      if (uniQuote) {
        console.log(
          `  [${stablecoin.symbol}] DEX price via uniswap_v3 (fee ${uniQuote.feeTier}): ${uniQuote.price.toFixed(6)}`,
        );
        return uniQuote;
      }
    }

    // 3. Try Curve on-chain quoter
    if (this.config.enableCurve) {
      const curveQuote = await this.dexQuoter.quoteCurve(
        stablecoin.address,
        vusdAmount,
        stablecoin.decimals,
        18,
        true, // VUSD is input (sell direction for quoting)
      );
      if (curveQuote) {
        console.log(
          `  [${stablecoin.symbol}] DEX price via curve: ${curveQuote.price.toFixed(6)}`,
        );
        return curveQuote;
      }
    }

    // 4. All sources failed
    console.warn(
      `  [${stablecoin.symbol}] All DEX price sources failed, defaulting to 1.0`,
    );
    return {price: 1.0, source: "default"};
  }
}
