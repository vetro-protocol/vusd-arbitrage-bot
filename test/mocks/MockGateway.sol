// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MockERC20} from "./MockERC20.sol";
import {IPeggedToken} from "../../contracts/interfaces/IPeggedToken.sol";

/// @title MockGateway - Simulates Vetro Gateway for testing
/// @dev Mints/burns VUSD at 1:1 rate minus configurable fees
contract MockGateway {
    using SafeERC20 for IERC20;

    MockERC20 public peggedToken; // VUSD
    uint256 public mintFeeBps; // e.g., 0 = 0%
    uint256 public redeemFeeBps; // e.g., 30 = 0.3%
    uint256 public constant MAX_BPS = 10_000;

    mapping(address => bool) public instantRedeemWhitelist;

    constructor(address peggedToken_, uint256 mintFeeBps_, uint256 redeemFeeBps_) {
        peggedToken = MockERC20(peggedToken_);
        mintFeeBps = mintFeeBps_;
        redeemFeeBps = redeemFeeBps_;
    }

    // solhint-disable-next-line func-name-mixedcase
    function PEGGED_TOKEN() external view returns (IPeggedToken) {
        return IPeggedToken(address(peggedToken));
    }

    function addToInstantRedeemWhitelist(address account_) external {
        instantRedeemWhitelist[account_] = true;
    }

    function isInstantRedeemWhitelisted(address account_) external view returns (bool) {
        return instantRedeemWhitelist[account_];
    }

    function mintFee(address) external view returns (uint256) {
        return mintFeeBps;
    }

    function redeemFee(address) external view returns (uint256) {
        return redeemFeeBps;
    }

    function maxMint() external pure returns (uint256) {
        return type(uint256).max;
    }

    function maxWithdraw(address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function previewDeposit(address tokenIn_, uint256 amountIn_) external view returns (uint256) {
        uint256 afterFee = mintFeeBps > 0 ? (amountIn_ * (MAX_BPS - mintFeeBps)) / MAX_BPS : amountIn_;
        uint8 tokenDecimals = MockERC20(tokenIn_).decimals();
        uint8 vusdDecimals = peggedToken.decimals();
        return afterFee * 10 ** (vusdDecimals - tokenDecimals);
    }

    function previewRedeem(address tokenOut_, uint256 peggedTokenIn_) external view returns (uint256) {
        uint256 afterFee =
            redeemFeeBps > 0 ? (peggedTokenIn_ * (MAX_BPS - redeemFeeBps)) / MAX_BPS : peggedTokenIn_;
        uint8 tokenDecimals = MockERC20(tokenOut_).decimals();
        uint8 vusdDecimals = peggedToken.decimals();
        return afterFee / 10 ** (vusdDecimals - tokenDecimals);
    }

    /// @notice Deposit stablecoin, receive VUSD
    function deposit(address tokenIn_, uint256 amountIn_, uint256 minPeggedTokenOut_, address receiver_)
        external
        returns (uint256 vusdOut)
    {
        // Pull stablecoin from caller
        IERC20(tokenIn_).safeTransferFrom(msg.sender, address(this), amountIn_);

        // Calculate VUSD to mint (1:1 minus fee, adjusted for decimals)
        uint256 afterFee = mintFeeBps > 0 ? (amountIn_ * (MAX_BPS - mintFeeBps)) / MAX_BPS : amountIn_;
        uint8 tokenDecimals = MockERC20(tokenIn_).decimals();
        uint8 vusdDecimals = peggedToken.decimals();
        vusdOut = afterFee * 10 ** (vusdDecimals - tokenDecimals);

        require(vusdOut >= minPeggedTokenOut_, "MockGateway: insufficient output");

        // Mint VUSD to receiver
        peggedToken.mint(receiver_, vusdOut);
    }

    /// @notice Redeem VUSD for stablecoin
    function redeem(address tokenOut_, uint256 peggedTokenIn_, uint256 minAmountOut_, address receiver_)
        external
        returns (uint256 tokenOut)
    {
        require(instantRedeemWhitelist[msg.sender], "MockGateway: not whitelisted");

        // Burn VUSD from caller
        peggedToken.burn(msg.sender, peggedTokenIn_);

        // Calculate stablecoin to return (1:1 minus fee, adjusted for decimals)
        uint256 afterFee =
            redeemFeeBps > 0 ? (peggedTokenIn_ * (MAX_BPS - redeemFeeBps)) / MAX_BPS : peggedTokenIn_;
        uint8 tokenDecimals = MockERC20(tokenOut_).decimals();
        uint8 vusdDecimals = peggedToken.decimals();
        tokenOut = afterFee / 10 ** (vusdDecimals - tokenDecimals);

        require(tokenOut >= minAmountOut_, "MockGateway: insufficient output");

        // Transfer stablecoin to receiver
        IERC20(tokenOut_).safeTransfer(receiver_, tokenOut);
    }

    function treasury() external view returns (address) {
        return address(this);
    }
}
