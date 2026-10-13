// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {FixedPointMathLib as FPM} from "solady/utils/FixedPointMathLib.sol";

/// @notice Pure arithmetic for repayment, spread share and pro-rata claims.
library Settlement {
    uint256 internal constant BPS = 10_000;

    /// @notice Quote a borrower pays to buy back `units`: K per whole asset, rounded up.
    function repayAmount(uint256 units, uint256 strike, uint256 scale) internal pure returns (uint256) {
        return FPM.fullMulDivUp(units, strike, scale);
    }

    /// @notice Spread share: feeBps of the interest (K - vwap) on `units`. Zero when vwap >= K, never underflows.
    function fee(uint256 units, uint256 strike, uint256 vwap, uint256 feeBps, uint256 scale)
        internal
        pure
        returns (uint256)
    {
        if (strike <= vwap) return 0;
        return FPM.fullMulDiv(units * (strike - vwap), feeBps, scale * BPS);
    }

    /// @notice Pro-rata share of a remaining balance. Computed on what is left, so the last claimer takes the dust.
    function share(uint256 amount, uint256 balance, uint256 supply) internal pure returns (uint256) {
        if (supply == 0) return 0;
        return FPM.fullMulDiv(amount, balance, supply);
    }
}
