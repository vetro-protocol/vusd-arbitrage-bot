import {
  FlashLoanProvider,
  StablecoinConfig,
  FlashLoanProviderConfig,
  CurvePoolConfig,
  CurveRouterRouteConfig,
  CurveRouterHop,
} from "./types";
import * as C from "./constants";

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

  // Curve Router (multi-hop via crvUSD)
  curveRouterAddress: string;
  crvusdAddress: string;
  curveRouterRoutes: Record<string, CurveRouterRouteConfig>;

  // Per-source enable/disable flags
  enableOneInch: boolean;
  enableZeroX: boolean;
  enableLifi: boolean;
  enableUniswapV3: boolean;
  enableCurve: boolean;
  enableCurveRouter: boolean;

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
  const requiredEnvVars = ["ETHEREUM_RPC_URL", "PRIVATE_KEY"];

  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      throw new Error(`Missing required environment variable: ${envVar}`);
    }
  }

  return {
    rpcUrl: process.env.ETHEREUM_RPC_URL!,
    chainId: 1,

    vusdArbitrageAddress: C.VUSD_ARBITRAGE_ADDRESS,
    gatewayAddress: C.GATEWAY_ADDRESS,
    vusdAddress: C.VUSD_ADDRESS,

    stablecoins: [
      {address: C.USDC_ADDRESS, symbol: "USDC", decimals: 6},
      {address: C.USDT_ADDRESS, symbol: "USDT", decimals: 6},
    ],

    flashLoanProviders: buildProviderList(),

    oneInchApiKey: process.env.ONEINCH_API_KEY,
    zeroXApiKey: process.env.ZEROX_API_KEY,
    lifiEnabled: process.env.LIFI_ENABLED === "true",

    uniswapV3QuoterAddress: C.UNISWAP_V3_QUOTER,
    uniswapV3RouterAddress: C.UNISWAP_V3_ROUTER,
    curvePoolConfigs: parseCurvePoolConfigs(),

    curveRouterAddress: C.CURVE_ROUTER_ADDRESS,
    crvusdAddress: C.CRVUSD_ADDRESS,
    curveRouterRoutes: parseCurveRouterRoutes(),

    enableOneInch: process.env.ENABLE_ONEINCH !== "false",
    enableZeroX: process.env.ENABLE_ZEROX !== "false",
    enableLifi: process.env.ENABLE_LIFI !== "false",
    enableUniswapV3: process.env.ENABLE_UNISWAP_V3 !== "false",
    enableCurve: process.env.ENABLE_CURVE !== "false",
    enableCurveRouter: process.env.ENABLE_CURVE_ROUTER !== "false",

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
  providers.push({
    provider: FlashLoanProvider.MORPHO,
    address: C.MORPHO_ADDRESS,
    feeBps: 0,
  });

  // Balancer — 0 fee (optional, only if address provided)
  if (process.env.BALANCER_VAULT) {
    providers.push({
      provider: FlashLoanProvider.BALANCER,
      address: process.env.BALANCER_VAULT,
      feeBps: 0,
    });
  }

  // Aave V3 — ~5 bps fee
  providers.push({
    provider: FlashLoanProvider.AAVE_V3,
    address: C.AAVE_V3_POOL,
    feeBps: 5,
  });

  return providers;
}

/**
 * Parse Curve pool configs from env vars.
 * Format: CURVE_POOL_USDC=poolAddress:vusdIndex:stablecoinIndex
 */
function parseCurvePoolConfigs(): Record<string, CurvePoolConfig> {
  const configs: Record<string, CurvePoolConfig> = {};

  const curveUsdc = process.env.CURVE_POOL_USDC;
  if (curveUsdc) {
    const [poolAddress, vusdIdx, stableIdx] = curveUsdc.split(":");
    configs[C.USDC_ADDRESS.toLowerCase()] = {
      poolAddress,
      vusdIndex: parseInt(vusdIdx),
      stablecoinIndex: parseInt(stableIdx),
    };
  }

  const curveUsdt = process.env.CURVE_POOL_USDT;
  if (curveUsdt) {
    const [poolAddress, vusdIdx, stableIdx] = curveUsdt.split(":");
    configs[C.USDT_ADDRESS.toLowerCase()] = {
      poolAddress,
      vusdIndex: parseInt(vusdIdx),
      stablecoinIndex: parseInt(stableIdx),
    };
  }

  return configs;
}

/**
 * Parse a single hop from "pool:i:j:swapType:poolType:nCoins" format.
 */
function parseHop(raw: string): CurveRouterHop {
  const [pool, i, j, swapType, poolType, nCoins] = raw.split(":");
  return {
    pool,
    i: parseInt(i),
    j: parseInt(j),
    swapType: parseInt(swapType),
    poolType: parseInt(poolType),
    nCoins: parseInt(nCoins),
  };
}

/**
 * Parse Curve Router multi-hop route configs from env vars.
 * Format: CURVE_ROUTER_ROUTE_USDC=hop1|hop2
 * Each hop: pool:i:j:swapType:poolType:nCoins
 * Hops define BUY direction (stablecoin → crvUSD → VUSD).
 */
function parseCurveRouterRoutes(): Record<string, CurveRouterRouteConfig> {
  const configs: Record<string, CurveRouterRouteConfig> = {};

  const routeUsdc = process.env.CURVE_ROUTER_ROUTE_USDC;
  if (routeUsdc) {
    const [hop1Raw, hop2Raw] = routeUsdc.split("|");
    configs[C.USDC_ADDRESS.toLowerCase()] = {
      hops: [parseHop(hop1Raw), parseHop(hop2Raw)],
      intermediateToken: C.CRVUSD_ADDRESS,
    };
  }

  const routeUsdt = process.env.CURVE_ROUTER_ROUTE_USDT;
  if (routeUsdt) {
    const [hop1Raw, hop2Raw] = routeUsdt.split("|");
    configs[C.USDT_ADDRESS.toLowerCase()] = {
      hops: [parseHop(hop1Raw), parseHop(hop2Raw)],
      intermediateToken: C.CRVUSD_ADDRESS,
    };
  }

  return configs;
}
