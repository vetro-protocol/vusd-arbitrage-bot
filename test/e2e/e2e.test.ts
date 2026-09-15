import {describe, it, expect, beforeAll, afterAll, beforeEach, afterEach} from "vitest";
import http from "node:http";
import {ethers} from "ethers";
import {startAnvil, stopAnvil, deployMocks, DeployedAddresses, ANVIL_PRIVATE_KEY, ANVIL_ADMIN_KEY} from "./anvil";
import {MockDexAdapter} from "./mockDexAdapter";
import {Config} from "../../src/config";
import {PriceMonitor} from "../../src/priceMonitor";
import {ProfitCalculator} from "../../src/profitCalculator";
import {SwapBuilder} from "../../src/swapBuilder";
import {Executor} from "../../src/executor";
import {DexQuoter} from "../../src/dexQuoter";
import {ArbDirection, ArbOpportunity} from "../../src/types";
import {Product, UnderlyingToken} from "../../src/products";

const RPC_URL = "http://127.0.0.1:8545";
const CHAIN_ID = 31337;

const MOCK_DEX_ABI = ["function setPrice(uint256 priceAinB_) external", "function priceAinB() view returns (uint256)"];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

/**
 * Stands in for Flashbots Protect declining to include a transaction: accepts
 * eth_sendRawTransaction, hands back a hash, and never mines it. Exactly what a
 * lost one-block race looks like from the bot's side.
 */
async function startDroppingRpc(): Promise<{url: string; close: () => Promise<void>}> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      // ethers batches JSON-RPC calls, so the payload may be an array.
      const payload = JSON.parse(body);
      const answer = ({id, method}: {id: number; method: string}) => ({
        jsonrpc: "2.0",
        id,
        result:
          method === "eth_sendRawTransaction"
            ? "0x" + "ab".repeat(32) // plausible hash for a tx that will never land
            : method === "eth_chainId"
              ? "0x" + CHAIN_ID.toString(16)
              : method === "net_version"
                ? String(CHAIN_ID)
                : "0x0",
      });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(Array.isArray(payload) ? payload.map(answer) : answer(payload)));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const {port} = server.address() as {port: number};
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("E2E: Off-chain arbitrage pipeline", () => {
  let provider: ethers.JsonRpcProvider;
  let addresses: DeployedAddresses;
  let mockDexAdapter: MockDexAdapter;
  let config: Config;
  let priceMonitor: PriceMonitor;
  let profitCalculator: ProfitCalculator;
  let swapBuilder: SwapBuilder;
  let executor: Executor;
  let usdc: UnderlyingToken;
  let dexContract: ethers.Contract;
  let usdcContract: ethers.Contract;
  let snapshotId: string;

  beforeAll(async () => {
    await startAnvil();
    addresses = deployMocks(RPC_URL);

    provider = new ethers.JsonRpcProvider(RPC_URL);
    const adminWallet = new ethers.Wallet(ANVIL_ADMIN_KEY, provider);

    mockDexAdapter = new MockDexAdapter(provider, addresses.dex);

    usdc = {address: addresses.usdc, symbol: "USDC", decimals: 6};

    // Synthetic Product for the mock environment
    const mockProduct: Product = {
      name: "VUSD_TEST",
      description: "Mock VUSD",
      peggedToken: {address: addresses.vusd, symbol: "VUSD", decimals: 18},
      gatewayAddress: addresses.gateway,
      treasuryAddress: addresses.treasury,
      arbitrageAddress: addresses.arb,
      underlyingTokens: [usdc],
      curveRouterRoutes: {},
      defaultMinProfitBase: 1.0,
      defaultEstimatedGasCostBase: 0,
      defaultMaxFlashAmount: 1_000_000,
      defaultFlashAmountTiers: [
        {deviationBps: 500, amount: 500000},
        {deviationBps: 200, amount: 100000},
        {deviationBps: 50, amount: 50000},
        {deviationBps: 0, amount: 10000},
      ],
      priceQuoteAmount: 1000,
    };

    config = {
      rpcUrl: RPC_URL,
      // No Flashbots against a local anvil — send down the same pipe we read from.
      sendRpcUrl: RPC_URL,
      chainId: CHAIN_ID,
      morphoAddress: ethers.ZeroAddress,
      curveRouterAddress: ethers.ZeroAddress,

      product: mockProduct,
      peggedTokenAddress: mockProduct.peggedToken.address,
      arbitrageAddress: mockProduct.arbitrageAddress,

      oneInchApiKey: undefined,
      zeroXApiKey: undefined,
      lifiApiKey: undefined,

      enableOneInch: false,
      enableZeroX: false,
      enableLifi: false,
      enableCurveRouter: false,

      minProfitBase: 1.0,
      estimatedGasCostBase: 0,
      maxFlashAmount: ethers.parseUnits("1000000", usdc.decimals),
      flashAmountTiers: mockProduct.defaultFlashAmountTiers,
      pollIntervalMs: 1000,
      maxGasPriceGwei: 1000,
      slippageBps: 50,

      inclusionTimeoutMs: 15_000,
    };

    const dexQuoter = new DexQuoter(provider, ethers.ZeroAddress, addresses.vusd, {});

    priceMonitor = new PriceMonitor(provider, config, [mockDexAdapter], dexQuoter);
    profitCalculator = new ProfitCalculator(config.minProfitBase, config.flashAmountTiers);
    swapBuilder = new SwapBuilder(config, [mockDexAdapter], dexQuoter);
    executor = new Executor(provider, config, ANVIL_PRIVATE_KEY);

    dexContract = new ethers.Contract(addresses.dex, MOCK_DEX_ABI, adminWallet);
    usdcContract = new ethers.Contract(addresses.usdc, ERC20_ABI, provider);
  });

  afterAll(() => {
    stopAnvil();
  });

  beforeEach(async () => {
    snapshotId = await provider.send("evm_snapshot", []);
  });

  afterEach(async () => {
    await provider.send("evm_revert", [snapshotId]);
  });

  async function runPipeline(price: bigint, exec: Executor = executor) {
    await dexContract.setPrice(price);

    const priceData = await priceMonitor.getPriceData(usdc);
    const flashAmount = profitCalculator.suggestFlashAmount(priceData, config.maxFlashAmount);
    const evaluation = profitCalculator.evaluate(priceData, flashAmount, 0);

    if (!evaluation) {
      return {priceData, evaluation: null, receipt: null};
    }

    let swapParams;
    if (evaluation.direction === ArbDirection.MINT_AND_SELL) {
      const peggedEstimate = priceData.gatewayMintOutput;
      const scaledPegged = (peggedEstimate * flashAmount) / ethers.parseUnits("10000", usdc.decimals);
      swapParams = await swapBuilder.buildSellPeggedSwap(scaledPegged, usdc, priceData.dexSellQuote);
    } else {
      swapParams = await swapBuilder.buildBuyPeggedSwap(flashAmount, usdc, priceData.dexBuyQuote);
    }

    const opportunity: ArbOpportunity = {
      direction: evaluation.direction,
      underlying: usdc,
      flashAmount,
      swapParams,
      estimatedProfitBase: evaluation.estimatedProfitBase,
      dexPricePegged: priceData.peggedDexSellPrice,
      minProfit: 0n,
    };

    const receipt = await exec.execute(opportunity);
    return {priceData, evaluation, receipt};
  }

  it("should detect and execute MINT_AND_SELL when VUSD is above peg", async () => {
    const {priceData, evaluation, receipt} = await runPipeline(ethers.parseUnits("1.03", 18));

    expect(priceData.peggedDexSellPrice).toBeCloseTo(1.03, 2);
    expect(priceData.dexSellQuote.source).toBe("1inch");
    expect(priceData.mintFeeBps).toBe(0);
    expect(priceData.redeemFeeBps).toBe(30);

    expect(evaluation).not.toBeNull();
    expect(evaluation!.direction).toBe(ArbDirection.MINT_AND_SELL);
    expect(evaluation!.spreadBps).toBeGreaterThan(0);
    expect(evaluation!.estimatedProfitBase).toBeGreaterThan(0);

    expect(receipt).not.toBeNull();
    expect(receipt!.status).toBe(1);

    const keeperBal: bigint = await usdcContract.balanceOf(addresses.keeper);
    const treasuryBal: bigint = await usdcContract.balanceOf(addresses.treasury);
    expect(keeperBal).toBeGreaterThan(0n);
    expect(treasuryBal).toBeGreaterThan(0n);

    console.log(
      `  MINT_AND_SELL profit: keeper=${ethers.formatUnits(keeperBal, 6)} USDC, ` +
        `treasury=${ethers.formatUnits(treasuryBal, 6)} USDC`,
    );
  });

  it("should detect and execute BUY_AND_REDEEM when VUSD is below peg", async () => {
    const {priceData, evaluation, receipt} = await runPipeline(ethers.parseUnits("0.95", 18));

    expect(priceData.peggedDexSellPrice).toBeCloseTo(0.95, 2);

    expect(evaluation).not.toBeNull();
    expect(evaluation!.direction).toBe(ArbDirection.BUY_AND_REDEEM);
    expect(evaluation!.spreadBps).toBeGreaterThan(0);

    expect(receipt).not.toBeNull();
    expect(receipt!.status).toBe(1);

    const keeperBal: bigint = await usdcContract.balanceOf(addresses.keeper);
    const treasuryBal: bigint = await usdcContract.balanceOf(addresses.treasury);
    expect(keeperBal).toBeGreaterThan(0n);
    expect(treasuryBal).toBeGreaterThan(0n);

    console.log(
      `  BUY_AND_REDEEM profit: keeper=${ethers.formatUnits(keeperBal, 6)} USDC, ` +
        `treasury=${ethers.formatUnits(treasuryBal, 6)} USDC`,
    );
  });

  it("should skip when VUSD is at peg (no opportunity)", async () => {
    const {priceData, evaluation, receipt} = await runPipeline(ethers.parseUnits("1.0", 18));

    expect(priceData.peggedDexSellPrice).toBeCloseTo(1.0, 4);
    expect(evaluation).toBeNull();
    expect(receipt).toBeNull();
  });

  it("should give up, not hang, when the tx is never included", async () => {
    const droppingRpc = await startDroppingRpc();
    const inclusionTimeoutMs = 3_000;

    try {
      const droppingExecutor = new Executor(
        provider,
        {...config, sendRpcUrl: droppingRpc.url, inclusionTimeoutMs},
        ANVIL_PRIVATE_KEY,
      );

      const startedAt = Date.now();
      const {evaluation, receipt} = await runPipeline(ethers.parseUnits("1.03", 18), droppingExecutor);
      const elapsed = Date.now() - startedAt;

      // The opportunity was real and the tx was signed and submitted — it just
      // never landed. That must resolve as "no receipt" within the timeout,
      // because an unbounded wait here blocks the whole keeper loop forever.
      expect(evaluation).not.toBeNull();
      expect(receipt).toBeNull();
      expect(elapsed).toBeLessThan(inclusionTimeoutMs * 5);
    } finally {
      await droppingRpc.close();
    }
  });

  it("should skip when profit is below minProfitBase threshold", async () => {
    const highThresholdCalc = new ProfitCalculator(100, config.flashAmountTiers);

    await dexContract.setPrice(ethers.parseUnits("1.001", 18));

    const priceData = await priceMonitor.getPriceData(usdc);
    const flashAmount = highThresholdCalc.suggestFlashAmount(priceData, config.maxFlashAmount);
    const evaluation = highThresholdCalc.evaluate(priceData, flashAmount, 5.0);

    expect(evaluation).toBeNull();
  });
});
