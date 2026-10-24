// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Base} from "../utils/Base.sol";
import {Confluere} from "../../src/Confluere.sol";
import {IConfluere} from "../../src/interfaces/IConfluere.sol";
import {PoolKey, Kind} from "../../src/libraries/PoolKey.sol";
import {GridConfig} from "../../src/libraries/Grid.sol";
import {SELL, BUY} from "../../src/libraries/OrderSet.sol";

/// @notice Blueprint §4 v1 rows: long-tail batch cadence (6 h / 24 h), minimum fill, cancel cutoff
/// (cancellation cutoff) and the creator's first-auction price bounds.
contract LongTailTest is Base {
    function _createWith(uint8 cadence, uint96 minFill, uint96 lo, uint96 hi) internal returns (bytes32) {
        return
            _createKey(core, _keyT(K, Kind.American, E1, 1500, cadence), IConfluere.PoolOptions(minFill, lo, hi, false));
    }

    function _cross(bytes32 pid, uint256 units, uint256 price) internal {
        _sell(alice, pid, units, price);
        _buy(bob, pid, units, price);
    }

    // ------------------------------------------------------------ cadence

    function test_cadence_6hBatches() public {
        bytes32 pid = _createWith(1, 0, 0, 0); // 12 x 30 min
        IConfluere.PoolView memory v = core.pool(pid);
        assertEq(v.batchInterval, 6 hours);
        assertEq(v.key.cadence, 1);
        uint256 next = core.nextBatchAt(pid);
        assertEq((next - ANCHOR) % 6 hours, 0, "boundaries on the 6 h grid");
        _cross(pid, ONE, 2900e6);
        vm.warp(next - 1);
        vm.expectRevert(IConfluere.BatchNotReady.selector);
        core.settleBatch(pid); // a 30-min boundary is not enough
        vm.warp(next);
        core.settleBatch(pid);
        assertEq(core.balanceOf(alice, _r(pid)), ONE);
        assertEq(core.nextBatchAt(pid), next + 6 hours);
    }

    function test_cadence_24h() public {
        bytes32 pid = _createWith(2, 0, 0, 0);
        assertEq(core.pool(pid).batchInterval, 24 hours);
    }

    function test_mainstreamDefaultUnchanged() public {
        bytes32 pid = _create();
        IConfluere.PoolView memory v = core.pool(pid);
        assertEq(v.batchInterval, BATCH);
        assertEq(v.key.cadence, 0);
        assertEq(v.options.minFill, 0);
    }

    // ------------------------------------------------------------ minimum fill

    function test_minFill_thinBatchDoesNotTrade_thenTrades() public {
        bytes32 pid = _createWith(0, 3e18, 0, 0); // at least 3 units must cross
        _sell(alice, pid, ONE, 2900e6);
        _buy(bob, pid, ONE, 2900e6);
        _settle(pid);
        assertEq(core.balanceOf(alice, _r(pid)), 0, "below the minimum: no trade");
        assertEq(core.pool(pid).lastClearingPrice, 0, "no price recorded");
        // the orders rolled; two more units make the batch big enough
        _sell(dave, pid, 2 * ONE, 2900e6);
        _buy(carol, pid, 2 * ONE, 2900e6);
        _settle(pid);
        assertEq(core.totalSupply(_r(pid)), 3 * ONE, "all three units trade together");
    }

    // ------------------------------------------------------------ first-auction bounds

    function test_firstAuctionBounds() public {
        bytes32 pid = _createWith(0, 0, 2800e6, 2950e6);
        _cross(pid, ONE, 2990e6); // P* 2990 above the creator's ceiling
        _settle(pid);
        assertEq(core.totalSupply(_r(pid)), 0, "first price outside the bounds: no trade");
        // new orders inside the range
        _sell(dave, pid, ONE, 2900e6);
        _buy(carol, pid, ONE, 2900e6);
        // the rolled 2990 sell is now the cheapest? no: dave's 2900 sell is cheaper and carol's 2900 buy crosses it
        _settle(pid);
        assertGt(core.totalSupply(_r(pid)), 0, "inside the bounds: trades");
        uint256 first = core.pool(pid).lastClearingPrice;
        assertGe(first, 2800e6);
        assertLe(first, 2950e6);
        // after the first trade the bounds no longer apply
        _cross(pid, ONE, 2990e6);
        _settle(pid);
        assertEq(core.pool(pid).lastClearingPrice, 2990e6);
    }

    function test_firstAuctionFloor() public {
        bytes32 pid = _createWith(0, 0, 2800e6, 0); // floor only
        _cross(pid, ONE, 2700e6);
        _settle(pid);
        assertEq(core.totalSupply(_r(pid)), 0);
    }

    // ------------------------------------------------------------ cancel cutoff

    function test_cancelCutoff_lastTwelfthOfLongTailBatch() public {
        bytes32 pid = _createWith(1, 0, 0, 0); // 6 h batches: cutoff = last 30 min
        uint64 id = _order(alice, pid, SELL, ONE, 2900e6, 0, 5);
        uint256 next = core.nextBatchAt(pid);
        vm.warp(next - 30 minutes);
        vm.prank(alice);
        vm.expectRevert(IConfluere.InvalidState.selector);
        core.cancelOrder(pid, id);
        vm.warp(next - 31 minutes);
        vm.prank(alice);
        core.cancelOrder(pid, id); // before the cutoff
        assertEq(_pend(address(weth), alice), ONE);
    }

    /// Audit #10: past the boundary the batch is still unsettled and the order still clears in it, so the cutoff
    /// holds until someone settles.
    function test_cancelCutoff_holdsAfterBoundaryUntilSettled() public {
        bytes32 pid = _createWith(1, 0, 0, 0);
        uint64 id = _order(alice, pid, SELL, ONE, 3500e6, 0, 5); // no counterparty: stays live after the batch
        uint256 next = core.nextBatchAt(pid);
        vm.warp(next + 1);
        vm.prank(alice);
        vm.expectRevert(IConfluere.InvalidState.selector);
        core.cancelOrder(pid, id);
        vm.warp(next + 3 hours); // a long settle delay changes nothing
        vm.prank(alice);
        vm.expectRevert(IConfluere.InvalidState.selector);
        core.cancelOrder(pid, id);
        core.settleBatch(pid); // permissionless: the owner can do it too
        vm.prank(alice);
        core.cancelOrder(pid, id);
        assertEq(_pend(address(weth), alice), ONE);
    }

    function test_cancelCutoff_unsettledBatchDoesNotLockWhilePaused() public {
        bytes32 pid = _createWith(1, 0, 0, 0);
        uint64 id = _order(alice, pid, SELL, ONE, 3500e6, 0, 5);
        vm.warp(core.nextBatchAt(pid) + 1);
        vm.prank(guardian);
        core.pause(pid, 100); // settleBatch cannot run, so the order must stay withdrawable
        vm.prank(alice);
        core.cancelOrder(pid, id);
        assertEq(_pend(address(weth), alice), ONE);
    }

    function test_cancelCutoff_doesNotApplyToMainstreamOrExpired() public {
        bytes32 main = _create();
        uint64 a = _sell(alice, main, ONE, 2900e6);
        vm.warp(core.nextBatchAt(main) - 1);
        vm.prank(alice);
        core.cancelOrder(main, a); // mainstream: no cutoff

        bytes32 pid = _createKey(core, _keyT(3100e6, Kind.American, E1, 1500, 1), _noOpts()); // different strike: a separate pool from `main`
        uint64 id = _order(alice, pid, SELL, ONE, 3500e6, 0, 1);
        vm.warp(core.nextBatchAt(pid));
        core.settleBatch(pid); // its single batch passes untraded: expired
        vm.warp(core.nextBatchAt(pid) - 1); // inside the next cutoff
        vm.prank(alice);
        core.cancelOrder(pid, id); // expired orders can always be withdrawn
    }

    // ------------------------------------------------------------ validation

    function test_options_validation() public {
        vm.expectRevert(IConfluere.InvalidParams.selector);
        _createWith(3, 0, 0, 0);
        vm.expectRevert(IConfluere.InvalidParams.selector);
        _createWith(0, 0, 3000e6, 2900e6); // lo > hi
    }

    function test_cadenceLongerThanPeriodRejected() public {
        // a demo grid: 1-hour expiries, 2-minute batches -> 48 x 2 min = 96 min > 1 h
        Confluere.Config memory c = _config();
        c.grid =
            GridConfig({anchor: ANCHOR, period: 1 hours, batchInterval: 2 minutes, maxExpiries: 4, strikeSigDigits: 2});
        Confluere demo = new Confluere(c);
        weth.approve(address(demo), type(uint256).max);
        usdc.approve(address(demo), type(uint256).max);
        uint64 exp = ANCHOR + uint64((block.timestamp - ANCHOR) / 1 hours + 1) * 1 hours;
        vm.expectRevert(IConfluere.InvalidParams.selector);
        _createKey(demo, _keyT(K, Kind.American, exp, 800, 2), _noOpts());
        _createKey(demo, _keyT(K, Kind.American, exp, 800, 1), _noOpts()); // 24 min fits
    }
}
