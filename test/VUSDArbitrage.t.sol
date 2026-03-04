// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {VUSDArbitrage} from "../contracts/VUSDArbitrage.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockGateway} from "./mocks/MockGateway.sol";
import {MockDex} from "./mocks/MockDex.sol";
import {MockMorpho} from "./mocks/MockMorpho.sol";

contract VUSDArbitrageTest is Test {
    VUSDArbitrage public arb;
    MockERC20 public usdc;
    MockERC20 public vusd;
    MockGateway public gateway;
    MockDex public dex;
    MockMorpho public morpho;

    address public owner = makeAddr("owner");
    address public keeper = makeAddr("keeper");
    address public treasury = makeAddr("treasury");
    address public keeper2 = makeAddr("keeper2");

    uint256 public constant INITIAL_USDC_SUPPLY = 10_000_000e6; // 10M USDC
    uint256 public constant INITIAL_VUSD_DEX_LIQUIDITY = 5_000_000e18; // 5M VUSD in DEX
    uint256 public constant INITIAL_USDC_DEX_LIQUIDITY = 5_000_000e6; // 5M USDC in DEX
    uint256 public constant MORPHO_LIQUIDITY = 10_000_000e6; // 10M USDC in Morpho

    function setUp() public {
        // Deploy tokens
        usdc = new MockERC20("USD Coin", "USDC", 6);
        vusd = new MockERC20("Vetro USD", "VUSD", 18);

        // Deploy mock gateway (0% mint fee, 30bps redeem fee)
        gateway = new MockGateway(address(vusd), 0, 30);

        // Fund gateway with USDC for redemptions
        usdc.mint(address(gateway), INITIAL_USDC_SUPPLY);

        // Deploy mock DEX with VUSD at peg (1:1)
        dex = new MockDex(address(vusd), address(usdc), 1e18);

        // Fund DEX with liquidity
        vusd.mint(address(dex), INITIAL_VUSD_DEX_LIQUIDITY);
        usdc.mint(address(dex), INITIAL_USDC_DEX_LIQUIDITY);

        // Deploy mock Morpho and fund it
        morpho = new MockMorpho();
        usdc.mint(address(morpho), MORPHO_LIQUIDITY);

        // Deploy arbitrage contract (10% keeper share)
        arb = new VUSDArbitrage(address(gateway), keeper, treasury, 1000, owner);

        // Set Morpho as flash loan provider
        vm.prank(owner);
        arb.setProviderAddress(VUSDArbitrage.FlashLoanProvider.MORPHO, address(morpho));

        // Whitelist arb contract for instant redeem
        gateway.addToInstantRedeemWhitelist(address(arb));
    }

    /*//////////////////////////////////////////////////////////////
                        MINT AND SELL TESTS
                    (VUSD trades above $1 on DEX)
    //////////////////////////////////////////////////////////////*/

    function test_mintAndSell_vusdAbovePeg() public {
        // VUSD is trading at $1.02 on DEX (2% premium)
        dex.setPrice(1.02e18);

        uint256 flashAmount = 100_000e6; // 100k USDC

        // Build swap calldata: sell VUSD for USDC on DEX
        // After minting 100k USDC → ~100k VUSD (0% mint fee)
        // Sell 100k VUSD at $1.02 → ~102k USDC
        bytes memory swapCalldata =
            abi.encodeWithSelector(MockDex.swapAforB.selector, 100_000e18, 0);

        VUSDArbitrage.SwapParams memory swapParams = VUSDArbitrage.SwapParams({
            target: address(dex),
            approveTarget: address(dex),
            swapCalldata: swapCalldata,
            minAmountOut: 100_000e6 // At least get back what we flash-loaned
        });

        uint256 profitReceiverBefore = usdc.balanceOf(treasury);
        uint256 keeperBefore = usdc.balanceOf(keeper);

        vm.prank(keeper);
        int256 profit = arb.mintAndSell(
            VUSDArbitrage.FlashLoanProvider.MORPHO, address(usdc), flashAmount, swapParams, 0
        );

        // Profit should be ~2000 USDC (2% of 100k)
        assertGt(profit, 0, "Should be profitable");
        console2.log("Profit (USDC):", uint256(profit));

        // Check profit distribution (10% to keeper, 90% to profitReceiver)
        uint256 keeperProfit = usdc.balanceOf(keeper) - keeperBefore;
        uint256 treasuryProfit = usdc.balanceOf(treasury) - profitReceiverBefore;

        assertGt(keeperProfit, 0, "Keeper should receive profit share");
        assertGt(treasuryProfit, 0, "Treasury should receive profit");
        console2.log("Keeper profit:", keeperProfit);
        console2.log("Treasury profit:", treasuryProfit);

        // Keeper gets ~10% of total profit
        assertApproxEqRel(keeperProfit * 10, treasuryProfit + keeperProfit, 0.01e18);

        // Arb contract should have 0 balance
        assertEq(usdc.balanceOf(address(arb)), 0, "Arb contract should be empty");
    }

    function test_mintAndSell_vusd5PercentAbovePeg() public {
        // VUSD is trading at $1.05 on DEX (5% premium)
        dex.setPrice(1.05e18);

        uint256 flashAmount = 50_000e6;

        bytes memory swapCalldata =
            abi.encodeWithSelector(MockDex.swapAforB.selector, 50_000e18, 0);

        VUSDArbitrage.SwapParams memory swapParams = VUSDArbitrage.SwapParams({
            target: address(dex),
            approveTarget: address(dex),
            swapCalldata: swapCalldata,
            minAmountOut: 50_000e6
        });

        vm.prank(keeper);
        int256 profit = arb.mintAndSell(
            VUSDArbitrage.FlashLoanProvider.MORPHO, address(usdc), flashAmount, swapParams, 0
        );

        // Profit should be ~2500 USDC (5% of 50k)
        assertGt(profit, 0);
        // ~2500 USDC profit
        assertApproxEqAbs(uint256(profit), 2500e6, 10e6);
        console2.log("Profit at 5% premium (USDC):", uint256(profit));
    }

    /*//////////////////////////////////////////////////////////////
                        BUY AND REDEEM TESTS
                    (VUSD trades below $1 on DEX)
    //////////////////////////////////////////////////////////////*/

    function test_buyAndRedeem_vusdBelowPeg() public {
        // VUSD is trading at $0.97 on DEX (3% discount)
        dex.setPrice(0.97e18);

        uint256 flashAmount = 100_000e6; // 100k USDC

        // Build swap calldata: buy VUSD with USDC on DEX
        // Buy VUSD at $0.97 → get ~103092 VUSD for 100k USDC
        bytes memory swapCalldata =
            abi.encodeWithSelector(MockDex.swapBforA.selector, 100_000e6, 0);

        VUSDArbitrage.SwapParams memory swapParams = VUSDArbitrage.SwapParams({
            target: address(dex),
            approveTarget: address(dex),
            swapCalldata: swapCalldata,
            minAmountOut: 100_000e18 // At least get 100k VUSD
        });

        uint256 profitReceiverBefore = usdc.balanceOf(treasury);
        uint256 keeperBefore = usdc.balanceOf(keeper);

        vm.prank(keeper);
        int256 profit = arb.buyAndRedeem(
            VUSDArbitrage.FlashLoanProvider.MORPHO, address(usdc), flashAmount, swapParams, 0
        );

        // Profit = bought VUSD cheap at 0.97, redeemed at ~0.997 (1 - 0.3% redeem fee)
        // ~(0.997 - 0.97) * 103092 = ~2783 USDC
        assertGt(profit, 0, "Should be profitable");
        console2.log("Profit (USDC):", uint256(profit));

        uint256 keeperProfit = usdc.balanceOf(keeper) - keeperBefore;
        uint256 treasuryProfit = usdc.balanceOf(treasury) - profitReceiverBefore;
        console2.log("Keeper profit:", keeperProfit);
        console2.log("Treasury profit:", treasuryProfit);

        assertGt(keeperProfit, 0, "Keeper should receive profit share");
        assertGt(treasuryProfit, 0, "Treasury should receive profit");
        assertEq(usdc.balanceOf(address(arb)), 0, "Arb contract should be empty");
    }

    function test_buyAndRedeem_vusd2PercentBelowPeg() public {
        // VUSD is trading at $0.98 on DEX (2% discount)
        dex.setPrice(0.98e18);

        uint256 flashAmount = 200_000e6;

        bytes memory swapCalldata =
            abi.encodeWithSelector(MockDex.swapBforA.selector, 200_000e6, 0);

        VUSDArbitrage.SwapParams memory swapParams = VUSDArbitrage.SwapParams({
            target: address(dex),
            approveTarget: address(dex),
            swapCalldata: swapCalldata,
            minAmountOut: 200_000e18
        });

        vm.prank(keeper);
        int256 profit = arb.buyAndRedeem(
            VUSDArbitrage.FlashLoanProvider.MORPHO, address(usdc), flashAmount, swapParams, 0
        );

        assertGt(profit, 0, "Should be profitable");
        console2.log("Profit at 2% discount (USDC):", uint256(profit));
    }

    /*//////////////////////////////////////////////////////////////
                        MIN PROFIT TESTS
    //////////////////////////////////////////////////////////////*/

    function test_revert_mintAndSell_insufficientProfit() public {
        // VUSD barely above peg — profit won't meet minProfit
        dex.setPrice(1.001e18); // 0.1% premium

        uint256 flashAmount = 10_000e6;
        bytes memory swapCalldata =
            abi.encodeWithSelector(MockDex.swapAforB.selector, 10_000e18, 0);

        VUSDArbitrage.SwapParams memory swapParams = VUSDArbitrage.SwapParams({
            target: address(dex),
            approveTarget: address(dex),
            swapCalldata: swapCalldata,
            minAmountOut: 0
        });

        vm.prank(keeper);
        vm.expectRevert(); // InsufficientProfit
        arb.mintAndSell(
            VUSDArbitrage.FlashLoanProvider.MORPHO,
            address(usdc),
            flashAmount,
            swapParams,
            1000e6 // Require at least $1000 profit — impossible with 0.1% spread on 10k
        );
    }

    function test_revert_buyAndRedeem_insufficientProfit() public {
        dex.setPrice(0.999e18); // 0.1% discount

        uint256 flashAmount = 10_000e6;
        bytes memory swapCalldata =
            abi.encodeWithSelector(MockDex.swapBforA.selector, 10_000e6, 0);

        VUSDArbitrage.SwapParams memory swapParams = VUSDArbitrage.SwapParams({
            target: address(dex),
            approveTarget: address(dex),
            swapCalldata: swapCalldata,
            minAmountOut: 0
        });

        vm.prank(keeper);
        vm.expectRevert(); // Revert — spread too small to cover redeem fee
        arb.buyAndRedeem(
            VUSDArbitrage.FlashLoanProvider.MORPHO,
            address(usdc),
            flashAmount,
            swapParams,
            1000e6
        );
    }

    /*//////////////////////////////////////////////////////////////
                        STATIC CALL SIMULATION
    //////////////////////////////////////////////////////////////*/

    function test_staticCall_simulation_mintAndSell() public {
        dex.setPrice(1.03e18);

        uint256 flashAmount = 50_000e6;
        bytes memory swapCalldata =
            abi.encodeWithSelector(MockDex.swapAforB.selector, 50_000e18, 0);

        VUSDArbitrage.SwapParams memory swapParams = VUSDArbitrage.SwapParams({
            target: address(dex),
            approveTarget: address(dex),
            swapCalldata: swapCalldata,
            minAmountOut: 0
        });

        // Simulate via staticcall — should return profit without state changes
        vm.prank(keeper);
        int256 profit = arb.mintAndSell(
            VUSDArbitrage.FlashLoanProvider.MORPHO, address(usdc), flashAmount, swapParams, 0
        );

        assertGt(profit, 0);
        // ~1500 USDC (3% of 50k)
        assertApproxEqAbs(uint256(profit), 1500e6, 10e6);
    }

    function test_staticCall_simulation_buyAndRedeem() public {
        dex.setPrice(0.95e18);

        uint256 flashAmount = 100_000e6;
        bytes memory swapCalldata =
            abi.encodeWithSelector(MockDex.swapBforA.selector, 100_000e6, 0);

        VUSDArbitrage.SwapParams memory swapParams = VUSDArbitrage.SwapParams({
            target: address(dex),
            approveTarget: address(dex),
            swapCalldata: swapCalldata,
            minAmountOut: 0
        });

        vm.prank(keeper);
        int256 profit = arb.buyAndRedeem(
            VUSDArbitrage.FlashLoanProvider.MORPHO, address(usdc), flashAmount, swapParams, 0
        );

        assertGt(profit, 0);
        console2.log("Profit at 5% discount (USDC):", uint256(profit));
    }

    /*//////////////////////////////////////////////////////////////
                        ACCESS CONTROL TESTS
    //////////////////////////////////////////////////////////////*/

    function test_revert_notKeeper() public {
        VUSDArbitrage.SwapParams memory swapParams = VUSDArbitrage.SwapParams({
            target: address(dex),
            approveTarget: address(dex),
            swapCalldata: "",
            minAmountOut: 0
        });

        address randomUser = makeAddr("random");
        vm.prank(randomUser);
        vm.expectRevert(VUSDArbitrage.NotKeeper.selector);
        arb.mintAndSell(VUSDArbitrage.FlashLoanProvider.MORPHO, address(usdc), 1000e6, swapParams, 0);
    }

    function test_multipleKeepers() public {
        // Add a second keeper
        vm.prank(owner);
        arb.addKeeper(keeper2);

        dex.setPrice(1.02e18);

        bytes memory swapCalldata =
            abi.encodeWithSelector(MockDex.swapAforB.selector, 10_000e18, 0);

        VUSDArbitrage.SwapParams memory swapParams = VUSDArbitrage.SwapParams({
            target: address(dex),
            approveTarget: address(dex),
            swapCalldata: swapCalldata,
            minAmountOut: 0
        });

        // keeper2 should be able to execute
        vm.prank(keeper2);
        int256 profit = arb.mintAndSell(
            VUSDArbitrage.FlashLoanProvider.MORPHO, address(usdc), 10_000e6, swapParams, 0
        );
        assertGt(profit, 0);

        // keeper2's profit goes to keeper2 (10% share)
        assertGt(usdc.balanceOf(keeper2), 0, "Keeper2 should receive profit share");
    }

    function test_removeKeeper() public {
        vm.prank(owner);
        arb.removeKeeper(keeper);

        VUSDArbitrage.SwapParams memory swapParams = VUSDArbitrage.SwapParams({
            target: address(dex),
            approveTarget: address(dex),
            swapCalldata: "",
            minAmountOut: 0
        });

        vm.prank(keeper);
        vm.expectRevert(VUSDArbitrage.NotKeeper.selector);
        arb.mintAndSell(VUSDArbitrage.FlashLoanProvider.MORPHO, address(usdc), 1000e6, swapParams, 0);
    }

    /*//////////////////////////////////////////////////////////////
                        ADMIN TESTS
    //////////////////////////////////////////////////////////////*/

    function test_setKeeperShareBps() public {
        vm.prank(owner);
        arb.setKeeperShareBps(2000); // 20%
        assertEq(arb.keeperShareBps(), 2000);
    }

    function test_revert_setKeeperShareTooHigh() public {
        vm.prank(owner);
        vm.expectRevert();
        arb.setKeeperShareBps(6000); // 60% > MAX_KEEPER_SHARE_BPS (50%)
    }

    function test_zeroKeeperShare() public {
        // Set keeper share to 0 — all profit goes to treasury
        vm.prank(owner);
        arb.setKeeperShareBps(0);

        dex.setPrice(1.02e18);
        uint256 flashAmount = 100_000e6;
        bytes memory swapCalldata =
            abi.encodeWithSelector(MockDex.swapAforB.selector, 100_000e18, 0);

        VUSDArbitrage.SwapParams memory swapParams = VUSDArbitrage.SwapParams({
            target: address(dex),
            approveTarget: address(dex),
            swapCalldata: swapCalldata,
            minAmountOut: 0
        });

        uint256 keeperBefore = usdc.balanceOf(keeper);

        vm.prank(keeper);
        arb.mintAndSell(VUSDArbitrage.FlashLoanProvider.MORPHO, address(usdc), flashAmount, swapParams, 0);

        assertEq(usdc.balanceOf(keeper) - keeperBefore, 0, "Keeper should get 0 with 0% share");
        assertGt(usdc.balanceOf(treasury), 0, "All profit to treasury");
    }

    function test_setTreasury() public {
        address newTreasury = makeAddr("newTreasury");
        vm.prank(owner);
        arb.setTreasury(newTreasury);
        assertEq(arb.treasury(), newTreasury);
    }

    function test_rescueTokens() public {
        // Send some tokens to arb contract directly (stuck tokens)
        usdc.mint(address(arb), 500e6);

        uint256 treasuryBefore = usdc.balanceOf(treasury);

        vm.prank(keeper);
        arb.rescueTokens(address(usdc));

        assertEq(usdc.balanceOf(address(arb)), 0, "Arb should be empty");
        assertEq(usdc.balanceOf(treasury) - treasuryBefore, 500e6, "Treasury should receive rescued tokens");
    }

    function test_viewFunctions() public view {
        assertTrue(arb.isKeeper(keeper));
        assertFalse(arb.isKeeper(keeper2));
        assertEq(arb.keeperCount(), 1);

        address[] memory keepers = arb.getKeepers();
        assertEq(keepers.length, 1);
        assertEq(keepers[0], keeper);
    }

    function test_emergencyWithdraw() public {
        // Send some tokens to arb contract directly
        usdc.mint(address(arb), 1000e6);

        vm.prank(owner);
        arb.emergencyWithdraw(address(usdc), owner, 1000e6);
        assertEq(usdc.balanceOf(owner), 1000e6);
    }

    function test_revert_notOwner_adminFunctions() public {
        vm.startPrank(keeper);

        vm.expectRevert();
        arb.addKeeper(makeAddr("newKeeper"));

        vm.expectRevert();
        arb.removeKeeper(keeper);

        vm.expectRevert();
        arb.setTreasury(makeAddr("newTreasury"));

        vm.expectRevert();
        arb.setKeeperShareBps(500);

        vm.expectRevert();
        arb.setGateway(makeAddr("newGateway"));

        vm.expectRevert();
        arb.emergencyWithdraw(address(usdc), keeper, 100);

        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                    KEEPER RESTRICTION TOGGLE TESTS
    //////////////////////////////////////////////////////////////*/

    function test_keeperRestrictionDisabled_anyoneCanCall() public {
        // Disable keeper restriction
        vm.prank(owner);
        arb.setKeeperRestriction(false);
        assertFalse(arb.keeperRestrictionEnabled());

        dex.setPrice(1.02e18);

        bytes memory swapCalldata =
            abi.encodeWithSelector(MockDex.swapAforB.selector, 10_000e18, 0);

        VUSDArbitrage.SwapParams memory swapParams = VUSDArbitrage.SwapParams({
            target: address(dex),
            approveTarget: address(dex),
            swapCalldata: swapCalldata,
            minAmountOut: 0
        });

        // Random non-keeper user can now call
        address randomUser = makeAddr("random");
        vm.prank(randomUser);
        int256 profit = arb.mintAndSell(
            VUSDArbitrage.FlashLoanProvider.MORPHO, address(usdc), 10_000e6, swapParams, 0
        );
        assertGt(profit, 0, "Random user should be able to arb when restriction disabled");

        // Caller (randomUser) gets keeper share
        assertGt(usdc.balanceOf(randomUser), 0, "Caller should receive keeper share");
    }

    function test_keeperRestrictionReEnabled_blocksNonKeeper() public {
        // Disable then re-enable
        vm.startPrank(owner);
        arb.setKeeperRestriction(false);
        arb.setKeeperRestriction(true);
        vm.stopPrank();

        assertTrue(arb.keeperRestrictionEnabled());

        VUSDArbitrage.SwapParams memory swapParams = VUSDArbitrage.SwapParams({
            target: address(dex),
            approveTarget: address(dex),
            swapCalldata: "",
            minAmountOut: 0
        });

        address randomUser = makeAddr("random");
        vm.prank(randomUser);
        vm.expectRevert(VUSDArbitrage.NotKeeper.selector);
        arb.mintAndSell(VUSDArbitrage.FlashLoanProvider.MORPHO, address(usdc), 1000e6, swapParams, 0);
    }

    function test_keeperRestrictionDefault_isEnabled() public view {
        assertTrue(arb.keeperRestrictionEnabled(), "Keeper restriction should be enabled by default");
    }

    /*//////////////////////////////////////////////////////////////
                        PROVIDER NOT SET TEST
    //////////////////////////////////////////////////////////////*/

    function test_revert_providerNotSet() public {
        VUSDArbitrage.SwapParams memory swapParams = VUSDArbitrage.SwapParams({
            target: address(dex),
            approveTarget: address(dex),
            swapCalldata: "",
            minAmountOut: 0
        });

        vm.prank(keeper);
        vm.expectRevert(VUSDArbitrage.ProviderNotSet.selector);
        arb.mintAndSell(
            VUSDArbitrage.FlashLoanProvider.AAVE_V3, // Not set
            address(usdc),
            1000e6,
            swapParams,
            0
        );
    }
}
