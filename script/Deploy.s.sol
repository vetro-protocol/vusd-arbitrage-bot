// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {VetroArbitrage} from "../contracts/VetroArbitrage.sol";

/// @notice Deploys VetroArbitrage against a Vetro Gateway.
///         Pass PRODUCT=VUSD (default) or PRODUCT=VETBTC to pick the Gateway.
///
/// Flow:
///   1. Deploy with the deployer as initial owner (so we can call setMorpho())
///   2. setMorpho() to wire the flashloan provider
///   3. If OWNER_ADDRESS != deployer, transferOwnership(OWNER_ADDRESS) — Ownable2Step,
///      so OWNER_ADDRESS must then call acceptOwnership() in a follow-up tx
///
/// Env vars:
///   PRIVATE_KEY        Deployer private key (required)
///   KEEPER_ADDRESS     Initial keeper to whitelist (required)
///   OWNER_ADDRESS      Final admin/owner address (required). Can equal deployer.
///   PRODUCT            "VUSD" (default) or "VETBTC"
///   KEEPER_SHARE_BPS   Optional, defaults to 0 (max 5000 = 50%)
///   TREASURY_ADDRESS   Optional override of the product's default treasury
contract Deploy is Script {
    // ── Per-product Gateways + Treasuries ────────────────────────
    address constant VUSD_GATEWAY = 0xDaD503f8B9d42bb7af3AfC588358D30163e4416F;
    address constant VUSD_TREASURY = 0xC8317A10385BE07901A4c9ee3d06E1D83AE378c9;

    address constant VETBTC_GATEWAY = 0xCBA2Ffa0AC52d7871a4221a871793Eb788013faB;
    address constant VETBTC_TREASURY = 0xd25a7b0b817fD816d0995eC67fb70e75EE65Bd7F;

    // ── Shared infra ─────────────────────────────────────────────
    /// @dev Morpho Blue — supports flashLoan() for any token with supply liquidity.
    ///      WBTC + cbBTC markets are well-funded; verify hemiBTC has Morpho liquidity
    ///      before relying on it for vetBTC arbs.
    address constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;

    function run() external {
        // ── Read env ────────────────────────────────────────────
        string memory product = vm.envOr("PRODUCT", string("VUSD"));
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address keeper = vm.envAddress("KEEPER_ADDRESS");
        address finalOwner = vm.envAddress("OWNER_ADDRESS");
        uint256 keeperShareBps = vm.envOr("KEEPER_SHARE_BPS", uint256(0));

        (address gateway, address defaultTreasury) = _resolveProduct(product);
        address treasury = vm.envOr("TREASURY_ADDRESS", defaultTreasury);

        // ── Pre-deploy summary ──────────────────────────────────
        console2.log("=== VetroArbitrage Deploy ===");
        console2.log("Product:           ", product);
        console2.log("Gateway:           ", gateway);
        console2.log("Treasury:          ", treasury);
        console2.log("Keeper:            ", keeper);
        console2.log("Keeper share (bps):", keeperShareBps);
        console2.log("Deployer:          ", deployer);
        console2.log("Final owner:       ", finalOwner);
        console2.log("Morpho:            ", MORPHO);

        // ── Broadcast ───────────────────────────────────────────
        vm.startBroadcast(deployerKey);

        // 1. Deploy with deployer as initial owner so we can configure
        VetroArbitrage arb = new VetroArbitrage(gateway, keeper, treasury, keeperShareBps, deployer);

        // 2. Wire Morpho
        arb.setMorpho(MORPHO);

        // 3. Hand off ownership if needed (Ownable2Step — new owner must accept)
        if (finalOwner != deployer) {
            arb.transferOwnership(finalOwner);
        }

        vm.stopBroadcast();

        // ── Post-deploy output ──────────────────────────────────
        console2.log("");
        console2.log("=== Deployed ===");
        console2.log("VetroArbitrage:", address(arb));
        console2.log("");
        console2.log("Next steps:");
        if (finalOwner != deployer) {
            console2.log("  1. From OWNER_ADDRESS, call: acceptOwnership()");
            console2.log("     cast send", address(arb), '"acceptOwnership()" --from', finalOwner);
        }
        console2.log("  2. Update src/products.ts: set arbitrageAddress for", product);
        console2.log("     OR set ARBITRAGE_ADDRESS=", address(arb), "in .env");
        console2.log("  3. Vetro admin: whitelist this contract on the Gateway for instant redeem");
        console2.log("     Gateway:", gateway);
    }

    function _resolveProduct(string memory product) internal pure returns (address gateway, address treasury) {
        bytes32 h = keccak256(bytes(product));
        if (h == keccak256("VUSD")) {
            return (VUSD_GATEWAY, VUSD_TREASURY);
        }
        if (h == keccak256("VETBTC")) {
            return (VETBTC_GATEWAY, VETBTC_TREASURY);
        }
        revert(string.concat("Unknown PRODUCT: ", product, " (expected VUSD or VETBTC)"));
    }
}
