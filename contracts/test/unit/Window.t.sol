// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Base} from "../utils/Base.sol";
import {IConfluere} from "../../src/interfaces/IConfluere.sol";
import {Kind, Status} from "../../src/libraries/PoolKey.sol";
import {BID} from "../../src/libraries/OrderSet.sol";

contract WindowTest is Base {
    function _funded(Kind kind) internal returns (bytes32 pid) {
        pid = _create(K, kind, E1);
        // alice and dave borrow 1 ETH each at 2900; bob and carol lend
        _sell(alice, pid, ONE, 2900e6);
        _sell(dave, pid, ONE, 2900e6);
        _buy(bob, pid, ONE, 2900e6);
        _buy(carol, pid, ONE, 2900e6);
        _settle(pid);
        assertEq(core.pool(pid).vwap, 2900e6);
    }

    function test_american_repayAnytime_withSpreadShare() public {
        bytes32 pid = _funded(Kind.American);
        uint256 w0 = weth.balanceOf(alice);
        uint256 u0 = usdc.balanceOf(alice);
        vm.prank(alice);
        core.repay(pid, uint96(ONE));
        assertEq(weth.balanceOf(alice), w0 + ONE, "asset back");
        assertEq(u0 - usdc.balanceOf(alice), 3000e6, "paid K");
        // fee = 10% of (K - vwap) = 10e6
        assertEq(_pend(address(usdc), treasury), 10e6);
        assertEq(core.pool(pid).quoteBal, 2990e6);
        assertEq(core.balanceOf(alice, _r(pid)), 0);
    }

    function test_european_repayOnlyInWindow() public {
        bytes32 pid = _funded(Kind.European);
        vm.prank(alice);
        vm.expectRevert(IConfluere.InvalidState.selector);
        core.repay(pid, uint96(ONE));
        vm.warp(E1);
        core.mature(pid);
        vm.prank(alice);
        core.repay(pid, uint96(ONE));
        assertEq(core.balanceOf(alice, _r(pid)), 0);
    }

    function test_mature_onlyAtExpiry_andWindowInBlocks() public {
        bytes32 pid = _funded(Kind.American);
        vm.expectRevert(IConfluere.InvalidState.selector);
        core.mature(pid);
        vm.warp(E1);
        uint256 b = block.number;
        core.mature(pid);
        assertEq(core.pool(pid).windowEnd, b + WINDOW);
        // time passing without blocks does not end the window
        vm.warp(E1 + 30 days);
        vm.prank(alice);
        core.repay(pid, uint96(ONE));
        vm.roll(b + WINDOW);
        vm.prank(dave);
        vm.expectRevert(IConfluere.InvalidState.selector);
        core.repay(pid, uint96(ONE));
    }

    function test_noSettleAfterExpiry() public {
        bytes32 pid = _funded(Kind.American);
        vm.warp(E1);
        vm.expectRevert(IConfluere.InvalidState.selector);
        core.settleBatch(pid);
    }

    function test_allRepay_lendersGetQuote() public {
        bytes32 pid = _funded(Kind.American);
        vm.warp(E1);
        core.mature(pid);
        vm.prank(alice);
        core.repay(pid, uint96(ONE));
        vm.prank(dave);
        core.repay(pid, uint96(ONE));
        vm.roll(block.number + WINDOW);
        assertTrue(core.closeWindow(pid, 10));
        uint256 u0 = usdc.balanceOf(bob);
        vm.prank(bob);
        (uint256 q, uint256 a) = core.claim(pid);
        assertEq(a, 0);
        assertEq(q, 2990e6, "K minus spread share");
        assertEq(usdc.balanceOf(bob), u0 + q);
        vm.prank(carol);
        (q,) = core.claim(pid);
        assertEq(q, 2990e6);
        assertEq(core.pool(pid).quoteBal, 0);
    }

    function test_default_lendersGetAsset() public {
        bytes32 pid = _funded(Kind.European);
        _matureAndEndWindow(pid);
        core.closeWindow(pid, 10);
        vm.prank(bob);
        (uint256 q, uint256 a) = core.claim(pid);
        assertEq(q, 0);
        assertEq(a, ONE, "physical delivery");
        assertEq(_pend(address(usdc), treasury), 0, "no fee on default");
    }

    function test_abandonmentAuction_surplusToRHolders() public {
        bytes32 pid = _funded(Kind.European);
        vm.warp(E1);
        core.mature(pid);
        // eve bids for 1.5 units at +100 per unit, carol bids 1 unit at +40
        uint64 b1 = _bid(eve, pid, 15e17, 100e6);
        uint256 carol0 = _pend(address(usdc), carol);
        _bid(carol, pid, ONE, 40e6);
        // alice repays herself: repayment always beats bids
        vm.prank(alice);
        core.repay(pid, uint96(ONE));
        vm.roll(block.number + WINDOW);
        assertTrue(core.closeWindow(pid, 10));

        // only dave's 1 unit was unrepaid: eve (highest) takes it all
        assertEq(_pend(address(weth), eve), ONE);
        assertEq(_pend(address(usdc), eve), 5e17 * 3100e6 / ONE, "unused half refunded");
        assertEq(_pend(address(usdc), carol) - carol0, 3040e6, "losing bid refunded");
        (address o,,,,,,) = core.order(pid, b1);
        assertEq(o, address(0));

        IConfluere.PoolView memory v = core.pool(pid);
        assertEq(v.surplusBal, 100e6);
        assertEq(v.assetBal, 0);

        // dave (R holder) collects the surplus, alice has no R left
        vm.prank(dave);
        (uint256 q,) = core.claim(pid);
        assertEq(q, 100e6);
        // lenders split: alice repaid 2990 net + eve paid 3000
        vm.prank(bob);
        (q,) = core.claim(pid);
        assertEq(q, 2995e6);
    }

    function test_bid_cancellableOnlyInWindow() public {
        bytes32 pid = _funded(Kind.European);
        vm.warp(E1);
        core.mature(pid);
        uint64 b1 = _bid(eve, pid, ONE, 1e6);
        vm.prank(eve);
        core.cancelOrder(pid, b1);
        uint64 b2 = _bid(eve, pid, ONE, 1e6);
        vm.roll(block.number + WINDOW);
        vm.prank(eve);
        vm.expectRevert(IConfluere.InvalidState.selector);
        core.cancelOrder(pid, b2);
        vm.prank(eve);
        vm.expectRevert(IConfluere.InvalidState.selector);
        core.bid(pid, uint96(ONE), 1e6, 0);
    }

    function test_segmentedClose() public {
        bytes32 pid = _funded(Kind.European);
        vm.warp(E1);
        core.mature(pid);
        for (uint256 i; i < 4; ++i) {
            _bid(eve, pid, 5e17, 10e6 * (i + 1));
        }
        vm.roll(block.number + WINDOW);
        assertFalse(core.closeWindow(pid, 3));
        assertEq(uint8(core.pool(pid).status), uint8(Status.Closing));
        vm.prank(bob);
        vm.expectRevert(IConfluere.InvalidState.selector);
        core.claim(pid);
        assertTrue(core.closeWindow(pid, 3));
        assertEq(uint8(core.pool(pid).status), uint8(Status.Closed));
        // 2 units unrepaid, bids for 2 units total: all filled, highest first
        assertEq(_pend(address(weth), eve), 2 * ONE);
        assertEq(core.pool(pid).surplusBal, (40e6 + 30e6 + 20e6 + 10e6) / 2);
    }

    function test_bidBookFull_evictsLowestSurplus() public {
        bytes32 pid = _funded(Kind.European);
        vm.warp(E1);
        core.mature(pid);
        for (uint256 i; i < 4; ++i) {
            _bid(eve, pid, ONE, 10e6 * (i + 1));
        }
        uint256 hint = core.findHint(pid, BID, 5e6);
        vm.prank(carol);
        vm.expectRevert(IConfluere.BookFull.selector);
        core.bid(pid, uint96(ONE), 5e6, uint64(hint));
        _bid(carol, pid, ONE, 50e6);
        assertEq(_pend(address(usdc), eve), 3010e6, "lowest bid evicted and refunded");
    }

    function test_claim_burnsAndPaysProRata_mixed() public {
        bytes32 pid = _funded(Kind.European);
        vm.warp(E1);
        core.mature(pid);
        vm.prank(alice);
        core.repay(pid, uint96(ONE));
        vm.roll(block.number + WINDOW);
        core.closeWindow(pid, 10);
        vm.prank(bob);
        (uint256 q, uint256 a) = core.claim(pid);
        assertEq(q, 1495e6);
        assertEq(a, 5e17);
        assertEq(core.balanceOf(bob, _c(pid)), 0);
        // transferred C claims the same
        vm.prank(carol);
        core.transfer(eve, _c(pid), ONE);
        vm.prank(eve);
        (q, a) = core.claim(pid);
        assertEq(q, 1495e6);
        assertEq(a, 5e17);
    }

    function test_closeWindow_tooEarly() public {
        bytes32 pid = _funded(Kind.European);
        vm.warp(E1);
        core.mature(pid);
        vm.expectRevert(IConfluere.InvalidState.selector);
        core.closeWindow(pid, 10);
    }

    function _bid(address who, bytes32 pid, uint256 units, uint256 surplus) internal returns (uint64) {
        uint64 hint = core.findHint(pid, BID, uint96(surplus));
        vm.prank(who);
        return core.bid(pid, uint96(units), uint96(surplus), hint);
    }
}
