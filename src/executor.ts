import {ethers} from "ethers";
import {Config} from "./config";
import {ArbDirection, ArbOpportunity, SwapParams} from "./types";

/** ABI matches the new VetroArbitrage contract. Param names don't affect selector, so this also works against old VUSDArbitrage deployments. */
const ARB_ABI = [
  "function mintAndSell(address underlying_, uint256 flashAmount_, tuple(address target, address approveTarget, bytes swapCalldata, uint256 minAmountOut) swapParams_, uint256 minProfit_) returns (int256)",
  "function buyAndRedeem(address underlying_, uint256 flashAmount_, tuple(address target, address approveTarget, bytes swapCalldata, uint256 minAmountOut) swapParams_, uint256 minProfit_) returns (int256)",
];

/** Headroom over eth_estimateGas. The estimate has none, which cost us out-of-gas reverts. */
const GAS_LIMIT_BUFFER_PCT = 125n;

export class Executor {
  private arbContract: ethers.Contract;
  private wallet: ethers.Wallet | null;
  private provider: ethers.Provider;
  /** Send-only (Flashbots Protect). Reads and simulation never go through this. */
  private sendProvider: ethers.JsonRpcProvider;

  constructor(
    provider: ethers.Provider,
    private config: Config,
    privateKey?: string,
  ) {
    this.provider = provider;
    this.wallet = privateKey ? new ethers.Wallet(privateKey, provider) : null;
    this.arbContract = new ethers.Contract(config.arbitrageAddress, ARB_ABI, this.wallet ?? provider);
    this.sendProvider = new ethers.JsonRpcProvider(config.sendRpcUrl);
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

    // blockNumber is only for the inclusion-delay diagnostic below.
    const [feeData, quoteBlock] = await Promise.all([
      this.provider.getFeeData(),
      this.provider.getBlockNumber(),
    ]);

    if (feeData.gasPrice && feeData.gasPrice > ethers.parseUnits(String(this.config.maxGasPriceGwei), "gwei")) {
      console.log(`[Execute] Gas price too high: ${ethers.formatUnits(feeData.gasPrice, "gwei")} gwei`);
      return null;
    }
    if (feeData.maxFeePerGas == null || feeData.maxPriorityFeePerGas == null) {
      console.log("[Execute] No EIP-1559 fee data from RPC, skipping");
      return null;
    }

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
      const populated = await this.arbContract[method].populateTransaction(
        opportunity.underlying.address,
        opportunity.flashAmount,
        this.formatSwapParams(opportunity.swapParams),
        opportunity.minProfit,
      );

      // Unlike simulate(), this carries the real minProfit_ — so a revert here is
      // the same revert the submitted tx would hit, and we never sign it.
      const estimate = await this.provider.estimateGas({
        to: populated.to,
        data: populated.data,
        from: this.wallet.address,
      });
      const gasLimit = (estimate * GAS_LIMIT_BUFFER_PCT) / 100n;

      const raw = await this.wallet.signTransaction({
        to: populated.to,
        data: populated.data,
        value: 0n,
        gasLimit,
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
        nonce: await this.provider.getTransactionCount(this.wallet.address),
        chainId: this.config.chainId,
        type: 2,
      });

      const hash: string = await this.sendProvider.send("eth_sendRawTransaction", [raw]);
      console.log(
        `[Execute] Tx submitted: ${hash} | simulated at block ${quoteBlock} | ` +
          `tip ${ethers.formatUnits(feeData.maxPriorityFeePerGas, "gwei")} gwei | gasLimit ${gasLimit}`,
      );

      const receipt = await this.waitForInclusion(hash);
      if (!receipt) {
        console.log(
          `[Execute] ${hash} not included within ${this.config.inclusionTimeoutMs}ms — dropped, no gas spent`,
        );
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
   * Poll for a receipt until `inclusionTimeoutMs`, then give up.
   *
   * Under Flashbots Protect a transaction that would revert is simply never
   * included, so missing is the common case and must resolve as "no receipt".
   * Polling rather than `waitForTransaction`: that rejects on timeout instead of
   * returning null, and only re-checks on a "block" event, which never arrives
   * on a chain that has gone quiet. Either way an unbounded wait would block the
   * keeper loop forever.
   */
  private async waitForInclusion(hash: string): Promise<ethers.TransactionReceipt | null> {
    const deadline = Date.now() + this.config.inclusionTimeoutMs;

    while (Date.now() < deadline) {
      const receipt = await this.provider.getTransactionReceipt(hash);
      if (receipt) return receipt;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }

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
