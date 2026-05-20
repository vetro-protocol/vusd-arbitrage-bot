import {ethers} from "ethers";
import {Config} from "./config";
import {ArbDirection, ArbOpportunity, SwapParams} from "./types";

/** ABI matches the new VetroArbitrage contract. Param names don't affect selector, so this also works against old VUSDArbitrage deployments. */
const ARB_ABI = [
  "function mintAndSell(address underlying_, uint256 flashAmount_, tuple(address target, address approveTarget, bytes swapCalldata, uint256 minAmountOut) swapParams_, uint256 minProfit_) returns (int256)",
  "function buyAndRedeem(address underlying_, uint256 flashAmount_, tuple(address target, address approveTarget, bytes swapCalldata, uint256 minAmountOut) swapParams_, uint256 minProfit_) returns (int256)",
];

export class Executor {
  private arbContract: ethers.Contract;
  private wallet: ethers.Wallet | null;
  private provider: ethers.Provider;

  constructor(
    provider: ethers.Provider,
    private config: Config,
    privateKey?: string,
  ) {
    this.provider = provider;
    this.wallet = privateKey ? new ethers.Wallet(privateKey, provider) : null;
    this.arbContract = new ethers.Contract(config.arbitrageAddress, ARB_ABI, this.wallet ?? provider);
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

    const feeData = await this.provider.getFeeData();
    if (feeData.gasPrice && feeData.gasPrice > ethers.parseUnits(String(this.config.maxGasPriceGwei), "gwei")) {
      console.log(`[Execute] Gas price too high: ${ethers.formatUnits(feeData.gasPrice, "gwei")} gwei`);
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

    const swapTuple = this.formatSwapParams(opportunity.swapParams);

    try {
      let tx: ethers.TransactionResponse;
      if (opportunity.direction === ArbDirection.MINT_AND_SELL) {
        tx = await this.arbContract.mintAndSell(
          opportunity.underlying.address,
          opportunity.flashAmount,
          swapTuple,
          opportunity.minProfit,
        );
      } else {
        tx = await this.arbContract.buyAndRedeem(
          opportunity.underlying.address,
          opportunity.flashAmount,
          swapTuple,
          opportunity.minProfit,
        );
      }

      console.log(`[Execute] Tx submitted: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`[Execute] Tx confirmed in block ${receipt!.blockNumber}, gas used: ${receipt!.gasUsed}`);
      return receipt;
    } catch (error: any) {
      console.error(`[Execute] Failed: ${error.reason || error.message}`);
      return null;
    }
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
