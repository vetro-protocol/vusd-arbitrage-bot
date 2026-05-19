import {describe, it, expect, beforeAll, afterAll, beforeEach, afterEach} from "vitest";
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
    };

    config = {
      rpcUrl: RPC_URL,
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

  async function runPipeline(price: bigint) {
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

    const receipt = await executor.execute(opportunity);
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

  it("should skip when profit is below minProfitBase threshold", async () => {
    const highThresholdCalc = new ProfitCalculator(100, config.flashAmountTiers);

    await dexContract.setPrice(ethers.parseUnits("1.001", 18));

    const priceData = await priceMonitor.getPriceData(usdc);
    const flashAmount = highThresholdCalc.suggestFlashAmount(priceData, config.maxFlashAmount);
    const evaluation = highThresholdCalc.evaluate(priceData, flashAmount, 5.0);

    expect(evaluation).toBeNull();
  });
});
