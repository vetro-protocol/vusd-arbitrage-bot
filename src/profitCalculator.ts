import {ethers} from "ethers";
import {ArbDirection, PriceData} from "./types";
import {FlashAmountTier} from "./products";

/**
 * Evaluates whether an arb opportunity is actionable and sizes the flash loan.
 *
 * All "profit" / "amount" values here are denominated in the **underlying base
 * asset** of the product:
 *   - VUSD product → USDC / USDT (≈ USD)
 *   - vetBTC product → WBTC / cbBTC / hemiBTC (≈ BTC)
 *
 * The peg is assumed to be 1:1 between pegged token and underlying. Both VUSD
 * (1 ≈ 1 USDC) and vetBTC (1 ≈ 1 WBTC) satisfy this.
 */
export class ProfitCalculator {
  constructor(
    private minProfitBase: number,
    private flashAmountTiers: FlashAmountTier[],
  ) {}

  /**
   * Determine flash loan size from price deviation.
   * Tiers are sorted descending — first match wins. Result capped at maxAmount.
   */
  suggestFlashAmount(priceData: PriceData, maxAmount: bigint): bigint {
    const sellDev = Math.abs(priceData.peggedDexSellPrice - 1.0) * 10000;
    const buyDev = Math.abs(priceData.peggedDexBuyPrice - 1.0) * 10000;
    const deviationBps = Math.max(sellDev, buyDev);
    const decimals = priceData.underlying.decimals;

    let amount = this.flashAmountTiers[this.flashAmountTiers.length - 1]?.amount ?? 0;
    for (const tier of this.flashAmountTiers) {
      if (deviationBps >= tier.deviationBps) {
        amount = tier.amount;
        break;
      }
    }

    const amountBig = ethers.parseUnits(String(amount), decimals);
    return amountBig < maxAmount ? amountBig : maxAmount;
  }

  /**
   * Evaluate whether an arb opportunity exists at the given flash amount.
   * profit = (spread × notional) − gasCost, all in base-asset units.
   * Returns null if no opportunity or profit below threshold.
   */
  evaluate(
    priceData: PriceData,
    flashAmount: bigint,
    estimatedGasCostBase: number,
  ): {
    direction: ArbDirection;
    estimatedProfitBase: number;
    spreadBps: number;
  } | null {
    const {peggedDexSellPrice, peggedDexBuyPrice, mintFeeBps, redeemFeeBps, underlying} = priceData;
    const flashFeeBps = 0; // Morpho has no fee

    // Convert flash amount to base-asset notional
    const notionalBase = Number(flashAmount) / 10 ** underlying.decimals;

    // pegged sell price > 1.0 on DEX → mint and sell
    if (peggedDexSellPrice > 1.0) {
      const gatewayMintCost = 1 + mintFeeBps / 10000 + flashFeeBps / 10000;
      const spreadPerUnit = peggedDexSellPrice - gatewayMintCost;
      const spreadBps = Math.round(spreadPerUnit * 10000);
      const estimatedProfitBase = spreadPerUnit * notionalBase - estimatedGasCostBase;

      if (estimatedProfitBase >= this.minProfitBase && spreadBps > 0) {
        return {direction: ArbDirection.MINT_AND_SELL, estimatedProfitBase, spreadBps};
      }
    }

    // pegged buy price < 1.0 on DEX → buy and redeem
    if (peggedDexBuyPrice < 1.0) {
      const gatewayRedeemReturn = 1 - redeemFeeBps / 10000 - flashFeeBps / 10000;
      const spreadPerUnit = gatewayRedeemReturn - peggedDexBuyPrice;
      const spreadBps = Math.round(spreadPerUnit * 10000);
      const estimatedProfitBase = spreadPerUnit * notionalBase - estimatedGasCostBase;

      if (estimatedProfitBase >= this.minProfitBase && spreadBps > 0) {
        return {direction: ArbDirection.BUY_AND_REDEEM, estimatedProfitBase, spreadBps};
      }
    }

    return null;
  }
}
