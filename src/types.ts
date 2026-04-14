export enum FlashLoanProvider {
  AAVE_V3 = 0,
  MORPHO = 1,
  BALANCER = 2,
}

export enum ArbDirection {
  MINT_AND_SELL = 0,
  BUY_AND_REDEEM = 1,
}

export interface SwapParams {
  target: string;
  approveTarget: string;
  swapCalldata: string;
  minAmountOut: bigint;
}

export interface StablecoinConfig {
  address: string;
  symbol: string;
  decimals: number;
}

export interface FlashLoanProviderConfig {
  provider: FlashLoanProvider;
  address: string;
  feeBps: number;
}

export type DexSource = "1inch" | "0x" | "lifi" | "uniswap_v3" | "curve" | "curve_router" | "default";

export interface DexQuoteResult {
  price: number;
  source: DexSource;
  /** Uniswap V3 fee tier that produced the quote */
  feeTier?: number;
  /** Curve pool address */
  poolAddress?: string;
  /** Curve VUSD index in pool */
  vusdIndex?: number;
  /** Curve stablecoin index in pool */
  stablecoinIndex?: number;
}

export interface CurvePoolConfig {
  poolAddress: string;
  vusdIndex: number;
  stablecoinIndex: number;
}

export interface CurveRouterHop {
  pool: string;
  /** Input token index in the pool (buy direction: stablecoin → crvUSD → VUSD) */
  i: number;
  /** Output token index in the pool (buy direction) */
  j: number;
  swapType: number;
  poolType: number;
  nCoins: number;
}

export interface CurveRouterRouteConfig {
  /** Hops in BUY direction: stablecoin → intermediateToken → VUSD. Reversed for sell. */
  hops: [CurveRouterHop, CurveRouterHop];
  /** Intermediate token address (e.g., crvUSD) */
  intermediateToken: string;
}

export interface PriceData {
  /** VUSD sell price: how much stablecoin you get per VUSD sold on DEX (e.g., 0.9927) */
  vusdDexPrice: number;
  /** VUSD buy price: how much stablecoin it costs to buy 1 VUSD on DEX (e.g., 0.9940) */
  vusdDexBuyPrice: number;
  /** Which DEX source provided the sell quote */
  dexQuote: DexQuoteResult;
  /** Which DEX source provided the buy quote */
  dexBuyQuote: DexQuoteResult;
  /** Gateway previewDeposit result: VUSD out for depositing testAmount of stablecoin */
  gatewayMintOutput: bigint;
  /** Mint fee in BPS */
  mintFeeBps: number;
  /** Redeem fee in BPS */
  redeemFeeBps: number;
  stablecoin: StablecoinConfig;
}

/**
 * A single tier mapping a minimum price deviation (bps) to a flash loan amount (USD).
 * Tiers are sorted descending by deviationBps — first match wins.
 */
export interface FlashAmountTier {
  /** Minimum deviation in bps (e.g., 500 = 5%) */
  deviationBps: number;
  /** Flash loan amount in USD (before decimals) */
  amountUsd: number;
}

export interface ArbOpportunity {
  direction: ArbDirection;
  stablecoin: StablecoinConfig;
  flashAmount: bigint;
  swapParams: SwapParams;
  provider: FlashLoanProvider;
  estimatedProfitUsd: number;
  dexPriceVusd: number;
  minProfit: bigint;
}
