// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @notice American pools allow repayment at any time before the window closes; European pools only inside the window.
enum Kind {
    American,
    European
}

/// @notice Lifecycle of a pool. Closing is the segmented abandonment-auction phase after the window ends; Selling is
/// the autoSell sub-state after it, while the defaulted asset rests as a sell order in the next expiry's pool.
enum Status {
    None,
    Open,
    Window,
    Closing,
    Selling,
    Closed
}

/// @notice The terms shared by every position in a pool.
struct PoolKey {
    address asset; // collateral the borrower sells into the pool
    address quote; // funding asset the borrower receives
    uint64 expiry; // timestamp on the expiry grid
    uint128 strike; // K: quote base units per 1 whole asset (10 ** assetDecimals units)
    Kind kind;
    uint16 bandBps; // price band of the pool: 150, 800 or 1500
    uint8 cadence; // batch interval = base interval * {1, 12, 48}[cadence]
}

/// @notice Pool id, C-Token id and R-Token id derivation.
/// @dev poolId has its lowest bit cleared. C-Token id == poolId, R-Token id == poolId | 1.
library PoolKeyLib {
    function toId(PoolKey memory key) internal pure returns (bytes32) {
        return keccak256(abi.encode(key)) & ~bytes32(uint256(1));
    }

    function cId(bytes32 poolId) internal pure returns (uint256) {
        return uint256(poolId);
    }

    function rId(bytes32 poolId) internal pure returns (uint256) {
        return uint256(poolId) | 1;
    }

    /// @notice A market groups every strike and expiry of one asset pair and kind. Graduation is tracked per market.
    function marketId(address asset, address quote, Kind kind) internal pure returns (bytes32) {
        return keccak256(abi.encode(asset, quote, kind));
    }
}
