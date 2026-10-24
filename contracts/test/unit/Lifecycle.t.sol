// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Base} from "../utils/Base.sol";
import {Confluere} from "../../src/Confluere.sol";
import {IConfluere} from "../../src/interfaces/IConfluere.sol";
import {PoolKeyLib, Kind} from "../../src/libraries/PoolKey.sol";
import {SELL} from "../../src/libraries/OrderSet.sol";
import {MockFlashBorrower} from "../../src/mocks/MockFlashBorrower.sol";

contract LifecycleTest is Base {
    function _config() internal view override returns (Confluere.Config memory c) {
        c = super._config();
        c.chains[0].graduationQuotes = new address[](1);
        c.chains[0].graduationFees = new uint256[](1);
        c.chains[0].graduationQuotes[0] = address(usdc);
        c.chains[0].graduationFees[0] = 0.8e6; // trade fees of one 1-ETH fill at 2900: 2 x 0.435 USDC
    }

    // ------------------------------------------------------------ rollover

    function _borrow(bytes32 pid, address who, uint256 units, uint256 price) internal {
        _sell(who, pid, units, price);
        _buy(bob, pid, units, price);
        _settle(pid);
    }

    function _rollover(bytes32 oldP, bytes32 newP, uint256 units, uint256 minPrice, uint256 topUp, uint16 ttl)
        internal
        returns (uint64 id)
    {
        uint64 hint = core.findHint(newP, SELL, uint96(minPrice));
        vm.prank(alice);
        id = core.rollover(oldP, newP, uint96(units), uint96(minPrice), uint128(topUp), ttl, hint);
    }

    function test_rollover_fillsInWindow_movesPosition() public {
        bytes32 p1 = _create(K, Kind.American, E1);
        bytes32 p2 = _create(K, Kind.American, E2);
        _borrow(p1, alice, ONE, 2900e6);

        _rollover(p1, p2, ONE, 2850e6, 200e6, 500);
        assertEq(core.lockedR(alice, p1), ONE);
        // locked R cannot move or be repaid directly
        vm.prank(alice);
        vm.expectRevert(IConfluere.Locked.selector);
        core.transfer(eve, _r(p1), ONE);
        vm.prank(alice);
        vm.expectRevert(IConfluere.Locked.selector);
        core.repay(p1, uint96(ONE));

        // lender in the new pool, before the old pool matures: rollover waits
        _buy(carol, p2, ONE, 2950e6);
        _settle(p2);
        assertEq(core.balanceOf(alice, _r(p2)), 0, "inactive before old window");

        vm.warp(E1);
        core.mature(p1);
        _settle(p2);
        // P* = (2850 + 2950)/2 = 2900; old pool gets K = 3000 with 100 from top-up
        assertEq(core.balanceOf(alice, _r(p2)), ONE);
        assertEq(core.balanceOf(alice, _r(p1)), 0);
        assertEq(core.lockedR(alice, p1), 0);
        IConfluere.PoolView memory v1 = core.pool(p1);
        assertEq(v1.assetBal, 0);
        assertEq(v1.quoteBal, 3000e6, "all of K; the old pool counts the units as repaid");
        assertEq(v1.repaidUnits, ONE);
        assertEq(core.pool(p2).assetBal, ONE);
        assertEq(core.pool(p2).feeEscrow, 5e6, "new pool's spread share at its own P*");
        assertEq(_pend(address(usdc), treasury), 4 * 435_000, "trade fees, both pools, both sides");
        // net per fill at 2900 = 2900 - 0.435 trade fee - 5 spread share; top-up = 3000 - 2894.565
        assertEq(_pend(address(usdc), alice), 2894.565e6 + (200e6 - 105.435e6), "first borrow + unused top-up");
    }

    function test_rollover_needsEnoughTopUp() public {
        bytes32 p1 = _create(K, Kind.American, E1);
        bytes32 p2 = _create(K, Kind.American, E2);
        _borrow(p1, alice, ONE, 2900e6);
        vm.prank(alice);
        vm.expectRevert(IConfluere.InvalidParams.selector);
        core.rollover(p1, p2, uint96(ONE), 2850e6, 150e6, 10, 0);
    }

    function test_rollover_failsAfterOldWindow_refunds() public {
        bytes32 p1 = _create(K, Kind.American, E1);
        bytes32 p2 = _create(K, Kind.American, E2);
        _borrow(p1, alice, ONE, 2900e6);
        uint64 id = _rollover(p1, p2, ONE, 2850e6, 200e6, 500);
        vm.warp(E1);
        core.mature(p1);
        vm.roll(block.number + WINDOW);
        uint64[] memory ids = new uint64[](1);
        ids[0] = id;
        uint256 before = _pend(address(usdc), alice);
        core.purge(p2, ids);
        assertEq(core.lockedR(alice, p1), 0, "unlocked");
        assertEq(_pend(address(usdc), alice) - before, 200e6, "top-up refunded");
        // the R now goes through the normal close: default
        core.closeWindow(p1, 10);
        vm.prank(bob);
        (, uint256 a) = core.claim(p1);
        assertEq(a, ONE);
    }

    function test_rollover_rejectsMismatchedPools() public {
        bytes32 p1 = _create(K, Kind.American, E1);
        bytes32 p2 = _create(K, Kind.European, E2);
        _borrow(p1, alice, ONE, 2900e6);
        vm.prank(alice);
        vm.expectRevert(IConfluere.InvalidPool.selector);
        core.rollover(p1, p2, uint96(ONE), 2850e6, 200e6, 10, 0);
    }

    // ------------------------------------------------------------ flash loans

    function test_flashLoan_feeToTreasury() public {
        bytes32 pid = _create();
        _borrow(pid, alice, ONE, 2900e6);
        MockFlashBorrower fb = new MockFlashBorrower();
        usdc.mint(address(fb), 1e6);
        uint256 amount = 1000e6;
        core.flashLoan(fb, address(usdc), amount, "");
        assertEq(fb.seen(), amount + 1e6);
        assertEq(_pend(address(usdc), treasury), 500_000 + 2 * 435_000, "0.05% on top of the trade fees");
    }

    function test_flashLoan_mustRepay() public {
        bytes32 pid = _create();
        _borrow(pid, alice, ONE, 2900e6);
        MockFlashBorrower fb = new MockFlashBorrower();
        fb.setRepay(false);
        vm.expectRevert();
        core.flashLoan(fb, address(usdc), 1000e6, "");
    }

    // ------------------------------------------------------------ guardian

    function test_pause_blocksOrdersAndClearing_notCancelOrRepay() public {
        bytes32 pid = _create();
        _borrow(pid, alice, ONE, 2900e6);
        uint64 s = _sell(dave, pid, ONE, 2900e6);
        vm.prank(eve);
        vm.expectRevert(IConfluere.NotOwner.selector);
        core.pause(pid, 100);
        vm.prank(guardian);
        core.pause(pid, 100);

        vm.prank(dave);
        vm.expectRevert(IConfluere.IsPaused.selector);
        core.placeOrder(pid, _params(SELL, ONE, 2900e6, 0, 1, 0));
        vm.warp(core.nextBatchAt(pid));
        vm.expectRevert(IConfluere.IsPaused.selector);
        core.settleBatch(pid);

        vm.prank(dave);
        core.cancelOrder(pid, s);
        vm.prank(alice);
        core.repay(pid, uint96(ONE));

        vm.roll(block.number + 100);
        core.settleBatch(pid);
    }

    function test_pause_limitedDuration() public {
        bytes32 pid = _create();
        vm.prank(guardian);
        vm.expectRevert(IConfluere.InvalidParams.selector);
        core.pause(pid, 7 days + 1);
    }

    // ------------------------------------------------------------ graduation

    function test_graduation_afterFourCleanCycles_thenNoPause() public {
        bytes32 m = PoolKeyLib.marketId(address(weth), address(usdc), Kind.American);
        bytes32 last;
        for (uint64 i = 1; i <= 4; ++i) {
            uint64 e = ANCHOR + i * WEEK;
            vm.warp(e - 3 days);
            bytes32 pid = _create(K, Kind.American, e);
            _borrow(pid, alice, ONE, 2900e6);
            last = pid;
        }
        uint64 e4 = ANCHOR + 4 * WEEK;
        vm.expectRevert(IConfluere.InvalidParams.selector);
        core.graduate(address(weth), address(usdc), Kind.American, e4); // not past yet
        vm.warp(e4 + 1);
        core.graduate(address(weth), address(usdc), Kind.American, e4);
        assertTrue(core.graduated(m));
        vm.prank(guardian);
        vm.expectRevert(IConfluere.InvalidParams.selector);
        core.pause(last, 10);
    }

    function test_graduation_blockedByPause() public {
        for (uint64 i = 1; i <= 4; ++i) {
            uint64 e = ANCHOR + i * WEEK;
            vm.warp(e - 3 days);
            bytes32 pid = _create(K, Kind.American, e);
            _borrow(pid, alice, ONE, 2900e6);
            if (i == 2) {
                vm.prank(guardian);
                core.pause(pid, 1);
            }
        }
        vm.warp(ANCHOR + 4 * WEEK + 1);
        vm.expectRevert(IConfluere.InvalidState.selector);
        core.graduate(address(weth), address(usdc), Kind.American, ANCHOR + 4 * WEEK);
    }

    function test_graduation_needsFees() public {
        for (uint64 i = 1; i <= 4; ++i) {
            uint64 e = ANCHOR + i * WEEK;
            vm.warp(e - 3 days);
            bytes32 pid = _create(K, Kind.American, e);
            if (i != 3) _borrow(pid, alice, ONE, 2900e6);
        }
        vm.warp(ANCHOR + 4 * WEEK + 1);
        vm.expectRevert(IConfluere.InvalidState.selector);
        core.graduate(address(weth), address(usdc), Kind.American, ANCHOR + 4 * WEEK);
    }

    // ------------------------------------------------------------ ERC-6909

    function test_erc6909_allowanceAndOperator() public {
        bytes32 pid = _create();
        _borrow(pid, alice, ONE, 2900e6);
        vm.prank(bob);
        core.approve(eve, _c(pid), 4e17);
        vm.prank(eve);
        core.transferFrom(bob, eve, _c(pid), 4e17);
        vm.prank(eve);
        vm.expectRevert();
        core.transferFrom(bob, eve, _c(pid), 1);
        assertEq(core.balanceOf(eve, _c(pid)), 4e17);
        assertEq(core.totalSupply(_c(pid)), ONE);
        assertTrue(core.supportsInterface(0x0f632fb3)); // ERC-6909
    }
}
