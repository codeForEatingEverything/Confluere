// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @notice Deploy-time grid. Mainnet: Friday 08:00 UTC anchor, 1 week period, 30 minute batches.
/// Demo deployments use minute-scale values so the full lifecycle can be shown live.
struct GridConfig {
    uint64 anchor; // a past timestamp that sits on the expiry grid (e.g. some Friday 08:00 UTC)
    uint64 period; // distance between consecutive expiries
    uint64 batchInterval; // distance between consecutive batch boundaries
    uint32 maxExpiries; // how many future expiries may be listed at once
    uint8 strikeSigDigits; // strikes may have at most this many significant decimal digits
}

library Grid {
    error InvalidGrid();

    function validate(GridConfig memory g) internal view {
        if (
            g.period == 0 || g.batchInterval == 0 || g.batchInterval > g.period || g.maxExpiries == 0
                || g.strikeSigDigits == 0 || g.strikeSigDigits > 30 || g.anchor > block.timestamp
                || g.period % g.batchInterval != 0
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

    /// @notice Scale-free strike grid without an oracle: strip trailing zeros, the rest must fit in `sigDigits` digits.
    /// With 2 digits, ETH-class strikes in [1000, 9900] USD land on a 100 USD step and pegged ratios on 0.01 steps.
    function isGridStrike(GridConfig memory g, uint256 strike) internal pure returns (bool) {
        if (strike == 0) return false;
        while (strike % 10 == 0) {
            strike /= 10;
        }
        return strike < 10 ** uint256(g.strikeSigDigits);
    }
}
