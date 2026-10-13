// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Confluere} from "../src/Confluere.sol";
import {IConfluere} from "../src/interfaces/IConfluere.sol";
import {SELL, BUY} from "../src/libraries/OrderSet.sol";
import {Status} from "../src/libraries/PoolKey.sol";
import {DeployConfig} from "./DeployConfig.sol";

/// @notice Places a two-sided book in every launch pool so the next batch clears. Run, wait for the batch boundary,
/// then run `forge script script/Seed.s.sol --sig "settle()"` (or let the keeper do it).
/// Env SEED_UNIT_BPS (default 10000): size of one seed unit as a fraction of one whole asset, so real testnet tokens
/// (which cannot be minted) can seed small books; e.g. 100 = 0.01 asset per unit. Pools of the extra pair
/// (`.pools.extraAsset` / `.pools.extraQuote`, see CreatePools.s.sol) use EXTRA_SEED_UNIT_BPS instead (default
/// SEED_UNIT_BPS), so a pair whose quote has a larger graduation row can still clear it in one seed.
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

    function run() external {
        (Confluere core, bytes32[] memory ids, string memory path) = _load();
        (address xa, address xq) = _extraPair(vm.readFile(path));
        uint256 bps = vm.envOr("SEED_UNIT_BPS", uint256(10_000));
        uint256 xbps = vm.envOr("EXTRA_SEED_UNIT_BPS", bps);
        vm.startBroadcast();
        (, address me,) = vm.readCallers();
        uint256 n;
        for (uint256 i; i < ids.length; ++i) {
            if (_hasSell(core, ids[i], me)) continue;
            IConfluere.PoolView memory v = core.pool(ids[i]);
            _seedPool(core, ids[i], v, v.key.asset == xa && v.key.quote == xq ? xbps : bps);
            ++n;
        }
        vm.stopBroadcast();
        console2.log("seeded pools", n, "skipped (already seeded)", ids.length - n);
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
            (address owner,,,,,, uint64 next) = core.order(pid, id);
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
    function _seedPool(Confluere core, bytes32 pid, IConfluere.PoolView memory v, uint256 bps) internal {
        IERC20(v.key.asset).approve(address(core), type(uint256).max);
        IERC20(v.key.quote).approve(address(core), type(uint256).max);
        uint256 unit = 10 ** uint256(v.assetDecimals) * bps / 10_000;
        uint256 k = v.key.strike;
        for (uint256 j; j < 3; ++j) {
            _pair(core, pid, uint96(unit * (j + 1)), uint96(k * (96 - j) / 100), uint96(k * (97 + j) / 100));
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
        pure
        returns (IConfluere.OrderParams memory p)
    {
        p.side = side;
        p.units = units;
        p.limit = limit;
        p.ttl = 48;
        p.hint = hint;
    }
}
