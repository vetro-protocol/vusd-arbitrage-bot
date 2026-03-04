import { ethers } from "ethers";
import { Config } from "./config";
import { PriceMonitor } from "./priceMonitor";
import { ProfitCalculator } from "./profitCalculator";
import { SwapBuilder } from "./swapBuilder";
import { Executor } from "./executor";
import { ArbDirection, ArbOpportunity } from "./types";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Keeper {
  private priceMonitor: PriceMonitor;
  private profitCalculator: ProfitCalculator;
  private swapBuilder: SwapBuilder;
  private executor: Executor;
  private running = false;
  private provider: ethers.Provider;

  constructor(private config: Config) {
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.priceMonitor = new PriceMonitor(this.provider, config);
    this.profitCalculator = new ProfitCalculator(config.minProfitUsd);
    this.swapBuilder = new SwapBuilder(config);
    this.executor = new Executor(this.provider, config);
  }

  async start(): Promise<void> {
    this.running = true;
    console.log("Keeper started. Monitoring VUSD price...");
    console.log(`  Stablecoins: ${this.config.stablecoins.map((s) => s.symbol).join(", ")}`);
    console.log(`  Providers: ${this.config.flashLoanProviders.map((p) => `${p.address} (${p.feeBps}bps)`).join(", ")}`);
    console.log(`  Min profit: $${this.config.minProfitUsd}`);
    console.log(`  Poll interval: ${this.config.pollIntervalMs}ms`);

    while (this.running) {
      try {
        await this.tick();
      } catch (error) {
        console.error("[Keeper] Tick error:", error);
      }
      await sleep(this.config.pollIntervalMs);
    }
  }

  private async tick(): Promise<void> {
    for (const stablecoin of this.config.stablecoins) {
      try {
        // 1. Get prices
        const priceData = await this.priceMonitor.getPriceData(stablecoin);
        console.log(
          `[${stablecoin.symbol}] VUSD DEX price: ${priceData.vusdDexPrice.toFixed(4)}, ` +
            `mint fee: ${priceData.mintFeeBps}bps, redeem fee: ${priceData.redeemFeeBps}bps`
        );

        // 2. Select best provider
        const provider = this.config.flashLoanProviders[0]; // Already sorted by fee
        if (!provider) {
          console.warn("No flash loan providers configured");
          continue;
        }

        // 3. Evaluate opportunity
        const estimatedGasCostUsd = 5.0; // Conservative estimate
        const evaluation = this.profitCalculator.evaluate(priceData, provider, estimatedGasCostUsd);

        if (!evaluation) continue;

        console.log(
          `[${stablecoin.symbol}] Opportunity found: ${ArbDirection[evaluation.direction]}, ` +
            `spread: ${evaluation.spreadBps}bps, est. profit: $${evaluation.estimatedProfitUsd.toFixed(2)}`
        );

        // 4. Determine flash amount
        const flashAmount = this.profitCalculator.suggestFlashAmount(priceData, this.config.maxFlashAmount);

        // 5. Build swap params
        let swapParams;
        if (evaluation.direction === ArbDirection.MINT_AND_SELL) {
          // We need to estimate VUSD minted first for the sell swap
          const vusdEstimate = priceData.gatewayMintOutput; // from previewDeposit
          const scaledVusd = (vusdEstimate * flashAmount) / ethers.parseUnits("10000", stablecoin.decimals);
          swapParams = await this.swapBuilder.buildSellVusdSwap(scaledVusd, stablecoin);
        } else {
          swapParams = await this.swapBuilder.buildBuyVusdSwap(flashAmount, stablecoin);
        }

        // 6. Build opportunity
        const minProfit = ethers.parseUnits(String(this.config.minProfitUsd), stablecoin.decimals);

        const opportunity: ArbOpportunity = {
          direction: evaluation.direction,
          stablecoin,
          flashAmount,
          swapParams,
          provider: provider.provider,
          estimatedProfitUsd: evaluation.estimatedProfitUsd,
          dexPriceVusd: priceData.vusdDexPrice,
          minProfit,
        };

        // 7. Execute
        const receipt = await this.executor.execute(opportunity);
        if (receipt) {
          console.log(`[${stablecoin.symbol}] Arb executed! Tx: ${receipt.hash}`);
        }
      } catch (error) {
        console.error(`[${stablecoin.symbol}] Error:`, error);
      }
    }
  }

  stop(): void {
    this.running = false;
    console.log("Keeper stopping...");
  }
}
