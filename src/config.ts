import {ethers} from "ethers";
import {FlashAmountTier, StablecoinConfig, CurveRouterRouteConfig, CurveRouterHop} from "./types";
import * as Constants from "./constants";

export interface Config {
  rpcUrl: string;
  chainId: number;

  // Contract addresses
  vusdArbitrageAddress: string;
  gatewayAddress: string;
  vusdAddress: string;

  // Stablecoins to monitor
  stablecoins: StablecoinConfig[];

  // DEX aggregator API keys (optional — each enables an aggregator)
  oneInchApiKey?: string;
  zeroXApiKey?: string;
  lifiApiKey?: string;

  // Curve Router (multi-hop via crvUSD)
  curveRouterAddress: string;
  crvusdAddress: string;
  curveRouterRoutes: Record<string, CurveRouterRouteConfig>;

  // Per-source enable/disable flags
  enableOneInch: boolean;
  enableZeroX: boolean;
  enableLifi: boolean;
  enableCurveRouter: boolean;

  // Flash amount sizing — deviation tiers sorted descending
  flashAmountTiers: FlashAmountTier[];

  // Thresholds
  minProfitUsd: number;
  maxFlashAmount: bigint;
  pollIntervalMs: number;
  maxGasPriceGwei: number;
  slippageBps: number;
  estimatedGasCostUsd: number;

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

    vusdArbitrageAddress: process.env.VUSD_ARBITRAGE_ADDRESS || Constants.VUSD_ARBITRAGE_ADDRESS,
    gatewayAddress: Constants.GATEWAY_ADDRESS,
    vusdAddress: Constants.VUSD_ADDRESS,

    stablecoins: [
      {address: Constants.USDC_ADDRESS, symbol: "USDC", decimals: 6},
      {address: Constants.USDT_ADDRESS, symbol: "USDT", decimals: 6},
    ],

    oneInchApiKey: process.env.ONEINCH_API_KEY,
    zeroXApiKey: process.env.ZEROX_API_KEY,
    lifiApiKey: process.env.LIFI_API_KEY,

    curveRouterAddress: Constants.CURVE_ROUTER_ADDRESS,
    crvusdAddress: Constants.CRVUSD_ADDRESS,
    curveRouterRoutes: parseCurveRouterRoutes(),

    enableOneInch: process.env.ENABLE_ONEINCH !== "false",
    enableZeroX: process.env.ENABLE_ZEROX !== "false",
    enableLifi: process.env.ENABLE_LIFI !== "false",
    enableCurveRouter: process.env.ENABLE_CURVE_ROUTER !== "false",

    flashAmountTiers: parseFlashAmountTiers(),

    minProfitUsd: parseFloat(process.env.MIN_PROFIT_USD || "5"),
    maxFlashAmount: BigInt(process.env.MAX_FLASH_AMOUNT || "1000000000000"), // 1M USDC default
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "5000"),
    maxGasPriceGwei: parseInt(process.env.MAX_GAS_PRICE_GWEI || "50"),
    slippageBps: parseInt(process.env.SLIPPAGE_BPS || "50"),
    estimatedGasCostUsd: parseFloat(process.env.ESTIMATED_GAS_COST_USD || "5"),

    privateKey: process.env.PRIVATE_KEY!,
  };
}

/**
 * Parse a single hop from "pool:i:j:swapType:poolType:nCoins" format.
 */
function parseHop(raw: string): CurveRouterHop {
  const [pool, i, j, swapType, poolType, nCoins] = raw.split(":");
  return {
    pool: ethers.getAddress(pool),
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
    configs[Constants.USDC_ADDRESS.toLowerCase()] = {
      hops: [parseHop(hop1Raw), parseHop(hop2Raw)],
      intermediateToken: Constants.CRVUSD_ADDRESS,
    };
  }

  const routeUsdt = process.env.CURVE_ROUTER_ROUTE_USDT;
  if (routeUsdt) {
    const [hop1Raw, hop2Raw] = routeUsdt.split("|");
    configs[Constants.USDT_ADDRESS.toLowerCase()] = {
      hops: [parseHop(hop1Raw), parseHop(hop2Raw)],
      intermediateToken: Constants.CRVUSD_ADDRESS,
    };
  }

  return configs;
}

/**
 * Default flash amount tiers — conservative for low-liquidity pools.
 * Format: deviation threshold (bps) → flash amount (USD).
 * First match wins (sorted descending by deviationBps).
 */
const DEFAULT_FLASH_TIERS: FlashAmountTier[] = [
  {deviationBps: 500, amountUsd: 2000}, // > 5%  → $2,000
  {deviationBps: 200, amountUsd: 1000}, // > 2%  → $1,000
  {deviationBps: 50, amountUsd: 500}, // > 0.5% → $500
  {deviationBps: 0, amountUsd: 500}, // default  → $500
];

/**
 * Parse flash amount tiers from FLASH_AMOUNT_TIERS env var.
 * Format: JSON array of [deviationBps, amountUsd] pairs.
 * Example: [[500,2000],[200,1000],[50,500],[0,500]]
 * If not set, uses DEFAULT_FLASH_TIERS.
 */
function parseFlashAmountTiers(): FlashAmountTier[] {
  const raw = process.env.FLASH_AMOUNT_TIERS;
  if (!raw) return DEFAULT_FLASH_TIERS;

  try {
    const parsed: [number, number][] = JSON.parse(raw);
    const tiers = parsed.map(([deviationBps, amountUsd]) => ({
      deviationBps,
      amountUsd,
    }));
    // Sort descending by deviationBps so first match wins
    tiers.sort((a, b) => b.deviationBps - a.deviationBps);
    return tiers;
  } catch (e) {
    console.warn("Failed to parse FLASH_AMOUNT_TIERS, using defaults:", e instanceof Error ? e.message : e);
    return DEFAULT_FLASH_TIERS;
  }
}
