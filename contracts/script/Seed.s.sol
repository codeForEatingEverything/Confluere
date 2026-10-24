// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Confluere} from "../src/Confluere.sol";
import {IConfluere} from "../src/interfaces/IConfluere.sol";
import {SELL, BUY} from "../src/libraries/OrderSet.sol";
import {Status} from "../src/libraries/PoolKey.sol";
import {Router} from "../src/periphery/Router.sol";
import {KeeperReceiver} from "../src/periphery/KeeperReceiver.sol";
import {DeployConfig} from "./DeployConfig.sol";

/// @notice Places a two-sided book in every launch pool so the next batch clears. Run, wait for the batch boundary,
/// then run `forge script script/Seed.s.sol --sig "settle()"` (or let the keeper do it).
/// Env SEED_UNIT_BPS (default 10000): size of one seed unit as a fraction of one whole asset, so real testnet tokens
/// (which cannot be minted) can seed small books; e.g. 100 = 0.01 asset per unit. Pools of the extra pair
/// (`.pools.extraAsset` / `.pools.extraQuote`, see CreatePools.s.sol) use EXTRA_SEED_UNIT_BPS instead (default
/// SEED_UNIT_BPS), so a pair whose quote has a larger graduation row can still clear it in one seed.
/// Pools of the loop pair (`.pools.lst` against `.pools.native`) use LST_SEED_UNIT_BPS (default SEED_UNIT_BPS).
/// Env SEED_APR_BPS (default 0): 0 seeds the crossing demo book below (`_seedPool`, everything clears in the next
/// batch). Above 0 it seeds a book priced by time to expiry that stays two-sided after clearing (`_seedBook`, the
/// testnets): anyone can borrow or lend at once. SEED_SPREAD_BPS (default half of SEED_APR_BPS) and SEED_TTL
/// (settlements each order may take part in, default 48, at most 1000) shape it.
/// Idempotent per batch: a pool where the caller already has a resting sell is skipped, so re-running a failed seed
/// does not double the book. `collect()` claims closed pools and withdraws the caller's pending balances
/// (scripts/roll-testnet.sh runs it before opening the next expiry).
contract Seed is Script {
    function _load() internal view returns (Confluere core, bytes32[] memory ids, string memory path) {
        path = DeployConfig.deploymentsFile(vm);
        string memory json = vm.readFile(path);
        core = Confluere(vm.parseJsonAddress(json, ".confluere"));
        ids = vm.parseJsonBytes32Array(json, ".pools.poolIds");
    }

    /// @dev Seed unit sizes per pair and the book layout, from env (see the contract notes).
    struct Cfg {
        address xa;
        address xq;
        address lst;
        uint256 bps;
        uint256 xbps;
        uint256 lbps;
        uint256 apr;
    }

    /// @dev Orders collected for one flush (book layout): placed one by one with hints, or through the Router.
    struct Buf {
        bytes32[] pids;
        IConfluere.OrderParams[] ps;
        uint256 n;
    }

    function _cfg(string memory json) internal view returns (Cfg memory c) {
        (c.xa, c.xq) = _extraPair(json);
        if (vm.keyExistsJson(json, ".pools.lst")) c.lst = vm.parseJsonAddress(json, ".pools.lst");
        c.bps = vm.envOr("SEED_UNIT_BPS", uint256(10_000));
        c.xbps = vm.envOr("EXTRA_SEED_UNIT_BPS", c.bps);
        c.lbps = vm.envOr("LST_SEED_UNIT_BPS", c.bps);
        c.apr = vm.envOr("SEED_APR_BPS", uint256(0));
    }

    function _unit(Cfg memory c, IConfluere.PoolView memory v) internal pure returns (uint96) {
        uint256 b = v.key.asset == c.xa && v.key.quote == c.xq
            ? c.xbps
            : c.lst != address(0) && v.key.asset == c.lst ? c.lbps : c.bps;
        return uint96(10 ** uint256(v.assetDecimals) * b / 10_000);
    }

    function run() external {
        (Confluere core, bytes32[] memory ids, string memory path) = _load();
        Cfg memory c = _cfg(vm.readFile(path));
        Buf memory b = _buf(4 * ids.length);
        vm.startBroadcast();
        (, address me,) = vm.readCallers();
        uint256 n;
        for (uint256 i; i < ids.length; ++i) {
            if (_hasSell(core, ids[i], me)) continue;
            IConfluere.PoolView memory v = core.pool(ids[i]);
            if (c.apr == 0) _seedPool(core, ids[i], v, _unit(c, v));
            else _seedBook(b, ids[i], v, _unit(c, v), c.apr);
            ++n;
        }
        _flush(core, b, me);
        vm.stopBroadcast();
        console2.log("seeded pools", n, "skipped (already seeded)", ids.length - n);
    }

    /// @notice One round of small crossing trades (book layout, SEED_APR_BPS > 0): in every Open, unexpired pool of
    /// `.pools.poolIds` (plus TRADE_POOLS, comma-separated), a borrow and a lend of one seed unit at the same limit, at
    /// a rate that moves with TRADE_ROUND (0, +20%, -15%, +10% of SEED_APR_BPS, repeating) and stays strictly between
    /// the resting seed orders, so the next batch fills exactly this pair. Run once per batch for a short price history.
    function trade() external {
        (Confluere core, bytes32[] memory current, string memory path) = _load();
        bytes32[] memory ids = _withExtra(current, vm.envOr("TRADE_POOLS", string("")));
        Cfg memory c = _cfg(vm.readFile(path));
        require(c.apr != 0, "trade: set SEED_APR_BPS");
        int256[4] memory moves = [int256(0), 20, -15, 10];
        uint256 rate = uint256(int256(c.apr) * (100 + moves[vm.envOr("TRADE_ROUND", uint256(0)) % 4]) / 100);
        Buf memory b = _buf(2 * ids.length);
        vm.startBroadcast();
        (, address me,) = vm.readCallers();
        for (uint256 i; i < ids.length; ++i) {
            IConfluere.PoolView memory v = core.pool(ids[i]);
            if (v.status != Status.Open || block.timestamp >= v.key.expiry) continue;
            (uint256 lo, uint256 mid, uint256 hi) = _levels(v, c.apr);
            uint256 at = _price(v.key.strike, rate, v.key.expiry - block.timestamp);
            if (at <= lo) at = lo + 1;
            if (at >= hi) at = hi - 1;
            if (at <= lo) at = mid;
            uint96 u = _unit(c, v);
            _push(b, ids[i], _p(SELL, u, uint96(at), 0));
            _push(b, ids[i], _p(BUY, u, uint96(at), 0));
        }
        _flush(core, b, me);
        vm.stopBroadcast();
        console2.log("traded pools", b.n / 2);
    }

    /// @dev The extra pair CreatePools recorded (zero when there is none).
    function _extraPair(string memory json) internal view returns (address a, address q) {
        if (!vm.keyExistsJson(json, ".pools.extraAsset")) return (address(0), address(0));
        a = vm.parseJsonAddress(json, ".pools.extraAsset");
        q = vm.parseJsonAddress(json, ".pools.extraQuote");
    }

    /// @dev True when `me` already has a resting sell in the pool's book (at most maxOrdersPerSide nodes to walk).
    function _hasSell(Confluere core, bytes32 pid, address me) internal view returns (bool) {
        (uint64 id,) = core.bookHead(pid, SELL);
        while (id != 0) {
            (address owner,,,,,,, uint64 next) = core.order(pid, id);
            if (owner == me) return true;
            id = next;
        }
        return false;
    }

    /// @notice Recover the seeder's funds: claim every Closed pool (the deployments `.pools.poolIds` plus env
    /// CLAIM_POOLS, comma-separated, for earlier expiries) where the caller holds C units, then withdraw the caller's
    /// pending balance of every token those pools use. Pools that are not Closed yet are left for a later run.
    function collect() external {
        (Confluere core, bytes32[] memory current,) = _load();
        bytes32[] memory ids = _withExtra(current, vm.envOr("CLAIM_POOLS", string("")));
        vm.startBroadcast();
        (, address me,) = vm.readCallers();
        address[] memory tokens = new address[](2 * ids.length);
        uint256 nt;
        uint256 claimed;
        for (uint256 i; i < ids.length; ++i) {
            IConfluere.PoolView memory v = core.pool(ids[i]);
            if (v.status == Status.None) continue;
            nt = _add(tokens, nt, v.key.asset);
            nt = _add(tokens, nt, v.key.quote);
            if (v.status != Status.Closed || core.balanceOf(me, uint256(ids[i])) == 0) continue;
            core.claim(ids[i]);
            ++claimed;
        }
        uint256 withdrawn;
        for (uint256 i; i < nt; ++i) {
            if (core.pending(tokens[i], me) == 0) continue;
            core.withdraw(tokens[i], me);
            ++withdrawn;
        }
        vm.stopBroadcast();
        console2.log("collected: claimed pools", claimed, "withdrawn tokens", withdrawn);
    }

    function _withExtra(bytes32[] memory ids, string memory extra) internal pure returns (bytes32[] memory out) {
        if (bytes(extra).length == 0) return ids;
        string[] memory items = vm.split(extra, ",");
        out = new bytes32[](ids.length + items.length);
        for (uint256 i; i < ids.length; ++i) {
            out[i] = ids[i];
        }
        for (uint256 i; i < items.length; ++i) {
            out[ids.length + i] = vm.parseBytes32(items[i]);
        }
    }

    function _add(address[] memory set, uint256 n, address a) internal pure returns (uint256) {
        for (uint256 i; i < n; ++i) {
            if (set[i] == a) return n;
        }
        set[n] = a;
        return n + 1;
    }

    /// @dev Borrowers ask from 96% of K down, lenders bid from 97% of K up: the batch clears near 96.5% of K.
    function _seedPool(Confluere core, bytes32 pid, IConfluere.PoolView memory v, uint256 unit) internal {
        IERC20(v.key.asset).approve(address(core), type(uint256).max);
        IERC20(v.key.quote).approve(address(core), type(uint256).max);
        uint256 k = v.key.strike;
        for (uint256 j; j < 3; ++j) {
            _pair(core, pid, uint96(unit * (j + 1)), uint96(k * (96 - j) / 100), uint96(k * (97 + j) / 100));
        }
    }

    /// @dev Testnet book priced by time to expiry t: price = K / (1 + rate * t / year). One crossing pair at
    /// SEED_APR_BPS (the batch clears there, so the market shows a price and counts volume), plus one order per side
    /// that rests after clearing: a lender's bid at the rate plus SEED_SPREAD_BPS (a borrower can sell into it) and a
    /// borrower's ask at the rate minus the spread (a lender can buy it). One unit each: per pool 2 units of asset and
    /// about 2 units' worth at K of quote.
    function _seedBook(Buf memory b, bytes32 pid, IConfluere.PoolView memory v, uint96 unit, uint256 apr)
        internal
        view
    {
        (uint256 lo, uint256 mid, uint256 hi) = _levels(v, apr);
        _push(b, pid, _p(SELL, unit, uint96(mid), 0)); // crosses the next order: clears at mid
        _push(b, pid, _p(BUY, unit, uint96(mid), 0));
        _push(b, pid, _p(SELL, unit, uint96(hi), 0)); // rests: ask above, bid below
        _push(b, pid, _p(BUY, unit, uint96(lo), 0));
    }

    /// @dev Lender's resting bid, crossing level, borrower's resting ask; kept apart when the discount is only a few
    /// quote units (short pools, cheap assets).
    function _levels(IConfluere.PoolView memory v, uint256 apr)
        internal
        view
        returns (uint256 lo, uint256 mid, uint256 hi)
    {
        uint256 spread = vm.envOr("SEED_SPREAD_BPS", apr / 2);
        uint256 t = v.key.expiry > block.timestamp ? v.key.expiry - block.timestamp : 0;
        uint256 k = v.key.strike;
        mid = _price(k, apr, t);
        lo = _price(k, apr + spread, t);
        hi = _price(k, apr > spread ? apr - spread : 0, t);
        if (mid >= k) mid = k - 1;
        if (lo >= mid) lo = mid - 1;
        if (hi <= mid) hi = mid + 1;
    }

    function _price(uint256 k, uint256 aprBps, uint256 t) internal pure returns (uint256) {
        return k * (365 days * 10_000) / (365 days * 10_000 + aprBps * t);
    }

    function _buf(uint256 cap) internal pure returns (Buf memory b) {
        b.pids = new bytes32[](cap);
        b.ps = new IConfluere.OrderParams[](cap);
    }

    function _push(Buf memory b, bytes32 pid, IConfluere.OrderParams memory p) internal pure {
        b.pids[b.n] = pid;
        b.ps[b.n] = p;
        ++b.n;
    }

    /// @dev Places the collected orders. SEED_ROUTER (an address, e.g. the deployment's router) batches them into
    /// Router.placeOrders calls of at most SEED_CHUNK orders (default 48), the orders still owned by the caller: a
    /// handful of transactions instead of one per order (Monad testnet gas is scarce). Without it each order is placed
    /// on the core with a fresh hint. Approvals are sent only when the allowance is short.
    function _flush(Confluere core, Buf memory b, address me) internal {
        if (b.n == 0) return;
        address router = vm.envOr("SEED_ROUTER", address(0));
        address spender = router == address(0) ? address(core) : router;
        address[] memory toks = new address[](2 * b.n);
        uint256 nt;
        for (uint256 i; i < b.n; ++i) {
            IConfluere.PoolView memory v = core.pool(b.pids[i]);
            nt = _add(toks, nt, b.ps[i].side == SELL ? v.key.asset : v.key.quote);
        }
        for (uint256 i; i < nt; ++i) {
            if (IERC20(toks[i]).allowance(me, spender) < type(uint128).max) {
                IERC20(toks[i]).approve(spender, type(uint256).max);
            }
        }
        if (router == address(0)) {
            for (uint256 i; i < b.n; ++i) {
                b.ps[i].hint = core.findHint(b.pids[i], b.ps[i].side, b.ps[i].limit);
                core.placeOrder(b.pids[i], b.ps[i]);
            }
            return;
        }
        uint256 chunk = vm.envOr("SEED_CHUNK", uint256(48));
        for (uint256 from; from < b.n; from += chunk) {
            uint256 len = b.n - from < chunk ? b.n - from : chunk;
            bytes32[] memory pids = new bytes32[](len);
            IConfluere.OrderParams[] memory ps = new IConfluere.OrderParams[](len);
            for (uint256 i; i < len; ++i) {
                pids[i] = b.pids[from + i];
                ps[i] = b.ps[from + i]; // hint 0: books this small are found from the head
            }
            Router(router).placeOrders(pids, ps);
        }
    }

    function _pair(Confluere core, bytes32 pid, uint96 units, uint96 ask, uint96 bid) internal {
        uint64 hs = core.findHint(pid, SELL, ask);
        core.placeOrder(pid, _p(SELL, units, ask, hs));
        uint64 hb = core.findHint(pid, BUY, bid);
        core.placeOrder(pid, _p(BUY, units, bid, hb));
    }

    /// @notice A cheap competitive sell of 2 units in pool `i` (deployments order): it clears first, so the most
    /// expensive seeded sell is left over, still willing at P*, for non-competitive buyers such as vaults.
    function leftover(uint256 i) external {
        (Confluere core, bytes32[] memory ids,) = _load();
        IConfluere.PoolView memory v = core.pool(ids[i]);
        uint96 units = uint96(2 * 10 ** uint256(v.assetDecimals));
        uint96 limit = uint96(uint256(v.key.strike) * 90 / 100);
        vm.startBroadcast();
        uint64 hint = core.findHint(ids[i], SELL, limit);
        core.placeOrder(ids[i], _p(SELL, units, limit, hint));
        vm.stopBroadcast();
    }

    /// @notice Settles (or matures / closes) every due pool of `.pools.poolIds` plus TRADE_POOLS in one transaction
    /// through the deployment's KeeperReceiver, which skips what is not due and catches failures, so racing the keeper
    /// is harmless. Used between trade() rounds.
    function tick() external {
        (, bytes32[] memory current, string memory path) = _load();
        bytes32[] memory ids = _withExtra(current, vm.envOr("TRADE_POOLS", string("")));
        KeeperReceiver kr = KeeperReceiver(vm.parseJsonAddress(vm.readFile(path), ".keeperReceiver"));
        vm.startBroadcast();
        kr.tick(ids, new address[](0));
        vm.stopBroadcast();
    }

    function settle() external {
        (Confluere core, bytes32[] memory ids,) = _load();
        vm.startBroadcast();
        for (uint256 i; i < ids.length; ++i) {
            if (block.timestamp >= core.nextBatchAt(ids[i])) core.settleBatch(ids[i]);
        }
        vm.stopBroadcast();
    }

    function _p(uint8 side, uint96 units, uint96 limit, uint64 hint)
        internal
        view
        returns (IConfluere.OrderParams memory p)
    {
        p.side = side;
        p.units = units;
        p.limit = limit;
        p.ttl = uint16(vm.envOr("SEED_TTL", uint256(48)));
        p.hint = hint;
    }
}
