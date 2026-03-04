// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IPeggedToken} from "./IPeggedToken.sol";

/// @title IGateway - Interface for PeggedToken Gateway
interface IGateway {
    function deposit(address tokenIn_, uint256 amountIn_, uint256 minPeggedTokenOut_, address receiver_)
        external
        returns (uint256);

    function redeem(address tokenOut_, uint256 peggedTokenIn_, uint256 minAmountOut_, address receiver_)
        external
        returns (uint256);

    function previewDeposit(address tokenIn_, uint256 amountIn_) external view returns (uint256);

    function previewRedeem(address tokenOut_, uint256 peggedTokenIn_) external view returns (uint256);

    function mintFee(address token_) external view returns (uint256);

    function redeemFee(address token_) external view returns (uint256);

    function maxMint() external view returns (uint256);

    function maxWithdraw(address tokenOut_) external view returns (uint256);

    // solhint-disable-next-line func-name-mixedcase
    function PEGGED_TOKEN() external view returns (IPeggedToken);

    function treasury() external view returns (address);

    function isInstantRedeemWhitelisted(address account_) external view returns (bool);
}
