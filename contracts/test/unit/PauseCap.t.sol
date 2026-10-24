// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Base} from "../utils/Base.sol";
import {IConfluere} from "../../src/interfaces/IConfluere.sol";
import {Kind} from "../../src/libraries/PoolKey.sol";

/// @notice Guardian pause budget per pool (blueprint 10, ARCH 2.9, invariant 3c).
contract PauseCapTest is Base {
    uint64 internal constant MAX = 7 days; // Base sets maxPauseBlocks = 7 days

    function _pause(bytes32 pid, uint64 blocks) internal {
        vm.prank(guardian);
        core.pause(pid, blocks);
    }

    function test_pause_cumulativeCap() public {
        bytes32 pid = _create();
        _pause(pid, MAX - 10);
        vm.roll(block.number + MAX);
        vm.prank(guardian);
        vm.expectRevert(IConfluere.InvalidParams.selector);
        core.pause(pid, 11);
        _pause(pid, 10);
        assertEq(core.pool(pid).pausedBlocks, MAX);
        vm.roll(block.number + 10);
        vm.prank(guardian);
        vm.expectRevert(IConfluere.InvalidParams.selector);
        core.pause(pid, 1);
    }

    function test_pause_rejectedWhilePaused() public {
        bytes32 pid = _create();
        _pause(pid, 100);
        vm.roll(block.number + 99);
        vm.prank(guardian);
        vm.expectRevert(IConfluere.IsPaused.selector);
        core.pause(pid, 1);
    }

    function test_pause_afterExpiryOfPause_usesRemaining() public {
        bytes32 pid = _create();
        _pause(pid, 100);
        vm.roll(block.number + 100);
        _pause(pid, 200);
        IConfluere.PoolView memory v = core.pool(pid);
        assertEq(v.pausedBlocks, 300);
        assertEq(v.pausedUntil, block.number + 200);
    }

    function test_pause_capIsPerPool() public {
        bytes32 a = _create();
        bytes32 b = _create(K, Kind.European, E1);
        _pause(a, MAX);
        _pause(b, MAX);
        assertEq(core.pool(b).pausedBlocks, MAX);
    }

    function test_pause_onlyGuardian() public {
        bytes32 pid = _create();
        vm.prank(eve);
        vm.expectRevert(IConfluere.NotOwner.selector);
        core.pause(pid, 1);
    }

    function testFuzz_pause_neverExceedsCap(uint64[6] memory asks, uint8[6] memory gaps) public {
        bytes32 pid = _create();
        for (uint256 i; i < asks.length; ++i) {
            vm.roll(block.number + uint256(gaps[i]) * 1000);
            vm.prank(guardian);
            try core.pause(pid, asks[i] % (2 * MAX)) {} catch {}
            assertLe(core.pool(pid).pausedBlocks, MAX);
        }
    }
}
