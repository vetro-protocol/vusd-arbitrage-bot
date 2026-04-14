import {DexSource, SwapParams} from "./types";

/**
 * Common interface for DEX aggregator APIs.
 * Each adapter provides price quoting and swap calldata building.
 */
export interface AggregatorAdapter {
  readonly name: DexSource;

  /**
   * Get a price quote: how much destToken you get for `amount` of srcToken.
   * Returns the raw destination amount as bigint, or null if the pair is unsupported.
   */
  getQuote(params: QuoteParams): Promise<bigint | null>;

  /**
   * Build swap transaction calldata.
   * Returns SwapParams ready for on-chain execution.
   */
  buildSwap(params: SwapBuildParams): Promise<SwapParams>;
}

export interface QuoteParams {
  srcToken: string;
  destToken: string;
  amount: bigint;
  srcDecimals: number;
  destDecimals: number;
  chainId: number;
}

export interface SwapBuildParams extends QuoteParams {
  receiver: string;
  slippageBps: number;
}

// ---------------------------------------------------------------------------
// 1inch
// ---------------------------------------------------------------------------

export class OneInchAdapter implements AggregatorAdapter {
  readonly name: DexSource = "1inch";

  constructor(private apiKey: string) {}

  private baseUrl(chainId: number): string {
    return `https://api.1inch.com/swap/v6.1/${chainId}`;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
    };
  }

  async getQuote(p: QuoteParams): Promise<bigint | null> {
    try {
      const url = new URL(`${this.baseUrl(p.chainId)}/quote`);
      url.searchParams.set("src", p.srcToken);
      url.searchParams.set("dst", p.destToken);
      url.searchParams.set("amount", p.amount.toString());

      const res = await fetch(url.toString(), {headers: this.headers()});
      if (!res.ok) return null;

      const data = await res.json();
      return BigInt(data.dstAmount);
    } catch {
      return null;
    }
  }

  async buildSwap(p: SwapBuildParams): Promise<SwapParams> {
    const url = new URL(`${this.baseUrl(p.chainId)}/swap`);
    url.searchParams.set("src", p.srcToken);
    url.searchParams.set("dst", p.destToken);
    url.searchParams.set("amount", p.amount.toString());
    url.searchParams.set("from", p.receiver);
    url.searchParams.set("receiver", p.receiver);
    url.searchParams.set("slippage", (p.slippageBps / 100).toString());
    url.searchParams.set("disableEstimate", "true");

    const res = await fetch(url.toString(), {headers: this.headers()});
    if (!res.ok) {
      throw new Error(`1inch swap build failed: ${res.status}`);
    }
    const data = await res.json();

    const expectedOutput = BigInt(data.dstAmount);
    const minAmountOut = (expectedOutput * BigInt(10000 - p.slippageBps)) / 10000n;

    return {
      target: data.tx.to,
      approveTarget: data.tx.to,
      swapCalldata: data.tx.data,
      minAmountOut,
    };
  }
}

// ---------------------------------------------------------------------------
// 0x
// ---------------------------------------------------------------------------

export class ZeroXAdapter implements AggregatorAdapter {
  readonly name: DexSource = "0x";

  constructor(private apiKey: string) {}

  private headers(): Record<string, string> {
    return {
      "0x-api-key": this.apiKey,
      "0x-version": "v2",
      Accept: "application/json",
    };
  }

  async getQuote(p: QuoteParams): Promise<bigint | null> {
    try {
      const url = new URL("https://api.0x.org/swap/allowance-holder/price");
      url.searchParams.set("sellToken", p.srcToken);
      url.searchParams.set("buyToken", p.destToken);
      url.searchParams.set("sellAmount", p.amount.toString());
      url.searchParams.set("chainId", p.chainId.toString());

      const res = await fetch(url.toString(), {headers: this.headers()});
      if (!res.ok) return null;

      const data = await res.json();
      return BigInt(data.buyAmount);
    } catch {
      return null;
    }
  }

  async buildSwap(p: SwapBuildParams): Promise<SwapParams> {
    const url = new URL("https://api.0x.org/swap/allowance-holder/quote");
    url.searchParams.set("sellToken", p.srcToken);
    url.searchParams.set("buyToken", p.destToken);
    url.searchParams.set("sellAmount", p.amount.toString());
    url.searchParams.set("chainId", p.chainId.toString());
    url.searchParams.set("taker", p.receiver);
    url.searchParams.set("slippageBps", p.slippageBps.toString());

    const res = await fetch(url.toString(), {headers: this.headers()});
    if (!res.ok) {
      throw new Error(`0x swap build failed: ${res.status}`);
    }
    const data = await res.json();

    return {
      target: data.transaction.to,
      approveTarget: data.allowanceTarget || data.issues?.allowance?.spender || data.transaction.to,
      swapCalldata: data.transaction.data,
      minAmountOut: BigInt(data.minBuyAmount),
    };
  }
}

// ---------------------------------------------------------------------------
// LiFi
// ---------------------------------------------------------------------------

export class LiFiAdapter implements AggregatorAdapter {
  readonly name: DexSource = "lifi";

  async getQuote(p: QuoteParams): Promise<bigint | null> {
    try {
      const url = new URL("https://li.quest/v1/quote");
      url.searchParams.set("fromChain", p.chainId.toString());
      url.searchParams.set("toChain", p.chainId.toString());
      url.searchParams.set("fromToken", p.srcToken);
      url.searchParams.set("toToken", p.destToken);
      url.searchParams.set("fromAmount", p.amount.toString());
      url.searchParams.set("fromAddress", "0x0000000000000000000000000000000000000001");

      const res = await fetch(url.toString(), {
        headers: {Accept: "application/json"},
      });
      if (!res.ok) return null;

      const data = await res.json();
      return BigInt(data.estimate.toAmount);
    } catch {
      return null;
    }
  }

  async buildSwap(p: SwapBuildParams): Promise<SwapParams> {
    const url = new URL("https://li.quest/v1/quote");
    url.searchParams.set("fromChain", p.chainId.toString());
    url.searchParams.set("toChain", p.chainId.toString());
    url.searchParams.set("fromToken", p.srcToken);
    url.searchParams.set("toToken", p.destToken);
    url.searchParams.set("fromAmount", p.amount.toString());
    url.searchParams.set("fromAddress", p.receiver);
    url.searchParams.set("toAddress", p.receiver);
    url.searchParams.set("slippage", (p.slippageBps / 10000).toFixed(4));

    const res = await fetch(url.toString(), {
      headers: {Accept: "application/json"},
    });
    if (!res.ok) {
      throw new Error(`LiFi swap build failed: ${res.status}`);
    }
    const data = await res.json();

    return {
      target: data.transactionRequest.to,
      approveTarget: data.estimate.approvalAddress || data.transactionRequest.to,
      swapCalldata: data.transactionRequest.data,
      minAmountOut: BigInt(data.estimate.toAmountMin),
    };
  }
}
