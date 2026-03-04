// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IMorphoFlashLoanCallback} from "../../contracts/interfaces/morpho/IMorpho.sol";

/// @title MockMorpho - Mock Morpho flash loan provider for testing
/// @dev Matches real Morpho behavior: transfers funds out, calls callback, then pulls funds back via transferFrom.
contract MockMorpho {
    using SafeERC20 for IERC20;

    function flashLoan(address token, uint256 assets, bytes calldata data) external {
        IERC20(token).safeTransfer(msg.sender, assets);

        IMorphoFlashLoanCallback(msg.sender).onMorphoFlashLoan(assets, data);

        // Real Morpho pulls funds back via safeTransferFrom (borrower must approve)
        IERC20(token).safeTransferFrom(msg.sender, address(this), assets);
    }
}
