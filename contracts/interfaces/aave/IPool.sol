// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IPool - Aave V3 Pool interface (flashloan subset)
interface IPool {
    /// @notice Execute a simple flash loan (single asset)
    /// @param receiverAddress Contract that will receive the flash-loaned assets and execute the callback
    /// @param asset The address of the asset to flash loan
    /// @param amount The amount to flash loan
    /// @param params Arbitrary bytes to pass to the receiver's executeOperation callback
    /// @param referralCode Referral code (use 0)
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;

    /// @notice Returns the total flash loan premium as a percentage (in bps, e.g. 5 = 0.05%)
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
}

/// @title IFlashLoanSimpleReceiver - Aave V3 callback interface
interface IFlashLoanSimpleReceiver {
    /// @notice Called by Aave Pool after flash loan funds are sent to the receiver
    /// @param asset The address of the flash-loaned asset
    /// @param amount The amount flash-loaned
    /// @param premium The fee charged for the flash loan
    /// @param initiator The address that initiated the flash loan
    /// @param params The arbitrary data passed from the flash loan call
    /// @return True if the operation was successful
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}
