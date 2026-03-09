import {
  FlashLoanProvider,
  StablecoinConfig,
  FlashLoanProviderConfig,
  CurvePoolConfig,
} from "./types";

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

  // DEX aggregator API keys (optional — each enables an aggregator)
  oneInchApiKey?: string;
  zeroXApiKey?: string;
  lifiEnabled: boolean;

  // On-chain quoters
  uniswapV3QuoterAddress: string;
  uniswapV3RouterAddress: string;
  curvePoolConfigs: Record<string, CurvePoolConfig>;

  // Per-source enable/disable flags
  enableOneInch: boolean;
  enableZeroX: boolean;
  enableLifi: boolean;
  enableUniswapV3: boolean;
  enableCurve: boolean;

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
        address:
          process.env.USDC_ADDRESS ||
          "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        symbol: "USDC",
        decimals: 6,
      },
      {
        address:
          process.env.USDT_ADDRESS ||
          "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        symbol: "USDT",
        decimals: 6,
      },
    ],

    flashLoanProviders: buildProviderList(),

    oneInchApiKey: process.env.ONEINCH_API_KEY,
    zeroXApiKey: process.env.ZEROX_API_KEY,
    lifiEnabled: process.env.LIFI_ENABLED === "true",

    uniswapV3QuoterAddress:
      process.env.UNISWAP_V3_QUOTER ||
      "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    uniswapV3RouterAddress:
      process.env.UNISWAP_V3_ROUTER ||
      "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    curvePoolConfigs: parseCurvePoolConfigs(),

    enableOneInch: process.env.ENABLE_ONEINCH !== "false",
    enableZeroX: process.env.ENABLE_ZEROX !== "false",
    enableLifi: process.env.ENABLE_LIFI !== "false",
    enableUniswapV3: process.env.ENABLE_UNISWAP_V3 !== "false",
    enableCurve: process.env.ENABLE_CURVE !== "false",

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

/**
 * Parse Curve pool configs from env vars.
 * Format: CURVE_POOL_USDC=poolAddress:vusdIndex:stablecoinIndex
 */
function parseCurvePoolConfigs(): Record<string, CurvePoolConfig> {
  const configs: Record<string, CurvePoolConfig> = {};

  const usdcAddress = (
    process.env.USDC_ADDRESS || "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
  ).toLowerCase();
  const usdtAddress = (
    process.env.USDT_ADDRESS || "0xdAC17F958D2ee523a2206206994597C13D831ec7"
  ).toLowerCase();

  const curveUsdc = process.env.CURVE_POOL_USDC;
  if (curveUsdc) {
    const [poolAddress, vusdIdx, stableIdx] = curveUsdc.split(":");
    configs[usdcAddress] = {
      poolAddress,
      vusdIndex: parseInt(vusdIdx),
      stablecoinIndex: parseInt(stableIdx),
    };
  }

  const curveUsdt = process.env.CURVE_POOL_USDT;
  if (curveUsdt) {
    const [poolAddress, vusdIdx, stableIdx] = curveUsdt.split(":");
    configs[usdtAddress] = {
      poolAddress,
      vusdIndex: parseInt(vusdIdx),
      stablecoinIndex: parseInt(stableIdx),
    };
  }

  return configs;
}
