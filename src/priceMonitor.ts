import { ethers } from "ethers";
import { Config } from "./config";
import { PriceData, StablecoinConfig } from "./types";

const GATEWAY_ABI = [
  "function previewDeposit(address tokenIn_, uint256 amountIn_) view returns (uint256)",
  "function previewRedeem(address tokenOut_, uint256 peggedTokenIn_) view returns (uint256)",
  "function mintFee(address token_) view returns (uint256)",
  "function redeemFee(address token_) view returns (uint256)",
  "function maxMint() view returns (uint256)",
  "function maxWithdraw(address tokenOut_) view returns (uint256)",
];

export class PriceMonitor {
  private gateway: ethers.Contract;

  constructor(
    private provider: ethers.Provider,
    private config: Config
  ) {
    this.gateway = new ethers.Contract(config.gatewayAddress, GATEWAY_ABI, provider);
  }

  async getPriceData(stablecoin: StablecoinConfig): Promise<PriceData> {
    // Use a meaningful test amount for price discovery
    const testAmount = ethers.parseUnits("10000", stablecoin.decimals);
    const testVusdAmount = ethers.parseUnits("10000", 18);

    const [gatewayMintOutput, gatewayRedeemOutput, mintFeeBps, redeemFeeBps, vusdDexPrice] =
      await Promise.all([
        this.gateway.previewDeposit(stablecoin.address, testAmount) as Promise<bigint>,
        this.gateway.previewRedeem(stablecoin.address, testVusdAmount) as Promise<bigint>,
        this.gateway.mintFee(stablecoin.address) as Promise<bigint>,
        this.gateway.redeemFee(stablecoin.address) as Promise<bigint>,
        this.fetchDexPrice(stablecoin),
      ]);

    return {
      vusdDexPrice,
      gatewayMintOutput,
      gatewayRedeemOutput,
      mintFeeBps: Number(mintFeeBps),
      redeemFeeBps: Number(redeemFeeBps),
      stablecoin,
    };
  }

  /** Check capacity limits on the Gateway */
  async getCapacity(stablecoin: StablecoinConfig): Promise<{ maxMint: bigint; maxWithdraw: bigint }> {
    const [maxMint, maxWithdraw] = await Promise.all([
      this.gateway.maxMint() as Promise<bigint>,
      this.gateway.maxWithdraw(stablecoin.address) as Promise<bigint>,
    ]);
    return { maxMint, maxWithdraw };
  }

  /**
   * Fetch VUSD price on DEX via aggregator quote API
   * Returns price in stablecoin terms (e.g., 0.98 means 1 VUSD = 0.98 USDC)
   */
  private async fetchDexPrice(stablecoin: StablecoinConfig): Promise<number> {
    const vusdAmount = ethers.parseUnits("1000", 18); // quote for 1000 VUSD

    try {
      // Paraswap /prices endpoint
      const url = new URL(`${this.config.aggregatorApiUrl}/prices`);
      url.searchParams.set("srcToken", this.config.vusdAddress);
      url.searchParams.set("destToken", stablecoin.address);
      url.searchParams.set("amount", vusdAmount.toString());
      url.searchParams.set("srcDecimals", "18");
      url.searchParams.set("destDecimals", stablecoin.decimals.toString());
      url.searchParams.set("network", this.config.chainId.toString());

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.config.aggregatorApiKey) {
        headers["X-API-KEY"] = this.config.aggregatorApiKey;
      }

      const response = await fetch(url.toString(), { headers });

      if (!response.ok) {
        console.warn(`DEX price fetch failed for ${stablecoin.symbol}: ${response.status}`);
        return 1.0; // Default to peg if API fails
      }

      const data = await response.json();
      const destAmount = BigInt(data.priceRoute.destAmount);

      // Price = destAmount / srcAmount (normalized to decimals)
      // e.g., 980_000000 USDC for 1000_000000000000000000 VUSD = 0.98
      const price =
        Number(destAmount) /
        10 ** stablecoin.decimals /
        (Number(vusdAmount) / 10 ** 18);

      return price;
    } catch (error) {
      console.error(`Error fetching DEX price for ${stablecoin.symbol}:`, error);
      return 1.0;
    }
  }
}
