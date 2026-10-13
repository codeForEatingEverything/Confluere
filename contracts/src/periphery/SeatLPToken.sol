// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SeatRegistry} from "./SeatRegistry.sol";
import {Kind} from "../libraries/PoolKey.sol";

/// @notice Receipt token for one market's LP slot (a SeatRegistry seat), shown in wallets like an Aave aToken.
/// The holder's balance is the seat's deposit after tax accrued up to now plus its bond, in the quote token; everyone
/// else holds zero. It is read-only and non-transferable: a seat changes hands only by being bought at its declared
/// price (Harberger tax), so a free transfer would break the mechanism. Nothing is minted or stored here.
contract SeatLPToken {
    SeatRegistry public immutable registry;
    address public immutable asset;
    address public immutable quote;
    Kind public immutable kind;
    uint8 public immutable decimals;
    string public name;
    string public symbol;

    error NonTransferable();

    constructor(SeatRegistry registry_, address asset_, address quote_, Kind kind_) {
        registry = registry_;
        asset = asset_;
        quote = quote_;
        kind = kind_;
        decimals = IERC20Metadata(quote_).decimals();
        string memory pair = string.concat(IERC20Metadata(asset_).symbol(), "/", IERC20Metadata(quote_).symbol());
        string memory style = kind_ == Kind.American ? "American" : "European";
        name = string.concat("Confluere LP ", pair, " ", style);
        symbol = string.concat("cLP-", IERC20Metadata(asset_).symbol(), "-", IERC20Metadata(quote_).symbol());
    }

    /// @notice Current holder of the LP slot (zero when vacant).
    function holder() public view returns (address h) {
        (SeatRegistry.Seat memory st,) = registry.seatOf(asset, quote, kind);
        h = st.holder;
    }

    /// @notice Deposit after accrued tax plus bond for the holder; zero for everyone else.
    function balanceOf(address account) public view returns (uint256) {
        (SeatRegistry.Seat memory st,) = registry.seatOf(asset, quote, kind);
        if (st.holder == address(0) || st.holder != account) return 0;
        return uint256(st.deposit) + st.bond;
    }

    function totalSupply() external view returns (uint256) {
        return balanceOf(holder());
    }

    function allowance(address, address) external pure returns (uint256) {
        return 0;
    }

    function transfer(address, uint256) external pure returns (bool) {
        revert NonTransferable();
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        revert NonTransferable();
    }

    function approve(address, uint256) external pure returns (bool) {
        revert NonTransferable();
    }
}
