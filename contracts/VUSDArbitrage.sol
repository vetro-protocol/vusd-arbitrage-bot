// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import {IGateway} from "./interfaces/IGateway.sol";
import {IPool, IFlashLoanSimpleReceiver} from "./interfaces/aave/IPool.sol";
import {IMorpho, IMorphoFlashLoanCallback} from "./interfaces/morpho/IMorpho.sol";
import {IBalancerVault, IFlashLoanRecipient} from "./interfaces/balancer/IBalancerVault.sol";

/// @title VUSDArbitrage
/// @notice Arbitrage contract between Vetro Gateway (mint/redeem) and DEXes
/// @dev Flashloan-funded, keeper-only, profit split between caller (keeper) and treasury
contract VUSDArbitrage is
    Ownable2Step,
    ReentrancyGuardTransient,
    IFlashLoanSimpleReceiver,
    IMorphoFlashLoanCallback,
    IFlashLoanRecipient
{
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    /*//////////////////////////////////////////////////////////////
                                TYPES
    //////////////////////////////////////////////////////////////*/

    enum FlashLoanProvider {
        AAVE_V3,
        MORPHO,
        BALANCER
    }

    enum ArbDirection {
        MINT_AND_SELL,
        BUY_AND_REDEEM
    }

    struct SwapParams {
        address target; // Contract to CALL (DEX router / aggregator)
        address approveTarget; // Contract to APPROVE (may differ, e.g., Paraswap TokenTransferProxy)
        bytes swapCalldata; // Raw calldata from aggregator API
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
    event ProviderUpdated(FlashLoanProvider indexed provider, address indexed providerAddress);
    event ArbitrageExecuted(
        ArbDirection indexed direction,
        address indexed stablecoin,
        FlashLoanProvider indexed provider,
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
    error ProviderNotSet();
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

    IGateway public gateway;
    IERC20 public vusd;
    address public treasury; // Receives profit after keeper share

    /// @notice Keeper share of profit in BPS (e.g., 1000 = 10%). Can be 0.
    uint256 public keeperShareBps;

    /// @notice When true, only whitelisted keepers can call entry points. When false, anyone can call.
    bool public keeperRestrictionEnabled;

    EnumerableSet.AddressSet private _keepers;
    mapping(FlashLoanProvider => address) public providerAddress;

    /// @dev Set in callback, read/returned from entry point, zeroed after use
    int256 private _lastProfit;
    /// @dev Guard to avoid anyone to initiate Balancer flash loan
    bool private _balancerFlashloanInitiated; 

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
        vusd = IERC20(address(IGateway(gateway_).PEGGED_TOKEN()));
        treasury = treasury_;
        keeperShareBps = keeperShareBps_;
        keeperRestrictionEnabled = true;

        _keepers.add(keeper_);
        emit KeeperAdded(keeper_);
    }

    /*//////////////////////////////////////////////////////////////
                           ENTRY POINTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Mint VUSD via Gateway and sell on DEX (when VUSD > $1 on DEX)
    /// @param provider_ Flash loan provider to use
    /// @param stablecoin_ Stablecoin address (USDC or USDT)
    /// @param flashAmount_ Amount of stablecoin to flash loan
    /// @param swapParams_ DEX swap parameters for selling VUSD
    /// @param minProfit_ Minimum total profit required (reverts if not met). Use 0 to skip check.
    /// @return profit Net profit in stablecoin (negative if unprofitable)
    function mintAndSell(
        FlashLoanProvider provider_,
        address stablecoin_,
        uint256 flashAmount_,
        SwapParams calldata swapParams_,
        uint256 minProfit_
    ) external nonReentrant onlyKeeper returns (int256 profit) {
        _lastProfit = 0;

        bytes memory data = abi.encode(ArbDirection.MINT_AND_SELL, stablecoin_, swapParams_);

        _initiateFlashLoan(provider_, stablecoin_, flashAmount_, data);

        profit = _lastProfit;
        _lastProfit = 0;

        if (minProfit_ > 0 && (profit < 0 || uint256(profit) < minProfit_)) {
            revert InsufficientProfit(profit, minProfit_);
        }

        (uint256 keeperAmount, uint256 treasuryAmount) = _distributeProfit(stablecoin_);

        emit ArbitrageExecuted(
            ArbDirection.MINT_AND_SELL, stablecoin_, provider_, flashAmount_, profit, keeperAmount, treasuryAmount
        );
    }

    /// @notice Buy VUSD on DEX and redeem via Gateway (when VUSD < $1 on DEX)
    /// @param provider_ Flash loan provider to use
    /// @param stablecoin_ Stablecoin address (USDC or USDT)
    /// @param flashAmount_ Amount of stablecoin to flash loan
    /// @param swapParams_ DEX swap parameters for buying VUSD
    /// @param minProfit_ Minimum total profit required (reverts if not met). Use 0 to skip check.
    /// @return profit Net profit in stablecoin (negative if unprofitable)
    function buyAndRedeem(
        FlashLoanProvider provider_,
        address stablecoin_,
        uint256 flashAmount_,
        SwapParams calldata swapParams_,
        uint256 minProfit_
    ) external nonReentrant onlyKeeper returns (int256 profit) {
        _lastProfit = 0;

        bytes memory data = abi.encode(ArbDirection.BUY_AND_REDEEM, stablecoin_, swapParams_);

        _initiateFlashLoan(provider_, stablecoin_, flashAmount_, data);

        profit = _lastProfit;
        _lastProfit = 0;

        if (minProfit_ > 0 && (profit < 0 || uint256(profit) < minProfit_)) {
            revert InsufficientProfit(profit, minProfit_);
        }

        (uint256 keeperAmount, uint256 treasuryAmount) = _distributeProfit(stablecoin_);

        emit ArbitrageExecuted(
            ArbDirection.BUY_AND_REDEEM, stablecoin_, provider_, flashAmount_, profit, keeperAmount, treasuryAmount
        );
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
                       FLASHLOAN CALLBACKS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IFlashLoanSimpleReceiver
    function executeOperation(
        address asset_,
        uint256 amount_,
        uint256 premium_,
        address initiator_,
        bytes calldata params_
    ) external returns (bool) {
        if (msg.sender != providerAddress[FlashLoanProvider.AAVE_V3]) revert InvalidSender();
        if (initiator_ != address(this)) revert InvalidInitiator();

        _onFlashLoanReceived(asset_, amount_, premium_, params_);

        // Aave auto-pulls: approve Pool for amount + premium
        IERC20(asset_).forceApprove(msg.sender, amount_ + premium_);

        return true;
    }

    /// @inheritdoc IMorphoFlashLoanCallback
    function onMorphoFlashLoan(uint256 assets_, bytes calldata data_) external {
        address morpho = providerAddress[FlashLoanProvider.MORPHO];
        if (msg.sender != morpho) revert InvalidSender();

        // Morpho callback doesn't pass token address — decode from our data
        (, address stablecoin_,) = abi.decode(data_, (ArbDirection, address, SwapParams));

        _onFlashLoanReceived(stablecoin_, assets_, 0, data_);

        // Morpho pulls funds back via safeTransferFrom — approve instead of transfer
        IERC20(stablecoin_).forceApprove(morpho, assets_);
    }

    /// @inheritdoc IFlashLoanRecipient
    function receiveFlashLoan(
        IERC20[] memory tokens_,
        uint256[] memory amounts_,
        uint256[] memory feeAmounts_,
        bytes memory userData_
    ) external {
        address vault = providerAddress[FlashLoanProvider.BALANCER];
        if (msg.sender != vault) revert InvalidSender();
        if (!_balancerFlashloanInitiated) revert InvalidInitiator();

        address token = address(tokens_[0]);
        uint256 amount = amounts_[0];
        uint256 fee = feeAmounts_[0];

        _onFlashLoanReceived(token, amount, fee, userData_);

        // Balancer: manual transfer back
        IERC20(token).safeTransfer(vault, amount + fee);
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
        vusd = IERC20(address(IGateway(gateway_).PEGGED_TOKEN()));
    }

    function setProviderAddress(FlashLoanProvider provider_, address addr_) external onlyOwner {
        if (addr_ == address(0)) revert AddressIsZero();
        emit ProviderUpdated(provider_, addr_);
        providerAddress[provider_] = addr_;
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

    /// @dev Route flashloan to the correct provider
    function _initiateFlashLoan(
        FlashLoanProvider provider_,
        address token_,
        uint256 amount_,
        bytes memory data_
    ) internal {
        address lender = providerAddress[provider_];
        if (lender == address(0)) revert ProviderNotSet();


        if (provider_ == FlashLoanProvider.AAVE_V3) {
            IPool(lender).flashLoanSimple(address(this), token_, amount_, data_, 0);
        } else if (provider_ == FlashLoanProvider.MORPHO) {
            IMorpho(lender).flashLoan(token_, amount_, data_);
        } else if (provider_ == FlashLoanProvider.BALANCER) {
            IERC20[] memory tokens = new IERC20[](1);
            tokens[0] = IERC20(token_);
            uint256[] memory amounts = new uint256[](1);
            amounts[0] = amount_;
            _balancerFlashloanInitiated = true;
            IBalancerVault(lender).flashLoan(address(this), tokens, amounts, data_);
            _balancerFlashloanInitiated = false;
        }

    }

    /// @dev Shared handler called by all flashloan callbacks
    function _onFlashLoanReceived(address token_, uint256 amount_, uint256 fee_, bytes memory data_) internal {
        (ArbDirection direction, address stablecoin, SwapParams memory swapParams) =
            abi.decode(data_, (ArbDirection, address, SwapParams));

        if (stablecoin != token_) revert TokenMismatch();

        if (direction == ArbDirection.MINT_AND_SELL) {
            _executeMintAndSell(stablecoin, amount_, swapParams);
        } else {
            _executeBuyAndRedeem(stablecoin, amount_, swapParams);
        }

        uint256 balanceAfter = IERC20(stablecoin).balanceOf(address(this));
        uint256 repayAmount = amount_ + fee_;

        _lastProfit = int256(balanceAfter) - int256(repayAmount);
    }

    /// @dev Deposit stablecoin to Gateway (mint VUSD), then sell VUSD on DEX
    function _executeMintAndSell(address stablecoin_, uint256 amount_, SwapParams memory swapParams_) internal {
        IERC20(stablecoin_).forceApprove(address(gateway), amount_);

        uint256 vusdMinted = gateway.deposit(stablecoin_, amount_, 0, address(this));

        vusd.forceApprove(swapParams_.approveTarget, vusdMinted);

        uint256 stablecoinBefore = IERC20(stablecoin_).balanceOf(address(this));
        _executeSwap(swapParams_);
        uint256 stablecoinReceived = IERC20(stablecoin_).balanceOf(address(this)) - stablecoinBefore;

        if (stablecoinReceived < swapParams_.minAmountOut) {
            revert InsufficientOutputAmount(stablecoinReceived, swapParams_.minAmountOut);
        }

        vusd.forceApprove(swapParams_.approveTarget, 0);
        IERC20(stablecoin_).forceApprove(address(gateway), 0);
    }

    /// @dev Buy VUSD on DEX, then redeem via Gateway for stablecoin
    function _executeBuyAndRedeem(address stablecoin_, uint256 amount_, SwapParams memory swapParams_) internal {
        IERC20(stablecoin_).forceApprove(swapParams_.approveTarget, amount_);

        uint256 vusdBefore = vusd.balanceOf(address(this));
        _executeSwap(swapParams_);
        uint256 vusdBought = vusd.balanceOf(address(this)) - vusdBefore;

        if (vusdBought < swapParams_.minAmountOut) {
            revert InsufficientOutputAmount(vusdBought, swapParams_.minAmountOut);
        }

        IERC20(stablecoin_).forceApprove(swapParams_.approveTarget, 0);

        // No approval needed — Gateway burns VUSD directly via PeggedToken.burnFrom()
        gateway.redeem(stablecoin_, vusdBought, 0, address(this));
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
    function _distributeProfit(address stablecoin_) internal returns (uint256 keeperAmount, uint256 treasuryAmount) {
        uint256 balance = IERC20(stablecoin_).balanceOf(address(this));
        if (balance == 0) return (0, 0);

        uint256 _keeperShareBps = keeperShareBps;
        if (_keeperShareBps > 0) {
            keeperAmount = (balance * _keeperShareBps) / MAX_BPS;
            if (keeperAmount > 0) {
                IERC20(stablecoin_).safeTransfer(msg.sender, keeperAmount);
            }
        }

        treasuryAmount = balance - keeperAmount;
        if (treasuryAmount > 0) {
            IERC20(stablecoin_).safeTransfer(treasury, treasuryAmount);
        }
    }
}
