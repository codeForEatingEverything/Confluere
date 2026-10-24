// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Base} from "../utils/Base.sol";
import {IConfluere} from "../../src/interfaces/IConfluere.sol";
import {Kind} from "../../src/libraries/PoolKey.sol";
import {Specials} from "../../src/periphery/Specials.sol";
import {Router} from "../../src/periphery/Router.sol";

/// @notice Specials periphery against the real core (decision A, invariant 3b): per-loan accounting matches the
/// core's aggregate, partial / full return, top-up, cutoff, and repayment from forfeited margin after a default.
contract SpecialsTest is Base {
    Specials internal sp;
    bytes32 internal pid;
    address internal frank = makeAddr("frank"); // a second borrower of the asset

    function setUp() public override {
        sp = new Specials(address(this), 0);
        specials = address(sp);
        super.setUp();
        sp.bind(core);
        pid = _create(K, Kind.European, E1);
        _sell(alice, pid, 10 * ONE, 2900e6);
        _buy(bob, pid, 10 * ONE, 2950e6);
        _settle(pid);
        assertEq(core.pool(pid).assetBal, 10 * ONE);

        address[2] memory bs = [dave, frank];
        for (uint256 i; i < 2; ++i) {
            usdc.mint(bs[i], 1_000_000e6);
            vm.startPrank(bs[i]);
            usdc.approve(address(sp), type(uint256).max);
            weth.approve(address(sp), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _open(address who, uint96 units, uint128 fee) internal returns (uint256 id, uint128 margin) {
        margin = sp.minMargin(pid, units);
        vm.prank(who);
        id = sp.open(pid, units, margin, fee, who);
    }

    function _assertLedger(uint256[] memory ids) internal view {
        uint256 u;
        uint256 m;
        for (uint256 i; i < ids.length; ++i) {
            (,, uint96 lu, uint128 lm) = sp.loans(ids[i]);
            u += lu;
            m += lm;
        }
        IConfluere.PoolView memory v = core.pool(pid);
        assertEq(u, v.lentUnits, "sum units");
        assertEq(m, v.lentMargin, "sum margin");
    }

    function test_bind_onlyOnce() public {
        vm.expectRevert(Specials.AlreadyBound.selector);
        sp.bind(core);
    }

    function test_open_deliversAsset_feeToLenders() public {
        uint256 qb = core.pool(pid).quoteBal;
        uint256 w = weth.balanceOf(dave);
        (uint256 id, uint128 margin) = _open(dave, uint96(2 * ONE), 5e6);
        assertEq(weth.balanceOf(dave), w + 2 * ONE);
        assertEq(core.pool(pid).quoteBal, qb + 5e6);
        assertGe(uint256(margin) * 10_000, uint256(2) * core.pool(pid).lastClearingPrice * 12_000);
        assertEq(usdc.balanceOf(address(sp)), 0);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        _assertLedger(ids);
        assertEq(sp.available(pid), 3 * ONE);
    }

    function test_open_belowMinMargin_reverts() public {
        uint128 m = sp.minMargin(pid, uint96(ONE));
        vm.prank(dave);
        vm.expectRevert(Specials.InvalidParams.selector);
        sp.open(pid, uint96(ONE), m - 1, 0, dave);
    }

    function test_open_capHalf() public {
        _open(dave, uint96(3 * ONE), 0);
        uint128 m = sp.minMargin(pid, uint96(3 * ONE));
        vm.prank(frank);
        vm.expectRevert(IConfluere.InvalidParams.selector);
        sp.open(pid, uint96(3 * ONE), m, 0, frank);
    }

    function test_open_american_reverts() public {
        bytes32 a = _create(K, Kind.American, E1);
        _sell(alice, a, 10 * ONE, 2900e6);
        _buy(bob, a, 10 * ONE, 2950e6);
        _settle(a);
        uint128 m = sp.minMargin(a, uint96(ONE));
        vm.prank(dave);
        vm.expectRevert(IConfluere.InvalidState.selector);
        sp.open(a, uint96(ONE), m, 0, dave);
    }

    function test_topUp_partialAndFullClose() public {
        (uint256 a, uint128 ma) = _open(dave, uint96(2 * ONE), 0);
        (uint256 b,) = _open(frank, uint96(ONE), 0);
        vm.prank(dave);
        sp.topUp(a, 100e6);
        ma += 100e6;
        uint256[] memory ids = new uint256[](2);
        ids[0] = a;
        ids[1] = b;
        _assertLedger(ids);

        vm.prank(dave);
        sp.close(a, uint96(ONE));
        assertEq(_pend(address(usdc), dave), ma / 2);
        _assertLedger(ids);

        vm.prank(frank);
        vm.expectRevert(Specials.NotBorrower.selector);
        sp.close(a, uint96(ONE));

        vm.prank(dave);
        sp.close(a, uint96(ONE));
        assertEq(_pend(address(usdc), dave), ma);
        vm.prank(frank);
        sp.close(b, uint96(ONE));
        _assertLedger(ids);
        assertEq(core.pool(pid).lentUnits, 0);
        assertEq(core.pool(pid).lentMargin, 0);
        assertEq(weth.balanceOf(address(core)), 10 * ONE);
    }

    function test_close_afterCutoff_reverts_andDefaulted() public {
        (uint256 a,) = _open(dave, uint96(2 * ONE), 0);
        assertFalse(sp.defaulted(a));
        vm.warp(sp.cutoff(pid));
        assertTrue(sp.defaulted(a));
        vm.prank(dave);
        vm.expectRevert(IConfluere.InvalidState.selector);
        sp.close(a, uint96(ONE));
        vm.prank(dave);
        vm.expectRevert(IConfluere.InvalidState.selector);
        sp.topUp(a, 1e6);
    }

    function test_overdue_repayGetsAssetThenMargin() public {
        (, uint128 margin) = _open(dave, uint96(2 * ONE), 0);
        vm.warp(E1);
        core.mature(pid);
        uint256 w = weth.balanceOf(alice);
        uint256 p0 = _pend(address(usdc), alice);
        vm.prank(alice);
        (uint256 assetOut, uint256 marginOut) = core.repay(pid, uint96(10 * ONE));
        assertEq(assetOut, 8 * ONE);
        assertEq(marginOut, margin);
        assertEq(weth.balanceOf(alice), w + 8 * ONE);
        assertEq(_pend(address(usdc), alice), p0 + margin);
    }

    function test_router_repay_withShortUnits_forwardsMargin() public {
        (, uint128 margin) = _open(dave, uint96(2 * ONE), 0);
        Router r = new Router(core);
        vm.warp(E1);
        core.mature(pid);
        vm.startPrank(alice);
        core.setOperator(address(r), true);
        usdc.approve(address(r), type(uint256).max);
        uint256 w = weth.balanceOf(alice);
        uint256 q = usdc.balanceOf(alice);
        (uint256 assetOut, uint256 marginOut) = r.repay(pid, uint96(9 * ONE));
        vm.stopPrank();
        // 8 units are physical; the 9th is short: paid K, receives the whole margin (it is half of 2 short units)
        assertEq(assetOut, 8 * ONE);
        assertEq(marginOut, margin / 2);
        assertEq(weth.balanceOf(alice), w + 8 * ONE);
        uint256 pay = uint256(9) * K; // K per whole unit
        assertEq(usdc.balanceOf(alice), q - pay + margin / 2);
        assertEq(weth.balanceOf(address(r)), 0);
        assertEq(usdc.balanceOf(address(r)), 0);
    }
}
