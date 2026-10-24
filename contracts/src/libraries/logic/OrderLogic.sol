// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.37;

import {IConfluere} from "../../interfaces/IConfluere.sol";
import {PoolKey, PoolKeyLib, Status} from "../PoolKey.sol";
import {GridConfig, Grid} from "../Grid.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Order, SELL, BUY, NC_SELL, NC_BUY, BID, FLAG_ROLLOVER, FLAG_LOCKED} from "../OrderSet.sol";
import {Clearing} from "../Clearing.sol";
import {Settlement} from "../Settlement.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {CoreState, PoolState, Params, ParamsLib, CoreLib} from "../State.sol";

/// @notice Order entry, cancellation and abandonment-auction bids. Linked library; runs in the core's context.
library OrderLogic {
    using CoreLib for CoreState;
    using CoreLib for PoolState;
    using ParamsLib for Params;
    using PoolKeyLib for bytes32;

    uint16 internal constant MAX_TTL = 1000;

    /// @notice Permissionless pool creation (moved out of the core for bytecode size). Validates the key against the
    /// grid, round-trips one unit of each token to reject fee-on-transfer, and stores the creator's options.
    function createPool(
        CoreState storage s,
        GridConfig memory g,
        PoolKey calldata key,
        int16 strikeIndex,
        IConfluere.PoolOptions calldata opts
    ) external returns (bytes32 poolId) {
        if (key.asset == key.quote || key.asset.code.length == 0 || key.quote.code.length == 0) {
            revert IConfluere.BadToken();
        }
        uint16 band = key.bandBps;
        if (band != 150 && band != 800 && band != 1500) revert IConfluere.InvalidParams();
        if (!Grid.isListableExpiry(g, key.expiry, block.timestamp)) revert IConfluere.InvalidParams();
        if (key.cadence > 2 || (opts.firstHi != 0 && opts.firstLo > opts.firstHi)) revert IConfluere.InvalidParams();

        poolId = PoolKeyLib.toId(key);
        PoolState storage ps = s.pools[poolId];
        if (ps.status != Status.None) revert IConfluere.InvalidPool();

        uint8 dec = IERC20Metadata(key.asset).decimals();
        uint8 qd = IERC20Metadata(key.quote).decimals();
        if (dec > 30 || qd > 30) revert IConfluere.BadToken();
        if (!Grid.isGridStrike(key.strike, strikeIndex, qd)) revert IConfluere.InvalidParams();
        _probe(key.asset);
        _probe(key.quote);

        ps.key = key;
        ps.marketId = PoolKeyLib.marketId(key.asset, key.quote, key.kind);
        ps.status = Status.Open;
        ps.assetDecimals = dec;
        ps.strikeIndex = strikeIndex;
        ps.autoSell = opts.autoSell;
        ps.minFill = opts.minFill;
        ps.firstLo = opts.firstLo;
        ps.firstHi = opts.firstHi;
        uint256 iv = ps.interval(g.batchInterval);
        if (iv > g.period) revert IConfluere.InvalidParams();
        ps.lastSettledBatch = uint64((block.timestamp - g.anchor) / iv);
        emit IConfluere.PoolCreated(poolId, key, strikeIndex, ps.marketId);
        if (opts.minFill != 0 || opts.firstLo != 0 || opts.firstHi != 0 || opts.autoSell) {
            emit IConfluere.PoolOptionsSet(poolId, opts.minFill, opts.firstLo, opts.firstHi, opts.autoSell);
        }
    }

    /// @dev Round-trip one base unit to reject fee-on-transfer tokens at pool creation.
    function _probe(address token) private {
        CoreLib.pullExact(token, 1);
        uint256 before = IERC20(token).balanceOf(msg.sender);
        CoreLib.push(token, msg.sender, 1);
        if (IERC20(token).balanceOf(msg.sender) != before + 1) revert IConfluere.BadToken();
    }

    function placeOrder(
        CoreState storage s,
        Params memory pr,
        bytes32 poolId,
        IConfluere.OrderParams calldata p,
        bool locked
    ) external returns (uint64 id) {
        PoolState storage ps = s.pool(poolId);
        ps.requireTrading();
        if (p.ttl == 0 || p.ttl > MAX_TTL) revert IConfluere.InvalidParams();
        address owner = p.owner == address(0) ? msg.sender : p.owner;

        id = s.newOrderId();
        Order storage o = s.orders[poolId][id];
        o.owner = owner;
        o.side = p.side;
        o.deadline = ps.settleCount + p.ttl;
        if (locked) o.flags = FLAG_LOCKED;

        // Competitive orders carry a limit. Non-competitive orders trade at P*; their optional `limit` is only a
        // protective floor (NC_SELL) or ceiling (NC_BUY), never a price they set.
        if (p.side == SELL || p.side == NC_SELL) {
            if (p.units == 0 || (p.side == SELL && p.limit == 0) || p.budget != 0) revert IConfluere.InvalidParams();
            s.requireMinNotional(ps, p.units);
            o.units = p.units;
            o.limit = p.limit;
            CoreLib.pullExact(ps.key.asset, p.units);
        } else if (p.side == BUY) {
            if (p.units == 0 || p.limit == 0 || p.budget != 0) revert IConfluere.InvalidParams();
            s.requireMinNotional(ps, p.units);
            // Escrow covers the full order at its limit, its trade fee, and 2 wei of rounding per batch it can trade in.
            uint256 esc = Settlement.buyEscrow(p.units, p.limit, ps.scale(), p.ttl);
            o.units = p.units;
            o.limit = p.limit;
            o.escrow = SafeCast.toUint128(esc);
            CoreLib.pullExact(ps.key.quote, esc);
        } else if (p.side == NC_BUY) {
            if (p.budget == 0 || p.units != 0) revert IConfluere.InvalidParams();
            if (p.budget < s.minNotional[ps.key.quote]) revert IConfluere.InvalidParams();
            o.escrow = p.budget;
            o.limit = p.limit;
            CoreLib.pullExact(ps.key.quote, p.budget);
        } else {
            revert IConfluere.InvalidParams();
        }
        s.insert(pr, poolId, ps, id, p.hint);
        emit IConfluere.OrderPlaced(poolId, id, owner, p.side, o.units, o.limit, o.escrow, o.deadline);
    }

    struct RolloverArgs {
        bytes32 oldPoolId;
        bytes32 newPoolId;
        uint96 units;
        uint96 minPrice;
        uint128 maxTopUp;
        uint16 ttl;
        uint64 hint;
    }

    /// @notice Lock R in the old pool and post a rollover sell into the new pool, pre-funding the top-up.
    function rollover(CoreState storage s, Params memory pr, RolloverArgs memory a) external returns (uint64 id) {
        PoolState storage op = s.pool(a.oldPoolId);
        PoolState storage np = s.pool(a.newPoolId);
        np.requireTrading();
        if (
            op.key.asset != np.key.asset || op.key.quote != np.key.quote || op.key.kind != np.key.kind
                || np.key.expiry <= op.key.expiry
        ) revert IConfluere.InvalidPool();
        if (!((op.status == Status.Open && block.timestamp < op.key.expiry) || s.windowOpen(op))) {
            revert IConfluere.InvalidState();
        }
        if (a.units == 0 || a.minPrice == 0 || a.ttl == 0 || a.ttl > MAX_TTL) revert IConfluere.InvalidParams();

        // The top-up is largest when the new pool clears at minPrice: K - minPrice per unit, plus the seller's trade
        // fee and spread share at minPrice, plus rounding (one wei on each leg and on each fee) per batch.
        uint256 sc = op.scale();
        uint256 k = op.key.strike;
        uint256 need = (k > a.minPrice ? Clearing.quoteUp(a.units, k - a.minPrice, sc) : 0)
            + Settlement.tradeFee(Clearing.quoteUp(a.units, a.minPrice, sc))
            + Settlement.spreadShare(a.units, np.key.strike, a.minPrice, sc) + 4 * uint256(a.ttl);
        if (a.maxTopUp < need) revert IConfluere.InvalidParams();

        s.requireMinNotional(op, a.units);
        if (s.freeR(msg.sender, a.oldPoolId) < a.units) revert IConfluere.Locked();
        s.lockedR[msg.sender][a.oldPoolId] += a.units;

        id = s.newOrderId();
        Order storage o = s.orders[a.newPoolId][id];
        o.owner = msg.sender;
        o.side = SELL;
        o.flags = FLAG_ROLLOVER;
        o.deadline = np.settleCount + a.ttl;
        o.units = a.units;
        o.limit = a.minPrice;
        o.escrow = a.maxTopUp;
        s.linkedPool[a.newPoolId][id] = a.oldPoolId;
        CoreLib.pullExact(np.key.quote, a.maxTopUp);
        s.insert(pr, a.newPoolId, np, id, a.hint);
        emit IConfluere.OrderPlaced(a.newPoolId, id, msg.sender, SELL, a.units, a.minPrice, a.maxTopUp, o.deadline);
    }

    function cancelOrder(CoreState storage s, Params memory pr, bytes32 poolId, uint64 id) external {
        PoolState storage ps = s.pool(poolId);
        Order storage o = s.orders[poolId][id];
        address owner = o.owner;
        if (owner == address(0)) revert IConfluere.InvalidParams();
        if (msg.sender != owner && !s.isOperator[owner][msg.sender]) revert IConfluere.NotOwner();
        if (o.side == BID && !(ps.status == Status.Window && block.number < ps.windowEnd)) {
            revert IConfluere.InvalidState();
        }
        // a commitment order stays until it fills, expires or trading ends
        if (
            o.flags & FLAG_LOCKED != 0 && o.deadline > ps.settleCount && ps.status == Status.Open
                && block.timestamp < ps.key.expiry
        ) revert IConfluere.Locked();
        // cancel cutoff: in long-tail pools a live order cannot be cancelled in the last 1/12 of its batch, nor after the
        // batch boundary while that batch is still unsettled (it clears whenever settleBatch runs, so the gap before
        // it is still "just before clearing"). Anyone can settle to lift the latter; while paused nothing can settle,
        // so that rule is off then.
        if (
            ps.key.cadence != 0 && o.side != BID && o.deadline > ps.settleCount && ps.status == Status.Open
                && block.timestamp < ps.key.expiry
        ) {
            uint256 iv = ps.interval(pr.batchInterval());
            uint256 cur = (block.timestamp - pr.anchor()) / iv;
            uint256 next = pr.anchor() + (cur + 1) * iv;
            bool due = cur > ps.lastSettledBatch && block.number >= ps.pausedUntil;
            if (due || next - block.timestamp <= iv / 12) revert IConfluere.InvalidState();
        }
        s.removeWithRefund(poolId, ps, id, CoreLib.RM_CANCELLED);
    }

    /// @notice Remove orders that can no longer trade. Non-removable ids are skipped so keepers can batch freely.
    function purge(CoreState storage s, bytes32 poolId, uint64[] calldata ids) external {
        PoolState storage ps = s.pool(poolId);
        bool tradingOver = ps.status != Status.Open || block.timestamp >= ps.key.expiry;
        for (uint256 i; i < ids.length; ++i) {
            Order storage o = s.orders[poolId][ids[i]];
            if (o.owner == address(0) || o.side == BID) continue;
            bool dead = tradingOver || o.deadline <= ps.settleCount;
            if (!dead && o.flags & FLAG_ROLLOVER != 0) {
                PoolState storage op = s.pools[s.linkedPool[poolId][ids[i]]];
                dead = !s.windowOpen(op) && (op.status != Status.Open || block.timestamp >= op.key.expiry);
            }
            if (dead) s.removeWithRefund(poolId, ps, ids[i], CoreLib.RM_EXPIRED);
        }
    }

    /// @notice Bid for unrepaid R units: escrow K plus a surplus per whole asset. Highest surplus fills first.
    function bid(
        CoreState storage s,
        Params memory pr,
        bytes32 poolId,
        uint96 units,
        uint96 surplusPerUnit,
        uint64 hint
    ) external returns (uint64 id) {
        PoolState storage ps = s.pool(poolId);
        if (ps.status != Status.Window || block.number >= ps.windowEnd) revert IConfluere.InvalidState();
        if (units == 0) revert IConfluere.InvalidParams();
        s.requireMinNotional(ps, units);
        uint256 esc = Clearing.quoteUp(units, uint256(ps.key.strike) + surplusPerUnit, ps.scale());
        id = s.newOrderId();
        Order storage o = s.orders[poolId][id];
        o.owner = msg.sender;
        o.side = BID;
        o.deadline = type(uint32).max;
        o.units = units;
        o.limit = surplusPerUnit;
        o.escrow = SafeCast.toUint128(esc);
        CoreLib.pullExact(ps.key.quote, esc);
        s.insert(pr, poolId, ps, id, hint);
        emit IConfluere.OrderPlaced(poolId, id, msg.sender, BID, units, surplusPerUnit, o.escrow, o.deadline);
    }
}
