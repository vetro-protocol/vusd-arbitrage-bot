import { ethers } from "ethers";
import { ArbDirection, PriceData, FlashLoanProviderConfig } from "./types";

export class ProfitCalculator {
  constructor(private minProfitUsd: number) {}

  /**
   * Check if an arb opportunity exists and estimate profit
   * Returns null if no opportunity
   */
  evaluate(
    priceData: PriceData,
    provider: FlashLoanProviderConfig,
    estimatedGasCostUsd: number
  ): { direction: ArbDirection; estimatedProfitUsd: number; spreadBps: number } | null {
    const { vusdDexPrice, mintFeeBps, redeemFeeBps, stablecoin } = priceData;
    const flashFeeBps = provider.feeBps;

    // VUSD > $1 on DEX → mint and sell
    if (vusdDexPrice > 1.0) {
      // Profit per $1: sell at vusdDexPrice, gateway costs 1 + mintFee + flashFee
      const gatewayMintCost = 1 + mintFeeBps / 10000 + flashFeeBps / 10000;
      const spreadBps = Math.round((vusdDexPrice - gatewayMintCost) * 10000);
      const estimatedProfitPer1000 = (vusdDexPrice - gatewayMintCost) * 1000;
      const estimatedProfitUsd = estimatedProfitPer1000 - estimatedGasCostUsd;

      if (estimatedProfitUsd >= this.minProfitUsd && spreadBps > 0) {
        return {
          direction: ArbDirection.MINT_AND_SELL,
          estimatedProfitUsd,
          spreadBps,
        };
      }
    }

    // VUSD < $1 on DEX → buy and redeem
    if (vusdDexPrice < 1.0) {
      // Profit per $1: buy at vusdDexPrice, gateway redeems at 1 - redeemFee - flashFee
      const gatewayRedeemReturn = 1 - redeemFeeBps / 10000 - flashFeeBps / 10000;
      const spreadBps = Math.round((gatewayRedeemReturn - vusdDexPrice) * 10000);
      const estimatedProfitPer1000 = (gatewayRedeemReturn - vusdDexPrice) * 1000;
      const estimatedProfitUsd = estimatedProfitPer1000 - estimatedGasCostUsd;

      if (estimatedProfitUsd >= this.minProfitUsd && spreadBps > 0) {
        return {
          direction: ArbDirection.BUY_AND_REDEEM,
          estimatedProfitUsd,
          spreadBps,
        };
      }
    }

    return null;
  }

  /**
   * Determine optimal flash amount based on estimated profit curve.
   * Start conservative, increase as long as marginal profit stays positive.
   * The real check is done via staticCall simulation.
   */
  suggestFlashAmount(
    priceData: PriceData,
    maxAmount: bigint
  ): bigint {
    // Start with 10k, scale up based on price deviation
    const deviation = Math.abs(priceData.vusdDexPrice - 1.0);
    const decimals = priceData.stablecoin.decimals;

    let amount: bigint;
    if (deviation > 0.05) {
      // Large deviation: aggressive sizing
      amount = ethers.parseUnits("500000", decimals);
    } else if (deviation > 0.02) {
      amount = ethers.parseUnits("100000", decimals);
    } else if (deviation > 0.005) {
      amount = ethers.parseUnits("50000", decimals);
    } else {
      amount = ethers.parseUnits("10000", decimals);
    }

    return amount < maxAmount ? amount : maxAmount;
  }
}
