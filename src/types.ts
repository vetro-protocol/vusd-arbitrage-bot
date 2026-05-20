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

export type DexSource = "1inch" | "0x" | "lifi" | "curve_router" | "default";

export interface DexQuoteResult {
  price: number;
  source: DexSource;
}

export interface PriceData {
  /** Sell price: how much underlying you get per 1 pegged token sold on DEX */
  peggedDexSellPrice: number;
  /** Buy price: how much underlying it costs to buy 1 pegged token on DEX */
  peggedDexBuyPrice: number;
  /** Which DEX source provided the sell quote */
  dexSellQuote: DexQuoteResult;
  /** Which DEX source provided the buy quote */
  dexBuyQuote: DexQuoteResult;
  /** Gateway previewDeposit result: pegged tokens out for depositing testAmount of underlying */
  gatewayMintOutput: bigint;
  /** Mint fee in BPS */
  mintFeeBps: number;
  /** Redeem fee in BPS */
  redeemFeeBps: number;
  /** Which underlying token this price data is for */
  underlying: import("./products").UnderlyingToken;
}

export interface ArbOpportunity {
  direction: ArbDirection;
  underlying: import("./products").UnderlyingToken;
  flashAmount: bigint;
  swapParams: SwapParams;
  estimatedProfitBase: number;
  dexPricePegged: number;
  minProfit: bigint;
}

// Re-export product types so they show up as one type-surface to consumers.
export type {
  PeggedToken,
  UnderlyingToken,
  CurveRouterHop,
  CurveRouterRoute,
  FlashAmountTier,
  Product,
} from "./products";
