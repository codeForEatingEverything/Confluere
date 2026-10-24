// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {FixedPointMathLib as FPM} from "solady/utils/FixedPointMathLib.sol";

/// @notice Deploy-time grid. Mainnet: Friday 08:00 UTC anchor, 1 week period, 30 minute batches.
/// Demo deployments use minute-scale values so the full lifecycle can be shown live.
struct GridConfig {
    uint64 anchor; // a past timestamp that sits on the expiry grid (e.g. some Friday 08:00 UTC)
    uint64 period; // distance between consecutive expiries
    uint64 batchInterval; // distance between consecutive batch boundaries
    uint32 maxExpiries; // how many future expiries may be listed at once
}

library Grid {
    error InvalidGrid();

    function validate(GridConfig memory g) internal view {
        if (
            g.period == 0 || g.batchInterval == 0 || g.batchInterval > g.period || g.maxExpiries == 0
                || g.anchor > block.timestamp || g.period % g.batchInterval != 0
        ) revert InvalidGrid();
    }

    /// @notice An expiry is listable if it lies on the grid, is in the future, and is at most `maxExpiries` periods out.
    function isListableExpiry(GridConfig memory g, uint64 expiry, uint256 nowTs) internal pure returns (bool) {
        if (expiry <= nowTs || expiry < g.anchor) return false;
        if ((expiry - g.anchor) % g.period != 0) return false;
        return expiry - nowTs <= uint256(g.period) * g.maxExpiries;
    }

    function isOnGrid(GridConfig memory g, uint64 expiry) internal pure returns (bool) {
        return expiry >= g.anchor && (expiry - g.anchor) % g.period == 0;
    }

    /// @notice Index of the batch interval that contains `ts`. A batch can be settled once its boundary has passed.
    function batchIndex(GridConfig memory g, uint256 ts) internal pure returns (uint64) {
        return uint64((ts - g.anchor) / g.batchInterval);
    }

    function batchStart(GridConfig memory g, uint64 index) internal pure returns (uint256) {
        return uint256(g.anchor) + uint256(index) * g.batchInterval;
    }

    // ------------------------------------------------------------ strikes: 1% log grid (blueprint 3.3)

    uint256 internal constant RAY = 1e27;
    uint256 internal constant STEP = 101e25; // 1.01 in RAY, exact
    int256 internal constant MAX_STRIKE_INDEX = 4095;

    /// @notice 1.01^m in RAY, by repeated squaring with every product rounded down. The SDK copies this integer
    /// routine line by line (bigint) so both sides agree to the last unit.
    function growth(uint256 m) internal pure returns (uint256 r) {
        r = RAY;
        uint256 b = STEP;
        while (m != 0) {
            if (m & 1 == 1) r = FPM.fullMulDiv(r, b, RAY);
            m >>= 1;
            if (m != 0) b = FPM.fullMulDiv(b, b, RAY);
        }
    }

    /// @notice Strike at grid index n: one whole quote unit times 1.01^n, rounded down to the quote's base unit.
    function strikeAt(int256 n, uint8 quoteDecimals) internal pure returns (uint256) {
        uint256 unit = 10 ** uint256(quoteDecimals);
        return n >= 0 ? FPM.fullMulDiv(unit, growth(uint256(n)), RAY) : FPM.fullMulDiv(unit, RAY, growth(uint256(-n)));
    }

    /// @notice K is on the grid at index n iff |n| <= MAX_STRIKE_INDEX, 0 < K <= uint96 max, K == strikeAt(n) and n is
    /// the smallest index giving K (rounding makes neighbours collide for tiny strikes; only the first counts).
    function isGridStrike(uint256 strike, int256 n, uint8 quoteDecimals) internal pure returns (bool) {
        if (n > MAX_STRIKE_INDEX || n < -MAX_STRIKE_INDEX || strike == 0 || strike > type(uint96).max) return false;
        if (strikeAt(n, quoteDecimals) != strike) return false;
        return n == -MAX_STRIKE_INDEX || strikeAt(n - 1, quoteDecimals) < strike;
    }

    /// @notice Canonical index of `strike` (smallest n with strikeAt(n) >= strike) by binary search; `ok` tells whether
    /// the strike is on the grid. For scripts and tests; the core only verifies a given index.
    function indexOf(uint256 strike, uint8 quoteDecimals) internal pure returns (int256 n, bool ok) {
        int256 lo = -MAX_STRIKE_INDEX;
        int256 hi = MAX_STRIKE_INDEX;
        while (lo < hi) {
            int256 mid = (lo + hi) >> 1;
            if (strikeAt(mid, quoteDecimals) >= strike) hi = mid;
            else lo = mid + 1;
        }
        return (lo, isGridStrike(strike, lo, quoteDecimals));
    }
}
