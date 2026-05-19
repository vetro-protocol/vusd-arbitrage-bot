// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import {IGateway} from "./interfaces/IGateway.sol";
import {IMorpho, IMorphoFlashLoanCallback} from "./interfaces/morpho/IMorpho.sol";

/// @title VetroArbitrage
/// @notice Generic arbitrage contract between any Vetro Gateway (mint/redeem) and DEXes.
///         Works for any product whose Gateway exposes `PEGGED_TOKEN()` (VUSD, vetBTC, …).
/// @dev Pegged token is auto-discovered from the Gateway at construction / setGateway time.
///      Flashloan-funded (Morpho only), keeper-gated, profit split between caller and treasury.
contract VetroArbitrage is
    Ownable2Step,
    ReentrancyGuardTransient,
    IMorphoFlashLoanCallback
{
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    /*//////////////////////////////////////////////////////////////
                                TYPES
    //////////////////////////////////////////////////////////////*/

    enum ArbDirection {
        MINT_AND_SELL,
        BUY_AND_REDEEM
    }

    struct SwapParams {
        address target; // Contract to CALL (DEX router / aggregator)
        address approveTarget; // Contract to APPROVE (may differ from target)
        bytes swapCalldata; // Raw calldata from aggregator API or router
        uint256 minAmountOut; // On-chain slippage guard
    }

    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    uint256 public constant MAX_BPS = 10_000;
    uint256 public constant MAX_KEEPER_SHARE_BPS = 5000; // 50% max

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event KeeperAdded(address indexed keeper);
    event KeeperRemoved(address indexed keeper);
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event KeeperShareUpdated(uint256 previousShareBps, uint256 newShareBps);
    event GatewayUpdated(address indexed previousGateway, address indexed newGateway);
    event MorphoUpdated(address indexed previousMorpho, address indexed newMorpho);
    event ArbitrageExecuted(
        ArbDirection indexed direction,
        address indexed underlying,
        uint256 flashAmount,
        int256 profit,
        uint256 keeperProfit,
        uint256 treasuryProfit
    );
    event TokensRescued(address indexed token, address indexed to, uint256 amount, address indexed rescuer);
    event KeeperRestrictionUpdated(bool enabled);

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error NotKeeper();
    error AddressIsZero();
    error MorphoNotSet();
    error InvalidSender();
    error InvalidInitiator();
    error TokenMismatch();
    error InsufficientOutputAmount(uint256 actual, uint256 minRequired);
    error KeeperShareTooHigh(uint256 shareBps, uint256 maxBps);
    error KeeperAlreadyAdded(address keeper);
    error KeeperNotFound(address keeper);
    error InsufficientProfit(int256 actual, uint256 minRequired);

    /*//////////////////////////////////////////////////////////////
                            STATE VARIABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice Active Vetro Gateway (VUSD or vetBTC variant)
    IGateway public gateway;
    /// @notice Pegged token managed by `gateway` (auto-derived from Gateway.PEGGED_TOKEN())
    IERC20 public peggedToken;
    /// @notice Receives profit after keeper share
    address public treasury;
    /// @notice Morpho flash loan pool
    address public morpho;

    /// @notice Keeper share of profit in BPS (e.g., 1000 = 10%). Can be 0.
    uint256 public keeperShareBps;

    /// @notice When true, only whitelisted keepers can call entry points. When false, anyone can call.
    bool public keeperRestrictionEnabled;

    EnumerableSet.AddressSet private _keepers;

    /// @dev Set in callback, read/returned from entry point, zeroed after use
    int256 private _lastProfit;

    /*//////////////////////////////////////////////////////////////
                              MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier onlyKeeper() {
        if (keeperRestrictionEnabled && !_keepers.contains(msg.sender)) revert NotKeeper();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                             CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(
        address gateway_,
        address keeper_,
        address treasury_,
        uint256 keeperShareBps_,
        address owner_
    ) Ownable(owner_) {
        if (gateway_ == address(0) || keeper_ == address(0) || treasury_ == address(0)) {
            revert AddressIsZero();
        }
        if (keeperShareBps_ > MAX_KEEPER_SHARE_BPS) {
            revert KeeperShareTooHigh(keeperShareBps_, MAX_KEEPER_SHARE_BPS);
        }

        gateway = IGateway(gateway_);
        peggedToken = IERC20(address(IGateway(gateway_).PEGGED_TOKEN()));
        treasury = treasury_;
        keeperShareBps = keeperShareBps_;
        keeperRestrictionEnabled = true;

        _keepers.add(keeper_);
        emit KeeperAdded(keeper_);
    }

    /*//////////////////////////////////////////////////////////////
                           ENTRY POINTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Mint pegged token via Gateway and sell on DEX (when pegged > peg on DEX)
    /// @param underlying_ Underlying token address (USDC/USDT for VUSD; WBTC/cbBTC/hemiBTC for vetBTC)
    /// @param flashAmount_ Amount of underlying to flash loan
    /// @param swapParams_ DEX swap parameters for selling pegged token
    /// @param minProfit_ Minimum total profit required (reverts if not met). Use 0 to skip check.
    /// @return profit Net profit in underlying (negative if unprofitable)
    function mintAndSell(
        address underlying_,
        uint256 flashAmount_,
        SwapParams calldata swapParams_,
        uint256 minProfit_
    ) external nonReentrant onlyKeeper returns (int256 profit) {
        _lastProfit = 0;

        bytes memory data = abi.encode(ArbDirection.MINT_AND_SELL, underlying_, swapParams_);

        _initiateFlashLoan(underlying_, flashAmount_, data);

        profit = _lastProfit;
        _lastProfit = 0;

        if (minProfit_ > 0 && (profit < 0 || uint256(profit) < minProfit_)) {
            revert InsufficientProfit(profit, minProfit_);
        }

        (uint256 keeperAmount, uint256 treasuryAmount) = _distributeProfit(underlying_);

        emit ArbitrageExecuted(ArbDirection.MINT_AND_SELL, underlying_, flashAmount_, profit, keeperAmount, treasuryAmount);
    }

    /// @notice Buy pegged token on DEX and redeem via Gateway (when pegged < peg on DEX)
    /// @param underlying_ Underlying token address (USDC/USDT for VUSD; WBTC/cbBTC/hemiBTC for vetBTC)
    /// @param flashAmount_ Amount of underlying to flash loan
    /// @param swapParams_ DEX swap parameters for buying pegged token
    /// @param minProfit_ Minimum total profit required (reverts if not met). Use 0 to skip check.
    /// @return profit Net profit in underlying (negative if unprofitable)
    function buyAndRedeem(
        address underlying_,
        uint256 flashAmount_,
        SwapParams calldata swapParams_,
        uint256 minProfit_
    ) external nonReentrant onlyKeeper returns (int256 profit) {
        _lastProfit = 0;

        bytes memory data = abi.encode(ArbDirection.BUY_AND_REDEEM, underlying_, swapParams_);

        _initiateFlashLoan(underlying_, flashAmount_, data);

        profit = _lastProfit;
        _lastProfit = 0;

        if (minProfit_ > 0 && (profit < 0 || uint256(profit) < minProfit_)) {
            revert InsufficientProfit(profit, minProfit_);
        }

        (uint256 keeperAmount, uint256 treasuryAmount) = _distributeProfit(underlying_);

        emit ArbitrageExecuted(ArbDirection.BUY_AND_REDEEM, underlying_, flashAmount_, profit, keeperAmount, treasuryAmount);
    }

    /// @notice Rescue any tokens stuck in the contract to treasury. Callable by keepers.
    /// @param token_ Token address to rescue
    function rescueTokens(address token_) external onlyKeeper {
        uint256 balance = IERC20(token_).balanceOf(address(this));
        if (balance > 0) {
            IERC20(token_).safeTransfer(treasury, balance);
            emit TokensRescued(token_, treasury, balance, msg.sender);
        }
    }

    /*//////////////////////////////////////////////////////////////
                       FLASHLOAN CALLBACK (Morpho)
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IMorphoFlashLoanCallback
    function onMorphoFlashLoan(uint256 assets_, bytes calldata data_) external {
        if (msg.sender != morpho) revert InvalidSender();

        // Morpho callback doesn't pass token address — decode from our data
        (, address underlying_,) = abi.decode(data_, (ArbDirection, address, SwapParams));

        _onFlashLoanReceived(underlying_, assets_, 0, data_);

        // Morpho pulls funds back via safeTransferFrom — approve instead of transfer
        IERC20(underlying_).forceApprove(morpho, assets_);
    }

    /*//////////////////////////////////////////////////////////////
                          ADMIN FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function addKeeper(address keeper_) external onlyOwner {
        if (keeper_ == address(0)) revert AddressIsZero();
        if (!_keepers.add(keeper_)) revert KeeperAlreadyAdded(keeper_);
        emit KeeperAdded(keeper_);
    }

    function removeKeeper(address keeper_) external onlyOwner {
        if (!_keepers.remove(keeper_)) revert KeeperNotFound(keeper_);
        emit KeeperRemoved(keeper_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert AddressIsZero();
        emit TreasuryUpdated(treasury, treasury_);
        treasury = treasury_;
    }

    function setKeeperShareBps(uint256 keeperShareBps_) external onlyOwner {
        if (keeperShareBps_ > MAX_KEEPER_SHARE_BPS) {
            revert KeeperShareTooHigh(keeperShareBps_, MAX_KEEPER_SHARE_BPS);
        }
        emit KeeperShareUpdated(keeperShareBps, keeperShareBps_);
        keeperShareBps = keeperShareBps_;
    }

    function setKeeperRestriction(bool enabled_) external onlyOwner {
        keeperRestrictionEnabled = enabled_;
        emit KeeperRestrictionUpdated(enabled_);
    }

    function setGateway(address gateway_) external onlyOwner {
        if (gateway_ == address(0)) revert AddressIsZero();
        emit GatewayUpdated(address(gateway), gateway_);
        gateway = IGateway(gateway_);
        peggedToken = IERC20(address(IGateway(gateway_).PEGGED_TOKEN()));
    }

    function setMorpho(address morpho_) external onlyOwner {
        if (morpho_ == address(0)) revert AddressIsZero();
        emit MorphoUpdated(morpho, morpho_);
        morpho = morpho_;
    }

    function emergencyWithdraw(address token_, address to_, uint256 amount_) external onlyOwner {
        if (to_ == address(0)) revert AddressIsZero();
        IERC20(token_).safeTransfer(to_, amount_);
        emit TokensRescued(token_, to_, amount_, msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                          VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function isKeeper(address account_) external view returns (bool) {
        return _keepers.contains(account_);
    }

    function getKeepers() external view returns (address[] memory) {
        return _keepers.values();
    }

    function keeperCount() external view returns (uint256) {
        return _keepers.length();
    }

    /*//////////////////////////////////////////////////////////////
                         INTERNAL FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @dev Initiate a Morpho flashloan
    function _initiateFlashLoan(address token_, uint256 amount_, bytes memory data_) internal {
        if (morpho == address(0)) revert MorphoNotSet();
        IMorpho(morpho).flashLoan(token_, amount_, data_);
    }

    /// @dev Shared handler called by Morpho's flash loan callback
    function _onFlashLoanReceived(address token_, uint256 amount_, uint256 fee_, bytes memory data_) internal {
        (ArbDirection direction, address underlying, SwapParams memory swapParams) =
            abi.decode(data_, (ArbDirection, address, SwapParams));

        if (underlying != token_) revert TokenMismatch();

        if (direction == ArbDirection.MINT_AND_SELL) {
            _executeMintAndSell(underlying, amount_, swapParams);
        } else {
            _executeBuyAndRedeem(underlying, amount_, swapParams);
        }

        uint256 balanceAfter = IERC20(underlying).balanceOf(address(this));
        uint256 repayAmount = amount_ + fee_;

        _lastProfit = int256(balanceAfter) - int256(repayAmount);
    }

    /// @dev Deposit underlying to Gateway (mint pegged token), then sell pegged on DEX
    function _executeMintAndSell(address underlying_, uint256 amount_, SwapParams memory swapParams_) internal {
        IERC20(underlying_).forceApprove(address(gateway), amount_);

        uint256 peggedMinted = gateway.deposit(underlying_, amount_, 0, address(this));

        peggedToken.forceApprove(swapParams_.approveTarget, peggedMinted);

        uint256 underlyingBefore = IERC20(underlying_).balanceOf(address(this));
        _executeSwap(swapParams_);
        uint256 underlyingReceived = IERC20(underlying_).balanceOf(address(this)) - underlyingBefore;

        if (underlyingReceived < swapParams_.minAmountOut) {
            revert InsufficientOutputAmount(underlyingReceived, swapParams_.minAmountOut);
        }

        peggedToken.forceApprove(swapParams_.approveTarget, 0);
        IERC20(underlying_).forceApprove(address(gateway), 0);
    }

    /// @dev Buy pegged token on DEX, then redeem via Gateway for underlying
    function _executeBuyAndRedeem(address underlying_, uint256 amount_, SwapParams memory swapParams_) internal {
        IERC20(underlying_).forceApprove(swapParams_.approveTarget, amount_);

        uint256 peggedBefore = peggedToken.balanceOf(address(this));
        _executeSwap(swapParams_);
        uint256 peggedBought = peggedToken.balanceOf(address(this)) - peggedBefore;

        if (peggedBought < swapParams_.minAmountOut) {
            revert InsufficientOutputAmount(peggedBought, swapParams_.minAmountOut);
        }

        IERC20(underlying_).forceApprove(swapParams_.approveTarget, 0);

        // No approval needed — Gateway burns pegged token directly via PeggedToken.burnFrom()
        gateway.redeem(underlying_, peggedBought, 0, address(this));
    }

    /// @dev Execute a DEX swap via raw calldata
    function _executeSwap(SwapParams memory params_) internal {
        (bool success, bytes memory result) = params_.target.call(params_.swapCalldata);
        if (!success) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }

    /// @dev Split profit: keeper share to caller, remainder to treasury
    function _distributeProfit(address underlying_) internal returns (uint256 keeperAmount, uint256 treasuryAmount) {
        uint256 balance = IERC20(underlying_).balanceOf(address(this));
        if (balance == 0) return (0, 0);

        uint256 _keeperShareBps = keeperShareBps;
        if (_keeperShareBps > 0) {
            keeperAmount = (balance * _keeperShareBps) / MAX_BPS;
            if (keeperAmount > 0) {
                IERC20(underlying_).safeTransfer(msg.sender, keeperAmount);
            }
        }

        treasuryAmount = balance - keeperAmount;
        if (treasuryAmount > 0) {
            IERC20(underlying_).safeTransfer(treasury, treasuryAmount);
        }
    }
}
