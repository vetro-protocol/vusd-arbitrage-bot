// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title IBalancerVault - Balancer V2 Vault flash loan interface
interface IBalancerVault {
    /// @notice Execute a flash loan for one or more tokens
    /// @param recipient Contract that will receive the flash-loaned tokens and execute the callback
    /// @param tokens Array of token addresses to flash loan
    /// @param amounts Array of amounts to flash loan (corresponding to tokens)
    /// @param userData Arbitrary bytes passed to the callback
    function flashLoan(
        address recipient,
        IERC20[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}

/// @title IFlashLoanRecipient - Balancer V2 callback interface
interface IFlashLoanRecipient {
    /// @notice Called by Balancer Vault after flash loan funds are sent
    /// @param tokens Array of flash-loaned token addresses
    /// @param amounts Array of flash-loaned amounts
    /// @param feeAmounts Array of fees for each token
    /// @param userData The arbitrary data passed from the flash loan call
    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external;
}
