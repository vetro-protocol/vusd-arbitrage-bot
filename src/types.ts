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

export interface PriceData {
  /** VUSD price on DEX in stablecoin terms (e.g., 0.98 means 1 VUSD = 0.98 USDC) */
  vusdDexPrice: number;
  /** Gateway previewDeposit result: VUSD out for depositing testAmount of stablecoin */
  gatewayMintOutput: bigint;
  /** Gateway previewRedeem result: stablecoin out for redeeming testAmount of VUSD */
  gatewayRedeemOutput: bigint;
  /** Mint fee in BPS */
  mintFeeBps: number;
  /** Redeem fee in BPS */
  redeemFeeBps: number;
  stablecoin: StablecoinConfig;
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
