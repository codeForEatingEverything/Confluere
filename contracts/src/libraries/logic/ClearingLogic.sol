// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.37;

import {IConfluere} from "../../interfaces/IConfluere.sol";
import {PoolKey, PoolKeyLib} from "../PoolKey.sol";
import {Order, SELL, BUY, NC_SELL, NC_BUY, FLAG_ROLLOVER} from "../OrderSet.sol";
import {Clearing} from "../Clearing.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Settlement} from "../Settlement.sol";
import {CoreState, PoolState, Params, CoreLib} from "../State.sol";

/// @notice Uniform-price batch clearing. Linked library; runs in the core's context.
///
/// Pass 1 (read-only) crosses the competitive books alone: volume q0 and price P0 (midpoint of the marginal pair).
/// If P0 is inside the band, non-competitive buy demand enters the price once (blueprint 4.2): d = min(NC budget at P0,
/// 50% of q0) units of any-price demand take the cheapest sells first, the competitive books recross on what is left,
/// and P* is the midpoint of the marginal competitive pair of that recross. When d would leave no competitive buy
/// filled there is no price from NC demand and the competitive-only result stands. NC sells never price. Then
/// non-competitive sells trade at P* against competitive leftovers and remaining NC budget, inside the same cap.
/// Pass 2 applies the fills in book order, skipping exactly the orders pass 1 skipped, so the allocations match.
library ClearingLogic {
    using CoreLib for CoreState;
    using CoreLib for PoolState;
    using PoolKeyLib for bytes32;

    uint256 internal constant NC_SHARE_BPS = 5000;
    uint8 internal constant BREAKER_FAILURES = 3;

    struct Batch {
        bytes32 poolId;
        uint256 scale;
        uint256 price;
        uint32 sc;
        uint256 paid;
        uint256 received;
        address treasury;
        address quote;
        uint256 strike;
        uint256 spread;
        uint256 trade;
    }

    struct Cursor {
        uint64 id;
        uint256 rem;
    }

    struct Plan {
        uint256 q;
        uint256 ncX; // NC buy units priced in by the recross
        uint256 q0; // competitive-only crossing volume, the base of the 50% cap
        uint256 sellC2;
        uint256 buyC2;
        uint256 sellNC;
        uint256 buyNC;
    }

    function settleBatch(CoreState storage s, Params memory pr, bytes32 poolId) external {
        PoolState storage ps = s.pool(poolId);
        ps.requireTrading();
        uint64 batchIndex = uint64((block.timestamp - pr.anchor) / ps.interval(pr.batchInterval));
        if (batchIndex <= ps.lastSettledBatch) revert IConfluere.BatchNotReady();
        ps.lastSettledBatch = batchIndex;

        Batch memory bt;
        bt.poolId = poolId;
        bt.scale = ps.scale();
        bt.sc = ps.settleCount;
        bt.treasury = pr.treasury;
        bt.quote = ps.key.quote;
        bt.strike = ps.key.strike;
        ps.settleCount = bt.sc + 1;

        for (uint8 side; side <= NC_BUY; ++side) {
            _dropExpiredHead(s, ps, bt, side);
        }
        Plan memory pl = _plan(s, ps, bt);
        uint256 total;
        if (pl.q != 0) {
            _fillSorted(s, ps, bt, SELL, pl.q + pl.ncX + pl.sellC2);
            _fillSorted(s, ps, bt, BUY, pl.q + pl.buyC2);
            if (pl.sellNC != 0) _fillQueue(s, ps, bt, NC_SELL, pl.sellNC);
            if (pl.ncX + pl.buyNC != 0) _fillQueue(s, ps, bt, NC_BUY, pl.ncX + pl.buyNC);

            total = pl.q + pl.ncX + pl.sellNC + pl.sellC2;
            ps.quoteBal += bt.paid - bt.received;
            ps.feeEscrow += bt.spread;
            ps.filledUnits += total;
            if (bt.trade != 0) {
                s.pending[bt.quote][bt.treasury] += bt.trade;
                s.marketFees[ps.marketId] += bt.trade;
                CoreLib.addFees(s, ps, bt.trade);
            }
            _countVolume(s, ps, Clearing.quoteDown(total, bt.price, bt.scale));
        }
        emit IConfluere.BatchSettled(poolId, bt.sc, bt.price, pl.q, total - pl.q, bt.spread, bt.trade, pl.q0);
    }

    /// @dev Market volume at this expiry, the pool's tier volume, and the main tier as an incremental argmax (O(1);
    /// ties keep the tier that got there first). Saturating: the counters must never block clearing.
    function _countVolume(CoreState storage s, PoolState storage ps, uint256 vol) private {
        PoolKey storage k = ps.key;
        IConfluere.MarketStats storage st = s.stats[ps.marketId][k.expiry];
        st.volume = _sat128(uint256(st.volume) + vol);
        uint256 tv = s.tierVolume[ps.marketId][k.expiry][PoolKeyLib.tierKey(k.strike, k.bandBps, k.cadence)] += vol;
        if (tv > st.mainVolume) {
            st.mainVolume = _sat128(tv);
            st.mainStrike = uint96(k.strike);
            st.mainIndex = ps.strikeIndex;
            st.mainBand = k.bandBps;
            st.mainCadence = k.cadence;
        }
    }

    function _sat128(uint256 x) private pure returns (uint128) {
        return x > type(uint128).max ? type(uint128).max : uint128(x);
    }

    function _plan(CoreState storage s, PoolState storage ps, Batch memory bt) private returns (Plan memory pl) {
        Cursor memory cs;
        Cursor memory cb;
        (pl.q, cs, cb, bt.price) = _cross(s, bt, 0);
        if (pl.q == 0) return pl;
        // Minimum fill and first-auction bounds: too little competitive volume, or a first price outside the creator's
        // range, means the batch does not trade and every order rolls to the next batch.
        if (
            pl.q < ps.minFill
                || (ps.filledUnits == 0 && (bt.price < ps.firstLo || (ps.firstHi != 0 && bt.price > ps.firstHi)))
        ) {
            pl.q = 0;
            bt.price = 0;
            return pl;
        }
        pl.q0 = pl.q;
        if (_bandAllowsNc(s, ps, bt.price)) {
            uint256 cap = pl.q * NC_SHARE_BPS / Clearing.BPS;
            _priceNc(s, bt, pl, cs, cb, cap);
            if (pl.ncX != 0) ps.bandBase = SafeCast.toUint96(bt.price);
            _sizeNc(s, bt, pl, cs, cb, cap);
        }
        ps.lastClearingPrice = SafeCast.toUint96(bt.price);
    }

    /// @dev Non-competitive buy demand in the price: one recross with d = min(NC units at P0, cap) any-price units
    /// ahead of the competitive buys. Adopted only if a competitive buy still fills and some NC demand is eligible at
    /// the new price; the units taken are what that demand affords at the new price, never more than d.
    function _priceNc(
        CoreState storage s,
        Batch memory bt,
        Plan memory pl,
        Cursor memory cs,
        Cursor memory cb,
        uint256 cap
    ) private view {
        uint256 d = _sumQueue(s, bt.poolId, NC_BUY, bt, cap);
        if (d > cap) d = cap;
        if (d == 0) return;
        (uint256 q1, Cursor memory cs1, Cursor memory cb1, uint256 p1) = _cross(s, bt, d);
        if (q1 == 0) return;
        uint256 p0 = bt.price;
        bt.price = p1;
        uint256 x = _sumQueue(s, bt.poolId, NC_BUY, bt, d);
        if (x == 0) {
            bt.price = p0;
            return;
        }
        pl.q = q1;
        pl.ncX = x < d ? x : d;
        (cs.id, cs.rem, cb.id, cb.rem) = (cs1.id, cs1.rem, cb1.id, cb1.rem);
    }

    /// @dev Pass 1: crossing volume and the midpoint of the marginal competitive pair, after `pre` units of
    /// any-price demand have taken the cheapest sells. Leaves the cursors where competitive matching stopped.
    function _cross(CoreState storage s, Batch memory bt, uint256 pre)
        private
        view
        returns (uint256 q, Cursor memory cs, Cursor memory cb, uint256 price)
    {
        mapping(uint64 => Order) storage os = s.orders[bt.poolId];
        cs = _firstLive(s, bt.poolId, s.books[bt.poolId][SELL].head, bt.sc);
        cb = _firstLive(s, bt.poolId, s.books[bt.poolId][BUY].head, bt.sc);
        while (pre != 0 && cs.id != 0) {
            uint256 t = cs.rem < pre ? cs.rem : pre;
            pre -= t;
            cs.rem -= t;
            if (cs.rem == 0) cs = _firstLive(s, bt.poolId, os[cs.id].next, bt.sc);
        }
        if (pre != 0) return (0, cs, cb, 0);
        uint256 lastB;
        while (cs.id != 0 && cb.id != 0) {
            uint96 sl = os[cs.id].limit;
            uint96 bl = os[cb.id].limit;
            if (sl > bl) break;
            uint256 m = cs.rem < cb.rem ? cs.rem : cb.rem;
            q += m;
            price = sl; // marginal sell; becomes the midpoint below
            lastB = bl;
            cs.rem -= m;
            cb.rem -= m;
            if (cs.rem == 0) cs = _firstLive(s, bt.poolId, os[cs.id].next, bt.sc);
            if (cb.rem == 0) cb = _firstLive(s, bt.poolId, os[cb.id].next, bt.sc);
        }
        if (q != 0) price = Clearing.midpoint(price, lastB);
    }

    /// @dev Stage 2 sizing: non-competitive volume at P*, inside what is left of the 50% cap after the recross.
    function _sizeNc(
        CoreState storage s,
        Batch memory bt,
        Plan memory pl,
        Cursor memory cs,
        Cursor memory cb,
        uint256 cap
    ) private view {
        if (cap <= pl.ncX) return;
        uint256 cap2 = cap - pl.ncX;
        uint256 ncS = _sumQueue(s, bt.poolId, NC_SELL, bt, cap2);
        uint256 ncB = _sumQueue(s, bt.poolId, NC_BUY, bt, cap);
        ncB = ncB > pl.ncX ? ncB - pl.ncX : 0;
        uint256 cSL = _sumLeftover(s, bt.poolId, SELL, cs, bt, cap2);
        // By construction at most one competitive side still has orders willing at P*; never match comp vs comp.
        uint256 cBL = cSL != 0 ? 0 : _sumLeftover(s, bt.poolId, BUY, cb, bt, cap2);
        uint256 m2 = ncS + cSL;
        if (ncB + cBL < m2) m2 = ncB + cBL;
        if (cap2 < m2) m2 = cap2;
        pl.sellNC = ncS < m2 ? ncS : m2;
        pl.sellC2 = m2 - pl.sellNC;
        pl.buyNC = ncB < m2 ? ncB : m2;
        pl.buyC2 = m2 - pl.buyNC;
    }

    /// @dev Static band around the last accepted price, widened 1.5x per consecutive failure. After three failures
    /// non-competitive orders sit out until the next competitive price resets the base.
    function _bandAllowsNc(CoreState storage s, PoolState storage ps, uint256 price) private returns (bool) {
        uint256 base = ps.bandBase;
        uint8 f = ps.bandFailures;
        if (base == 0 || f >= BREAKER_FAILURES) {
            ps.bandBase = SafeCast.toUint96(price);
            ps.bandFailures = 0;
            return false;
        }
        if (Clearing.withinBand(price, base, Clearing.widenedBand(ps.key.bandBps, f))) {
            ps.bandBase = SafeCast.toUint96(price);
            ps.bandFailures = 0;
            return true;
        }
        ps.bandFailures = ++f;
        if (f >= BREAKER_FAILURES) s.stats[ps.marketId][ps.key.expiry].bad = true;
        return false;
    }

    function _fillSorted(CoreState storage s, PoolState storage ps, Batch memory bt, uint8 side, uint256 target)
        private
    {
        mapping(uint64 => Order) storage os = s.orders[bt.poolId];
        uint64 id = s.books[bt.poolId][side].head;
        while (target != 0 && id != 0) {
            Order storage o = os[id];
            uint64 nxt = o.next;
            if (!s.live(bt.poolId, id, o, bt.sc)) {
                if (o.deadline <= bt.sc) s.removeWithRefund(bt.poolId, ps, id, CoreLib.RM_EXPIRED);
            } else {
                uint256 f = o.units < target ? o.units : target;
                target -= f;
                if (side == SELL) _fillSell(s, ps, bt, id, o, f);
                else _fillBuy(s, ps, bt, id, o, f);
            }
            id = nxt;
        }
    }

    function _fillQueue(CoreState storage s, PoolState storage ps, Batch memory bt, uint8 side, uint256 target)
        private
    {
        mapping(uint64 => Order) storage os = s.orders[bt.poolId];
        uint64 id = s.books[bt.poolId][side].head;
        while (target != 0 && id != 0) {
            Order storage o = os[id];
            uint64 nxt = o.next;
            if (o.deadline <= bt.sc) {
                s.removeWithRefund(bt.poolId, ps, id, CoreLib.RM_EXPIRED);
            } else if (_ncEligible(o, side, bt)) {
                uint256 avail = side == NC_SELL ? o.units : Settlement.ncUnits(o.escrow, bt.price, bt.scale);
                uint256 f = avail < target ? avail : target;
                if (f != 0) {
                    target -= f;
                    if (side == NC_SELL) _fillSell(s, ps, bt, id, o, f);
                    else _fillBuy(s, ps, bt, id, o, f);
                }
            }
            id = nxt;
        }
    }

    function _fillSell(
        CoreState storage s,
        PoolState storage ps,
        Batch memory bt,
        uint64 id,
        Order storage o,
        uint256 f
    ) private {
        uint256 net = _sellProceeds(bt, id, f);
        address owner = o.owner;
        ps.assetBal += f;
        if (o.flags & FLAG_ROLLOVER != 0) {
            _settleRollover(s, bt, id, o, f, net);
        } else {
            s.pending[ps.key.quote][owner] += net;
        }
        s.mint(owner, bt.poolId.rId(), f);
        uint96 rem = o.units - uint96(f);
        if (rem == 0) {
            o.units = 0;
            s.removeWithRefund(bt.poolId, ps, id, CoreLib.RM_FILLED);
        } else {
            o.units = rem;
        }
    }

    /// @dev Seller side of a fill: gross at P*, less the spread share (to the pool's escrow) and the trade fee.
    function _sellProceeds(Batch memory bt, uint64 id, uint256 f) private returns (uint256 net) {
        uint256 gross;
        uint256 spread;
        uint256 trade;
        (gross, spread, trade, net) = Settlement.sellSplit(f, bt.price, bt.strike, bt.scale);
        bt.received += gross;
        bt.spread += spread;
        bt.trade += trade;
        emit IConfluere.OrderFilled(bt.poolId, id, f, gross, spread + trade);
    }

    /// @dev New-pool net proceeds pay K into the old pool (the old pool counts these units as repaid); the pre-funded
    /// top-up covers any gap.
    /// The asset moves from the old pool to the new one and the old R is burned; the caller mints the new R.
    function _settleRollover(
        CoreState storage s,
        Batch memory bt,
        uint64 id,
        Order storage o,
        uint256 f,
        uint256 proceeds
    ) private {
        bytes32 oldId = s.rolloverOld[bt.poolId][id];
        PoolState storage op = s.pools[oldId];
        address owner = o.owner;
        uint256 pay = Settlement.repayAmount(f, op.key.strike, op.scale());
        uint256 topUp;
        if (proceeds >= pay) {
            s.pending[bt.quote][owner] += proceeds - pay;
        } else {
            topUp = pay - proceeds;
            o.escrow -= SafeCast.toUint128(topUp);
        }
        op.quoteBal += pay;
        op.repaidUnits += f;
        op.assetBal -= f;
        s.lockedR[owner][oldId] -= f;
        s.burn(owner, oldId.rId(), f);
        emit IConfluere.RolledOver(oldId, bt.poolId, owner, f, topUp);
    }

    function _fillBuy(CoreState storage s, PoolState storage ps, Batch memory bt, uint64 id, Order storage o, uint256 f)
        private
    {
        uint256 cost = Clearing.quoteUp(f, bt.price, bt.scale);
        uint256 fee = Settlement.tradeFee(cost);
        bt.paid += cost;
        bt.trade += fee;
        uint256 esc = o.escrow - cost - fee;
        address owner = o.owner;
        s.mint(owner, bt.poolId.cId(), f);
        emit IConfluere.OrderFilled(bt.poolId, id, f, cost, fee);
        if (o.side == BUY) {
            uint256 rem = o.units - f;
            if (rem == 0) {
                o.units = 0;
                o.escrow = uint128(esc);
                s.removeWithRefund(bt.poolId, ps, id, CoreLib.RM_FILLED);
                return;
            }
            // Keep exactly what the remainder can still cost, plus the per-batch rounding reserve.
            uint256 left = o.deadline > bt.sc + 1 ? o.deadline - bt.sc - 1 : 0;
            uint256 req = Settlement.buyEscrow(rem, o.limit, bt.scale, left);
            if (esc > req) {
                s.pending[ps.key.quote][owner] += esc - req;
                esc = req;
            }
            o.units = uint96(rem);
            o.escrow = uint128(esc);
        } else {
            o.escrow = uint128(esc);
            if (esc == 0) s.removeWithRefund(bt.poolId, ps, id, CoreLib.RM_FILLED);
        }
    }

    /// @dev A non-competitive order trades at P* only inside its protective limit, and a lender never pays P* >= K:
    /// C pays out at most K (or the asset when the borrower walks away), so such a fill is a certain loss.
    /// This blocks wash-traded prices from being pushed onto vaults and other price-takers.
    function _ncEligible(Order storage o, uint8 side, Batch memory bt) private view returns (bool) {
        uint256 lim = o.limit;
        if (side == NC_BUY) return bt.price < bt.strike && (lim == 0 || bt.price <= lim);
        return lim == 0 || bt.price >= lim;
    }

    /// @dev Expired orders at the top of a book are removed and refunded every batch.
    function _dropExpiredHead(CoreState storage s, PoolState storage ps, Batch memory bt, uint8 side) private {
        mapping(uint64 => Order) storage os = s.orders[bt.poolId];
        uint64 id = s.books[bt.poolId][side].head;
        while (id != 0 && os[id].deadline <= bt.sc) {
            uint64 nxt = os[id].next;
            s.removeWithRefund(bt.poolId, ps, id, CoreLib.RM_EXPIRED);
            id = nxt;
        }
    }

    function _firstLive(CoreState storage s, bytes32 poolId, uint64 id, uint32 sc)
        private
        view
        returns (Cursor memory c)
    {
        mapping(uint64 => Order) storage os = s.orders[poolId];
        while (id != 0 && !s.live(poolId, id, os[id], sc)) {
            id = os[id].next;
        }
        c.id = id;
        if (id != 0) c.rem = os[id].units;
    }

    /// @dev Competitive units still willing to trade at P* after pass 1, starting from the pass-1 cursor.
    function _sumLeftover(
        CoreState storage s,
        bytes32 poolId,
        uint8 side,
        Cursor memory c,
        Batch memory bt,
        uint256 cap
    ) private view returns (uint256 sum) {
        mapping(uint64 => Order) storage os = s.orders[poolId];
        uint64 id = c.id;
        uint256 rem = c.rem;
        while (id != 0 && sum < cap) {
            Order storage o = os[id];
            if (side == SELL ? o.limit > bt.price : o.limit < bt.price) break;
            sum += rem;
            Cursor memory nx = _firstLive(s, poolId, o.next, bt.sc);
            id = nx.id;
            rem = nx.rem;
        }
    }

    function _sumQueue(CoreState storage s, bytes32 poolId, uint8 side, Batch memory bt, uint256 cap)
        private
        view
        returns (uint256 sum)
    {
        mapping(uint64 => Order) storage os = s.orders[poolId];
        uint64 id = s.books[poolId][side].head;
        while (id != 0 && sum < cap) {
            Order storage o = os[id];
            if (o.deadline > bt.sc && _ncEligible(o, side, bt)) {
                sum += side == NC_SELL ? o.units : Settlement.ncUnits(o.escrow, bt.price, bt.scale);
            }
            id = o.next;
        }
    }
}
