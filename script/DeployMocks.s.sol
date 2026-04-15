// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {VUSDArbitrage} from "../contracts/VUSDArbitrage.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";
import {MockGateway} from "../test/mocks/MockGateway.sol";
import {MockDex} from "../test/mocks/MockDex.sol";
import {MockMorpho} from "../test/mocks/MockMorpho.sol";

/// @title DeployMocks — Deploy full mock environment to Anvil for E2E testing
/// @dev Replicates the same setup as test/VUSDArbitrage.t.sol::setUp()
contract DeployMocks is Script {
    function run() external {
        vm.startBroadcast();

        // 1. Deploy tokens
        MockERC20 usdc = new MockERC20("USD Coin", "USDC", 6);
        MockERC20 vusd = new MockERC20("Vetro USD", "VUSD", 18);

        // 2. Deploy MockGateway (0% mint fee, 30bps redeem fee)
        MockGateway gateway = new MockGateway(address(vusd), 0, 30);

        // 3. Fund gateway with USDC for redemptions
        usdc.mint(address(gateway), 10_000_000e6);

        // 4. Deploy MockDex at peg (price=1e18). Tests call setPrice() to adjust.
        MockDex dex = new MockDex(address(vusd), address(usdc), 1e18);

        // 5. Fund DEX with liquidity
        vusd.mint(address(dex), 5_000_000e18);
        usdc.mint(address(dex), 5_000_000e6);

        // 6. Deploy MockMorpho and fund it
        MockMorpho morpho = new MockMorpho();
        usdc.mint(address(morpho), 10_000_000e6);

        // 7. Deploy VUSDArbitrage
        address keeper = msg.sender;
        address treasury = address(0x70997970C51812dc3A010C7d01b50e0d17dc79C8);
        VUSDArbitrage arb = new VUSDArbitrage(address(gateway), keeper, treasury, 1000, msg.sender);

        // 8. Set Morpho as flash loan provider
        arb.setMorpho(address(morpho));

        // 9. Whitelist arb contract for instant redeem
        gateway.addToInstantRedeemWhitelist(address(arb));

        vm.stopBroadcast();

        // 10. Output addresses as parseable JSON
        console2.log("DEPLOYED_ADDRESSES_JSON_START");
        console2.log("{");
        console2.log(string.concat('  "usdc": "', vm.toString(address(usdc)), '",'));
        console2.log(string.concat('  "vusd": "', vm.toString(address(vusd)), '",'));
        console2.log(string.concat('  "gateway": "', vm.toString(address(gateway)), '",'));
        console2.log(string.concat('  "dex": "', vm.toString(address(dex)), '",'));
        console2.log(string.concat('  "morpho": "', vm.toString(address(morpho)), '",'));
        console2.log(string.concat('  "arb": "', vm.toString(address(arb)), '",'));
        console2.log(string.concat('  "keeper": "', vm.toString(keeper), '",'));
        console2.log(string.concat('  "treasury": "', vm.toString(treasury), '"'));
        console2.log("}");
        console2.log("DEPLOYED_ADDRESSES_JSON_END");
    }
}
