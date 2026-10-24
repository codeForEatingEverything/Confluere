// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.37;

import {IConfluere} from "../../interfaces/IConfluere.sol";
import {PoolKeyLib, Kind, Status} from "../PoolKey.sol";
import {Order, Book, OrderSet, SELL, BID, FLAG_AUTOSELL} from "../OrderSet.sol";
import {PoolKey} from "../PoolKey.sol";
import {Clearing} from "../Clearing.sol";
import {Settlement} from "../Settlement.sol";
import {CoreState, PoolState, Params, ParamsLib, CoreLib} from "../State.sol";

/// @notice Repayment, the abandonment auction at window close, and final claims. Linked library.
library WindowLogic {
    using CoreLib for CoreState;
    using CoreLib for PoolState;
    using ParamsLib for Params;
    using PoolKeyLib for bytes32;

    uint8 internal constant GRADUATION_CYCLES = 4;
    uint256 internal constant LEND_MAX_BPS = 5000; // at most half of a pool's asset may be lent
    uint256 internal constant LEND_MARGIN_BPS = 12_000; // margin >= 120% of the lent units at the last clearing price

    /// @notice Start (or join) the expiry's shared repayment window.
    function mature(CoreState storage s, Params memory pr, bytes32 poolId) external {
        PoolState storage ps = s.pool(poolId);
        if (ps.status != Status.Open || block.timestamp < ps.key.expiry) revert IConfluere.InvalidState();
        _syncShort(ps, pr, poolId);
        ps.status = Status.Window;
        // one window per expiry: the first mature() of an expiry starts it, later pools join it
        uint64 end = s.windowEnd[ps.key.expiry];
        if (end == 0) s.windowEnd[ps.key.expiry] = end = uint64(block.number) + pr.windowBlocks();
        ps.windowEnd = end;
        emit IConfluere.Matured(poolId, end);
    }

    /// @notice Guardian pause of an un-graduated pool (the core checks the caller). Each pool has a cumulative budget
    /// of MAX_PAUSE_BLOCKS, counted on the blocks granted; a running pause cannot be extended (invariant 3c).
    function pause(CoreState storage s, Params memory pr, bytes32 poolId, uint64 blocks) external {
        PoolState storage ps = s.pool(poolId);
        uint256 total = uint256(ps.pausedBlocks) + blocks;
        if (s.graduated[ps.marketId] || blocks == 0 || total > pr.maxPauseBlocks()) revert IConfluere.InvalidParams();
        if (block.number < ps.pausedUntil) revert IConfluere.IsPaused();
        uint64 until = uint64(block.number) + blocks;
        ps.pausedUntil = until;
        ps.pausedBlocks = uint64(total);
        s.stats[ps.marketId][ps.key.expiry].bad = true;
        emit IConfluere.Paused(poolId, until, uint64(total));
    }

    /// @notice Permissionless. A market graduates after GRADUATION_CYCLES consecutive past expiries that each reached
    /// the per-quote treasury-fee baseline (trade fees + spread share) with no pause and no circuit breaker.
    function graduate(CoreState storage s, Params memory pr, address asset, address quote, Kind kind, uint64 lastExpiry)
        external
    {
        bytes32 m = PoolKeyLib.marketId(asset, quote, kind);
        uint256 threshold = s.graduationFee[quote];
        if (
            s.graduated[m] || threshold == 0 || lastExpiry < pr.anchor()
                || (lastExpiry - pr.anchor()) % pr.period() != 0 || lastExpiry >= block.timestamp
        ) revert IConfluere.InvalidParams();
        if (lastExpiry < pr.anchor() + uint256(pr.period()) * (GRADUATION_CYCLES - 1)) {
            revert IConfluere.InvalidParams();
        }
        for (uint256 i; i < GRADUATION_CYCLES; ++i) {
            IConfluere.MarketStats storage st = s.stats[m][uint64(lastExpiry - i * pr.period())];
            if (st.bad || st.fees < threshold) revert IConfluere.InvalidState();
        }
        s.graduated[m] = true;
        emit IConfluere.PoolGraduated(m, lastExpiry);
    }

    /// @notice Pay K per whole asset (rounded up) to buy back `units`. American: any time until the window ends.
    /// European: only inside the window. All of K goes to C holders; the spread share was taken at clearing.
    /// Asset still in the pool is delivered first; for units recorded short (lent and not returned by the cutoff) the
    /// payer is credited their share of the forfeited margin instead (pending). Never reverts for missing asset.
    function repay(CoreState storage s, Params memory pr, bytes32 poolId, uint96 units)
        external
        returns (uint256 assetOut, uint256 marginOut)
    {
        PoolState storage ps = s.pool(poolId);
        bool early = ps.key.kind == Kind.American && ps.status == Status.Open && block.timestamp < ps.key.expiry;
        if (!(early || s.windowOpen(ps))) {
            revert IConfluere.InvalidState();
        }
        if (units == 0) revert IConfluere.InvalidParams();
        if (s.freeR(msg.sender, poolId) < units) revert IConfluere.Locked();
        _syncShort(ps, pr, poolId);

        uint256 phys = ps.assetBal - ps.shortUnits - ps.lentUnits;
        assetOut = units < phys ? units : phys;
        uint256 uShort = units - assetOut;
        if (uShort != 0) {
            uint256 su = ps.shortUnits;
            marginOut = uShort == su ? ps.shortMargin : Settlement.share(uShort, ps.shortMargin, su);
            ps.shortUnits = uint128(su - uShort);
            ps.shortMargin -= uint128(marginOut);
        }
        uint256 pay = Settlement.repayAmount(units, ps.key.strike, ps.scale());
        s.burn(msg.sender, poolId.rId(), units);
        ps.quoteBal += pay;
        ps.assetBal -= units;
        ps.repaidUnits += units;
        if (marginOut != 0) s.pending[ps.key.quote][msg.sender] += marginOut;
        CoreLib.pullExact(ps.key.quote, pay);
        if (assetOut != 0) CoreLib.push(ps.key.asset, msg.sender, assetOut);
        emit IConfluere.Repaid(poolId, msg.sender, units, pay, assetOut, marginOut);
    }

    // ------------------------------------------------------------ Specials lending (European pools, ARCH 2.6.1)

    /// @notice Lend up to half of a European pool's asset through Specials, against margin escrowed here.
    function lend(
        CoreState storage s,
        Params memory pr,
        bytes32 poolId,
        uint96 units,
        address to,
        uint128 margin,
        uint128 fee
    ) external {
        PoolState storage ps = _lendable(s, pr, poolId);
        if (ps.key.kind != Kind.European || ps.status != Status.Open || block.number < ps.pausedUntil) {
            revert IConfluere.InvalidState();
        }
        uint256 last = ps.lastClearingPrice;
        uint256 lent = uint256(ps.lentUnits) + units;
        if (units == 0 || last == 0 || to == address(0) || lent > ps.assetBal * LEND_MAX_BPS / Clearing.BPS) {
            revert IConfluere.InvalidParams();
        }
        if (margin < Clearing.quoteUp(units, last * LEND_MARGIN_BPS, ps.scale() * Clearing.BPS)) {
            revert IConfluere.InvalidParams();
        }
        CoreLib.pullExact(ps.key.quote, uint256(margin) + fee);
        ps.lentUnits = uint128(lent);
        ps.lentMargin += margin;
        ps.quoteBal += fee; // the lending fee belongs to the C holders; the protocol takes none
        CoreLib.push(ps.key.asset, to, units);
        emit IConfluere.Lent(poolId, to, units, margin, fee);
    }

    /// @notice Specials returns lent units before the cutoff; the released margin goes to `marginTo` (pending).
    function returnLent(
        CoreState storage s,
        Params memory pr,
        bytes32 poolId,
        uint96 units,
        uint128 marginOut,
        address marginTo
    ) external {
        PoolState storage ps = _lendable(s, pr, poolId);
        uint128 lent = ps.lentUnits;
        uint128 m = ps.lentMargin;
        if (units == 0 || units > lent || marginOut > m || (units == lent && marginOut != m)) {
            revert IConfluere.InvalidParams();
        }
        CoreLib.pullExact(ps.key.asset, units);
        ps.lentUnits = lent - units;
        ps.lentMargin = m - marginOut;
        if (marginOut != 0) s.pending[ps.key.quote][marginTo] += marginOut;
        emit IConfluere.LentReturned(poolId, units, marginOut, marginTo);
    }

    /// @notice Specials adds margin to the pool's lent position before the cutoff.
    function topUpLent(CoreState storage s, Params memory pr, bytes32 poolId, uint128 amount) external {
        PoolState storage ps = _lendable(s, pr, poolId);
        if (ps.lentUnits == 0 || amount == 0) revert IConfluere.InvalidParams();
        CoreLib.pullExact(ps.key.quote, amount);
        ps.lentMargin += amount;
        emit IConfluere.LentToppedUp(poolId, amount);
    }

    /// @dev Caller is Specials and the pool is before its lending cutoff.
    function _lendable(CoreState storage s, Params memory pr, bytes32 poolId)
        private
        view
        returns (PoolState storage ps)
    {
        if (msg.sender != pr.specials()) revert IConfluere.NotOwner();
        ps = s.pool(poolId);
        if (block.timestamp >= ps.key.expiry - pr.lendCutoff()) revert IConfluere.InvalidState();
    }

    /// @dev Lazily records lent units that missed the cutoff as short, with their whole margin (choice A1): from then
    /// on the numbers never change, so every repayer sees the same margin per short unit.
    function _syncShort(PoolState storage ps, Params memory pr, bytes32 poolId) private {
        uint128 lent = ps.lentUnits;
        if (lent == 0 || block.timestamp < ps.key.expiry - pr.lendCutoff()) return;
        ps.shortUnits += lent;
        ps.shortMargin += ps.lentMargin;
        ps.lentUnits = 0;
        ps.lentMargin = 0;
        emit IConfluere.ShortRecorded(poolId, ps.shortUnits, ps.shortMargin);
    }

    /// @notice Segmented close: each call fills at most `maxBids` bids from the top, then refunds them.
    /// Unrepaid units nobody bid on stay in the pool for C holders (default). Returns true once Closed.
    function closeWindow(CoreState storage s, Params memory pr, bytes32 poolId, uint256 maxBids)
        external
        returns (bool done)
    {
        PoolState storage ps = s.pool(poolId);
        if (ps.status == Status.Window) {
            if (block.number < ps.windowEnd) revert IConfluere.InvalidState();
            ps.status = Status.Closing;
            _syncShort(ps, pr, poolId);
            // bids only take units that are here; short units nobody repaid default to C holders as their margin
            uint256 su = ps.shortUnits;
            uint256 r = s.totalSupply[poolId.rId()];
            uint256 phys = ps.assetBal - su;
            ps.closeRemaining = r < phys ? r : phys;
            if (su != 0) {
                ps.quoteBal += ps.shortMargin;
                ps.assetBal -= su;
                ps.shortUnits = 0;
                ps.shortMargin = 0;
            }
        }
        if (ps.status == Status.Selling) return _finishSelling(s, ps);
        if (ps.status != Status.Closing) revert IConfluere.InvalidState();

        Book storage bk = s.books[poolId][BID];
        for (uint256 n; n < maxBids && bk.head != 0; ++n) {
            uint64 id = bk.head;
            _fillBid(s, ps, poolId, id);
            s.removeWithRefund(poolId, ps, id, CoreLib.RM_BID_CLOSED);
        }
        if (bk.head == 0) {
            _burnCoreR(s, ps, poolId);
            _splitEscrow(s, pr, ps, poolId);
            if (ps.autoSell && ps.assetBal != 0 && _placeAutoSell(s, pr, ps, poolId)) {
                ps.status = Status.Selling;
            } else {
                ps.status = Status.Closed;
                emit IConfluere.WindowClosed(poolId, ps.quoteBal, ps.assetBal, ps.surplusBal);
            }
            return true;
        }
    }

    /// @dev R held by the core came from autoSell fills of an older pool; it is never repaid. Burn it and move its
    /// share of the auction surplus to this pool's C holders (choice B2), so nothing is left unclaimable.
    function _burnCoreR(CoreState storage s, PoolState storage ps, bytes32 poolId) private {
        uint256 rId = poolId.rId();
        uint256 r = s.balanceOf[address(this)][rId];
        if (r == 0) return;
        uint256 x = Settlement.share(r, ps.surplusBal, s.totalSupply[rId]);
        ps.surplusBal -= x;
        ps.quoteBal += x;
        s.burn(address(this), rId, r);
    }

    /// @dev Decision B: offer the defaulted asset as a competitive sell at K x discount in the same market's next
    /// expiry pool of the same tier, owned by the core and linked back to this pool. False (the pool just closes and
    /// pays in kind) when that pool does not exist, no longer trades, or its sell book is full of better orders.
    function _placeAutoSell(CoreState storage s, Params memory pr, PoolState storage ps, bytes32 poolId)
        private
        returns (bool)
    {
        PoolKey memory k = ps.key;
        k.expiry += pr.period();
        bytes32 target = PoolKeyLib.toId(k);
        PoolState storage tp = s.pools[target];
        if (tp.status != Status.Open || block.timestamp >= k.expiry) return false;
        uint64 id = _writeAutoSell(s, pr, ps, target, tp.settleCount, poolId);
        if (!_insertAutoSell(s, pr, target, id)) return false;
        Order storage o = s.orders[target][id];
        ps.autoSellPool = target;
        ps.autoSellOrder = id;
        ps.autoSellUnits = o.units;
        emit IConfluere.AutoSellPlaced(poolId, target, id, o.units, o.limit);
        return true;
    }

    function _insertAutoSell(CoreState storage s, Params memory pr, bytes32 target, uint64 id) private returns (bool) {
        uint64 hint = OrderSet.findHint(s.books[target][SELL], s.orders[target], SELL, s.orders[target][id].limit);
        if (s.tryInsert(pr, target, s.pools[target], id, hint)) return true;
        delete s.orders[target][id];
        delete s.linkedPool[target][id];
        return false;
    }

    /// @dev The autoSell order: all of the defaulted asset (capped at uint96), limit K x discount (at least 1).
    function _writeAutoSell(
        CoreState storage s,
        Params memory pr,
        PoolState storage ps,
        bytes32 target,
        uint32 targetSettleCount,
        bytes32 poolId
    ) private returns (uint64 id) {
        uint256 units = ps.assetBal > type(uint96).max ? type(uint96).max : ps.assetBal;
        uint256 limit = uint256(ps.key.strike) * pr.autoSellDiscountBps() / Clearing.BPS;
        id = s.newOrderId();
        Order storage o = s.orders[target][id];
        o.owner = address(this);
        o.side = SELL;
        o.flags = FLAG_AUTOSELL;
        o.deadline = targetSettleCount + pr.autoSellTtl();
        o.units = uint96(units);
        o.limit = uint96(limit == 0 ? 1 : limit);
        s.linkedPool[target][id] = poolId;
    }

    /// @dev A Selling pool waits for its order; once the order can no longer trade (ttl used up, or the target pool
    /// stopped trading) anyone can end it here, so Selling always ends by the target's expiry at the latest.
    function _finishSelling(CoreState storage s, PoolState storage ps) private returns (bool) {
        bytes32 target = ps.autoSellPool;
        PoolState storage tp = s.pools[target];
        Order storage o = s.orders[target][ps.autoSellOrder];
        bool trading = tp.status == Status.Open && block.timestamp < tp.key.expiry;
        if (trading && o.deadline > tp.settleCount) revert IConfluere.InvalidState();
        s.removeWithRefund(target, tp, ps.autoSellOrder, CoreLib.RM_EXPIRED);
        return true;
    }

    /// @dev The spread escrow splits once, by the fraction of filled units whose K was paid in full: that part goes
    /// to the treasury (and counts toward graduation), the defaulted part to C holders.
    function _splitEscrow(CoreState storage s, Params memory pr, PoolState storage ps, bytes32 poolId) private {
        uint256 esc = ps.feeEscrow;
        if (esc == 0) return;
        uint256 toT = Settlement.feeSplit(esc, ps.repaidUnits, ps.filledUnits);
        ps.feeEscrow = 0;
        ps.quoteBal += esc - toT;
        if (toT != 0) {
            s.pending[ps.key.quote][pr.treasury()] += toT;
            s.marketFees[ps.marketId] += toT;
            CoreLib.addFees(s, ps, toT);
        }
        emit IConfluere.FeeEscrowSplit(poolId, toT, esc - toT, ps.repaidUnits, ps.filledUnits);
    }

    function _fillBid(CoreState storage s, PoolState storage ps, bytes32 poolId, uint64 id) private {
        Order storage o = s.orders[poolId][id];
        uint256 rem = ps.closeRemaining;
        uint256 f = o.units < rem ? o.units : rem;
        if (f == 0) return;
        uint256 sc = ps.scale();
        uint256 cost = Clearing.quoteUp(f, ps.key.strike + o.limit, sc);
        uint256 kPart = Clearing.quoteUp(f, ps.key.strike, sc);
        ps.closeRemaining = rem - f;
        ps.repaidUnits += f;
        ps.quoteBal += kPart;
        ps.surplusBal += cost - kPart;
        ps.assetBal -= f;
        o.escrow -= uint128(cost);
        s.pending[ps.key.asset][o.owner] += f;
        emit IConfluere.BidFilled(poolId, id, f, kPart, cost - kPart);
    }

    /// @notice Burn the caller's C (pro-rata quote and defaulted asset) and free R (pro-rata auction surplus).
    function claim(CoreState storage s, bytes32 poolId) external returns (uint256 quoteOut, uint256 assetOut) {
        PoolState storage ps = s.pool(poolId);
        if (ps.status != Status.Closed) revert IConfluere.InvalidState();
        uint256 cId = poolId.cId();
        uint256 c = s.balanceOf[msg.sender][cId];
        if (c != 0) {
            uint256 supply = s.totalSupply[cId];
            quoteOut = Settlement.share(c, ps.quoteBal, supply);
            assetOut = Settlement.share(c, ps.assetBal, supply);
            ps.quoteBal -= quoteOut;
            ps.assetBal -= assetOut;
            s.burn(msg.sender, cId, c);
        }
        uint256 r = s.freeR(msg.sender, poolId);
        if (r != 0) {
            uint256 rId = poolId.rId();
            uint256 surplus = Settlement.share(r, ps.surplusBal, s.totalSupply[rId]);
            ps.surplusBal -= surplus;
            quoteOut += surplus;
            s.burn(msg.sender, rId, r);
        }
        if (quoteOut != 0) CoreLib.push(ps.key.quote, msg.sender, quoteOut);
        if (assetOut != 0) CoreLib.push(ps.key.asset, msg.sender, assetOut);
        emit IConfluere.Claimed(poolId, msg.sender, quoteOut, assetOut);
    }
}
