/**
 * Truly global Ethereum mainnet infrastructure addresses — shared by every
 * product. Per-product addresses (Gateway, pegged token, arbitrage contract,
 * underlyings, Curve routes) live in `src/products.ts`.
 */

// Flash loan provider (Morpho — 0 bps fee, both VUSD and vetBTC)
export const MORPHO_ADDRESS = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

// Curve Router NG v1.2 — used as on-chain quoter + executor fallback
export const CURVE_ROUTER_ADDRESS = "0x45312ea0eFf7E09C83CBE249fa1d7598c4C8cd4e";
