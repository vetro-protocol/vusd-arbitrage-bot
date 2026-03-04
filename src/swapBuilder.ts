import { ethers } from "ethers";
import { Config } from "./config";
import { SwapParams, StablecoinConfig } from "./types";

export class SwapBuilder {
  constructor(private config: Config) {}

  /**
   * Build SwapParams for selling VUSD for stablecoin (mintAndSell direction)
   * Calls aggregator API to get best route
   */
  async buildSellVusdSwap(
    vusdAmount: bigint,
    stablecoin: StablecoinConfig
  ): Promise<SwapParams> {
    return this.buildSwap(
      this.config.vusdAddress,
      18,
      stablecoin.address,
      stablecoin.decimals,
      vusdAmount
    );
  }

  /**
   * Build SwapParams for buying VUSD with stablecoin (buyAndRedeem direction)
   * Calls aggregator API to get best route
   */
  async buildBuyVusdSwap(
    stablecoinAmount: bigint,
    stablecoin: StablecoinConfig
  ): Promise<SwapParams> {
    return this.buildSwap(
      stablecoin.address,
      stablecoin.decimals,
      this.config.vusdAddress,
      18,
      stablecoinAmount
    );
  }

  private async buildSwap(
    srcToken: string,
    srcDecimals: number,
    destToken: string,
    destDecimals: number,
    amount: bigint
  ): Promise<SwapParams> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.aggregatorApiKey) {
      headers["X-API-KEY"] = this.config.aggregatorApiKey;
    }

    // Step 1: Get price quote
    const priceUrl = new URL(`${this.config.aggregatorApiUrl}/prices`);
    priceUrl.searchParams.set("srcToken", srcToken);
    priceUrl.searchParams.set("destToken", destToken);
    priceUrl.searchParams.set("amount", amount.toString());
    priceUrl.searchParams.set("srcDecimals", srcDecimals.toString());
    priceUrl.searchParams.set("destDecimals", destDecimals.toString());
    priceUrl.searchParams.set("network", this.config.chainId.toString());

    const priceResponse = await fetch(priceUrl.toString(), { headers });
    if (!priceResponse.ok) {
      throw new Error(`Price quote failed: ${priceResponse.status} ${await priceResponse.text()}`);
    }

    const priceData = await priceResponse.json();
    const expectedOutput = BigInt(priceData.priceRoute.destAmount);
    const minAmountOut =
      (expectedOutput * BigInt(10000 - this.config.slippageBps)) / 10000n;

    // Step 2: Get transaction calldata
    const txUrl = new URL(`${this.config.aggregatorApiUrl}/transactions/${this.config.chainId}`);

    const txBody = {
      srcToken,
      destToken,
      srcAmount: amount.toString(),
      destAmount: expectedOutput.toString(),
      priceRoute: priceData.priceRoute,
      userAddress: this.config.vusdArbitrageAddress,
      receiver: this.config.vusdArbitrageAddress,
      srcDecimals,
      destDecimals,
    };

    const txResponse = await fetch(txUrl.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify(txBody),
    });

    if (!txResponse.ok) {
      throw new Error(`Transaction build failed: ${txResponse.status} ${await txResponse.text()}`);
    }

    const txData = await txResponse.json();

    return {
      target: txData.to,
      approveTarget: priceData.priceRoute.tokenTransferProxy || txData.to,
      swapCalldata: txData.data,
      minAmountOut,
    };
  }
}
