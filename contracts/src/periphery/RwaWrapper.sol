// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IRwaWrapper} from "../interfaces/IRwaWrapper.sol";

/// @notice wstETH-style wrapper: balances are fixed shares; rebases (dividends paid by rebase, splits) move the
/// exchange rate instead. Whoever holds the wrapper at expiry, borrower or C holders, receives the accrued value.
/// Corporate actions that are not rebases (delisting, cash dividends sent elsewhere) are out of scope for v1.
contract RwaWrapper is ERC20, IRwaWrapper {
    using SafeERC20 for IERC20;

    address public immutable underlying;
    uint8 internal immutable _dec;

    /// @dev Virtual shares/assets stop first-depositor share inflation: a donation must exceed a victim's deposit
    /// by ~1e6x to round it down, and most of the donation is captured by the virtual position.
    uint256 internal constant VIRTUAL = 1e6;

    error ZeroAddress();

    constructor(address underlying_, string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        if (underlying_ == address(0)) revert ZeroAddress();
        underlying = underlying_;
        _dec = IERC20Metadata(underlying_).decimals();
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function toShares(uint256 amount) public view returns (uint256) {
        return Math.mulDiv(amount, totalSupply() + VIRTUAL, IERC20(underlying).balanceOf(address(this)) + VIRTUAL);
    }

    function toUnderlying(uint256 shares) public view returns (uint256) {
        return Math.mulDiv(shares, IERC20(underlying).balanceOf(address(this)) + VIRTUAL, totalSupply() + VIRTUAL);
    }

    function wrap(uint256 amount, address to) external returns (uint256 shares) {
        uint256 before = IERC20(underlying).balanceOf(address(this));
        uint256 supply = totalSupply();
        IERC20(underlying).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(underlying).balanceOf(address(this)) - before;
        shares = Math.mulDiv(received, supply + VIRTUAL, before + VIRTUAL);
        _mint(to, shares);
        emit Wrapped(to, received, shares);
    }

    function unwrap(uint256 shares, address to) external returns (uint256 amount) {
        amount = toUnderlying(shares);
        _burn(msg.sender, shares);
        IERC20(underlying).safeTransfer(to, amount);
        emit Unwrapped(msg.sender, shares, amount);
    }
}
