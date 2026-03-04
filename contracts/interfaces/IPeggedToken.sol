// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";

/// @title IPeggedToken - Interface for PeggedToken stablecoin
interface IPeggedToken is IERC20 {
    function burnFrom(address account_, uint256 amount_) external;
    function mint(address account_, uint256 amount_) external;
    function gateway() external view returns (address _gateway);
    function treasury() external view returns (address _treasury);
}
