import {ethers} from "ethers";
import {Config} from "./config";
import {PriceMonitor} from "./priceMonitor";
import {ProfitCalculator} from "./profitCalculator";
import {SwapBuilder} from "./swapBuilder";
import {Executor} from "./executor";
import {ArbDirection, ArbOpportunity} from "./types";
import {AggregatorAdapter, OneInchAdapter, ZeroXAdapter, LiFiAdapter} from "./aggregators";
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

  if (config.enableLifi) {
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
      config.vusdAddress,
      config.curveRouterRoutes,
    );

    this.priceMonitor = new PriceMonitor(this.provider, config, aggregators, dexQuoter);
    this.profitCalculator = new ProfitCalculator(config.minProfitUsd, config.flashAmountTiers);
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
      } → default(1.0) | Flash loan: Morpho (0bps fee)`,
    );
  }

  async start(): Promise<void> {
    this.running = true;
    const ts = () => new Date().toISOString().slice(11, 19);

    console.log("═══════════════════════════════════════════════════");
    console.log("  VUSD Arbitrage Keeper");
    console.log("═══════════════════════════════════════════════════");
    console.log(`  Stablecoins : ${this.config.stablecoins.map((s) => s.symbol).join(", ")}`);
    console.log(`  Flash loan  : Morpho (0bps fee)`);
    console.log(`  Min profit  : $${this.config.minProfitUsd}`);
    console.log(`  Poll        : ${this.config.pollIntervalMs / 1000}s`);
    console.log(
      `  Flash tiers : ${this.config.flashAmountTiers.map((t) => `>${t.deviationBps}bps→$${t.amountUsd}`).join(", ")}`,
    );
    console.log("═══════════════════════════════════════════════════\n");

    while (this.running) {
      try {
        await this.tick(ts);
      } catch (error) {
        console.error(`[${ts()}] Tick error:`, error);
      }
      await sleep(this.config.pollIntervalMs);
    }
  }

  private async tick(ts: () => string): Promise<void> {
    for (const stablecoin of this.config.stablecoins) {
      try {
        // 1. Get prices
        const priceData = await this.priceMonitor.getPriceData(stablecoin);
        const deviationBps = Math.round(Math.abs(priceData.vusdDexPrice - 1.0) * 10000);
        const direction = priceData.vusdDexPrice > 1.0 ? "ABOVE" : priceData.vusdDexPrice < 1.0 ? "BELOW" : "AT";

        // Skip if both DEX sources are "default" — no real price data
        if (priceData.dexQuote.source === "default" && priceData.dexBuyQuote.source === "default") {
          console.log(`[${ts()}] [${stablecoin.symbol}] No DEX quote available (all sources failed)`);
          continue;
        }

        // 2. Determine flash amount based on price deviation
        const flashAmount = this.profitCalculator.suggestFlashAmount(priceData, this.config.maxFlashAmount);
        const flashUsd = Number(flashAmount) / 10 ** stablecoin.decimals;

        // 3. Evaluate opportunity at the actual flash amount
        const estimatedGasCostUsd = this.config.estimatedGasCostUsd;
        const evaluation = this.profitCalculator.evaluate(priceData, flashAmount, estimatedGasCostUsd);

        // Compute raw spread + profit for BOTH directions, pick the better one
        // MINT_AND_SELL: flash stablecoin → mint VUSD at Gateway → sell VUSD on DEX
        const mintCost = 1 + priceData.mintFeeBps / 10000;
        const mintSpreadBps = Math.round((priceData.vusdDexPrice - mintCost) * 10000);
        const mintEstProfit = (priceData.vusdDexPrice - mintCost) * flashUsd - estimatedGasCostUsd;

        // BUY_AND_REDEEM: flash stablecoin → buy VUSD on DEX → redeem at Gateway
        const redeemReturn = 1 - priceData.redeemFeeBps / 10000;
        const redeemSpreadBps = Math.round((redeemReturn - priceData.vusdDexBuyPrice) * 10000);
        const redeemEstProfit = (redeemReturn - priceData.vusdDexBuyPrice) * flashUsd - estimatedGasCostUsd;

        // Pick the better (or less-bad) direction for display
        const mintIsBetter = mintEstProfit >= redeemEstProfit;
        const rawDirection = mintIsBetter ? "MINT_AND_SELL" : "BUY_AND_REDEEM";
        const rawSpreadBps = mintIsBetter ? mintSpreadBps : redeemSpreadBps;
        const rawEstProfit = mintIsBetter ? mintEstProfit : redeemEstProfit;

        const profitSign = rawEstProfit >= 0 ? "+" : "";
        const actionable = evaluation ? ">>> ACTIONABLE" : "";

        console.log(
          `[${ts()}] [${stablecoin.symbol}] ` +
            `sell=$${priceData.vusdDexPrice.toFixed(4)} buy=$${priceData.vusdDexBuyPrice.toFixed(4)} (${direction} peg, ${deviationBps}bps) | ` +
            `via ${priceData.dexQuote.source}/${priceData.dexBuyQuote.source} | ` +
            `${rawDirection} spread=${rawSpreadBps}bps | ` +
            `flash=$${flashUsd.toLocaleString()} | ` +
            `est=${profitSign}$${rawEstProfit.toFixed(2)} (min $${this.config.minProfitUsd}) | ` +
            `fees: mint=${priceData.mintFeeBps}bps redeem=${priceData.redeemFeeBps}bps` +
            (actionable ? ` ${actionable}` : ""),
        );

        if (!evaluation) continue;

        // 5. Check Gateway capacity and cap flash amount
        const capacity = await this.priceMonitor.getCapacity(stablecoin);
        let cappedFlashAmount = flashAmount;

        if (evaluation.direction === ArbDirection.BUY_AND_REDEEM) {
          if (capacity.maxWithdraw === 0n) {
            console.warn(
              `[${ts()}] [${stablecoin.symbol}] SKIP BUY_AND_REDEEM: Gateway has 0 ${stablecoin.symbol} reserves`,
            );
            continue;
          }
          if (cappedFlashAmount > capacity.maxWithdraw) {
            const maxW = ethers.formatUnits(capacity.maxWithdraw, stablecoin.decimals);
            console.log(`[${ts()}] [${stablecoin.symbol}] Capping flash to Gateway maxWithdraw: $${maxW}`);
            cappedFlashAmount = capacity.maxWithdraw;
          }
        } else {
          if (capacity.maxMint === 0n) {
            console.warn(`[${ts()}] [${stablecoin.symbol}] SKIP MINT_AND_SELL: Gateway mint cap reached`);
            continue;
          }
        }

        const cappedUsd = Number(cappedFlashAmount) / 10 ** stablecoin.decimals;
        console.log(
          `[${ts()}] [${stablecoin.symbol}] >>> ${ArbDirection[evaluation.direction]} ` +
            `$${cappedUsd.toLocaleString()} ${stablecoin.symbol} | ` +
            `spread=${evaluation.spreadBps}bps | est profit=$${evaluation.estimatedProfitUsd.toFixed(2)}`,
        );

        // 6. Build swap params (use the matching directional quote as source)
        let swapParams;
        if (evaluation.direction === ArbDirection.MINT_AND_SELL) {
          const vusdEstimate = priceData.gatewayMintOutput;
          const scaledVusd = (vusdEstimate * cappedFlashAmount) / ethers.parseUnits("10000", stablecoin.decimals);
          swapParams = await this.swapBuilder.buildSellVusdSwap(scaledVusd, stablecoin, priceData.dexQuote);
        } else {
          swapParams = await this.swapBuilder.buildBuyVusdSwap(cappedFlashAmount, stablecoin, priceData.dexBuyQuote);
        }

        // 7. Build opportunity
        const minProfit = ethers.parseUnits(String(this.config.minProfitUsd), stablecoin.decimals);

        const opportunity: ArbOpportunity = {
          direction: evaluation.direction,
          stablecoin,
          flashAmount: cappedFlashAmount,
          swapParams,
          estimatedProfitUsd: evaluation.estimatedProfitUsd,
          dexPriceVusd: priceData.vusdDexPrice,
          minProfit,
        };

        // 8. Execute
        const receipt = await this.executor.execute(opportunity);
        if (receipt) {
          console.log(`[${ts()}] [${stablecoin.symbol}] ARB EXECUTED! Tx: ${receipt.hash}`);
        }
      } catch (error) {
        console.error(`[${ts()}] [${stablecoin.symbol}] Error:`, error);
      }
    }
  }

  stop(): void {
    this.running = false;
    console.log("Keeper stopping...");
  }
}
