// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {VUSDArbitrage} from "../contracts/VUSDArbitrage.sol";

contract Deploy is Script {
    // ── Mainnet constants ────────────────────────────────────────
    address constant GATEWAY = 0xDaD503f8B9d42bb7af3AfC588358D30163e4416F;
    address constant TREASURY = 0xC8317A10385BE07901A4c9ee3d06E1D83AE378c9;
    address constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;

    function run() external {
        address keeper = vm.envAddress("KEEPER_ADDRESS");
        address owner = vm.envAddress("OWNER_ADDRESS");
        uint256 keeperShareBps = vm.envOr("KEEPER_SHARE_BPS", uint256(0));

        vm.startBroadcast();

        VUSDArbitrage arb = new VUSDArbitrage(GATEWAY, keeper, TREASURY, keeperShareBps, owner);

        console2.log("VUSDArbitrage deployed at:", address(arb));
        console2.log("Gateway:", GATEWAY);
        console2.log("Keeper:", keeper);
        console2.log("Treasury:", TREASURY);
        console2.log("Keeper Share BPS:", keeperShareBps);

        // Set flash loan provider address
        arb.setMorpho(MORPHO);
        console2.log("Morpho set:", MORPHO);

        vm.stopBroadcast();
    }
}
