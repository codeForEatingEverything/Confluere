// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Base} from "../utils/Base.sol";
import {IConfluere} from "../../src/interfaces/IConfluere.sol";
import {PoolKey, PoolKeyLib, Kind, Status} from "../../src/libraries/PoolKey.sol";
import {SELL, BUY, NC_SELL, NC_BUY} from "../../src/libraries/OrderSet.sol";
import {OrderSet} from "../../src/libraries/OrderSet.sol";
import {FeeOnTransferERC20, MockERC20} from "../../src/mocks/MockERC20.sol";

contract PoolsTest is Base {
    function test_createPool_ids() public {
        bytes32 pid = _create();
        assertEq(uint256(pid) & 1, 0, "low bit cleared");
        assertEq(_r(pid), uint256(pid) | 1);
        IConfluere.PoolView memory v = core.pool(pid);
        assertEq(uint8(v.status), uint8(Status.Open));
        assertEq(v.assetDecimals, 18);
        assertEq(v.key.strike, K);
        assertEq(weth.balanceOf(address(core)), 0, "probe returned");
    }

    function test_createPool_rejectsDuplicate() public {
        _create();
        vm.expectRevert(IConfluere.InvalidPool.selector);
        _create();
    }

    function test_createPool_rejectsOffGridExpiry() public {
        vm.expectRevert(IConfluere.InvalidParams.selector);
        _create(K, Kind.American, E1 + 1 hours);
        // too far out: 5 periods
        vm.expectRevert(IConfluere.InvalidParams.selector);
        _create(K, Kind.American, ANCHOR + 5 * WEEK);
        // in the past
        vm.expectRevert(IConfluere.InvalidParams.selector);
        _create(K, Kind.American, ANCHOR);
    }

    function test_createPool_strikeGrid() public {
        _create(3100e6, Kind.American, E1); // two significant digits
        vm.expectRevert(IConfluere.InvalidParams.selector);
        _create(3150e6, Kind.American, E1); // three
        _create(98e16, Kind.European, E1); // pegged 0.98 in an 18-decimal quote
    }

    function test_createPool_rejectsFeeAndBandOutsideWhitelist() public {
        vm.expectRevert(IConfluere.InvalidParams.selector);
        core.createPool(_key(K, Kind.American, E1), 500, 800);
        vm.expectRevert(IConfluere.InvalidParams.selector);
        core.createPool(_key(K, Kind.American, E1), 1000, 100);
    }

    function test_createPool_rejectsFeeOnTransfer() public {
        FeeOnTransferERC20 fot = new FeeOnTransferERC20();
        fot.mint(address(this), ONE);
        fot.approve(address(core), type(uint256).max);
        PoolKey memory key = PoolKey(address(fot), address(usdc), E1, K, Kind.American);
        vm.expectRevert(IConfluere.BadToken.selector);
        core.createPool(key, 1000, 800);
    }

    function test_createPool_rejectsSameToken() public {
        PoolKey memory key = PoolKey(address(usdc), address(usdc), E1, K, Kind.American);
        vm.expectRevert(IConfluere.BadToken.selector);
        core.createPool(key, 1000, 800);
    }

    function test_placeOrder_escrows() public {
        bytes32 pid = _create();
        uint256 w0 = weth.balanceOf(alice);
        _sell(alice, pid, ONE, 2900e6);
        assertEq(weth.balanceOf(alice), w0 - ONE);
        uint256 u0 = usdc.balanceOf(bob);
        _buy(bob, pid, ONE, 2900e6);
        assertEq(
            u0 - usdc.balanceOf(bob), 2900e6 + 435_000 + 20, "limit cost, its 0.015% trade fee, 2 wei per ttl batch"
        );
    }

    function test_placeOrder_validation() public {
        bytes32 pid = _create();
        vm.startPrank(alice);
        vm.expectRevert(IConfluere.InvalidParams.selector);
        core.placeOrder(pid, _params(SELL, ONE, 0, 0, 1, 0)); // competitive sell needs a limit
        vm.expectRevert(IConfluere.InvalidParams.selector);
        core.placeOrder(pid, _params(NC_BUY, ONE, 0, 1e6, 1, 0)); // nc buy uses budget only
        vm.expectRevert(IConfluere.InvalidParams.selector);
        core.placeOrder(pid, _params(SELL, ONE, 1, 0, 0, 0)); // ttl 0
        vm.expectRevert(IConfluere.InvalidParams.selector);
        core.placeOrder(pid, _params(7, ONE, 1, 0, 1, 0)); // unknown side
        vm.stopPrank();
    }

    function test_placeOrder_onBehalfOf() public {
        bytes32 pid = _create();
        IConfluere.OrderParams memory p = _params(SELL, ONE, 2900e6, 0, 1, 0);
        p.owner = dave;
        vm.prank(alice);
        uint64 id = core.placeOrder(pid, p);
        (address owner,,,,,,) = core.order(pid, id);
        assertEq(owner, dave);
        vm.prank(dave);
        core.cancelOrder(pid, id);
        assertEq(_pend(address(weth), dave), ONE, "refund goes to the owner");
    }

    function test_sortedInsertion_andStaleHint() public {
        bytes32 pid = _create();
        uint64 a = _sell(alice, pid, ONE, 2800e6);
        uint64 b = _sell(alice, pid, ONE, 3000e6);
        uint64 c = _sell(alice, pid, ONE, 2900e6);
        _assertOrder(pid, SELL, _arr(a, c, b));
        // hint computed before two more inserts at the same price still works (probe forward)
        uint64 staleHint = core.findHint(pid, SELL, 2950e6); // = c
        _sell(alice, pid, ONE, 2900e6);
        _sell(alice, pid, ONE, 2900e6);
        vm.prank(alice);
        uint64 d = core.placeOrder(pid, _params(SELL, ONE, 2950e6, 0, 1, staleHint));
        (uint64 head,) = core.bookHead(pid, SELL);
        assertEq(head, a);
        (,,,,,, uint64 nextOfD) = core.order(pid, d);
        assertEq(nextOfD, b);
    }

    function test_hint_tooStale_reverts() public {
        bytes32 pid = _create();
        _sell(alice, pid, ONE, 2800e6);
        uint64 hint = core.findHint(pid, SELL, 2950e6);
        for (uint256 i; i < 4; ++i) {
            _sell(alice, pid, ONE, 2900e6);
        }
        vm.prank(alice);
        vm.expectRevert(OrderSet.InvalidHint.selector);
        core.placeOrder(pid, _params(SELL, ONE, 2950e6, 0, 1, hint));
    }

    function test_hint_wrongSide_reverts() public {
        bytes32 pid = _create();
        uint64 s = _sell(alice, pid, ONE, 2800e6);
        vm.prank(bob);
        vm.expectRevert(OrderSet.InvalidHint.selector);
        core.placeOrder(pid, _params(BUY, ONE, 2800e6, 0, 1, s));
    }

    function test_buyBook_descending() public {
        bytes32 pid = _create();
        uint64 a = _buy(bob, pid, ONE, 2800e6);
        uint64 b = _buy(bob, pid, ONE, 3000e6);
        uint64 c = _buy(bob, pid, ONE, 2900e6);
        _assertOrder(pid, BUY, _arr(b, c, a));
    }

    function test_fullBook_evictsWorst() public {
        bytes32 pid = _create();
        uint64 worst;
        for (uint256 i; i < 8; ++i) {
            uint64 id = _sell(alice, pid, ONE, 2000e6 + i * 100e6);
            if (i == 7) worst = id;
        }
        // not better than the worst (2700): rejected
        uint64 h = core.findHint(pid, SELL, 2700e6);
        vm.prank(dave);
        vm.expectRevert(IConfluere.BookFull.selector);
        core.placeOrder(pid, _params(SELL, ONE, 2700e6, 0, 1, h));
        // strictly better: evicts the worst, refunded through pending
        _sell(dave, pid, ONE, 2050e6);
        (, uint32 count) = core.bookHead(pid, SELL);
        assertEq(count, 8);
        (address owner,,,,,,) = core.order(pid, worst);
        assertEq(owner, address(0));
        assertEq(_pend(address(weth), alice), ONE);
    }

    function test_ncQueue_full_reverts() public {
        bytes32 pid = _create();
        for (uint256 i; i < 8; ++i) {
            _order(alice, pid, NC_SELL, ONE, 0, 0, 1);
        }
        vm.prank(alice);
        vm.expectRevert(IConfluere.BookFull.selector);
        core.placeOrder(pid, _params(NC_SELL, ONE, 0, 0, 1, 0));
    }

    function test_cancel_refundsToPending_andWithdraw() public {
        bytes32 pid = _create();
        uint64 s = _sell(alice, pid, ONE, 2900e6);
        uint64 b = _buy(bob, pid, ONE, 2800e6);
        vm.prank(bob);
        vm.expectRevert(IConfluere.NotOwner.selector);
        core.cancelOrder(pid, s);
        vm.prank(alice);
        core.cancelOrder(pid, s);
        vm.prank(bob);
        core.cancelOrder(pid, b);
        assertEq(_pend(address(weth), alice), ONE);
        assertEq(_pend(address(usdc), bob), 2800e6 + 420_000 + 20);
        uint256 before = weth.balanceOf(alice);
        vm.prank(alice);
        core.withdraw(address(weth), alice);
        assertEq(weth.balanceOf(alice), before + ONE);
        assertEq(_pend(address(weth), alice), 0);
    }

    function test_operatorCanCancel() public {
        bytes32 pid = _create();
        uint64 s = _sell(alice, pid, ONE, 2900e6);
        vm.prank(alice);
        core.setOperator(eve, true);
        vm.prank(eve);
        core.cancelOrder(pid, s);
        assertEq(_pend(address(weth), alice), ONE);
    }

    function test_noOrdersAfterExpiry() public {
        bytes32 pid = _create();
        vm.warp(E1);
        vm.prank(alice);
        vm.expectRevert(IConfluere.InvalidState.selector);
        core.placeOrder(pid, _params(SELL, ONE, 2900e6, 0, 1, 0));
    }

    // ------------------------------------------------------------ helpers

    function _arr(uint64 a, uint64 b, uint64 c) internal pure returns (uint64[] memory r) {
        r = new uint64[](3);
        (r[0], r[1], r[2]) = (a, b, c);
    }

    function _assertOrder(bytes32 pid, uint8 side, uint64[] memory ids) internal view {
        (uint64 cur,) = core.bookHead(pid, side);
        for (uint256 i; i < ids.length; ++i) {
            assertEq(cur, ids[i], "book order");
            (,,,,,, cur) = core.order(pid, cur);
        }
    }
}
