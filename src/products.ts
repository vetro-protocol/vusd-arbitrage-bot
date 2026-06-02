/**
 * Product registry.
 *
 * Each product (VUSD, vetBTC, …) is a pegged token that can be minted/redeemed
 * through a dedicated Vetro Gateway against one or more "underlying" tokens.
 *
 * All values here are committed to git on purpose — they are public on-chain
 * addresses + product-specific tuning defaults. Operators override the few
 * values that vary per environment via .env.
 */
import {ethers} from "ethers";

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export interface PeggedToken {
  address: string;
  symbol: string;
  decimals: number;
}

export interface UnderlyingToken {
  address: string;
  symbol: string;
  decimals: number;
}

export interface CurveRouterHop {
  pool: string;
  /** Input token index in pool (BUY direction: underlying → … → pegged) */
  i: number;
  /** Output token index in pool (BUY direction) */
  j: number;
  /** Curve Router swap_type code (1 = exchange) */
  swapType: number;
  /** Curve Router pool_type code (1 = stable, 10 = stable-ng, etc.) */
  poolType: number;
  /** Number of coins in the pool (2 or 3) */
  nCoins: number;
}

export interface CurveRouterRoute {
  /** Hops in BUY direction: underlying → … → pegged token. Reversed for SELL. */
  hops: CurveRouterHop[];
  /** Intermediate tokens between hops, BUY-direction order. Length = hops.length - 1. */
  intermediateTokens: string[];
}

export interface FlashAmountTier {
  /** Minimum deviation in bps (e.g., 500 = 5%) */
  deviationBps: number;
  /** Flash loan amount denominated in underlying base units (e.g., 2000 USDC, 0.02 WBTC) */
  amount: number;
}

export interface Product {
  /** Stable, uppercase identifier (used in env: PRODUCT=VUSD) */
  name: string;
  /** Human label for logs */
  description: string;
  peggedToken: PeggedToken;
  /** Gateway proxy address */
  gatewayAddress: string;
  /** Treasury (informational — profits go to it via the arbitrage contract) */
  treasuryAddress: string;
  /** Deployed VetroArbitrage contract address for this product */
  arbitrageAddress: string;
  /** Underlying tokens accepted by the Gateway for mint/redeem */
  underlyingTokens: UnderlyingToken[];
  /** Curve Router routes keyed by lowercase underlying token address */
  curveRouterRoutes: Record<string, CurveRouterRoute>;

  // ── Defaults — env can override ───────────────────────────────────────
  /** Minimum profit (in underlying base units) for an arb to be actionable */
  defaultMinProfitBase: number;
  /** Off-chain gas-cost assumption (underlying base units) used in profit estimate */
  defaultEstimatedGasCostBase: number;
  /** Hard cap on flash loan size (underlying base units) */
  defaultMaxFlashAmount: number;
  /** Flash-loan sizing tiers — first match wins (sorted descending by deviationBps) */
  defaultFlashAmountTiers: FlashAmountTier[];
  /**
   * Notional size (human units of pegged or underlying — both share decimals
   * within a product) used for price-discovery quotes. Must be small enough
   * that DEX/aggregator price impact stays meaningful at current pool depth.
   */
  priceQuoteAmount: number;
}

// ───────────────────────────────────────────────────────────────────────────
// VUSD — pegged to $1, underlying = USDC / USDT
// ───────────────────────────────────────────────────────────────────────────

const CRVUSD = "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E";

const USDC: UnderlyingToken = {
  address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  symbol: "USDC",
  decimals: 6,
};

const USDT: UnderlyingToken = {
  address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  symbol: "USDT",
  decimals: 6,
};

const VUSD: Product = {
  name: "VUSD",
  description: "Vetro USD",
  peggedToken: {
    address: "0xCa83DDE9c22254f58e771bE5E157773212AcBAc3",
    symbol: "VUSD",
    decimals: 18,
  },
  gatewayAddress: "0xDaD503f8B9d42bb7af3AfC588358D30163e4416F",
  treasuryAddress: "0xC8317A10385BE07901A4c9ee3d06E1D83AE378c9",
  arbitrageAddress: "0x359902B1e60574E56248EcDC57c1Df1f20982914",
  underlyingTokens: [USDC, USDT],
  curveRouterRoutes: {
    // USDC → crvUSD → VUSD
    [USDC.address.toLowerCase()]: {
      hops: [
        {pool: "0x4DEcE678ceceb27446b35C672dC7d61F30bAD69E", i: 0, j: 1, swapType: 1, poolType: 1, nCoins: 2},
        {pool: "0xAFbA5800252530CE71b03Ba2BCa2Dd5aE44a7F3d", i: 1, j: 0, swapType: 1, poolType: 10, nCoins: 2},
      ],
      intermediateTokens: [CRVUSD],
    },
    // USDT → crvUSD → VUSD
    [USDT.address.toLowerCase()]: {
      hops: [
        {pool: "0x390f3595bCa2Df7d23783dFd126427CCeb997BF4", i: 0, j: 1, swapType: 1, poolType: 1, nCoins: 2},
        {pool: "0xAFbA5800252530CE71b03Ba2BCa2Dd5aE44a7F3d", i: 1, j: 0, swapType: 1, poolType: 10, nCoins: 2},
      ],
      intermediateTokens: [CRVUSD],
    },
  },
  defaultMinProfitBase: 5, // 5 USDC
  defaultEstimatedGasCostBase: 5, // 5 USDC
  defaultMaxFlashAmount: 1_000_000, // 1,000,000 USDC
  defaultFlashAmountTiers: [
    {deviationBps: 500, amount: 2000},
    {deviationBps: 200, amount: 1000},
    {deviationBps: 50, amount: 500},
    {deviationBps: 0, amount: 500},
  ],
  priceQuoteAmount: 1000, // 1000 VUSD / USDC notional — deep VUSD pools
};

// ───────────────────────────────────────────────────────────────────────────
// vetBTC — pegged to 1 BTC, underlying = WBTC / cbBTC / hemiBTC
// ───────────────────────────────────────────────────────────────────────────

const WBTC: UnderlyingToken = {
  address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
  symbol: "WBTC",
  decimals: 8,
};

const CBBTC: UnderlyingToken = {
  address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
  symbol: "cbBTC",
  decimals: 8,
};

const HEMIBTC: UnderlyingToken = {
  address: "0x06ea695B91700071B161A434fED42D1DcbAD9f00",
  symbol: "hemiBTC",
  decimals: 8,
};

/**
 * 3-coin Curve stable-ng pool: HemiBTC / cbBTC / WBTC.
 * Indices: 0 = WBTC, 1 = cbBTC, 2 = HemiBTC.
 */
const POOL_HEMI_CB_W_BTC = "0x66039342c66760874047c36943b1e2d8300363bb";

/**
 * Curve stable-ng pool: vetBTC / WBTC.
 * Indices: 0 = vetBTC, 1 = WBTC.
 * Currently the only vetBTC pool. cbBTC and hemiBTC route through WBTC via the
 * 3-coin BTC pool above. When vetBTC/hemiBTC or vetBTC/cbBTC pools launch, swap
 * the relevant underlying's route below for a 1-hop direct route.
 */
const POOL_VETBTC_WBTC = "0xf2e47b9bcb26463a12b1409be06fdaa1c308aa65";

const VETBTC: Product = {
  name: "VETBTC",
  description: "Vetro BTC",
  peggedToken: {
    address: "0xf196C68233464A16CFDa319a47c21f4cECa62001",
    symbol: "vetBTC",
    decimals: 18,
  },
  gatewayAddress: "0xCBA2Ffa0AC52d7871a4221a871793Eb788013faB",
  treasuryAddress: "0xd25a7b0b817fD816d0995eC67fb70e75EE65Bd7F",
  arbitrageAddress: "0xB174B2C57AFD9Be660F4c00DF568Fe4c34401aEE",
  underlyingTokens: [WBTC, CBBTC, HEMIBTC],
  curveRouterRoutes: {
    // WBTC → vetBTC (direct, 1 hop)
    [WBTC.address.toLowerCase()]: {
      hops: [{pool: POOL_VETBTC_WBTC, i: 1, j: 0, swapType: 1, poolType: 10, nCoins: 2}],
      intermediateTokens: [],
    },
    // cbBTC → WBTC (via 3-coin pool) → vetBTC (via WBTC pool)
    // When vetBTC/cbBTC pool launches, collapse to a 1-hop direct route.
    [CBBTC.address.toLowerCase()]: {
      hops: [
        {pool: POOL_HEMI_CB_W_BTC, i: 1, j: 0, swapType: 1, poolType: 10, nCoins: 3},
        {pool: POOL_VETBTC_WBTC, i: 1, j: 0, swapType: 1, poolType: 10, nCoins: 2},
      ],
      intermediateTokens: [WBTC.address],
    },
    // hemiBTC → WBTC (via 3-coin pool) → vetBTC (via WBTC pool)
    // When vetBTC/hemiBTC pool launches, collapse to a 1-hop direct route.
    [HEMIBTC.address.toLowerCase()]: {
      hops: [
        {pool: POOL_HEMI_CB_W_BTC, i: 2, j: 0, swapType: 1, poolType: 10, nCoins: 3},
        {pool: POOL_VETBTC_WBTC, i: 1, j: 0, swapType: 1, poolType: 10, nCoins: 2},
      ],
      intermediateTokens: [WBTC.address],
    },
  },
  // TVL on vetBTC/WBTC pool is currently ~$1.1k. Sizes below are intentionally
  // tiny to keep price impact <~3%; raise as pool liquidity grows.
  defaultMinProfitBase: 0.0001, // ~0.0001 BTC ≈ $9 at $90k/BTC
  defaultEstimatedGasCostBase: 0.00006, // ~$5
  defaultMaxFlashAmount: 0.5, // 0.5 WBTC cap (was 10 — too large for current pool)
  defaultFlashAmountTiers: [
    {deviationBps: 500, amount: 0.0005},
    {deviationBps: 200, amount: 0.0002},
    {deviationBps: 50, amount: 0.0001},
    {deviationBps: 0, amount: 0.0001},
  ],
  // 0.0001 vetBTC ≈ $9 — small enough for ~$1.1k pool to quote without
  // require(false). Raise as pool liquidity grows.
  priceQuoteAmount: 0.0001,
};

// ───────────────────────────────────────────────────────────────────────────
// Registry + selector
// ───────────────────────────────────────────────────────────────────────────

export const PRODUCTS: Record<string, Product> = {
  VUSD,
  VETBTC,
};

/**
 * Resolve a Product by name. Case-insensitive. Throws on unknown names.
 */
export function getProduct(name: string | undefined): Product {
  if (!name) {
    throw new Error(`PRODUCT env var is required. Set PRODUCT=VUSD or PRODUCT=VETBTC.`);
  }
  const upper = name.toUpperCase();
  const product = PRODUCTS[upper];
  if (!product) {
    throw new Error(`Unknown PRODUCT="${name}". Valid values: ${Object.keys(PRODUCTS).join(", ")}`);
  }
  return product;
}
