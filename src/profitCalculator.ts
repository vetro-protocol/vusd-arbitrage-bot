import {ethers} from "ethers";
import {
  ArbDirection,
  FlashAmountTier,
  PriceData,
  FlashLoanProviderConfig,
} from "./types";

export class ProfitCalculator {
  constructor(
    private minProfitUsd: number,
    private flashAmountTiers: FlashAmountTier[],
  ) {}

  /**
   * Determine flash loan size based on price deviation and configurable tiers.
   * Tiers are sorted descending by deviationBps — first match wins.
   * Result is capped by maxAmount.
   */
  suggestFlashAmount(priceData: PriceData, maxAmount: bigint): bigint {
    const deviationBps = Math.abs(priceData.vusdDexPrice - 1.0) * 10000;
    const decimals = priceData.stablecoin.decimals;

    // Find the first tier whose threshold is met
    let amountUsd = this.flashAmountTiers[this.flashAmountTiers.length - 1]
      ?.amountUsd ?? 500;
    for (const tier of this.flashAmountTiers) {
      if (deviationBps >= tier.deviationBps) {
        amountUsd = tier.amountUsd;
        break;
      }
    }

    const amount = ethers.parseUnits(String(amountUsd), decimals);
    return amount < maxAmount ? amount : maxAmount;
  }

  /**
   * Evaluate whether an arb opportunity exists at the given flash amount.
   * Computes profit = (spread * notional) - gasCost.
   * Returns null if no opportunity or profit below threshold.
   */
  evaluate(
    priceData: PriceData,
    provider: FlashLoanProviderConfig,
    flashAmount: bigint,
    estimatedGasCostUsd: number,
  ): {
    direction: ArbDirection;
    estimatedProfitUsd: number;
    spreadBps: number;
  } | null {
    const {vusdDexPrice, mintFeeBps, redeemFeeBps, stablecoin} = priceData;
    const flashFeeBps = provider.feeBps;

    // Convert flash amount to USD-equivalent notional
    const notionalUsd =
      Number(flashAmount) / 10 ** stablecoin.decimals;

    // VUSD > $1 on DEX → mint and sell
    if (vusdDexPrice > 1.0) {
      const gatewayMintCost = 1 + mintFeeBps / 10000 + flashFeeBps / 10000;
      const spreadPerDollar = vusdDexPrice - gatewayMintCost;
      const spreadBps = Math.round(spreadPerDollar * 10000);
      const estimatedProfitUsd =
        spreadPerDollar * notionalUsd - estimatedGasCostUsd;

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
      const gatewayRedeemReturn =
        1 - redeemFeeBps / 10000 - flashFeeBps / 10000;
      const spreadPerDollar = gatewayRedeemReturn - vusdDexPrice;
      const spreadBps = Math.round(spreadPerDollar * 10000);
      const estimatedProfitUsd =
        spreadPerDollar * notionalUsd - estimatedGasCostUsd;

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
}
