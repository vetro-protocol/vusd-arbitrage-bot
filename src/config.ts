import { FlashLoanProvider, StablecoinConfig, FlashLoanProviderConfig } from "./types";

export interface Config {
  rpcUrl: string;
  chainId: number;

  // Contract addresses
  vusdArbitrageAddress: string;
  gatewayAddress: string;
  vusdAddress: string;

  // Stablecoins to monitor
  stablecoins: StablecoinConfig[];

  // Flash loan providers (sorted by fee ascending — Morpho/Balancer first)
  flashLoanProviders: FlashLoanProviderConfig[];

  // DEX aggregator
  aggregatorApiUrl: string;
  aggregatorApiKey?: string;

  // Thresholds
  minProfitUsd: number;
  maxFlashAmount: bigint;
  pollIntervalMs: number;
  maxGasPriceGwei: number;
  slippageBps: number;

  // Keeper wallet
  privateKey: string;
}

export function loadConfig(): Config {
  const requiredEnvVars = [
    "ETHEREUM_RPC_URL",
    "PRIVATE_KEY",
    "VUSD_ARBITRAGE_ADDRESS",
    "GATEWAY_ADDRESS",
    "VUSD_ADDRESS",
  ];

  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      throw new Error(`Missing required environment variable: ${envVar}`);
    }
  }

  return {
    rpcUrl: process.env.ETHEREUM_RPC_URL!,
    chainId: parseInt(process.env.CHAIN_ID || "1"),

    vusdArbitrageAddress: process.env.VUSD_ARBITRAGE_ADDRESS!,
    gatewayAddress: process.env.GATEWAY_ADDRESS!,
    vusdAddress: process.env.VUSD_ADDRESS!,

    stablecoins: [
      {
        address: process.env.USDC_ADDRESS || "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        symbol: "USDC",
        decimals: 6,
      },
      {
        address: process.env.USDT_ADDRESS || "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        symbol: "USDT",
        decimals: 6,
      },
    ],

    flashLoanProviders: buildProviderList(),

    aggregatorApiUrl: process.env.AGGREGATOR_API_URL || "https://api.paraswap.io",
    aggregatorApiKey: process.env.AGGREGATOR_API_KEY,

    minProfitUsd: parseFloat(process.env.MIN_PROFIT_USD || "5"),
    maxFlashAmount: BigInt(process.env.MAX_FLASH_AMOUNT || "1000000000000"), // 1M USDC default
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "5000"),
    maxGasPriceGwei: parseInt(process.env.MAX_GAS_PRICE_GWEI || "50"),
    slippageBps: parseInt(process.env.SLIPPAGE_BPS || "50"),

    privateKey: process.env.PRIVATE_KEY!,
  };
}

function buildProviderList(): FlashLoanProviderConfig[] {
  const providers: FlashLoanProviderConfig[] = [];

  // Morpho — 0 fee
  if (process.env.MORPHO_ADDRESS) {
    providers.push({
      provider: FlashLoanProvider.MORPHO,
      address: process.env.MORPHO_ADDRESS,
      feeBps: 0,
    });
  }

  // Balancer — 0 fee
  if (process.env.BALANCER_VAULT) {
    providers.push({
      provider: FlashLoanProvider.BALANCER,
      address: process.env.BALANCER_VAULT,
      feeBps: 0,
    });
  }

  // Aave V3 — ~5 bps fee
  if (process.env.AAVE_V3_POOL) {
    providers.push({
      provider: FlashLoanProvider.AAVE_V3,
      address: process.env.AAVE_V3_POOL,
      feeBps: 5,
    });
  }

  return providers;
}
