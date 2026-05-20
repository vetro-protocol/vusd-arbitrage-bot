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

function buildAggregators(config: Config): AggregatorAdapter[] {
  const adapters: AggregatorAdapter[] = [];
  if (config.enableOneInch && config.oneInchApiKey) {
    adapters.push(new OneInchAdapter(config.oneInchApiKey));
  }
  if (config.enableZeroX && config.zeroXApiKey) {
    adapters.push(new ZeroXAdapter(config.zeroXApiKey));
  }
  if (config.enableLifi) {
    adapters.push(new LiFiAdapter(config.lifiApiKey));
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

  constructor(
    private config: Config,
    privateKey?: string,
  ) {
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);

    const aggregators = buildAggregators(config);
    const dexQuoter = new DexQuoter(
      this.provider,
      config.curveRouterAddress,
      config.peggedTokenAddress,
      config.product.curveRouterRoutes,
    );

    this.priceMonitor = new PriceMonitor(this.provider, config, aggregators, dexQuoter);
    this.profitCalculator = new ProfitCalculator(config.minProfitBase, config.flashAmountTiers);
    this.swapBuilder = new SwapBuilder(config, aggregators, dexQuoter);
    this.executor = new Executor(this.provider, config, privateKey);

    console.log(
      `[Keeper] Price sources: ${
        [
          ...aggregators.map((a) => a.name),
          ...(config.enableCurveRouter ? ["curve_router"] : []),
        ].join(" → ") || "none"
      } → default(1.0) | Flash loan: Morpho (0bps fee)`,
    );
  }

  async start(): Promise<void> {
    this.running = true;
    const ts = () => new Date().toISOString().slice(11, 19);
    const p = this.config.product;
    const baseSymbol = p.underlyingTokens[0]?.symbol ?? "BASE";

    console.log("═══════════════════════════════════════════════════");
    console.log(`  ${p.description} Arbitrage Keeper (${p.peggedToken.symbol})`);
    console.log("═══════════════════════════════════════════════════");
    console.log(`  Product     : ${p.name}`);
    console.log(`  Pegged      : ${p.peggedToken.symbol} (${p.peggedToken.address})`);
    console.log(`  Arb contract: ${this.config.arbitrageAddress}`);
    console.log(`  Underlyings : ${p.underlyingTokens.map((u) => u.symbol).join(", ")}`);
    console.log(`  Flash loan  : Morpho (0bps fee)`);
    console.log(`  Mode        : ${this.executor.isDryRun ? "DRY-RUN (no PRIVATE_KEY — txs will be skipped)" : "LIVE"}`);
    console.log(`  Min profit  : ${this.config.minProfitBase} ${baseSymbol}`);
    console.log(`  Poll        : ${this.config.pollIntervalMs / 1000}s`);
    console.log(
      `  Flash tiers : ${this.config.flashAmountTiers.map((t) => `>${t.deviationBps}bps→${t.amount}${baseSymbol}`).join(", ")}`,
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
    for (const underlying of this.config.product.underlyingTokens) {
      try {
        // 1. Get prices
        const priceData = await this.priceMonitor.getPriceData(underlying);
        const deviationBps = Math.round(Math.abs(priceData.peggedDexSellPrice - 1.0) * 10000);
        const direction =
          priceData.peggedDexSellPrice > 1.0 ? "ABOVE" : priceData.peggedDexSellPrice < 1.0 ? "BELOW" : "AT";

        // Skip if both DEX sources defaulted — no real price data
        if (priceData.dexSellQuote.source === "default" && priceData.dexBuyQuote.source === "default") {
          console.log(`[${ts()}] [${underlying.symbol}] No DEX quote available (all sources failed)`);
          continue;
        }

        // 2. Size flash loan
        const flashAmount = this.profitCalculator.suggestFlashAmount(priceData, this.config.maxFlashAmount);
        const flashBase = Number(flashAmount) / 10 ** underlying.decimals;

        // 3. Evaluate
        const evaluation = this.profitCalculator.evaluate(priceData, flashAmount, this.config.estimatedGasCostBase);

        // Compute raw spread + profit for BOTH directions for logging
        const mintCost = 1 + priceData.mintFeeBps / 10000;
        const mintSpreadBps = Math.round((priceData.peggedDexSellPrice - mintCost) * 10000);
        const mintEstProfit = (priceData.peggedDexSellPrice - mintCost) * flashBase - this.config.estimatedGasCostBase;

        const redeemReturn = 1 - priceData.redeemFeeBps / 10000;
        const redeemSpreadBps = Math.round((redeemReturn - priceData.peggedDexBuyPrice) * 10000);
        const redeemEstProfit = (redeemReturn - priceData.peggedDexBuyPrice) * flashBase - this.config.estimatedGasCostBase;

        const mintIsBetter = mintEstProfit >= redeemEstProfit;
        const rawDirection = mintIsBetter ? "MINT_AND_SELL" : "BUY_AND_REDEEM";
        const rawSpreadBps = mintIsBetter ? mintSpreadBps : redeemSpreadBps;
        const rawEstProfit = mintIsBetter ? mintEstProfit : redeemEstProfit;

        const profitSign = rawEstProfit >= 0 ? "+" : "";
        const actionable = evaluation ? ">>> ACTIONABLE" : "";

        console.log(
          `[${ts()}] [${underlying.symbol}] ` +
            `sell=${priceData.peggedDexSellPrice.toFixed(4)} buy=${priceData.peggedDexBuyPrice.toFixed(4)} (${direction} peg, ${deviationBps}bps) | ` +
            `via ${priceData.dexSellQuote.source}/${priceData.dexBuyQuote.source} | ` +
            `${rawDirection} spread=${rawSpreadBps}bps | ` +
            `flash=${flashBase.toLocaleString()}${underlying.symbol} | ` +
            `est=${profitSign}${rawEstProfit.toFixed(4)} ${underlying.symbol} (min ${this.config.minProfitBase} ${underlying.symbol}) | ` +
            `fees: mint=${priceData.mintFeeBps}bps redeem=${priceData.redeemFeeBps}bps` +
            (actionable ? ` ${actionable}` : ""),
        );

        if (!evaluation) continue;

        // 4. Capacity guard + cap flash to Gateway maxWithdraw if needed
        const capacity = await this.priceMonitor.getCapacity(underlying);
        let cappedFlashAmount = flashAmount;

        if (evaluation.direction === ArbDirection.BUY_AND_REDEEM) {
          if (capacity.maxWithdraw === 0n) {
            console.warn(
              `[${ts()}] [${underlying.symbol}] SKIP BUY_AND_REDEEM: Gateway has 0 ${underlying.symbol} reserves`,
            );
            continue;
          }
          if (cappedFlashAmount > capacity.maxWithdraw) {
            const maxW = ethers.formatUnits(capacity.maxWithdraw, underlying.decimals);
            console.log(`[${ts()}] [${underlying.symbol}] Capping flash to Gateway maxWithdraw: ${maxW}`);
            cappedFlashAmount = capacity.maxWithdraw;
          }
        } else {
          if (capacity.maxMint === 0n) {
            console.warn(`[${ts()}] [${underlying.symbol}] SKIP MINT_AND_SELL: Gateway mint cap reached`);
            continue;
          }
        }

        const cappedBase = Number(cappedFlashAmount) / 10 ** underlying.decimals;
        console.log(
          `[${ts()}] [${underlying.symbol}] >>> ${ArbDirection[evaluation.direction]} ` +
            `${cappedBase.toLocaleString()} ${underlying.symbol} | ` +
            `spread=${evaluation.spreadBps}bps | est profit=${evaluation.estimatedProfitBase.toFixed(4)} ${underlying.symbol}`,
        );

        // 5. Build swap params
        let swapParams;
        if (evaluation.direction === ArbDirection.MINT_AND_SELL) {
          const peggedEstimate = priceData.gatewayMintOutput;
          const scaledPegged = (peggedEstimate * cappedFlashAmount) / ethers.parseUnits("10000", underlying.decimals);
          swapParams = await this.swapBuilder.buildSellPeggedSwap(scaledPegged, underlying, priceData.dexSellQuote);
        } else {
          swapParams = await this.swapBuilder.buildBuyPeggedSwap(cappedFlashAmount, underlying, priceData.dexBuyQuote);
        }

        // 6. Build opportunity
        const minProfit = ethers.parseUnits(String(this.config.minProfitBase), underlying.decimals);

        const opportunity: ArbOpportunity = {
          direction: evaluation.direction,
          underlying,
          flashAmount: cappedFlashAmount,
          swapParams,
          estimatedProfitBase: evaluation.estimatedProfitBase,
          dexPricePegged: priceData.peggedDexSellPrice,
          minProfit,
        };

        // 7. Execute
        const receipt = await this.executor.execute(opportunity);
        if (receipt) {
          console.log(`[${ts()}] [${underlying.symbol}] ARB EXECUTED! Tx: ${receipt.hash}`);
        }
      } catch (error) {
        console.error(`[${ts()}] [${underlying.symbol}] Error:`, error);
      }
    }
  }

  stop(): void {
    this.running = false;
    console.log("Keeper stopping...");
  }
}
