import {describe, it, expect} from "vitest";
import {blockRangeOf, inclusionTimeoutMs, parseSendRpcUrl} from "../../src/config";

describe("parseSendRpcUrl", () => {
  it("uses the Flashbots Protect default when not set", () => {
    expect(parseSendRpcUrl(undefined)).toBe("https://rpc.flashbots.net/fast?blockRange=5");
    expect(parseSendRpcUrl("")).toBe("https://rpc.flashbots.net/fast?blockRange=5");
  });

  it("accepts a Flashbots Protect URL with other params", () => {
    const url = "https://rpc.flashbots.net/fast?blockRange=10";
    expect(parseSendRpcUrl(url)).toBe(url);
  });

  it("accepts canRevert=false", () => {
    const url = "https://rpc.flashbots.net/fast?blockRange=5&canRevert=false";
    expect(parseSendRpcUrl(url)).toBe(url);
  });

  it.each([
    "https://rpc.flashbots.net/fast?blockRange=5&canRevert=true",
    "https://rpc.flashbots.net/fast?canRevert=TRUE",
    "https://rpc.flashbots.net/fast?blocksToLive=1",
    "https://rpc.flashbots.net/fast?blockRange=5&blocksToLive=1",
    "https://rpc.flashbots.net/fast?blockRange=0",
    "https://rpc.flashbots.net/fast?blockRange=abc",
    "https://eth.llamarpc.com",
    "http://rpc.flashbots.net/fast",
    "https://rpc.flashbots.net.evil.com",
    "not a url",
  ])("rejects %s", (url) => {
    expect(() => parseSendRpcUrl(url)).toThrow(/SEND_RPC_URL/);
  });
});

describe("inclusionTimeoutMs", () => {
  it("is 2 × blockRange blocks of 12 s", () => {
    expect(blockRangeOf("https://rpc.flashbots.net/fast?blockRange=5")).toBe(5);
    expect(inclusionTimeoutMs("https://rpc.flashbots.net/fast?blockRange=5")).toBe(120_000);
  });

  it("uses the Protect default (25 blocks) when blockRange is not set", () => {
    expect(inclusionTimeoutMs("https://rpc.flashbots.net/fast")).toBe(600_000);
  });
});
