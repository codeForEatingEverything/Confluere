// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Base} from "../utils/Base.sol";
import {IConfluere} from "../../src/interfaces/IConfluere.sol";
import {Kind, Status} from "../../src/libraries/PoolKey.sol";
import {SELL} from "../../src/libraries/OrderSet.sol";
import {Clearing} from "../../src/libraries/Clearing.sol";
import {Settlement} from "../../src/libraries/Settlement.sol";

/// @notice A rollover also fills in the new pool's last batch before the old pool expires (blueprint 3.7 #5).
contract RolloverLastBatchTest is Base {
    function _borrow(bytes32 pid, uint256 units, uint256 price) internal {
        _sell(alice, pid, units, price);
        _buy(bob, pid, units, price);
        _settle(pid);
    }

    function _roll(bytes32 oldP, bytes32 newP, uint256 units, uint256 minPrice, uint256 topUp)
        internal
        returns (uint64 id)
    {
        uint64 hint = core.findHint(newP, SELL, uint96(minPrice));
        vm.prank(alice);
        id = core.rollover(oldP, newP, uint96(units), uint96(minPrice), uint128(topUp), 500, hint);
    }

    function _setup(Kind kind, uint8 cadence) internal returns (bytes32 p1, bytes32 p2) {
        p1 = _create(K, kind, E1);
        p2 = _createKey(core, _keyT(K, kind, E2, 800, cadence), _noOpts());
        _borrow(p1, ONE, 2900e6);
        _roll(p1, p2, ONE, 2850e6, 200e6);
        _buy(carol, p2, ONE, 2950e6);
    }

    function test_rollover_earlierBatch_skipped() public {
        (bytes32 p1, bytes32 p2) = _setup(Kind.American, 0);
        vm.warp(E1 - 2 * BATCH);
        core.settleBatch(p2); // next boundary E1 - BATCH < E1: not the last batch
        assertEq(core.balanceOf(alice, _r(p2)), 0);
        assertEq(core.pool(p1).assetBal, ONE);
    }

    function test_rollover_baseCadence_lastBatch() public {
        (bytes32 p1, bytes32 p2) = _setup(Kind.American, 0);
        vm.warp(E1 - BATCH);
        core.settleBatch(p2); // next boundary is E1: the last chance before the old pool expires
        assertEq(core.balanceOf(alice, _r(p2)), ONE);
        IConfluere.PoolView memory v1 = core.pool(p1);
        assertEq(uint8(v1.status), uint8(Status.Open), "old pool still trading");
        assertEq(v1.assetBal, 0);
        assertEq(v1.quoteBal, K, "all of K paid one batch early");
        assertEq(v1.repaidUnits, ONE);
        assertEq(core.balanceOf(alice, _r(p1)), 0);
        assertEq(core.lockedR(alice, p1), 0);
    }

    function test_rollover_lastBatchBeforeExpiry_fills() public {
        // a long-tail new pool (one clearing per 12 base batches): its last batch before E1 starts 6 h earlier
        (bytes32 p1, bytes32 p2) = _setup(Kind.European, 1);
        vm.warp(E1 - 12 hours);
        core.settleBatch(p2);
        assertEq(core.balanceOf(alice, _r(p2)), 0, "next boundary E1 - 6 h: not yet");
        vm.warp(E1 - 6 hours);
        core.settleBatch(p2);
        assertEq(core.balanceOf(alice, _r(p2)), ONE, "European old pool repaid early by the rollover");
        assertEq(core.pool(p1).repaidUnits, ONE);
        assertEq(core.pool(p1).assetBal, 0);
    }

    function test_rollover_topUpCoversFees() public {
        bytes32 p1 = _create(K, Kind.American, E1);
        bytes32 p2 = _create(K_HI, Kind.American, E2);
        _borrow(p1, ONE, 2900e6);
        uint256 minP = 2850e6;
        uint256 need = Clearing.quoteUp(ONE, K - minP, ONE) + Settlement.tradeFee(Clearing.quoteUp(ONE, minP, ONE))
            + Settlement.spreadShare(ONE, K_HI, minP, ONE) + 4 * 500;
        uint64 hint = core.findHint(p2, SELL, uint96(minP));
        vm.prank(alice);
        vm.expectRevert(IConfluere.InvalidParams.selector);
        core.rollover(p1, p2, uint96(ONE), uint96(minP), uint128(need - 1), 500, hint);
        _roll(p1, p2, ONE, minP, need);
        _buy(carol, p2, ONE, minP); // clears exactly at minPrice: the largest top-up
        vm.warp(E1 - BATCH);
        core.settleBatch(p2);
        assertEq(core.balanceOf(alice, _r(p2)), ONE);
        assertEq(core.pool(p1).quoteBal, K);
    }
}
