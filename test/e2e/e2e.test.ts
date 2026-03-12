import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { ethers } from "ethers";
import {
  startAnvil,
  stopAnvil,
  deployMocks,
  DeployedAddresses,
  ANVIL_PRIVATE_KEY,
  ANVIL_ADMIN_KEY,
} from "./anvil";
import { MockDexAdapter } from "./mockDexAdapter";
import { Config } from "../../src/config";
import { PriceMonitor } from "../../src/priceMonitor";
import { ProfitCalculator } from "../../src/profitCalculator";
import { SwapBuilder } from "../../src/swapBuilder";
import { Executor } from "../../src/executor";
import { DexQuoter } from "../../src/dexQuoter";
import {
  ArbDirection,
  ArbOpportunity,
  FlashAmountTier,
  FlashLoanProvider,
  StablecoinConfig,
} from "../../src/types";

const RPC_URL = "http://127.0.0.1:8545";
const CHAIN_ID = 31337;

const MOCK_DEX_ABI = [
  "function setPrice(uint256 priceAinB_) external",
  "function priceAinB() view returns (uint256)",
];

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
  let usdc: StablecoinConfig;
  let dexContract: ethers.Contract;
  let usdcContract: ethers.Contract;
  let snapshotId: string;

  beforeAll(async () => {
    // 1. Start Anvil
    await startAnvil();

    // 2. Deploy all mocks via forge script
    addresses = deployMocks(RPC_URL);

    // 3. Set up provider and wallets
    provider = new ethers.JsonRpcProvider(RPC_URL);
    // Admin wallet for setPrice (separate account to avoid nonce conflicts with Executor)
    const adminWallet = new ethers.Wallet(ANVIL_ADMIN_KEY, provider);

    // 4. Create MockDexAdapter
    mockDexAdapter = new MockDexAdapter(provider, addresses.dex);

    // 5. Stablecoin config
    usdc = {
      address: addresses.usdc,
      symbol: "USDC",
      decimals: 6,
    };

    // 6. Build Config (no env vars — constructed directly)
    config = {
      rpcUrl: RPC_URL,
      chainId: CHAIN_ID,
      vusdArbitrageAddress: addresses.arb,
      gatewayAddress: addresses.gateway,
      vusdAddress: addresses.vusd,
      stablecoins: [usdc],
      flashLoanProviders: [
        {
          provider: FlashLoanProvider.MORPHO,
          address: addresses.morpho,
          feeBps: 0,
        },
      ],
      // All real DEX sources disabled
      enableOneInch: false,
      enableZeroX: false,
      enableLifi: false,
      enableUniswapV3: false,
      enableCurve: false,
      oneInchApiKey: undefined,
      zeroXApiKey: undefined,
      lifiEnabled: false,
      uniswapV3QuoterAddress: ethers.ZeroAddress,
      uniswapV3RouterAddress: ethers.ZeroAddress,
      curvePoolConfigs: {},
      flashAmountTiers: [
        {deviationBps: 500, amountUsd: 500000},
        {deviationBps: 200, amountUsd: 100000},
        {deviationBps: 50, amountUsd: 50000},
        {deviationBps: 0, amountUsd: 10000},
      ],
      minProfitUsd: 1.0,
      maxFlashAmount: BigInt("1000000000000"),
      pollIntervalMs: 1000,
      maxGasPriceGwei: 1000,
      slippageBps: 50,
      privateKey: ANVIL_PRIVATE_KEY,
    };

    // 7. DexQuoter (unused but required by constructors)
    const dexQuoter = new DexQuoter(
      provider,
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      {}
    );

    // 8. Wire components with MockDexAdapter as sole aggregator
    priceMonitor = new PriceMonitor(provider, config, [mockDexAdapter], dexQuoter);
    profitCalculator = new ProfitCalculator(config.minProfitUsd, config.flashAmountTiers);
    swapBuilder = new SwapBuilder(config, [mockDexAdapter], dexQuoter);
    executor = new Executor(provider, config);

    // 9. Contract handles (dexContract uses admin wallet to avoid nonce conflicts)
    dexContract = new ethers.Contract(addresses.dex, MOCK_DEX_ABI, adminWallet);
    usdcContract = new ethers.Contract(addresses.usdc, ERC20_ABI, provider);
  });

  afterAll(() => {
    stopAnvil();
  });

  // Snapshot/revert for test isolation
  beforeEach(async () => {
    snapshotId = await provider.send("evm_snapshot", []);
  });

  afterEach(async () => {
    await provider.send("evm_revert", [snapshotId]);
  });

  /**
   * Run the full off-chain pipeline (mirrors Keeper.tick() logic).
   * Sets MockDex price, then: getPriceData → evaluate → suggestFlashAmount → buildSwap → execute
   */
  async function runPipeline(price: bigint) {
    // Set DEX price
    await dexContract.setPrice(price);

    // Step 1: PriceMonitor reads Gateway + DEX prices
    const priceData = await priceMonitor.getPriceData(usdc);

    // Step 2: Flash amount sizing (before evaluate so profit is realistic)
    const flashAmount = profitCalculator.suggestFlashAmount(
      priceData,
      config.maxFlashAmount
    );

    // Step 3: ProfitCalculator evaluates at the actual flash amount
    const evaluation = profitCalculator.evaluate(
      priceData,
      config.flashLoanProviders[0],
      flashAmount,
      0 // gas cost = 0 on Anvil
    );

    if (!evaluation) {
      return { priceData, evaluation: null, receipt: null };
    }

    // Step 4: SwapBuilder builds calldata (routes through MockDexAdapter)
    let swapParams;
    if (evaluation.direction === ArbDirection.MINT_AND_SELL) {
      const vusdEstimate = priceData.gatewayMintOutput;
      const scaledVusd =
        (vusdEstimate * flashAmount) / ethers.parseUnits("10000", usdc.decimals);
      swapParams = await swapBuilder.buildSellVusdSwap(
        scaledVusd,
        usdc,
        priceData.dexQuote
      );
    } else {
      swapParams = await swapBuilder.buildBuyVusdSwap(
        flashAmount,
        usdc,
        priceData.dexQuote
      );
    }

    // Step 5: Build opportunity
    const opportunity: ArbOpportunity = {
      direction: evaluation.direction,
      stablecoin: usdc,
      flashAmount,
      swapParams,
      provider: FlashLoanProvider.MORPHO,
      estimatedProfitUsd: evaluation.estimatedProfitUsd,
      dexPriceVusd: priceData.vusdDexPrice,
      minProfit: 0n,
    };

    // Step 6: Executor simulates (staticCall) + executes
    const receipt = await executor.execute(opportunity);

    return { priceData, evaluation, receipt };
  }

  // ===========================================================================
  // Scenario 1: MINT_AND_SELL — VUSD trades above peg at $1.03
  // ===========================================================================
  it("should detect and execute MINT_AND_SELL when VUSD is above peg", async () => {
    const { priceData, evaluation, receipt } = await runPipeline(
      ethers.parseUnits("1.03", 18)
    );

    // Verify price detection
    expect(priceData.vusdDexPrice).toBeCloseTo(1.03, 2);
    expect(priceData.dexQuote.source).toBe("1inch");
    expect(priceData.mintFeeBps).toBe(0);
    expect(priceData.redeemFeeBps).toBe(30);

    // Verify opportunity detected correctly
    expect(evaluation).not.toBeNull();
    expect(evaluation!.direction).toBe(ArbDirection.MINT_AND_SELL);
    expect(evaluation!.spreadBps).toBeGreaterThan(0);
    expect(evaluation!.estimatedProfitUsd).toBeGreaterThan(0);

    // Verify on-chain execution succeeded
    expect(receipt).not.toBeNull();
    expect(receipt!.status).toBe(1);

    // Verify profit was distributed on-chain
    const keeperBal: bigint = await usdcContract.balanceOf(addresses.keeper);
    const treasuryBal: bigint = await usdcContract.balanceOf(addresses.treasury);
    expect(keeperBal).toBeGreaterThan(0n);
    expect(treasuryBal).toBeGreaterThan(0n);

    console.log(
      `  MINT_AND_SELL profit: keeper=${ethers.formatUnits(keeperBal, 6)} USDC, ` +
        `treasury=${ethers.formatUnits(treasuryBal, 6)} USDC`
    );
  });

  // ===========================================================================
  // Scenario 2: BUY_AND_REDEEM — VUSD trades below peg at $0.95
  // ===========================================================================
  it("should detect and execute BUY_AND_REDEEM when VUSD is below peg", async () => {
    const { priceData, evaluation, receipt } = await runPipeline(
      ethers.parseUnits("0.95", 18)
    );

    // Verify price detection
    expect(priceData.vusdDexPrice).toBeCloseTo(0.95, 2);

    // Verify opportunity
    expect(evaluation).not.toBeNull();
    expect(evaluation!.direction).toBe(ArbDirection.BUY_AND_REDEEM);
    expect(evaluation!.spreadBps).toBeGreaterThan(0);

    // Verify execution
    expect(receipt).not.toBeNull();
    expect(receipt!.status).toBe(1);

    // Verify profit
    const keeperBal: bigint = await usdcContract.balanceOf(addresses.keeper);
    const treasuryBal: bigint = await usdcContract.balanceOf(addresses.treasury);
    expect(keeperBal).toBeGreaterThan(0n);
    expect(treasuryBal).toBeGreaterThan(0n);

    console.log(
      `  BUY_AND_REDEEM profit: keeper=${ethers.formatUnits(keeperBal, 6)} USDC, ` +
        `treasury=${ethers.formatUnits(treasuryBal, 6)} USDC`
    );
  });

  // ===========================================================================
  // Scenario 3: No opportunity — VUSD at peg ($1.00)
  // ===========================================================================
  it("should skip when VUSD is at peg (no opportunity)", async () => {
    const { priceData, evaluation, receipt } = await runPipeline(
      ethers.parseUnits("1.0", 18)
    );

    expect(priceData.vusdDexPrice).toBeCloseTo(1.0, 4);
    expect(evaluation).toBeNull();
    expect(receipt).toBeNull();
  });

  // ===========================================================================
  // Scenario 4: Below min profit threshold
  // ===========================================================================
  it("should skip when profit is below minProfitUsd threshold", async () => {
    // Use a high-threshold calculator ($100 min)
    const highThresholdCalc = new ProfitCalculator(100, config.flashAmountTiers);

    await dexContract.setPrice(ethers.parseUnits("1.001", 18)); // 0.1% spread

    const priceData = await priceMonitor.getPriceData(usdc);
    const flashAmount = highThresholdCalc.suggestFlashAmount(
      priceData,
      config.maxFlashAmount
    );
    const evaluation = highThresholdCalc.evaluate(
      priceData,
      config.flashLoanProviders[0],
      flashAmount,
      5.0 // $5 gas cost
    );

    // Spread exists but profit doesn't meet $100 threshold
    expect(evaluation).toBeNull();
  });
});
