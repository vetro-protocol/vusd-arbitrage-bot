// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {VUSDArbitrage} from "../contracts/VUSDArbitrage.sol";

contract Deploy is Script {
    function run() external {
        // Load from environment variables
        address gateway = vm.envAddress("GATEWAY_ADDRESS");
        address keeper = vm.envAddress("KEEPER_ADDRESS");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        address owner = vm.envAddress("OWNER_ADDRESS");
        uint256 keeperShareBps = vm.envOr("KEEPER_SHARE_BPS", uint256(0));

        // Optional: flash loan provider addresses
        address aavePool = vm.envOr("AAVE_V3_POOL", address(0));
        address morpho = vm.envOr("MORPHO_ADDRESS", address(0));
        address balancerVault = vm.envOr("BALANCER_VAULT", address(0));

        vm.startBroadcast();

        VUSDArbitrage arb = new VUSDArbitrage(gateway, keeper, treasury, keeperShareBps, owner);

        console2.log("VUSDArbitrage deployed at:", address(arb));
        console2.log("Gateway:", gateway);
        console2.log("Keeper:", keeper);
        console2.log("Treasury:", treasury);
        console2.log("Keeper Share BPS:", keeperShareBps);

        // Set provider addresses if provided
        if (aavePool != address(0)) {
            arb.setProviderAddress(VUSDArbitrage.FlashLoanProvider.AAVE_V3, aavePool);
            console2.log("Aave V3 Pool set:", aavePool);
        }

        if (morpho != address(0)) {
            arb.setProviderAddress(VUSDArbitrage.FlashLoanProvider.MORPHO, morpho);
            console2.log("Morpho set:", morpho);
        }

        if (balancerVault != address(0)) {
            arb.setProviderAddress(VUSDArbitrage.FlashLoanProvider.BALANCER, balancerVault);
            console2.log("Balancer Vault set:", balancerVault);
        }

        vm.stopBroadcast();
    }
}
