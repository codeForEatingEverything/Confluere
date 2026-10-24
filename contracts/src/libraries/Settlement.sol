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

    uint256 internal constant SPREAD_SHARE_BPS = 500; // 5% of the interest K - P*, per fill (blueprint 8.1)
    uint256 internal constant TRADE_FEE_PPM = 150; // 0.015% of notional on each side (blueprint 8.2)
    uint256 internal constant PPM = 1_000_000;

    /// @notice Trade fee on a notional, rounded down.
    function tradeFee(uint256 notional) internal pure returns (uint256) {
        return notional * TRADE_FEE_PPM / PPM;
    }

    /// @notice Spread share on `units` filled at `price`: 5% of (K - price), rounded down. Zero at or above K.
    function spreadShare(uint256 units, uint256 strike, uint256 price, uint256 scale) internal pure returns (uint256) {
        if (price >= strike) return 0;
        return FPM.fullMulDiv(units * (strike - price), SPREAD_SHARE_BPS, scale * BPS);
    }

    /// @notice Seller side of a fill: gross proceeds (rounded down), the spread share into the pool's escrow, the
    /// seller's trade fee, and what the seller keeps. The spread is capped so a fill never reverts.
    function sellSplit(uint256 units, uint256 price, uint256 strike, uint256 scale)
        internal
        pure
        returns (uint256 gross, uint256 spread, uint256 trade, uint256 net)
    {
        gross = FPM.fullMulDiv(units, price, scale);
        trade = tradeFee(gross);
        spread = spreadShare(units, strike, price, scale);
        if (spread > gross - trade) spread = gross - trade;
        net = gross - trade - spread;
    }

    /// @notice Escrow for a competitive buy: cost at the limit (rounded up), its trade fee, and 2 wei of rounding
    /// reserve per batch it can trade in (1 for the cost, 1 for the fee).
    function buyEscrow(uint256 units, uint256 limit, uint256 scale, uint256 ttl) internal pure returns (uint256) {
        uint256 g = FPM.fullMulDivUp(units, limit, scale);
        return g + tradeFee(g) + 2 * ttl;
    }

    /// @notice Units an all-in quote budget (cost + trade fee) buys at `price`, rounded down with 1 wei reserve.
    function ncUnits(uint256 budget, uint256 price, uint256 scale) internal pure returns (uint256) {
        uint256 b = budget * PPM / (PPM + TRADE_FEE_PPM);
        if (b <= 1) return 0;
        return FPM.fullMulDiv(b - 1, scale, price);
    }

    /// @notice Treasury part of a pool's spread escrow at close: the repaid fraction, rounded down.
    function feeSplit(uint256 escrow, uint256 repaid, uint256 filled) internal pure returns (uint256) {
        if (filled == 0) return 0;
        return FPM.fullMulDiv(escrow, repaid, filled);
    }

    /// @notice Pro-rata share of a remaining balance. Computed on what is left, so the last claimer takes the dust.
    function share(uint256 amount, uint256 balance, uint256 supply) internal pure returns (uint256) {
        if (supply == 0) return 0;
        return FPM.fullMulDiv(amount, balance, supply);
    }
}
