// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Base} from "../utils/Base.sol";
import {IConfluere} from "../../src/interfaces/IConfluere.sol";
import {Kind, Status} from "../../src/libraries/PoolKey.sol";
import {SELL, BID} from "../../src/libraries/OrderSet.sol";

/// @notice The core side of Specials lending (decision A, ARCH 2.6.1, invariant 3b). `specials` stands in for the
/// Specials periphery.
contract SpecialsCoreTest is Base {
    bytes32 internal pid;
    uint256 internal constant MARGIN = 3480e6; // 120% of 1 ETH at the last clearing price 2900
    address internal taker = makeAddr("taker"); // the borrower of the lent asset

    function setUp() public override {
        super.setUp();
        pid = _create(K, Kind.European, E1);
        _sell(alice, pid, 2 * ONE, 2900e6);
        _buy(bob, pid, 2 * ONE, 2900e6);
        _settle(pid);
        weth.mint(specials, 100 * ONE);
        usdc.mint(specials, 1_000_000e6);
        vm.startPrank(specials);
        weth.approve(address(core), type(uint256).max);
        usdc.approve(address(core), type(uint256).max);
        vm.stopPrank();
    }

    function _lend(uint256 units, uint256 margin, uint256 fee) internal {
        vm.prank(specials);
        core.lend(pid, uint96(units), taker, uint128(margin), uint128(fee));
    }

    function _window() internal {
        vm.warp(E1);
        core.mature(pid);
    }

    // ------------------------------------------------------------ permissions and conditions

    function test_lend_onlySpecials() public {
        vm.prank(eve);
        vm.expectRevert(IConfluere.NotOwner.selector);
        core.lend(pid, uint96(ONE), taker, uint128(MARGIN), 0);
        vm.prank(eve);
        vm.expectRevert(IConfluere.NotOwner.selector);
        core.topUpLent(pid, 1);
        vm.prank(eve);
        vm.expectRevert(IConfluere.NotOwner.selector);
        core.returnLent(pid, 1, 0, eve);
    }

    function test_lend_europeanOnly() public {
        bytes32 am = _create(K, Kind.American, E1);
        _sell(alice, am, ONE, 2900e6);
        _buy(bob, am, ONE, 2900e6);
        _settle(am);
        vm.prank(specials);
        vm.expectRevert(IConfluere.InvalidState.selector);
        core.lend(am, 1e17, taker, uint128(MARGIN), 0);
    }

    function test_lend_movesAsset_andEscrowsMargin() public {
        uint256 c0 = weth.balanceOf(address(core));
        _lend(ONE, MARGIN, 0);
        assertEq(weth.balanceOf(taker), ONE);
        assertEq(weth.balanceOf(address(core)), c0 - ONE);
        IConfluere.PoolView memory v = core.pool(pid);
        assertEq(v.lentUnits, ONE);
        assertEq(v.lentMargin, MARGIN);
        assertEq(v.assetBal, 2 * ONE, "lent units still back R");
    }

    function test_lend_capHalf() public {
        vm.prank(specials);
        vm.expectRevert(IConfluere.InvalidParams.selector);
        core.lend(pid, uint96(ONE + 1), taker, uint128(2 * MARGIN), 0);
        _lend(5e17, MARGIN, 0);
        _lend(5e17, MARGIN, 0);
        vm.prank(specials);
        vm.expectRevert(IConfluere.InvalidParams.selector);
        core.lend(pid, 1, taker, uint128(MARGIN), 0);
    }

    function test_lend_minMargin120() public {
        vm.prank(specials);
        vm.expectRevert(IConfluere.InvalidParams.selector);
        core.lend(pid, uint96(ONE), taker, uint128(MARGIN - 1), 0);
        _lend(ONE, MARGIN, 0);
    }

    function test_lend_needsAPrice() public {
        bytes32 fresh = _create(K_HI, Kind.European, E1);
        vm.prank(specials);
        vm.expectRevert(IConfluere.InvalidParams.selector);
        core.lend(fresh, 1, taker, uint128(MARGIN), 0);
    }

    function test_lend_afterCutoff_reverts() public {
        vm.warp(E1 - 12 hours);
        vm.prank(specials);
        vm.expectRevert(IConfluere.InvalidState.selector);
        core.lend(pid, uint96(ONE), taker, uint128(MARGIN), 0);
    }

    function test_lend_whilePaused_reverts() public {
        vm.prank(guardian);
        core.pause(pid, 100);
        vm.prank(specials);
        vm.expectRevert(IConfluere.InvalidState.selector);
        core.lend(pid, uint96(ONE), taker, uint128(MARGIN), 0);
    }

    function test_fee_toLenders() public {
        uint256 q0 = core.pool(pid).quoteBal;
        _lend(ONE, MARGIN, 10e6);
        assertEq(core.pool(pid).quoteBal, q0 + 10e6);
        assertEq(_pend(address(usdc), treasury), 4 * 435_000, "the protocol takes nothing from lending");
    }

    // ------------------------------------------------------------ returning

    function test_return_partial_marginToPending() public {
        _lend(ONE, MARGIN, 0);
        vm.prank(specials);
        core.returnLent(pid, uint96(4e17), uint128(MARGIN * 2 / 5), taker);
        assertEq(_pend(address(usdc), taker), MARGIN * 2 / 5);
        IConfluere.PoolView memory v = core.pool(pid);
        assertEq(v.lentUnits, 6e17);
        assertEq(v.lentMargin, MARGIN - MARGIN * 2 / 5);
    }

    function test_return_full_mustReleaseAll() public {
        _lend(ONE, MARGIN, 0);
        vm.prank(specials);
        vm.expectRevert(IConfluere.InvalidParams.selector);
        core.returnLent(pid, uint96(ONE), uint128(MARGIN - 1), taker);
        vm.prank(specials);
        core.returnLent(pid, uint96(ONE), uint128(MARGIN), taker);
        assertEq(core.pool(pid).lentUnits, 0);
        assertEq(core.pool(pid).lentMargin, 0);
    }

    function test_return_afterCutoff_reverts() public {
        _lend(ONE, MARGIN, 0);
        vm.warp(E1 - 12 hours);
        vm.prank(specials);
        vm.expectRevert(IConfluere.InvalidState.selector);
        core.returnLent(pid, uint96(ONE), uint128(MARGIN), taker);
    }

    function test_topUp() public {
        _lend(ONE, MARGIN, 0);
        vm.prank(specials);
        core.topUpLent(pid, 100e6);
        assertEq(core.pool(pid).lentMargin, MARGIN + 100e6);
        vm.warp(E1 - 1);
        vm.prank(specials);
        vm.expectRevert(IConfluere.InvalidState.selector);
        core.topUpLent(pid, 1);
    }

    // ------------------------------------------------------------ short units after the cutoff

    function test_short_recordedLazily_atFirstTouch() public {
        _lend(ONE, MARGIN, 0);
        vm.warp(E1 - 1 hours); // past the cutoff, nothing touched the pool yet
        assertEq(core.pool(pid).lentUnits, ONE);
        vm.warp(E1);
        vm.expectEmit(true, false, false, true);
        emit IConfluere.ShortRecorded(pid, ONE, MARGIN);
        core.mature(pid);
        IConfluere.PoolView memory v = core.pool(pid);
        assertEq(v.lentUnits, 0);
        assertEq(v.shortUnits, ONE);
        assertEq(v.shortMargin, MARGIN);
    }

    function test_repay_assetFirst_thenMargin() public {
        _lend(ONE, MARGIN, 0);
        _window();
        vm.prank(alice);
        (uint256 a1, uint256 m1) = core.repay(pid, uint96(15e17));
        assertEq(a1, ONE, "the asset still here goes first");
        assertEq(m1, MARGIN / 2, "half of the short units: half of the margin");
        assertEq(_pend(address(usdc), alice) - (2 * 2900e6 - 2 * 435_000 - 2 * 5_548_315), MARGIN / 2);
        vm.prank(alice);
        (uint256 a2, uint256 m2) = core.repay(pid, uint96(5e17));
        assertEq(a2, 0);
        assertEq(m2, MARGIN - MARGIN / 2, "the last short unit takes the rest");
        IConfluere.PoolView memory v = core.pool(pid);
        assertEq(v.shortUnits, 0);
        assertEq(v.shortMargin, 0);
        assertEq(v.quoteBal, 2 * uint256(K), "C holders get K for every unit");
        assertEq(v.repaidUnits, 2 * ONE);
    }

    function test_repay_lastShortTakesAllMargin() public {
        _lend(ONE, MARGIN + 1, 0); // odd margin
        _window();
        vm.prank(alice);
        core.repay(pid, uint96(ONE)); // all physical
        vm.prank(alice);
        (, uint256 m1) = core.repay(pid, uint96(3e17));
        vm.prank(alice);
        (, uint256 m2) = core.repay(pid, uint96(7e17));
        assertEq(m1 + m2, MARGIN + 1, "no dust left behind");
    }

    function test_repay_neverRevertsWithShort() public {
        _lend(ONE, MARGIN, 0);
        _window();
        vm.prank(alice);
        core.repay(pid, uint96(2 * ONE));
        assertEq(core.balanceOf(alice, _r(pid)), 0);
    }

    function test_bids_onlyPhysical() public {
        _lend(ONE, MARGIN, 0);
        _window();
        uint64 hint = core.findHint(pid, BID, 1e6);
        vm.prank(eve);
        core.bid(pid, uint96(2 * ONE), 1e6, hint);
        vm.roll(block.number + WINDOW);
        core.closeWindow(pid, 10);
        assertEq(_pend(address(weth), eve), ONE, "only the unit still here can be bought");
        IConfluere.PoolView memory v = core.pool(pid);
        assertEq(v.assetBal, 0);
        assertEq(
            v.quoteBal, uint256(K) + MARGIN + 2 * 5_548_315 / 2, "K for the bid unit, the margin, lenders' escrow half"
        );
    }

    function test_close_unclaimedShortMarginToLenders() public {
        _lend(ONE, MARGIN, 0);
        _window();
        vm.roll(block.number + WINDOW);
        assertTrue(core.closeWindow(pid, 10));
        IConfluere.PoolView memory v = core.pool(pid);
        assertEq(uint8(v.status), uint8(Status.Closed));
        assertEq(v.shortUnits, 0);
        assertEq(v.shortMargin, 0);
        assertEq(v.assetBal, ONE, "the unit still here defaults in kind");
        assertEq(v.quoteBal, MARGIN + 2 * 5_548_315, "the forfeited margin and the defaulted escrow");
        vm.prank(bob);
        (uint256 q, uint256 a) = core.claim(pid);
        assertEq(q, MARGIN + 2 * 5_548_315);
        assertEq(a, ONE);
    }

    function test_rollover_skippedWhenOldPoolHasLent() public {
        bytes32 p2 = _create(K, Kind.European, E2);
        _lend(ONE, MARGIN, 0);
        uint64 hint = core.findHint(p2, SELL, 2850e6);
        vm.prank(alice);
        core.rollover(pid, p2, uint96(ONE), 2850e6, 200e6, 500, hint);
        _buy(carol, p2, ONE, 2950e6);
        vm.warp(E1 - BATCH);
        core.settleBatch(p2); // the last batch before E1, but the old pool's units are not all here
        assertEq(core.balanceOf(alice, _r(p2)), 0);
        assertEq(core.pool(pid).assetBal, 2 * ONE);
    }
}
