// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MockERC20} from "./MockERC20.sol";

/// @title MockDex - Simple constant-price DEX for testing
/// @dev Supports swapping between two tokens at a configurable rate
contract MockDex {
    using SafeERC20 for IERC20;

    IERC20 public tokenA; // e.g., VUSD (18 decimals)
    IERC20 public tokenB; // e.g., USDC (6 decimals)
    uint8 public decimalsA;
    uint8 public decimalsB;

    /// @notice Price of tokenA in tokenB terms, scaled by 1e18
    /// e.g., 0.98e18 means 1 tokenA = 0.98 tokenB
    uint256 public priceAinB;

    constructor(address tokenA_, address tokenB_, uint256 priceAinB_) {
        tokenA = IERC20(tokenA_);
        tokenB = IERC20(tokenB_);
        decimalsA = MockERC20(tokenA_).decimals();
        decimalsB = MockERC20(tokenB_).decimals();
        priceAinB = priceAinB_;
    }

    function setPrice(uint256 priceAinB_) external {
        priceAinB = priceAinB_;
    }

    /// @notice Swap tokenA for tokenB (sell VUSD for USDC)
    function swapAforB(uint256 amountA, uint256 minAmountB) external returns (uint256 amountB) {
        // amountB = amountA * priceAinB / 1e18, adjusted for decimal difference
        amountB = (amountA * priceAinB) / 1e18;
        // Convert from tokenA decimals to tokenB decimals
        if (decimalsA > decimalsB) {
            amountB = amountB / (10 ** (decimalsA - decimalsB));
        } else if (decimalsB > decimalsA) {
            amountB = amountB * (10 ** (decimalsB - decimalsA));
        }

        require(amountB >= minAmountB, "MockDex: slippage");

        tokenA.safeTransferFrom(msg.sender, address(this), amountA);
        tokenB.safeTransfer(msg.sender, amountB);
    }

    /// @notice Swap tokenB for tokenA (buy VUSD with USDC)
    function swapBforA(uint256 amountB, uint256 minAmountA) external returns (uint256 amountA) {
        // amountA = amountB * 1e18 / priceAinB, adjusted for decimal difference
        // Convert amountB to tokenA decimals first
        uint256 amountBInADecimals = amountB;
        if (decimalsA > decimalsB) {
            amountBInADecimals = amountB * (10 ** (decimalsA - decimalsB));
        } else if (decimalsB > decimalsA) {
            amountBInADecimals = amountB / (10 ** (decimalsB - decimalsA));
        }
        amountA = (amountBInADecimals * 1e18) / priceAinB;

        require(amountA >= minAmountA, "MockDex: slippage");

        tokenB.safeTransferFrom(msg.sender, address(this), amountB);
        tokenA.safeTransfer(msg.sender, amountA);
    }
}
