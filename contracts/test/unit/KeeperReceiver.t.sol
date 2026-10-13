// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Vm} from "forge-std/Vm.sol";
import {Base} from "../utils/Base.sol";
import {Kind, Status} from "../../src/libraries/PoolKey.sol";
import {KeeperReceiver} from "../../src/periphery/KeeperReceiver.sol";
import {IReceiver} from "../../src/interfaces/IReceiver.sol";

contract KeeperReceiverTest is Base {
    KeeperReceiver internal kr;
    bytes32 internal pid;

    function setUp() public override {
        super.setUp();
        kr = new KeeperReceiver(core, 16);
        pid = _create(K, Kind.European, E1);
        _sell(alice, pid, ONE, 2900e6);
        _buy(bob, pid, ONE, 2900e6);
    }

    function _report() internal view returns (bytes memory) {
        bytes32[] memory ps = new bytes32[](1);
        ps[0] = pid;
        return abi.encode(ps, new address[](0));
    }

    function _ticked() internal returns (uint256 s, uint256 m, uint256 c) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == KeeperReceiver.Ticked.selector) {
                (s, m, c,) = abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
            }
        }
    }

    function test_drivesTheWholeLifecycle_onlyWhenDue() public {
        vm.recordLogs();
        kr.onReport("", _report()); // before the boundary: nothing due
        (uint256 s,,) = _ticked();
        assertEq(s, 0);

        vm.warp(core.nextBatchAt(pid));
        vm.recordLogs();
        kr.onReport("", _report());
        (s,,) = _ticked();
        assertEq(s, 1, "settled");
        assertEq(core.balanceOf(alice, _r(pid)), ONE);

        vm.warp(E1);
        kr.onReport("", _report());
        assertEq(uint8(core.pool(pid).status), uint8(Status.Window), "matured");

        vm.roll(block.number + WINDOW);
        kr.onReport("", _report());
        assertEq(uint8(core.pool(pid).status), uint8(Status.Closed), "closed");
    }

    function test_unknownPoolOrRevertingVault_doesNotBlockOthers() public {
        bytes32[] memory ps = new bytes32[](2);
        ps[0] = pid;
        ps[1] = bytes32(uint256(0xdead) << 1);
        address[] memory vs = new address[](1);
        vs[0] = address(0xbeef);
        vm.warp(core.nextBatchAt(pid));
        kr.tick(ps, vs); // unknown pool reads as Status.None and is skipped; a vault without code is skipped
        assertEq(core.balanceOf(alice, _r(pid)), ONE);
    }

    function test_supportsReceiverInterface() public view {
        assertTrue(kr.supportsInterface(type(IReceiver).interfaceId));
        assertEq(type(IReceiver).interfaceId, bytes4(keccak256("onReport(bytes,bytes)")));
    }
}
