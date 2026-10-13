// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Fixed-balance wrapper around a token whose balances change on their own (rebasing dividends, splits).
/// Pools only ever hold the wrapper; value changes accrue to the wrapper's exchange rate and settle with the token.
interface IRwaWrapper is IERC20 {
    event Wrapped(address indexed account, uint256 underlying, uint256 shares);
    event Unwrapped(address indexed account, uint256 shares, uint256 underlying);

    function underlying() external view returns (address);
    function wrap(uint256 underlyingAmount, address to) external returns (uint256 shares);
    function unwrap(uint256 shares, address to) external returns (uint256 underlyingAmount);
    function toShares(uint256 underlyingAmount) external view returns (uint256);
    function toUnderlying(uint256 shares) external view returns (uint256);
}
