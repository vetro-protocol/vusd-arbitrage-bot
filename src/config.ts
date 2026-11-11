import {ethers} from "ethers";
import {FlashAmountTier, Product, getProduct} from "./products";
import * as Constants from "./constants";

export interface Config {
  // ── Global infra ──────────────────────────────────────────────────────
  rpcUrl: string;
  /**
   * Send-only Flashbots Protect endpoint. Transactions that would revert are
   * never included, so a lost race costs no gas. Its `blockRange` param sets
   * how long Protect tries. Reads and simulation always go through `rpcUrl`.
   * Must be on `https://rpc.flashbots.net`: the tx status is read from the
   * Protect API, which knows only txs sent to Protect.
   */
  sendRpcUrl: string;
  /** Flashbots Protect status API; the tx hash is appended. */
  protectStatusUrl: string;
  chainId: number;
  /** Morpho flash loan pool */
  morphoAddress: string;
  /** Curve Router NG v1.2 */
  curveRouterAddress: string;

  // ── Active product ────────────────────────────────────────────────────
  product: Product;
  /** Convenience: pegged-token address (= product.peggedToken.address) */
  peggedTokenAddress: string;
  /** Arbitrage contract — defaults from product, overridable via env */
  arbitrageAddress: string;

  // ── Aggregator API keys (optional, each toggles its source on) ────────
  oneInchApiKey?: string;
  zeroXApiKey?: string;
  lifiApiKey?: string;

  // ── Per-source enable flags (all default true) ────────────────────────
  enableOneInch: boolean;
  enableZeroX: boolean;
  enableLifi: boolean;
  enableCurveRouter: boolean;

  // ── Tunings — defaults sourced from the product, overridable via env ──
  /** Minimum profit (underlying base units) to execute an arb */
  minProfitBase: number;
  /** Off-chain gas-cost assumption (underlying base units) for profit estimate */
  estimatedGasCostBase: number;
  /** Hard cap on flash loan amount (raw bigint, underlying base units) */
  maxFlashAmount: bigint;
  /** Flash-loan tier table (sorted descending by deviationBps) */
  flashAmountTiers: FlashAmountTier[];
  /** Price poll interval (ms) */
  pollIntervalMs: number;
  /** Skip execution if gas price > this (gwei) */
  maxGasPriceGwei: number;
  /** DEX swap slippage tolerance (bps) */
  slippageBps: number;

  /**
   * Chainlink ETH price feed in the underlying base asset. Unset → no gas check
   * and the RPC's suggested tip is used.
   */
  ethPriceFeed?: string;
  /** Share (bps) of the profit above minProfit + base fee that is paid as priority fee */
  tipShareBps: number;
}

export function loadConfig(): Config {
  if (!process.env.ETHEREUM_RPC_URL) {
    throw new Error("Missing required environment variable: ETHEREUM_RPC_URL");
  }

  const product = getProduct(process.env.PRODUCT);

  const arbitrageAddress = process.env.ARBITRAGE_ADDRESS || product.arbitrageAddress;
  if (!arbitrageAddress || arbitrageAddress === ethers.ZeroAddress) {
    throw new Error(
      `No arbitrage contract address configured for product ${product.name}. ` +
        `Set ARBITRAGE_ADDRESS in .env (override) or update src/products.ts after deploying.`,
    );
  }

  const maxFlashAmount = parseFlashCap(product);

  return {
    rpcUrl: process.env.ETHEREUM_RPC_URL!,
    sendRpcUrl: parseSendRpcUrl(process.env.SEND_RPC_URL),
    protectStatusUrl: "https://protect.flashbots.net/tx/",
    chainId: 1,
    morphoAddress: Constants.MORPHO_ADDRESS,
    curveRouterAddress: Constants.CURVE_ROUTER_ADDRESS,

    product,
    peggedTokenAddress: product.peggedToken.address,
    arbitrageAddress,

    oneInchApiKey: process.env.ONEINCH_API_KEY,
    zeroXApiKey: process.env.ZEROX_API_KEY,
    lifiApiKey: process.env.LIFI_API_KEY,

    enableOneInch: process.env.ENABLE_ONEINCH !== "false",
    enableZeroX: process.env.ENABLE_ZEROX !== "false",
    enableLifi: process.env.ENABLE_LIFI !== "false",
    enableCurveRouter: process.env.ENABLE_CURVE_ROUTER !== "false",

    minProfitBase: parseFloat(process.env.MIN_PROFIT_BASE ?? String(product.defaultMinProfitBase)),
    estimatedGasCostBase: parseFloat(
      process.env.ESTIMATED_GAS_COST_BASE ?? String(product.defaultEstimatedGasCostBase),
    ),
    maxFlashAmount,
    flashAmountTiers: parseFlashAmountTiers(product),
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "5000"),
    maxGasPriceGwei: parseInt(process.env.MAX_GAS_PRICE_GWEI || "50"),
    slippageBps: parseInt(process.env.SLIPPAGE_BPS || "50"),

    // ETH_PRICE_FEED="" turns the gas check off.
    ethPriceFeed: process.env.ETH_PRICE_FEED ?? product.ethPriceFeed,
    tipShareBps: Number(process.env.TIP_SHARE_BPS || "5000"),
  };
}

const DEFAULT_SEND_RPC_URL = "https://rpc.flashbots.net/fast?blockRange=5";
const FLASHBOTS_PROTECT_HOST = "rpc.flashbots.net";
/** Protect's blockRange when the URL does not set it. */
const PROTECT_DEFAULT_BLOCK_RANGE = 25;
const BLOCK_TIME_MS = 12_000;

/**
 * SEND_RPC_URL must be Flashbots Protect. The bot reads the tx status from the
 * Protect status API, and a public RPC mines txs that revert (and burns gas).
 * Query params (for example `blockRange`) can change.
 */
export function parseSendRpcUrl(value: string | undefined): string {
  const raw = value || DEFAULT_SEND_RPC_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`SEND_RPC_URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:" || url.hostname !== FLASHBOTS_PROTECT_HOST) {
    throw new Error(
      `SEND_RPC_URL must be a Flashbots Protect URL (https://${FLASHBOTS_PROTECT_HOST}/...), got ${raw}. ` +
        `The bot reads the tx status from the Protect API.`,
    );
  }
  blockRangeOf(raw);
  return raw;
}

/** The `blockRange` query param of a Protect URL, or Protect's default when it is not set. */
export function blockRangeOf(sendRpcUrl: string): number {
  const value = new URL(sendRpcUrl).searchParams.get("blockRange");
  if (value === null) return PROTECT_DEFAULT_BLOCK_RANGE;
  const blockRange = Number(value);
  if (!Number.isInteger(blockRange) || blockRange <= 0) {
    throw new Error(`SEND_RPC_URL blockRange must be a positive integer, got ${value}`);
  }
  return blockRange;
}

/**
 * Safety cap on the wait for a final Protect status: 2 × blockRange blocks.
 * The status API reports FAILED once blockRange blocks pass, so the cap is
 * reached only when the API does not answer.
 */
export function inclusionTimeoutMs(sendRpcUrl: string): number {
  return 2 * blockRangeOf(sendRpcUrl) * BLOCK_TIME_MS;
}

/**
 * Compute MAX_FLASH_AMOUNT as a bigint in underlying base units.
 * MAX_FLASH_AMOUNT env var, if set, is denominated in the underlying's
 * human-readable units (e.g. "2000" = 2000 USDC, "0.5" = 0.5 WBTC).
 */
function parseFlashCap(product: Product): bigint {
  const human = process.env.MAX_FLASH_AMOUNT ?? String(product.defaultMaxFlashAmount);
  // Use the first underlying's decimals for parsing. All underlyings of a
  // product are assumed to share decimals (6 for USD-stables, 8 for BTC-stables).
  const decimals = product.underlyingTokens[0]?.decimals ?? 18;
  return ethers.parseUnits(human, decimals);
}

/**
 * Parse FLASH_AMOUNT_TIERS env var (JSON array of [deviationBps, amount] pairs)
 * or fall back to the product's defaults. Amounts are in underlying human units.
 */
function parseFlashAmountTiers(product: Product): FlashAmountTier[] {
  const raw = process.env.FLASH_AMOUNT_TIERS;
  if (!raw) return product.defaultFlashAmountTiers;

  try {
    const parsed: [number, number][] = JSON.parse(raw);
    const tiers = parsed.map(([deviationBps, amount]) => ({deviationBps, amount}));
    tiers.sort((a, b) => b.deviationBps - a.deviationBps);
    return tiers;
  } catch (e) {
    console.warn("Failed to parse FLASH_AMOUNT_TIERS, using product defaults:", e instanceof Error ? e.message : e);
    return product.defaultFlashAmountTiers;
  }
}
