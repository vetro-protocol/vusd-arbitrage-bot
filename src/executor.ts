import {ethers} from "ethers";
import {Config} from "./config";
import {
  ArbDirection,
  ArbOpportunity,
  FlashLoanProvider,
  SwapParams,
} from "./types";

const ARB_ABI = [
  "function mintAndSell(uint8 provider_, address stablecoin_, uint256 flashAmount_, tuple(address target, address approveTarget, bytes swapCalldata, uint256 minAmountOut) swapParams_, uint256 minProfit_) returns (int256)",
  "function buyAndRedeem(uint8 provider_, address stablecoin_, uint256 flashAmount_, tuple(address target, address approveTarget, bytes swapCalldata, uint256 minAmountOut) swapParams_, uint256 minProfit_) returns (int256)",
];

export class Executor {
  private arbContract: ethers.Contract;
  private wallet: ethers.Wallet;

  constructor(
    provider: ethers.Provider,
    private config: Config,
  ) {
    this.wallet = new ethers.Wallet(config.privateKey, provider);
    this.arbContract = new ethers.Contract(
      config.vusdArbitrageAddress,
      ARB_ABI,
      this.wallet,
    );
  }

  /**
   * Simulate an arb opportunity via staticCall.
   * Returns the int256 profit without spending gas.
   */
  async simulate(opportunity: ArbOpportunity): Promise<bigint> {
    const swapTuple = this.formatSwapParams(opportunity.swapParams);

    try {
      let profit: bigint;
      if (opportunity.direction === ArbDirection.MINT_AND_SELL) {
        profit = await this.arbContract.mintAndSell.staticCall(
          opportunity.provider,
          opportunity.stablecoin.address,
          opportunity.flashAmount,
          swapTuple,
          0n, // minProfit = 0 for simulation
        );
      } else {
        profit = await this.arbContract.buyAndRedeem.staticCall(
          opportunity.provider,
          opportunity.stablecoin.address,
          opportunity.flashAmount,
          swapTuple,
          0n,
        );
      }

      console.log(
        `[Simulation] ${ArbDirection[opportunity.direction]} ${opportunity.stablecoin.symbol}: ` +
          `profit = ${ethers.formatUnits(profit, opportunity.stablecoin.decimals)} ${opportunity.stablecoin.symbol}`,
      );

      return profit;
    } catch (error: any) {
      console.warn(`[Simulation] Reverted: ${error.reason || error.message}`);
      return -1n;
    }
  }

  /**
   * Execute an arb opportunity on-chain after simulation.
   */
  async execute(
    opportunity: ArbOpportunity,
  ): Promise<ethers.TransactionReceipt | null> {
    // Check gas price
    const feeData = await this.wallet.provider!.getFeeData();
    if (
      feeData.gasPrice &&
      feeData.gasPrice >
        ethers.parseUnits(String(this.config.maxGasPriceGwei), "gwei")
    ) {
      console.log(
        `[Execute] Gas price too high: ${ethers.formatUnits(feeData.gasPrice, "gwei")} gwei`,
      );
      return null;
    }

    // Simulate first
    const simulatedProfit = await this.simulate(opportunity);
    if (simulatedProfit <= 0n) {
      console.log("[Execute] Simulation shows no profit, skipping");
      return null;
    }

    // Check simulated profit meets minimum
    const minProfitFormatted = ethers.formatUnits(
      opportunity.minProfit,
      opportunity.stablecoin.decimals,
    );
    const profitFormatted = ethers.formatUnits(
      simulatedProfit,
      opportunity.stablecoin.decimals,
    );
    if (simulatedProfit < opportunity.minProfit) {
      console.log(
        `[Execute] Profit ${profitFormatted} < min ${minProfitFormatted}, skipping`,
      );
      return null;
    }

    const swapTuple = this.formatSwapParams(opportunity.swapParams);

    try {
      let tx: ethers.TransactionResponse;

      if (opportunity.direction === ArbDirection.MINT_AND_SELL) {
        tx = await this.arbContract.mintAndSell(
          opportunity.provider,
          opportunity.stablecoin.address,
          opportunity.flashAmount,
          swapTuple,
          opportunity.minProfit,
        );
      } else {
        tx = await this.arbContract.buyAndRedeem(
          opportunity.provider,
          opportunity.stablecoin.address,
          opportunity.flashAmount,
          swapTuple,
          opportunity.minProfit,
        );
      }

      console.log(`[Execute] Tx submitted: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(
        `[Execute] Tx confirmed in block ${receipt!.blockNumber}, gas used: ${receipt!.gasUsed}`,
      );
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
