// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {FixedPointMathLib as FPM} from "solady/utils/FixedPointMathLib.sol";

/// @notice Pure arithmetic for batch clearing. Prices are quote base units per 1 whole asset.
library Clearing {
    uint256 internal constant BPS = 10_000;

    /// @notice Quote owed for `units` at `price`, rounded down (what a seller receives).
    function quoteDown(uint256 units, uint256 price, uint256 scale) internal pure returns (uint256) {
        return FPM.fullMulDiv(units, price, scale);
    }

    /// @notice Quote owed for `units` at `price`, rounded up (what a buyer pays).
    function quoteUp(uint256 units, uint256 price, uint256 scale) internal pure returns (uint256) {
        return FPM.fullMulDivUp(units, price, scale);
    }

    /// @notice Units a quote budget buys at `price`, rounded down.
    function unitsFor(uint256 budget, uint256 price, uint256 scale) internal pure returns (uint256) {
        return FPM.fullMulDiv(budget, scale, price);
    }

    /// @notice k = 0.5 double auction: the midpoint of the marginal sell and buy limits.
    function midpoint(uint256 marginalSell, uint256 marginalBuy) internal pure returns (uint256) {
        return (marginalSell + marginalBuy) / 2;
    }

    /// @notice Band after `failures` consecutive out-of-band batches: base * 1.5^failures, capped at 100%.
    function widenedBand(uint256 bandBps, uint256 failures) internal pure returns (uint256 b) {
        b = bandBps;
        for (uint256 i; i < failures; ++i) {
            b = b * 3 / 2;
        }
        if (b > BPS) b = BPS;
    }

    function withinBand(uint256 price, uint256 base, uint256 bandBps) internal pure returns (bool) {
        return price * BPS >= base * (BPS - bandBps) && price * BPS <= base * (BPS + bandBps);
    }
}
