import { ethers } from "ethers";
import { AggregatorAdapter, QuoteParams, SwapBuildParams } from "../../src/aggregators";
import { DexSource, SwapParams } from "../../src/types";

const MOCK_DEX_ABI = [
  "function priceAinB() view returns (uint256)",
  "function decimalsA() view returns (uint8)",
  "function decimalsB() view returns (uint8)",
  "function tokenA() view returns (address)",
  "function tokenB() view returns (address)",
  "function swapAforB(uint256 amountA, uint256 minAmountB) returns (uint256 amountB)",
  "function swapBforA(uint256 amountB, uint256 minAmountA) returns (uint256 amountA)",
];

/**
 * Mock aggregator adapter that reads prices from and encodes calldata for
 * the on-chain MockDex contract. Impersonates "1inch" so SwapBuilder
 * routes through its adapterMap without production code changes.
 */
export class MockDexAdapter implements AggregatorAdapter {
  readonly name: DexSource = "1inch";
  private dexContract: ethers.Contract;
  private dexAddress: string;

  constructor(provider: ethers.Provider, dexAddress: string) {
    this.dexAddress = dexAddress;
    this.dexContract = new ethers.Contract(dexAddress, MOCK_DEX_ABI, provider);
  }

  async getQuote(p: QuoteParams): Promise<bigint | null> {
    try {
      const priceAinB: bigint = await this.dexContract.priceAinB();
      const tokenA: string = (await this.dexContract.tokenA()).toLowerCase();
      const decimalsA: number = Number(await this.dexContract.decimalsA());
      const decimalsB: number = Number(await this.dexContract.decimalsB());
      const srcLower = p.srcToken.toLowerCase();

      if (srcLower === tokenA) {
        // Selling tokenA (VUSD) for tokenB (USDC)
        // Mirror MockDex.swapAforB: amountB = (amountA * priceAinB) / 1e18
        // then adjust decimals
        let amountB = (p.amount * priceAinB) / BigInt(1e18);
        if (decimalsA > decimalsB) {
          amountB = amountB / BigInt(10 ** (decimalsA - decimalsB));
        } else if (decimalsB > decimalsA) {
          amountB = amountB * BigInt(10 ** (decimalsB - decimalsA));
        }
        return amountB;
      } else {
        // Buying tokenA (VUSD) with tokenB (USDC)
        // Mirror MockDex.swapBforA: amountA = (amountBInADecimals * 1e18) / priceAinB
        let amountBInADecimals = p.amount;
        if (decimalsA > decimalsB) {
          amountBInADecimals = p.amount * BigInt(10 ** (decimalsA - decimalsB));
        } else if (decimalsB > decimalsA) {
          amountBInADecimals = p.amount / BigInt(10 ** (decimalsB - decimalsA));
        }
        const amountA = (amountBInADecimals * BigInt(1e18)) / priceAinB;
        return amountA;
      }
    } catch {
      return null;
    }
  }

  async buildSwap(p: SwapBuildParams): Promise<SwapParams> {
    const tokenA: string = (await this.dexContract.tokenA()).toLowerCase();
    const srcLower = p.srcToken.toLowerCase();
    const iface = new ethers.Interface(MOCK_DEX_ABI);

    // Get quote for expected output to compute minAmountOut
    const expectedOutput = await this.getQuote(p);
    if (!expectedOutput) throw new Error("MockDexAdapter: quote failed");

    const minAmountOut = (expectedOutput * BigInt(10000 - p.slippageBps)) / 10000n;

    let swapCalldata: string;
    if (srcLower === tokenA) {
      // Sell tokenA -> tokenB: swapAforB(amountA, minAmountB)
      swapCalldata = iface.encodeFunctionData("swapAforB", [p.amount, minAmountOut]);
    } else {
      // Buy tokenA with tokenB: swapBforA(amountB, minAmountA)
      swapCalldata = iface.encodeFunctionData("swapBforA", [p.amount, minAmountOut]);
    }

    return {
      target: this.dexAddress,
      approveTarget: this.dexAddress,
      swapCalldata,
      minAmountOut,
    };
  }
}
