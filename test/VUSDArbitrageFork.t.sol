// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {VUSDArbitrage} from "../contracts/VUSDArbitrage.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockGateway} from "./mocks/MockGateway.sol";
import {MockDex} from "./mocks/MockDex.sol";

/// @title VUSDArbitrageForkTest
/// @notice Tests flashloan borrow+repay with real Aave V3 and Morpho on Ethereum mainnet fork
/// @dev Run with: ETHEREUM_RPC_URL=<rpc> forge test --mc VUSDArbitrageForkTest -vvv
contract VUSDArbitrageForkTest is Test {
    // Real mainnet addresses
    address constant AAVE_V3_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

    VUSDArbitrage public arb;
    MockERC20 public vusd;
    MockGateway public gateway;
    MockDex public dex;

    address public owner = makeAddr("owner");
    address public keeper = makeAddr("keeper");
    address public treasury = makeAddr("treasury");

    uint256 fork;

    function setUp() public {
        string memory rpcUrl = vm.envOr("ETHEREUM_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) {
            return; // Skip setup if no RPC URL — tests will skip via modifier
        }

        fork = vm.createFork(rpcUrl);
        vm.selectFork(fork);

        // Deploy VUSD mock on the fork (not deployed on mainnet yet)
        vusd = new MockERC20("Vetro USD", "VUSD", 18);

        // Deploy mock gateway (0% mint fee, 30bps redeem fee)
        gateway = new MockGateway(address(vusd), 0, 30);

        // Fund gateway with real USDC for redemptions (deal to get USDC)
        deal(USDC, address(gateway), 10_000_000e6);

        // Deploy mock DEX with VUSD at 2% premium
        dex = new MockDex(address(vusd), USDC, 1.02e18);

        // Fund DEX with liquidity
        vusd.mint(address(dex), 5_000_000e18);
        deal(USDC, address(dex), 5_000_000e6);

        // Deploy arb contract (10% keeper share)
        arb = new VUSDArbitrage(address(gateway), keeper, treasury, 1000, owner);

        // Set real Aave V3 and Morpho as flash loan providers
        vm.startPrank(owner);
        arb.setProviderAddress(VUSDArbitrage.FlashLoanProvider.AAVE_V3, AAVE_V3_POOL);
        arb.setProviderAddress(VUSDArbitrage.FlashLoanProvider.MORPHO, MORPHO);
        vm.stopPrank();

        // Whitelist arb for instant redeem on mock gateway
        gateway.addToInstantRedeemWhitelist(address(arb));
    }

    modifier onlyFork() {
        string memory rpcUrl = vm.envOr("ETHEREUM_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) {
            return;
        }
        _;
    }

    /*//////////////////////////////////////////////////////////////
                    AAVE V3 FLASHLOAN TESTS
    //////////////////////////////////////////////////////////////*/

    function test_fork_aaveV3_mintAndSell() public onlyFork {
        // VUSD at 2% premium — profitable to mint and sell
        uint256 flashAmount = 100_000e6; // 100k USDC

        bytes memory swapCalldata =
            abi.encodeWithSelector(MockDex.swapAforB.selector, 100_000e18, 0);

        VUSDArbitrage.SwapParams memory swapParams = VUSDArbitrage.SwapParams({
            target: address(dex),
            approveTarget: address(dex),
            swapCalldata: swapCalldata,
            minAmountOut: 100_000e6
        });

        uint256 treasuryBefore = IERC20(USDC).balanceOf(treasury);
        uint256 keeperBefore = IERC20(USDC).balanceOf(keeper);

        vm.prank(keeper);
        int256 profit = arb.mintAndSell(
            VUSDArbitrage.FlashLoanProvider.AAVE_V3, USDC, flashAmount, swapParams, 0
        );

        // Profit should be ~2000 USDC minus Aave's flash loan premium (~0.05%)
        assertGt(profit, 0, "Should be profitable after Aave premium");
        console2.log("Aave V3 mintAndSell profit (USDC):", uint256(profit));

        // Verify profit distribution
        uint256 keeperProfit = IERC20(USDC).balanceOf(keeper) - keeperBefore;
        uint256 treasuryProfit = IERC20(USDC).balanceOf(treasury) - treasuryBefore;
        assertGt(keeperProfit, 0, "Keeper should receive share");
        assertGt(treasuryProfit, 0, "Treasury should receive profit");
        console2.log("  Keeper profit:", keeperProfit);
        console2.log("  Treasury profit:", treasuryProfit);

        // Arb contract should be empty
        assertEq(IERC20(USDC).balanceOf(address(arb)), 0, "Arb contract should be empty");
    }

    function test_fork_aaveV3_buyAndRedeem() public onlyFork {
        // VUSD at 3% discount — profitable to buy and redeem
        dex.setPrice(0.97e18);

        uint256 flashAmount = 100_000e6;

        bytes memory swapCalldata =
            abi.encodeWithSelector(MockDex.swapBforA.selector, 100_000e6, 0);

        VUSDArbitrage.SwapParams memory swapParams = VUSDArbitrage.SwapParams({
            target: address(dex),
            approveTarget: address(dex),
            swapCalldata: swapCalldata,
            minAmountOut: 100_000e18
        });

        vm.prank(keeper);
        int256 profit = arb.buyAndRedeem(
            VUSDArbitrage.FlashLoanProvider.AAVE_V3, USDC, flashAmount, swapParams, 0
        );

        assertGt(profit, 0, "Should be profitable after Aave premium");
        console2.log("Aave V3 buyAndRedeem profit (USDC):", uint256(profit));
        assertEq(IERC20(USDC).balanceOf(address(arb)), 0, "Arb contract should be empty");
    }

    /*//////////////////////////////////////////////////////////////
                    MORPHO FLASHLOAN TESTS
    //////////////////////////////////////////////////////////////*/

    function test_fork_morpho_mintAndSell() public onlyFork {
        // VUSD at 2% premium
        uint256 flashAmount = 100_000e6;

        bytes memory swapCalldata =
            abi.encodeWithSelector(MockDex.swapAforB.selector, 100_000e18, 0);

        VUSDArbitrage.SwapParams memory swapParams = VUSDArbitrage.SwapParams({
            target: address(dex),
            approveTarget: address(dex),
            swapCalldata: swapCalldata,
            minAmountOut: 100_000e6
        });

        uint256 treasuryBefore = IERC20(USDC).balanceOf(treasury);

        vm.prank(keeper);
        int256 profit = arb.mintAndSell(
            VUSDArbitrage.FlashLoanProvider.MORPHO, USDC, flashAmount, swapParams, 0
        );

        // Morpho has 0 fee — profit should be ~2000 USDC (full 2%)
        assertGt(profit, 0, "Should be profitable with Morpho (zero fee)");
        console2.log("Morpho mintAndSell profit (USDC):", uint256(profit));

        uint256 treasuryProfit = IERC20(USDC).balanceOf(treasury) - treasuryBefore;
        assertGt(treasuryProfit, 0, "Treasury should receive profit");
        assertEq(IERC20(USDC).balanceOf(address(arb)), 0, "Arb contract should be empty");
    }

    function test_fork_morpho_buyAndRedeem() public onlyFork {
        // VUSD at 3% discount
        dex.setPrice(0.97e18);

        uint256 flashAmount = 100_000e6;

        bytes memory swapCalldata =
            abi.encodeWithSelector(MockDex.swapBforA.selector, 100_000e6, 0);

        VUSDArbitrage.SwapParams memory swapParams = VUSDArbitrage.SwapParams({
            target: address(dex),
            approveTarget: address(dex),
            swapCalldata: swapCalldata,
            minAmountOut: 100_000e18
        });

        vm.prank(keeper);
        int256 profit = arb.buyAndRedeem(
            VUSDArbitrage.FlashLoanProvider.MORPHO, USDC, flashAmount, swapParams, 0
        );

        assertGt(profit, 0, "Should be profitable with Morpho");
        console2.log("Morpho buyAndRedeem profit (USDC):", uint256(profit));
        assertEq(IERC20(USDC).balanceOf(address(arb)), 0, "Arb contract should be empty");
    }

    /*//////////////////////////////////////////////////////////////
                AAVE vs MORPHO PROFIT COMPARISON
    //////////////////////////////////////////////////////////////*/

    function test_fork_morphoMoreProfitableThanAave() public onlyFork {
        // Same arb, compare profit from Morpho (0 fee) vs Aave (0.05% fee)
        dex.setPrice(1.02e18);
        uint256 flashAmount = 100_000e6;

        bytes memory swapCalldata =
            abi.encodeWithSelector(MockDex.swapAforB.selector, 100_000e18, 0);

        VUSDArbitrage.SwapParams memory swapParams = VUSDArbitrage.SwapParams({
            target: address(dex),
            approveTarget: address(dex),
            swapCalldata: swapCalldata,
            minAmountOut: 100_000e6
        });

        // Morpho run
        vm.prank(keeper);
        int256 morphoProfit = arb.mintAndSell(
            VUSDArbitrage.FlashLoanProvider.MORPHO, USDC, flashAmount, swapParams, 0
        );

        // Reset DEX liquidity for second run
        deal(USDC, address(dex), 5_000_000e6);
        vusd.mint(address(dex), 5_000_000e18);

        // Aave run
        vm.prank(keeper);
        int256 aaveProfit = arb.mintAndSell(
            VUSDArbitrage.FlashLoanProvider.AAVE_V3, USDC, flashAmount, swapParams, 0
        );

        console2.log("Morpho profit:", uint256(morphoProfit));
        console2.log("Aave profit:", uint256(aaveProfit));
        assertGt(morphoProfit, aaveProfit, "Morpho (0 fee) should be more profitable than Aave");
    }
}
