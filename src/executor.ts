import {ethers} from "ethers";
import {Config, inclusionTimeoutMs} from "./config";
import {ArbDirection, ArbOpportunity, SwapParams} from "./types";

/** ABI matches the new VetroArbitrage contract. Param names don't affect selector, so this also works against old VUSDArbitrage deployments. */
const ARB_ABI = [
  "function mintAndSell(address underlying_, uint256 flashAmount_, tuple(address target, address approveTarget, bytes swapCalldata, uint256 minAmountOut) swapParams_, uint256 minProfit_) returns (int256)",
  "function buyAndRedeem(address underlying_, uint256 flashAmount_, tuple(address target, address approveTarget, bytes swapCalldata, uint256 minAmountOut) swapParams_, uint256 minProfit_) returns (int256)",
];

const CHAINLINK_ABI = [
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
];

/** Headroom over eth_estimateGas. The estimate has none, which cost us out-of-gas reverts. */
const GAS_LIMIT_BUFFER_PCT = 125n;

/** Poll interval for the Flashbots Protect status API. */
const STATUS_POLL_MS = 1_000;
/** Timeout for one status request. The loop deadline is only checked between requests. */
const STATUS_FETCH_TIMEOUT_MS = 5_000;

export class Executor {
  private arbContract: ethers.Contract;
  private wallet: ethers.Wallet | null;
  private provider: ethers.Provider;
  /** Send-only (Flashbots Protect). Reads and simulation never go through this. */
  private sendProvider: ethers.JsonRpcProvider;
  private priceFeed: ethers.Contract | null;
  private priceFeedDecimals: bigint | null = null;
  /** Safety cap on the wait for a final Protect status, from SEND_RPC_URL's blockRange. */
  private inclusionTimeoutMs: number;

  constructor(
    provider: ethers.Provider,
    private config: Config,
    privateKey?: string,
  ) {
    this.provider = provider;
    this.wallet = privateKey ? new ethers.Wallet(privateKey, provider) : null;
    this.arbContract = new ethers.Contract(config.arbitrageAddress, ARB_ABI, this.wallet ?? provider);
    // staticNetwork: no eth_chainId probe. A send-only endpoint may not answer
    // reads, and ethers then retries network detection forever.
    this.sendProvider = new ethers.JsonRpcProvider(config.sendRpcUrl, config.chainId, {staticNetwork: true});
    this.priceFeed = config.ethPriceFeed ? new ethers.Contract(config.ethPriceFeed, CHAINLINK_ABI, provider) : null;
    this.inclusionTimeoutMs = inclusionTimeoutMs(config.sendRpcUrl);
  }

  /** True when no PRIVATE_KEY is set — bot polls and logs but skips tx submission. */
  get isDryRun(): boolean {
    return this.wallet === null;
  }

  /** Simulate via staticCall — returns net profit (int256), or -1 on revert. */
  async simulate(opportunity: ArbOpportunity): Promise<bigint> {
    const swapTuple = this.formatSwapParams(opportunity.swapParams);

    try {
      let profit: bigint;
      if (opportunity.direction === ArbDirection.MINT_AND_SELL) {
        profit = await this.arbContract.mintAndSell.staticCall(
          opportunity.underlying.address,
          opportunity.flashAmount,
          swapTuple,
          0n,
        );
      } else {
        profit = await this.arbContract.buyAndRedeem.staticCall(
          opportunity.underlying.address,
          opportunity.flashAmount,
          swapTuple,
          0n,
        );
      }

      console.log(
        `[Simulation] ${ArbDirection[opportunity.direction]} ${opportunity.underlying.symbol}: ` +
          `profit = ${ethers.formatUnits(profit, opportunity.underlying.decimals)} ${opportunity.underlying.symbol}`,
      );

      return profit;
    } catch (error: any) {
      console.warn(`[Simulation] Reverted: ${error.reason || error.message}`);
      return -1n;
    }
  }

  /** Execute on-chain after simulation. Returns null in dry-run or on any guard failure. */
  async execute(opportunity: ArbOpportunity): Promise<ethers.TransactionReceipt | null> {
    if (!this.wallet) {
      console.log("[Dry-run] PRIVATE_KEY not set — skipping tx submission");
      return null;
    }

    const [feeData, block] = await Promise.all([this.provider.getFeeData(), this.provider.getBlock("latest")]);

    if (feeData.gasPrice && feeData.gasPrice > ethers.parseUnits(String(this.config.maxGasPriceGwei), "gwei")) {
      console.log(`[Execute] Gas price too high: ${ethers.formatUnits(feeData.gasPrice, "gwei")} gwei`);
      return null;
    }
    if (feeData.maxPriorityFeePerGas == null || block?.baseFeePerGas == null) {
      console.log("[Execute] No EIP-1559 fee data from RPC, skipping");
      return null;
    }
    const quoteBlock = block.number;
    const baseFee = block.baseFeePerGas;

    const simulatedProfit = await this.simulate(opportunity);
    if (simulatedProfit <= 0n) {
      console.log("[Execute] Simulation shows no profit, skipping");
      return null;
    }

    const minProfitFormatted = ethers.formatUnits(opportunity.minProfit, opportunity.underlying.decimals);
    const profitFormatted = ethers.formatUnits(simulatedProfit, opportunity.underlying.decimals);
    if (simulatedProfit < opportunity.minProfit) {
      console.log(`[Execute] Profit ${profitFormatted} < min ${minProfitFormatted}, skipping`);
      return null;
    }

    const method = opportunity.direction === ArbDirection.MINT_AND_SELL ? "mintAndSell" : "buyAndRedeem";

    try {
      const populate = (minProfit: bigint) =>
        this.arbContract[method].populateTransaction(
          opportunity.underlying.address,
          opportunity.flashAmount,
          this.formatSwapParams(opportunity.swapParams),
          minProfit,
        );
      // Unlike simulate(), this carries the real minProfit_ — so a revert here is
      // the same revert the submitted tx would hit, and we never sign it.
      const estimateGas = (data: string) =>
        this.provider.estimateGas({to: this.config.arbitrageAddress, data, from: this.wallet!.address});

      let populated = await populate(opportunity.minProfit);
      const firstEstimate = await estimateGas(populated.data);

      const fee = await this.priorityFee(
        opportunity,
        simulatedProfit,
        firstEstimate,
        baseFee,
        feeData.maxPriorityFeePerGas,
      );
      if (fee === null) return null;
      const {ethPrice} = fee;
      let {tip} = fee;

      // The tip is sized from the simulated profit. If the edge gets smaller before
      // inclusion, the tx must revert (Protect then drops it, no gas spent) and not
      // succeed at a net loss. Thus the on-chain floor also includes the gas cost.
      const minProfit = this.profitFloor(
        opportunity.minProfit,
        simulatedProfit,
        (baseFee + tip) * firstEstimate,
        ethPrice,
      );
      let estimate = firstEstimate;
      if (minProfit !== opportunity.minProfit) {
        populated = await populate(minProfit);
        estimate = await estimateGas(populated.data);
      }
      const gasLimit = (estimate * GAS_LIMIT_BUFFER_PCT) / 100n;

      // "pending": do not use the nonce of a tx that is still waiting.
      const [balance, nonce] = await Promise.all([
        this.provider.getBalance(this.wallet.address),
        this.provider.getTransactionCount(this.wallet.address, "pending"),
      ]);

      // The node rejects a tx when balance < gasLimit × maxFeePerGas. Reduce the
      // tip so that the tx is accepted: a smaller tip costs less, so the gas check
      // and the minProfit_ floor stay valid.
      const maxTip = balance / gasLimit - baseFee * 2n;
      if (maxTip <= 0n) {
        console.error(
          `[Execute] Balance ${ethers.formatEther(balance)} ETH does not cover gasLimit ${gasLimit} × ` +
            `2 × baseFee ${ethers.formatUnits(baseFee, "gwei")} gwei, skipping. Add ETH to ${this.wallet.address}`,
        );
        return null;
      }
      if (tip > maxTip) {
        console.warn(
          `[Execute] Tip ${ethers.formatUnits(tip, "gwei")} gwei is more than the balance ` +
            `${ethers.formatEther(balance)} ETH allows, using ${ethers.formatUnits(maxTip, "gwei")} gwei`,
        );
        tip = maxTip;
      }

      const raw = await this.wallet.signTransaction({
        to: populated.to,
        data: populated.data,
        value: 0n,
        gasLimit,
        maxFeePerGas: baseFee * 2n + tip,
        maxPriorityFeePerGas: tip,
        nonce,
        chainId: this.config.chainId,
        type: 2,
      });

      const hash: string = await this.sendProvider.send("eth_sendRawTransaction", [raw]);
      console.log(
        `[Execute] Tx submitted: ${hash} | simulated at block ${quoteBlock} | ` +
          `baseFee ${ethers.formatUnits(baseFee, "gwei")} gwei | tip ${ethers.formatUnits(tip, "gwei")} gwei | gasLimit ${gasLimit} | ` +
          `minProfit ${ethers.formatUnits(minProfit, opportunity.underlying.decimals)} ${opportunity.underlying.symbol}`,
      );

      const receipt = await this.waitForInclusion(hash);
      if (!receipt) return null;

      // getTransactionReceipt does not throw on a revert (tx.wait() did).
      if (receipt.status !== 1) {
        console.error(`[Execute] ${hash} reverted in block ${receipt.blockNumber}, gas used: ${receipt.gasUsed}`);
        return null;
      }

      console.log(
        `[Execute] Tx confirmed in block ${receipt.blockNumber} ` +
          `(simulated at ${quoteBlock}, delta ${receipt.blockNumber - quoteBlock}), gas used: ${receipt.gasUsed}`,
      );
      return receipt;
    } catch (error: any) {
      console.error(`[Execute] Failed: ${error.reason || error.message}`);
      return null;
    }
  }

  /**
   * Priority fee per gas: `tipShareBps` of the profit left after minProfit and
   * the base fee. The RPC's suggested tip (~0.0003 gwei in the 2026-10-29 depeg)
   * pays builders nothing, so with full blocks the tx never got in.
   *
   * Returns null when the profit does not pay for the gas. Without a price feed
   * there is no ETH price to compare against, so this falls back to `rpcTip`
   * and `ethPrice` is null.
   */
  private async priorityFee(
    opportunity: ArbOpportunity,
    simulatedProfit: bigint,
    gasEstimate: bigint,
    baseFee: bigint,
    rpcTip: bigint,
  ): Promise<{tip: bigint; ethPrice: bigint | null} | null> {
    if (!this.priceFeed) return {tip: rpcTip, ethPrice: null};

    const ethPrice = await this.ethPriceInUnderlying(opportunity.underlying.decimals);
    const toWei = (amount: bigint) => (amount * 10n ** 18n) / ethPrice;

    const budgetWei = toWei(simulatedProfit) - toWei(opportunity.minProfit);
    const surplusWei = budgetWei - baseFee * gasEstimate;
    const shareTip = surplusWei > 0n ? (surplusWei * BigInt(this.config.tipShareBps)) / 10000n / gasEstimate : 0n;
    const tip = shareTip > rpcTip ? shareTip : rpcTip;

    // Check with the final tip: the rpcTip floor can cost more than the share.
    if (surplusWei <= 0n || (baseFee + tip) * gasEstimate > budgetWei) {
      const {decimals, symbol} = opportunity.underlying;
      const gasCost = ((baseFee + tip) * gasEstimate * ethPrice) / 10n ** 18n;
      console.log(
        `[Execute] Profit ${ethers.formatUnits(simulatedProfit, decimals)} ${symbol} does not cover ` +
          `gas ${ethers.formatUnits(gasCost, decimals)} ${symbol} + min ${ethers.formatUnits(opportunity.minProfit, decimals)}, skipping`,
      );
      return null;
    }

    return {tip, ethPrice};
  }

  /**
   * On-chain minProfit_: `minProfit` plus the gas cost in the underlying,
   * rounded up. Capped at `simulatedProfit`, which priorityFee() makes sure
   * covers both. Without an ETH price (no feed) this is `minProfit` only.
   */
  private profitFloor(minProfit: bigint, simulatedProfit: bigint, gasCostWei: bigint, ethPrice: bigint | null): bigint {
    if (ethPrice === null) return minProfit;
    const gasCost = (gasCostWei * ethPrice + 10n ** 18n - 1n) / 10n ** 18n;
    const floor = minProfit + gasCost;
    return floor < simulatedProfit ? floor : simulatedProfit;
  }

  /** 1 ETH in underlying raw units, from the Chainlink feed. The feed is assumed to be up to date. */
  private async ethPriceInUnderlying(underlyingDecimals: number): Promise<bigint> {
    this.priceFeedDecimals ??= BigInt(await this.priceFeed!.decimals());
    const [, answer] = await this.priceFeed!.latestRoundData();
    if (answer <= 0n) throw new Error(`Bad ETH price from feed: ${answer}`);
    return (answer * 10n ** BigInt(underlyingDecimals)) / 10n ** this.priceFeedDecimals;
  }

  /**
   * Ask the Flashbots Protect status API until the tx is final. Protect stops
   * trying after `blockRange` blocks (from SEND_RPC_URL) and then reports
   * FAILED. A tx that would revert is never included, so FAILED is the usual
   * result of a lost race, and it costs no gas.
   *
   * `inclusionTimeoutMs` (2 × blockRange) is only a safety cap, so that a status API that does
   * not answer cannot block the keeper loop.
   */
  private async waitForInclusion(hash: string): Promise<ethers.TransactionReceipt | null> {
    const deadline = Date.now() + this.inclusionTimeoutMs;

    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.config.protectStatusUrl}${hash}`, {
          signal: AbortSignal.timeout(STATUS_FETCH_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const {status} = (await res.json()) as {status: string};

        if (status === "INCLUDED") {
          // The read RPC can be a moment behind Protect. Poll again until it has the receipt.
          const receipt = await this.provider.getTransactionReceipt(hash);
          if (receipt) return receipt;
        } else if (status === "FAILED" || status === "CANCELLED") {
          console.log(`[Execute] ${hash} not included (${status}) — dropped, no gas spent`);
          return null;
        }
        // PENDING, or UNKNOWN just after the send: poll again.
      } catch (error: any) {
        console.warn(`[Execute] Status poll failed, retrying: ${error.shortMessage || error.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_MS));
    }

    console.log(`[Execute] ${hash} has no final status after ${this.inclusionTimeoutMs} ms`);
    return null;
  }

  private formatSwapParams(params: SwapParams) {
    return {
      target: params.target,
      approveTarget: params.approveTarget,
      swapCalldata: params.swapCalldata,
      minAmountOut: params.minAmountOut,
    };
  }
}
