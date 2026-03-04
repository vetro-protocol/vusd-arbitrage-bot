// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IMorpho - Morpho flash loan interface
interface IMorpho {
    /// @notice Execute a flash loan
    /// @param token The address of the token to flash loan
    /// @param assets The amount to flash loan
    /// @param data Arbitrary bytes passed to the callback
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

/// @title IMorphoFlashLoanCallback - Morpho callback interface
interface IMorphoFlashLoanCallback {
    /// @notice Called by Morpho after flash loan funds are sent
    /// @param assets The amount flash-loaned
    /// @param data The arbitrary data passed from the flash loan call
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external;
}
