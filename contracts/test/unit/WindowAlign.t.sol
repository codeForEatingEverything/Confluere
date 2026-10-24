// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Base} from "../utils/Base.sol";
import {IConfluere} from "../../src/interfaces/IConfluere.sol";
import {Kind, Status} from "../../src/libraries/PoolKey.sol";
import {SELL} from "../../src/libraries/OrderSet.sol";

/// @notice Blueprint §3.5: every pool of an expiry shares one repayment window, counted in blocks from the first
/// mature() of that expiry, so the order in which keepers mature pools changes nothing for borrowers.
contract WindowAlignTest is Base {
    function _borrow(bytes32 pid, address who, uint256 units, uint256 price) internal {
        _sell(who, pid, units, price);
        _buy(bob, pid, units, price);
        _settle(pid);
    }

    function test_laterPoolsJoinTheFirstWindow() public {
        bytes32 a = _create(K, Kind.American, E1);
        bytes32 b = _create(K_HI, Kind.European, E1);
        vm.warp(E1);
        assertEq(core.expiryWindowEnd(E1), 0, "not started before the first mature");
        core.mature(a);
        uint64 end = core.expiryWindowEnd(E1);
        assertEq(end, block.number + WINDOW);
        vm.roll(block.number + 500);
        core.mature(b);
        assertEq(core.pool(b).windowEnd, end, "same end block, not 500 later");
        assertEq(core.pool(a).windowEnd, end);
    }

    function test_unmaturedPoolRepaysInsideTheSharedWindowOnly() public {
        bytes32 a = _create(K, Kind.American, E1);
        bytes32 eu = _create(K, Kind.European, E1);
        _borrow(eu, alice, 2 * ONE, 2900e6);
        vm.warp(E1);
        core.mature(a); // starts the expiry's window; nobody matures `eu`
        vm.prank(alice);
        core.repay(eu, uint96(ONE)); // European, still Open, but the shared window is running
        assertEq(core.balanceOf(alice, _r(eu)), ONE);
        vm.roll(block.number + WINDOW);
        vm.prank(alice);
        vm.expectRevert(IConfluere.InvalidState.selector);
        core.repay(eu, uint96(ONE));
        // maturing late lands the pool in an already finished window: it closes at once
        core.mature(eu);
        assertTrue(core.closeWindow(eu, 10));
        assertEq(uint8(core.pool(eu).status), uint8(Status.Closed));
    }

    function test_americanCannotRepayAfterTheSharedWindowEvenIfNeverMatured() public {
        bytes32 a = _create(K, Kind.American, E1);
        bytes32 b = _create(K_HI, Kind.American, E1);
        _borrow(b, alice, ONE, 2900e6);
        vm.warp(E1);
        core.mature(a);
        vm.roll(block.number + WINDOW);
        vm.prank(alice);
        vm.expectRevert(IConfluere.InvalidState.selector);
        core.repay(b, uint96(ONE));
    }

    function test_americanRepaysAfterExpiryBeforeAnyMature() public {
        bytes32 a = _create(K, Kind.American, E1);
        _borrow(a, alice, ONE, 2900e6);
        vm.warp(E1 + 1 hours);
        vm.prank(alice);
        core.repay(a, uint96(ONE)); // the window has not started yet: it starts with the first mature()
        assertEq(core.balanceOf(alice, _r(a)), 0);
    }

    function test_rolloverClearsAtExpiryBeforeTheOldPoolIsMatured() public {
        bytes32 p1 = _create(K, Kind.American, E1);
        bytes32 p2 = _create(K, Kind.American, E2);
        _borrow(p1, alice, ONE, 2900e6);
        uint64 hint = core.findHint(p2, SELL, 2850e6);
        vm.prank(alice);
        core.rollover(p1, p2, uint96(ONE), 2850e6, 200e6, 500, hint);
        _buy(carol, p2, ONE, 2950e6);
        // the expiry batch of the new pool settles first; the keeper has not matured p1 yet
        vm.warp(E1);
        core.settleBatch(p2);
        assertEq(core.balanceOf(alice, _r(p2)), ONE, "rolled at the expiry batch");
        assertEq(core.balanceOf(alice, _r(p1)), 0);
        assertEq(core.pool(p1).assetBal, 0);
    }

    function test_purgeKeepsRolloverWhileSharedWindowRuns() public {
        bytes32 p1 = _create(K, Kind.American, E1);
        bytes32 other = _create(K_HI, Kind.American, E1);
        bytes32 p2 = _create(K, Kind.American, E2);
        _borrow(p1, alice, ONE, 2900e6);
        uint64 hint = core.findHint(p2, SELL, 2850e6);
        vm.prank(alice);
        uint64 id = core.rollover(p1, p2, uint96(ONE), 2850e6, 200e6, 500, hint);
        vm.warp(E1);
        core.mature(other);
        uint64[] memory ids = new uint64[](1);
        ids[0] = id;
        core.purge(p2, ids);
        assertEq(core.lockedR(alice, p1), ONE, "still live: the shared window is open");
        vm.roll(block.number + WINDOW);
        core.purge(p2, ids);
        assertEq(core.lockedR(alice, p1), 0, "dead once the shared window is over");
    }

    function test_rolloverCannotStartAfterTheSharedWindow() public {
        bytes32 p1 = _create(K, Kind.American, E1);
        bytes32 other = _create(K_HI, Kind.American, E1);
        bytes32 p2 = _create(K, Kind.American, E2);
        _borrow(p1, alice, ONE, 2900e6);
        vm.warp(E1);
        core.mature(other);
        vm.roll(block.number + WINDOW); // p1 never matured, but its expiry's window is over
        vm.prank(alice);
        vm.expectRevert(IConfluere.InvalidState.selector);
        core.rollover(p1, p2, uint96(ONE), 2850e6, 200e6, 500, 0);
    }
}
