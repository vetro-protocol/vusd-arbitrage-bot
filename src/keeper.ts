import {ethers} from "ethers";
import {Config} from "./config";
import {PriceMonitor} from "./priceMonitor";
import {ProfitCalculator} from "./profitCalculator";
import {SwapBuilder} from "./swapBuilder";
import {Executor} from "./executor";
import {ArbDirection, ArbOpportunity} from "./types";
import {
  AggregatorAdapter,
  OneInchAdapter,
  ZeroXAdapter,
  LiFiAdapter,
} from "./aggregators";
import {DexQuoter} from "./dexQuoter";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the list of enabled aggregator adapters based on config.
 * Order determines fallback priority.
 */
function buildAggregators(config: Config): AggregatorAdapter[] {
  const adapters: AggregatorAdapter[] = [];

  if (config.enableOneInch && config.oneInchApiKey) {
    adapters.push(new OneInchAdapter(config.oneInchApiKey));
  }

  if (config.enableZeroX && config.zeroXApiKey) {
    adapters.push(new ZeroXAdapter(config.zeroXApiKey));
  }

  if (config.enableLifi && config.lifiEnabled) {
    adapters.push(new LiFiAdapter());
  }

  return adapters;
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

    const aggregators = buildAggregators(config);
    const dexQuoter = new DexQuoter(
      this.provider,
      config.uniswapV3QuoterAddress,
      config.uniswapV3RouterAddress,
      config.curvePoolConfigs,
      config.curveRouterAddress,
      config.crvusdAddress,
      config.vusdAddress,
      config.curveRouterRoutes,
    );

    this.priceMonitor = new PriceMonitor(
      this.provider,
      config,
      aggregators,
      dexQuoter,
    );
    this.profitCalculator = new ProfitCalculator(config.minProfitUsd);
    this.swapBuilder = new SwapBuilder(config, aggregators, dexQuoter);
    this.executor = new Executor(this.provider, config);

    console.log(
      `[Keeper] Price sources: ${
        [
          ...aggregators.map((a) => a.name),
          ...(config.enableUniswapV3 ? ["uniswap_v3"] : []),
          ...(config.enableCurve ? ["curve"] : []),
          ...(config.enableCurveRouter ? ["curve_router"] : []),
        ].join(" → ") || "none"
      } → default(1.0)`,
    );
  }

  async start(): Promise<void> {
    this.running = true;
    console.log("Keeper started. Monitoring VUSD price...");
    console.log(
      `  Stablecoins: ${this.config.stablecoins.map((s) => s.symbol).join(", ")}`,
    );
    console.log(
      `  Providers: ${this.config.flashLoanProviders.map((p) => `${p.address} (${p.feeBps}bps)`).join(", ")}`,
    );
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
          `[${stablecoin.symbol}] VUSD DEX price: ${priceData.vusdDexPrice.toFixed(4)} (via ${priceData.dexQuote.source}), ` +
            `mint fee: ${priceData.mintFeeBps}bps, redeem fee: ${priceData.redeemFeeBps}bps`,
        );

        // 2. Select best provider
        const provider = this.config.flashLoanProviders[0]; // Already sorted by fee
        if (!provider) {
          console.warn("No flash loan providers configured");
          continue;
        }

        // 3. Evaluate opportunity
        const estimatedGasCostUsd = 5.0; // Conservative estimate
        const evaluation = this.profitCalculator.evaluate(
          priceData,
          provider,
          estimatedGasCostUsd,
        );

        if (!evaluation) continue;

        // Skip if DEX source is "default" — no real price data, can't build swap
        if (priceData.dexQuote.source === "default") {
          console.warn(
            `[${stablecoin.symbol}] Opportunity detected but no DEX route available (all sources failed)`,
          );
          continue;
        }

        console.log(
          `[${stablecoin.symbol}] Opportunity found: ${ArbDirection[evaluation.direction]}, ` +
            `spread: ${evaluation.spreadBps}bps, est. profit: $${evaluation.estimatedProfitUsd.toFixed(2)}`,
        );

        // 4. Determine flash amount
        const flashAmount = this.profitCalculator.suggestFlashAmount(
          priceData,
          this.config.maxFlashAmount,
        );

        // 5. Build swap params (routed through same DEX that quoted the price)
        let swapParams;
        if (evaluation.direction === ArbDirection.MINT_AND_SELL) {
          const vusdEstimate = priceData.gatewayMintOutput;
          const scaledVusd =
            (vusdEstimate * flashAmount) /
            ethers.parseUnits("10000", stablecoin.decimals);
          swapParams = await this.swapBuilder.buildSellVusdSwap(
            scaledVusd,
            stablecoin,
            priceData.dexQuote,
          );
        } else {
          swapParams = await this.swapBuilder.buildBuyVusdSwap(
            flashAmount,
            stablecoin,
            priceData.dexQuote,
          );
        }

        // 6. Build opportunity
        const minProfit = ethers.parseUnits(
          String(this.config.minProfitUsd),
          stablecoin.decimals,
        );

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
          console.log(
            `[${stablecoin.symbol}] Arb executed! Tx: ${receipt.hash}`,
          );
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
