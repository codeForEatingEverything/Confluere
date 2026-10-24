// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC6909} from "@openzeppelin/contracts/interfaces/IERC6909.sol";

import {IConfluere} from "../interfaces/IConfluere.sol";
import {PoolKey, PoolKeyLib, Status} from "./PoolKey.sol";
import {Order, Book, OrderSet, SELL, NC_SELL, BID, FLAG_ROLLOVER} from "./OrderSet.sol";

/// @notice Per-pool state. All funds stay in the singleton; these are the pool's shares of them.
struct PoolState {
    PoolKey key;
    bytes32 marketId;
    Status status;
    uint8 assetDecimals;
    int16 strikeIndex; // n on the 1% log grid: strike == Grid.strikeAt(n, quoteDecimals)
    bool autoSell; // pool option: at close, defaulted asset is sold into the next expiry's pool of the same tier
    uint8 bandFailures;
    uint32 settleCount;
    uint64 lastSettledBatch;
    uint64 windowEnd;
    uint64 pausedUntil;
    uint64 pausedBlocks; // cumulative guardian pause granted to this pool, capped at MAX_PAUSE_BLOCKS
    uint96 lastClearingPrice;
    uint96 bandBase;
    uint96 minFill; // minimum fill: smallest competitive volume (asset units) a batch may trade
    uint96 firstLo; // first-auction price bounds; firstHi = 0 means no upper bound
    uint96 firstHi;
    uint256 quoteBal; // quote owned by C holders
    uint256 assetBal; // asset owned by the pool (backs outstanding R, then C after close)
    uint256 surplusBal; // abandonment-auction surplus owed to R holders
    uint256 feeEscrow; // spread share withheld from sellers at clearing, split at close by the repaid fraction
    uint256 filledUnits; // units ever filled (= C minted)
    uint256 repaidUnits; // units whose K was paid in full: repay, rollover, abandonment-auction fill
    uint256 closeRemaining; // unrepaid R units still open to bids during Closing
    // Specials lending (European pools only, ARCH 2.6.1). The asset part of assetBal that is physically here is
    // assetBal - lentUnits - shortUnits.
    uint128 lentUnits; // lent out through Specials, returnable until the cutoff
    uint128 lentMargin; // their margin (quote), escrowed here from the moment of lending
    uint128 shortUnits; // lent units not returned by the cutoff, recorded lazily at the first touch after it
    uint128 shortMargin; // the forfeited margin: pays repayers who paid K for units that are not here
}

/// @notice The whole storage of the singleton. Logic libraries receive it by storage reference.
struct CoreState {
    mapping(bytes32 => PoolState) pools;
    mapping(bytes32 => mapping(uint8 => Book)) books;
    mapping(bytes32 => mapping(uint64 => Order)) orders;
    mapping(bytes32 => mapping(uint64 => bytes32)) linkedPool; // order in a new pool -> its source pool (rollover)
    mapping(bytes32 => mapping(uint64 => IConfluere.MarketStats)) stats;
    mapping(bytes32 => mapping(uint64 => mapping(uint256 => uint256))) tierVolume; // market -> expiry -> tier -> quote
    mapping(address => mapping(address => uint256)) pending;
    mapping(address => mapping(bytes32 => uint256)) lockedR;
    mapping(bytes32 => bool) graduated;
    mapping(address => uint256) graduationFee; // per quote token: treasury fees an expiry must earn to count
    mapping(address => uint256) minNotional; // per quote token: smallest order, valued at K (anti-dust)
    mapping(bytes32 => uint256) marketFees; // cumulative treasury fees per market (trade fees + spread share)
    mapping(address => uint256) flashFees; // cumulative flash-loan fees per token (not tied to a market)
    mapping(uint64 => uint64) windowEnd; // per expiry: one repayment window for every pool, set by the first mature()
    // ERC-6909 ledger
    mapping(address => mapping(uint256 => uint256)) balanceOf;
    mapping(uint256 => uint256) totalSupply;
    mapping(address => mapping(address => mapping(uint256 => uint256))) allowance;
    mapping(address => mapping(address => bool)) isOperator;
    uint64 nextOrderId;
}

/// @notice Deploy-time constants the logic libraries need (immutables live in the core contract), packed into three
/// words so every forwarding call in the core pushes three constants instead of twelve (core bytecode size).
/// a: treasury | maxOrdersPerSide << 160 | maxBids << 192 | autoSellDiscountBps << 224 | autoSellTtl << 240
/// b: windowBlocks | anchor << 64 | batchInterval << 128 | period << 192
/// c: specials | maxPauseBlocks << 160 | lendCutoff << 192
struct Params {
    uint256 a;
    uint256 b;
    uint256 c;
}

/// @notice Accessors for the packed Params.
library ParamsLib {
    function treasury(Params memory p) internal pure returns (address) {
        return address(uint160(p.a));
    }

    function maxOrdersPerSide(Params memory p) internal pure returns (uint32) {
        return uint32(p.a >> 160);
    }

    function maxBids(Params memory p) internal pure returns (uint32) {
        return uint32(p.a >> 192);
    }

    function autoSellDiscountBps(Params memory p) internal pure returns (uint16) {
        return uint16(p.a >> 224);
    }

    function autoSellTtl(Params memory p) internal pure returns (uint16) {
        return uint16(p.a >> 240);
    }

    function windowBlocks(Params memory p) internal pure returns (uint64) {
        return uint64(p.b);
    }

    function anchor(Params memory p) internal pure returns (uint64) {
        return uint64(p.b >> 64);
    }

    function batchInterval(Params memory p) internal pure returns (uint64) {
        return uint64(p.b >> 128);
    }

    function period(Params memory p) internal pure returns (uint64) {
        return uint64(p.b >> 192);
    }

    function specials(Params memory p) internal pure returns (address) {
        return address(uint160(p.c));
    }

    function maxPauseBlocks(Params memory p) internal pure returns (uint32) {
        return uint32(p.c >> 160);
    }

    function lendCutoff(Params memory p) internal pure returns (uint32) {
        return uint32(p.c >> 192);
    }
}

/// @notice Helpers shared by the core and every logic library. Internal, so each library embeds its own copy.
library CoreLib {
    using SafeERC20 for IERC20;
    using OrderSet for Book;
    using PoolKeyLib for bytes32;

    uint8 internal constant RM_FILLED = 0;
    uint8 internal constant RM_CANCELLED = 1;
    uint8 internal constant RM_EXPIRED = 2;
    uint8 internal constant RM_EVICTED = 3;
    uint8 internal constant RM_BID_CLOSED = 4;

    function pool(CoreState storage s, bytes32 poolId) internal view returns (PoolState storage ps) {
        ps = s.pools[poolId];
        if (ps.status == Status.None) revert IConfluere.InvalidPool();
    }

    function requireTrading(PoolState storage ps) internal view {
        if (ps.status != Status.Open || block.timestamp >= ps.key.expiry) revert IConfluere.InvalidState();
        if (block.number < ps.pausedUntil) revert IConfluere.IsPaused();
    }

    /// @notice This pool's batch interval: the base interval times 1, 12 or 48 by cadence.
    function interval(PoolState storage ps, uint64 base) internal view returns (uint256) {
        uint8 c = ps.key.cadence;
        return uint256(base) * (c == 0 ? 1 : c == 1 ? 12 : 48);
    }

    function scale(PoolState storage ps) internal view returns (uint256) {
        return 10 ** uint256(ps.assetDecimals);
    }

    /// @notice Counts treasury fees toward the market's graduation at this expiry. Saturating: never blocks.
    function addFees(CoreState storage s, PoolState storage ps, uint256 amount) internal {
        IConfluere.MarketStats storage st = s.stats[ps.marketId][ps.key.expiry];
        uint256 f = uint256(st.fees) + amount;
        st.fees = f > type(uint128).max ? type(uint128).max : uint128(f);
    }

    function newOrderId(CoreState storage s) internal returns (uint64 id) {
        id = s.nextOrderId + 1;
        s.nextOrderId = id;
    }

    // ------------------------------------------------------------ ERC-6909 ledger

    function mint(CoreState storage s, address to, uint256 id, uint256 amount) internal {
        s.balanceOf[to][id] += amount;
        s.totalSupply[id] += amount;
        emit IERC6909.Transfer(msg.sender, address(0), to, id, amount);
    }

    function burn(CoreState storage s, address from, uint256 id, uint256 amount) internal {
        s.balanceOf[from][id] -= amount;
        s.totalSupply[id] -= amount;
        emit IERC6909.Transfer(msg.sender, from, address(0), id, amount);
    }

    /// @notice R balance not locked in a pending rollover.
    function freeR(CoreState storage s, address account, bytes32 poolId) internal view returns (uint256) {
        return s.balanceOf[account][poolId.rId()] - s.lockedR[account][poolId];
    }

    // ------------------------------------------------------------ orders

    function insert(CoreState storage s, Params memory p, bytes32 poolId, PoolState storage ps, uint64 id, uint64 hint)
        internal
    {
        mapping(uint64 => Order) storage os = s.orders[poolId];
        Order storage o = os[id];
        uint8 side = o.side;
        Book storage b = s.books[poolId][side];
        uint32 max = side == BID ? ParamsLib.maxBids(p) : ParamsLib.maxOrdersPerSide(p);
        if (OrderSet.sorted(side)) {
            if (b.count >= max) {
                // Full book: evict the worst order if it has expired, or if the new order beats it on price, or
                // matches its price with a larger size (so dust cannot squat the best price levels).
                uint64 worst = b.tail;
                Order storage w = os[worst];
                bool beats = w.limit == o.limit ? o.units > w.units : !OrderSet.goesAfter(side, w.limit, o.limit);
                if (w.deadline > ps.settleCount && !beats) revert IConfluere.BookFull();
                if (hint == worst) hint = w.prev;
                removeWithRefund(s, poolId, ps, worst, RM_EVICTED);
            }
            b.insertSorted(os, id, hint);
        } else {
            if (b.count >= max) _evictSmallest(s, poolId, ps, b, os, o);
            b.pushBack(os, id);
        }
    }

    /// @dev Full non-competitive queue: drop an expired entry if any, else the smallest one if the new order is
    /// strictly larger (units for sells, quote budget for buys). Otherwise the queue is genuinely full.
    function _evictSmallest(
        CoreState storage s,
        bytes32 poolId,
        PoolState storage ps,
        Book storage b,
        mapping(uint64 => Order) storage os,
        Order storage o
    ) private {
        bool bySize = o.side == NC_SELL;
        uint256 newSize = bySize ? o.units : o.escrow;
        uint64 victim;
        uint256 smallest = type(uint256).max;
        for (uint64 cur = b.head; cur != 0; cur = os[cur].next) {
            Order storage c = os[cur];
            if (c.deadline <= ps.settleCount) {
                victim = cur;
                smallest = 0;
                break;
            }
            uint256 size = bySize ? c.units : c.escrow;
            if (size < smallest) {
                smallest = size;
                victim = cur;
            }
        }
        if (smallest != 0 && newSize <= smallest) revert IConfluere.BookFull();
        removeWithRefund(s, poolId, ps, victim, RM_EVICTED);
    }

    /// @notice Orders must be worth at least the quote token's minimum, valued at K. No minimum if none is set.
    function requireMinNotional(CoreState storage s, PoolState storage ps, uint256 units) internal view {
        uint256 min = s.minNotional[ps.key.quote];
        if (min != 0 && units * ps.key.strike / scale(ps) < min) revert IConfluere.InvalidParams();
    }

    /// @notice Credits everything an order still escrows to its owner's pending balance, then unlinks it.
    function removeWithRefund(CoreState storage s, bytes32 poolId, PoolState storage ps, uint64 id, uint8 reason)
        internal
    {
        Order storage o = s.orders[poolId][id];
        address owner = o.owner;
        uint8 side = o.side;
        if (side == SELL || side == NC_SELL) {
            if (o.flags & FLAG_ROLLOVER != 0) {
                s.lockedR[owner][s.linkedPool[poolId][id]] -= o.units;
                delete s.linkedPool[poolId][id];
                if (o.escrow != 0) s.pending[ps.key.quote][owner] += o.escrow;
            } else if (o.units != 0) {
                s.pending[ps.key.asset][owner] += o.units;
            }
        } else if (o.escrow != 0) {
            s.pending[ps.key.quote][owner] += o.escrow;
        }
        s.books[poolId][side].remove(s.orders[poolId], id);
        emit IConfluere.OrderRemoved(poolId, id, reason);
    }

    /// @notice Whether an order may trade in the settlement numbered `sc`, whose batch is followed by a boundary at
    /// `nextBoundary`. A rollover trades while the old pool's window runs, and also in the new pool's last batch
    /// before the old pool expires (blueprint 3.7 #5): the old pool's K is then paid in full one batch early.
    function live(CoreState storage s, bytes32 poolId, uint64 id, Order storage o, uint32 sc, uint256 nextBoundary)
        internal
        view
        returns (bool)
    {
        if (o.deadline <= sc) return false;
        if (o.flags & FLAG_ROLLOVER == 0) return true;
        PoolState storage op = s.pools[s.linkedPool[poolId][id]];
        // the old pool must hold every unit it backs: no rollover while lent units are out or recorded short
        if (op.lentUnits != 0 || op.shortUnits != 0) return false;
        return windowOpen(s, op)
            || (op.status == Status.Open && block.timestamp < op.key.expiry && nextBoundary >= op.key.expiry);
    }

    /// @notice Whether the pool's repayment window is running. Windows are aligned per expiry: after expiry a pool
    /// nobody has matured yet shares the window the first mature() of that expiry started (or is waiting for it).
    function windowOpen(CoreState storage s, PoolState storage ps) internal view returns (bool) {
        if (ps.status == Status.Window) return block.number < ps.windowEnd;
        if (ps.status != Status.Open || block.timestamp < ps.key.expiry) return false;
        uint64 e = s.windowEnd[ps.key.expiry];
        return e == 0 || block.number < e;
    }

    // ------------------------------------------------------------ tokens

    /// @notice Pulls `amount` from msg.sender and requires exactly that much to arrive (rejects fee-on-transfer).
    function pullExact(address token, uint256 amount) internal {
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        if (IERC20(token).balanceOf(address(this)) - before != amount) revert IConfluere.BadToken();
    }

    function push(address token, address to, uint256 amount) internal {
        IERC20(token).safeTransfer(to, amount);
    }
}
