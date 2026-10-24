// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {PoolKey, Kind, Status} from "../libraries/PoolKey.sol";
import {GridConfig} from "../libraries/Grid.sol";

interface IConfluere {
    /// @notice Parameters for a new order. `owner` defaults to msg.sender; the payer is always msg.sender.
    struct OrderParams {
        uint8 side; // SELL, BUY, NC_SELL or NC_BUY
        uint96 units; // asset units (unused for NC_BUY)
        uint96 limit; // price limit (0 for non-competitive)
        uint128 budget; // quote budget, NC_BUY only
        uint16 ttl; // number of settlements the order may take part in
        uint64 hint; // predecessor order id for sorted insertion (0 = head)
        address owner;
    }

    /// @notice Creator-chosen pool options (blueprint §4), not part of the pool id: a minimum crossing volume below
    /// which a batch does not trade (minimum fill), price bounds for the first auction, and autoSell (blueprint 3.6).
    /// Band and cadence are part of the PoolKey.
    struct PoolOptions {
        uint96 minFill; // asset units; a batch whose competitive volume is below this does not trade
        uint96 firstLo; // until the first trade, P* must be >= firstLo ...
        uint96 firstHi; // ... and <= firstHi (0 = no upper bound)
        bool autoSell; // at close, sell defaulted asset into the next expiry's pool of the same tier
    }

    struct PoolView {
        PoolKey key;
        Status status;
        uint8 assetDecimals;
        int16 strikeIndex;
        uint8 bandFailures;
        uint32 settleCount;
        uint64 lastSettledBatch;
        uint64 windowEnd;
        uint64 pausedUntil;
        uint64 pausedBlocks;
        uint96 lastClearingPrice;
        uint96 bandBase;
        uint256 quoteBal;
        uint256 assetBal;
        uint256 surplusBal;
        uint256 feeEscrow;
        uint256 filledUnits;
        uint256 repaidUnits;
        uint256 closeRemaining;
        uint128 lentUnits;
        uint128 lentMargin;
        uint128 shortUnits;
        uint128 shortMargin;
        bytes32 autoSellPool;
        uint64 autoSellOrder;
        uint96 autoSellUnits;
        PoolOptions options;
        uint64 batchInterval;
    }

    struct MarketStats {
        uint128 volume; // quote traded at this expiry across the market
        uint128 fees; // treasury fees earned at this expiry: trade fees at clearing + spread share at close
        uint128 mainVolume; // traded volume of the main tier: the tier with the most volume at this expiry
        uint96 mainStrike; // main tier = (strike, band, cadence); ties keep the tier that got there first
        int16 mainIndex;
        uint16 mainBand;
        uint8 mainCadence;
        bool bad; // paused or circuit breaker tripped at this expiry
    }

    event PoolCreated(bytes32 indexed poolId, PoolKey key, int16 strikeIndex, bytes32 indexed marketId);
    event PoolOptionsSet(bytes32 indexed poolId, uint96 minFill, uint96 firstLo, uint96 firstHi, bool autoSell);
    event OrderPlaced(
        bytes32 indexed poolId,
        uint64 indexed orderId,
        address indexed owner,
        uint8 side,
        uint96 units,
        uint96 limit,
        uint128 escrow,
        uint32 deadline
    );
    event OrderRemoved(bytes32 indexed poolId, uint64 indexed orderId, uint8 reason);
    event OrderFilled(bytes32 indexed poolId, uint64 indexed orderId, uint256 units, uint256 quoteAmount, uint256 fee);
    event BatchSettled(
        bytes32 indexed poolId,
        uint32 indexed settleIndex,
        uint256 price,
        uint256 competitiveUnits,
        uint256 ncUnits,
        uint256 spreadToEscrow,
        uint256 tradeFees,
        uint256 capBase // competitive-only crossing volume q0: non-competitive units are capped at half of it
    );
    /// @dev assetOut units of asset were delivered; for the rest (lent units not returned by the cutoff) the payer
    /// was credited marginOut of forfeited margin (pending, pull).
    event Repaid(
        bytes32 indexed poolId,
        address indexed payer,
        uint256 units,
        uint256 quotePaid,
        uint256 assetOut,
        uint256 marginOut
    );
    event Lent(bytes32 indexed poolId, address indexed to, uint256 units, uint256 margin, uint256 fee);
    event LentReturned(bytes32 indexed poolId, uint256 units, uint256 marginOut, address marginTo);
    event LentToppedUp(bytes32 indexed poolId, uint256 amount);
    /// @dev A closed autoSell pool offered its defaulted asset in the next expiry's pool of the same tier; the pool
    /// stays Selling (claims wait) until the order leaves the book (AutoSellEnded, then WindowClosed).
    event AutoSellPlaced(
        bytes32 indexed poolId, bytes32 indexed targetPoolId, uint64 orderId, uint256 units, uint256 limit
    );
    /// @dev unitsLeft stay in the pool and are claimed in kind; units sold and their proceeds are in OrderFilled.
    event AutoSellEnded(bytes32 indexed poolId, uint256 unitsLeft);
    event ShortRecorded(bytes32 indexed poolId, uint256 shortUnits, uint256 shortMargin);
    event FeeEscrowSplit(
        bytes32 indexed poolId, uint256 toTreasury, uint256 toLenders, uint256 repaidUnits, uint256 filledUnits
    );
    event RolledOver(
        bytes32 indexed oldPoolId, bytes32 indexed newPoolId, address indexed owner, uint256 units, uint256 topUp
    );
    event Matured(bytes32 indexed poolId, uint64 windowEnd);
    event BidFilled(bytes32 indexed poolId, uint64 indexed orderId, uint256 units, uint256 kPaid, uint256 surplus);
    event WindowClosed(bytes32 indexed poolId, uint256 quoteBal, uint256 assetBal, uint256 surplusBal);
    event Claimed(bytes32 indexed poolId, address indexed account, uint256 quoteOut, uint256 assetOut);
    event Withdrawn(address indexed token, address indexed account, address to, uint256 amount);
    event Paused(bytes32 indexed poolId, uint64 untilBlock, uint64 pausedBlocks);
    event PoolGraduated(bytes32 indexed marketId, uint64 lastExpiry);
    event FlashLoan(address indexed receiver, address indexed token, uint256 amount, uint256 fee);

    error InvalidPool();
    error InvalidState();
    error InvalidParams();
    error NotOwner();
    error BookFull();
    error BatchNotReady();
    error IsPaused();
    error BadToken();
    error Locked();
    error FlashFailed();

    function createPool(PoolKey calldata key, int16 strikeIndex, PoolOptions calldata opts)
        external
        returns (bytes32 poolId);
    function placeOrder(bytes32 poolId, OrderParams calldata p) external returns (uint64 orderId);
    function placeLockedOrder(bytes32 poolId, OrderParams calldata p) external returns (uint64 orderId);
    function cancelOrder(bytes32 poolId, uint64 orderId) external;
    function purge(bytes32 poolId, uint64[] calldata orderIds) external;
    function settleBatch(bytes32 poolId) external;
    function repay(bytes32 poolId, uint96 units) external returns (uint256 assetOut, uint256 marginOut);
    /// @notice Specials only: lend `units` of a European pool's asset to `to` against `margin` (>= 120% of units at
    /// the last clearing price) and a lending fee that goes to the pool's C holders. Before the cutoff only.
    function lend(bytes32 poolId, uint96 units, address to, uint128 margin, uint128 fee) external;
    /// @notice Specials only: return lent units before the cutoff and release `marginOut` to `marginTo` (pending).
    function returnLent(bytes32 poolId, uint96 units, uint128 marginOut, address marginTo) external;
    /// @notice Specials only: add margin to the pool's lent position before the cutoff.
    function topUpLent(bytes32 poolId, uint128 amount) external;
    function mature(bytes32 poolId) external;
    function bid(bytes32 poolId, uint96 units, uint96 surplusPerUnit, uint64 hint) external returns (uint64 orderId);
    function closeWindow(bytes32 poolId, uint256 maxBids) external returns (bool done);
    function claim(bytes32 poolId) external returns (uint256 quoteOut, uint256 assetOut);
    function withdraw(address token, address to) external returns (uint256 amount);
    function rollover(
        bytes32 oldPoolId,
        bytes32 newPoolId,
        uint96 units,
        uint96 minPrice,
        uint128 maxTopUp,
        uint16 ttl,
        uint64 hint
    ) external returns (uint64 orderId);
    function pause(bytes32 poolId, uint64 blocks) external;
    function graduate(address asset, address quote, Kind kind, uint64 lastExpiry) external;

    function pool(bytes32 poolId) external view returns (PoolView memory);
    function order(bytes32 poolId, uint64 orderId)
        external
        view
        returns (
            address owner,
            uint8 side,
            uint8 flags,
            uint96 units,
            uint96 limit,
            uint128 escrow,
            uint32 deadline,
            uint64 next
        );
    /// @notice Source pool of a rollover order (or of an autoSell order) resting in `poolId`; 0 for other orders.
    function linkedPool(bytes32 poolId, uint64 orderId) external view returns (bytes32);
    function bookHead(bytes32 poolId, uint8 side) external view returns (uint64 head, uint32 count);
    function findHint(bytes32 poolId, uint8 side, uint96 limit) external view returns (uint64);
    function nextBatchAt(bytes32 poolId) external view returns (uint256);
    function graduated(bytes32 marketId) external view returns (bool);
    /// @notice Block at which the shared repayment window of `expiry` ends; 0 until the first pool of it matures.
    function expiryWindowEnd(uint64 expiry) external view returns (uint64);
    function marketStats(bytes32 marketId, uint64 expiry) external view returns (MarketStats memory);
    /// @notice Quote traded at one tier (PoolKeyLib.tierKey(strike, bandBps, cadence)) of a market at an expiry.
    function tierVolume(bytes32 marketId, uint64 expiry, uint256 tierKey) external view returns (uint256);
    function pending(address token, address account) external view returns (uint256);
    function marketFees(bytes32 marketId) external view returns (uint256);
    function flashFees(address token) external view returns (uint256);
    function minNotional(address quote) external view returns (uint256);
    function lockedR(address account, bytes32 poolId) external view returns (uint256);
    function grid() external view returns (GridConfig memory);
    function WINDOW_BLOCKS() external view returns (uint64);
    function MAX_PAUSE_BLOCKS() external view returns (uint64);
    function SPECIALS() external view returns (address);
    function LEND_CUTOFF() external view returns (uint64);
    function AUTOSELL_DISCOUNT_BPS() external view returns (uint16);
    function AUTOSELL_TTL() external view returns (uint16);
}
