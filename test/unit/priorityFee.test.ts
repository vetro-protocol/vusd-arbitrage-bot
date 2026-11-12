import {describe, it, expect} from "vitest";
import {ethers} from "ethers";
import {Executor} from "../../src/executor";

const GWEI = 10n ** 9n;
const GAS = 400_000n;
const BASE_FEE = 10n * GWEI; // gas cost = 0.004 ETH

/** Executor with a stub Chainlink feed. priorityFee is private, so the tests reach it through `any`. */
function makeExecutor(feedDecimals: number, answer: bigint) {
  const provider = new ethers.JsonRpcProvider("http://127.0.0.1:1", 1, {staticNetwork: true});
  const config: any = {
    arbitrageAddress: ethers.ZeroAddress,
    sendRpcUrl: "http://127.0.0.1:1",
    chainId: 1,
    ethPriceFeed: ethers.ZeroAddress,
    tipShareBps: 5000,
  };
  const executor: any = new Executor(provider, config);
  const updatedAt = BigInt(Math.floor(Date.now() / 1000));
  executor.priceFeed = {
    decimals: async () => BigInt(feedDecimals),
    latestRoundData: async () => [1n, answer, 0n, updatedAt, 1n],
  };
  return executor;
}

const usdc = {symbol: "USDC", decimals: 6};
const wbtc = {symbol: "WBTC", decimals: 8};
const opp = (underlying: {symbol: string; decimals: number}, minProfit: bigint) => ({underlying, minProfit}) as any;

describe("Executor.priorityFee", () => {
  it("pays tipShareBps of the surplus (USDC, ETH/USD 8-dec feed)", async () => {
    const ex = makeExecutor(8, 3000n * 10n ** 8n);
    // budget 95 USDC = 0.031667 ETH, surplus 0.027667 ETH, half / 400k gas ≈ 34.58 gwei
    const {tip} = await ex.priorityFee(opp(usdc, 5_000_000n), 100_000_000n, GAS, BASE_FEE, 1n);
    expect(tip).toBe(34_583_333_333n);
  });

  it("prices profit in ETH with an 18-dec ETH/BTC feed (WBTC)", async () => {
    const ex = makeExecutor(18, 35n * 10n ** 15n); // 1 ETH = 0.035 BTC
    // budget 0.0009 BTC = 0.025714 ETH, surplus 0.021714 ETH, half / 400k gas ≈ 27.14 gwei
    const {tip} = await ex.priorityFee(opp(wbtc, 10_000n), 100_000n, GAS, BASE_FEE, 1n);
    expect(tip / 10n ** 7n).toBe(2714n); // 27.14 gwei
  });

  it("skips when profit above minProfit does not cover the base fee", async () => {
    const ex = makeExecutor(8, 3000n * 10n ** 8n);
    // budget 10 USDC < gas 12 USDC
    expect(await ex.priorityFee(opp(usdc, 5_000_000n), 15_000_000n, GAS, BASE_FEE, 1n)).toBeNull();
  });

  it("skips when the RPC tip floor makes gas cost more than the budget", async () => {
    const ex = makeExecutor(8, 3000n * 10n ** 8n);
    // budget 15 USDC = 0.005 ETH. Share tip 1.25 gwei, floor 5 gwei → cost 0.006 ETH
    expect(await ex.priorityFee(opp(usdc, 5_000_000n), 20_000_000n, GAS, BASE_FEE, 5n * GWEI)).toBeNull();
  });
});

describe("Executor.profitFloor", () => {
  const ETH_USDC = 3000n * 10n ** 6n; // 1 ETH in USDC raw units

  it("adds the gas cost in the underlying to minProfit", async () => {
    const ex = makeExecutor(8, 3000n * 10n ** 8n);
    // (10 + 22.5 gwei) × 400k gas = 0.013 ETH = 39 USDC.
    const gasWei = (BASE_FEE + 22_500_000_000n) * GAS;
    expect(ex.profitFloor(5_000_000n, 100_000_000n, gasWei, ETH_USDC)).toBe(44_000_000n);
  });

  it("rounds the gas cost up", async () => {
    const ex = makeExecutor(8, 3000n * 10n ** 8n);
    expect(ex.profitFloor(0n, 100_000_000n, 1n, ETH_USDC)).toBe(1n);
  });

  it("does not go above the simulated profit", async () => {
    const ex = makeExecutor(8, 3000n * 10n ** 8n);
    // 5 + 12 USDC gas = 17 USDC > 16 USDC simulated
    expect(ex.profitFloor(5_000_000n, 16_000_000n, BASE_FEE * GAS, ETH_USDC)).toBe(16_000_000n);
  });

  it("is minProfit when there is no ETH price", async () => {
    const ex = makeExecutor(8, 3000n * 10n ** 8n);
    expect(ex.profitFloor(5_000_000n, 100_000_000n, BASE_FEE * GAS, null)).toBe(5_000_000n);
  });
});
