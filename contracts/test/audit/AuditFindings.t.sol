// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Base} from "../utils/Base.sol";
import {Confluere} from "../../src/Confluere.sol";
import {IConfluere} from "../../src/interfaces/IConfluere.sol";
import {Kind} from "../../src/libraries/PoolKey.sol";
import {SELL, BUY, NC_SELL, NC_BUY, BID} from "../../src/libraries/OrderSet.sol";

/// @notice Regression tests for the 2026-10-11 internal audit. Each test replays the attack and asserts it fails.
contract AuditFindingsTest is Base {
    bytes32 internal pid;
    address internal mallory = makeAddr("mallory");

    function _config() internal view override returns (Confluere.Config memory c) {
        c = super._config();
        c.chains[0].minNotionalQuotes = new address[](1);
        c.chains[0].minNotionals = new uint256[](1);
        c.chains[0].minNotionalQuotes[0] = address(usdc);
        c.chains[0].minNotionals[0] = 100e6; // 100 USDC valued at K
    }

    function setUp() public override {
        super.setUp();
        pid = _create();
        weth.mint(mallory, 1000 * ONE);
        usdc.mint(mallory, 10_000_000e6);
        vm.startPrank(mallory);
        weth.approve(address(core), type(uint256).max);
        usdc.approve(address(core), type(uint256).max);
        vm.stopPrank();
    }

    function _seedBase(uint256 price) internal {
        _sell(eve, pid, ONE, price);
        _buy(eve, pid, ONE, price);
        _settle(pid);
    }

    // ------------------------------------------------------------ H-1: price-takers never pay P* >= K

    /// Mallory wash-trades P* to 3100 > K = 3000 (inside the 8% band around 2900) and leaves a sell at that
    /// price for non-competitive buyers. Before the fix a vault-style buyer paid 3100 for a claim worth <= 3000.
    function test_H1_washTradedPriceAboveK_doesNotFillNcBuyers() public {
        _seedBase(2900e6);
        _order(carol, pid, NC_BUY, 0, 0, 10_000e6, 5);
        _sell(mallory, pid, 2 * ONE, 3100e6);
        _buy(mallory, pid, ONE, 3100e6);
        _settle(pid);
        assertEq(core.pool(pid).lastClearingPrice, 3100e6, "wash price inside the band");
        assertEq(core.balanceOf(carol, _c(pid)), 0, "non-competitive buyer did not pay >= K");
    }

    function test_H1_protectiveCeilingOnNcBuy() public {
        _seedBase(2900e6);
        _order(carol, pid, NC_BUY, 0, 2900e6, 10_000e6, 5); // ceiling 2900
        _order(bob, pid, NC_BUY, 0, 2960e6, 10_000e6, 5); // ceiling 2960
        _sell(alice, pid, 4 * ONE, 2950e6);
        _buy(dave, pid, 2 * ONE, 2950e6);
        _settle(pid); // P* = 2950
        assertEq(core.balanceOf(carol, _c(pid)), 0, "P* above carol's ceiling");
        assertGt(core.balanceOf(bob, _c(pid)), 0, "P* inside bob's ceiling");
    }

    function test_H1_protectiveFloorOnNcSell() public {
        _seedBase(2900e6);
        _order(carol, pid, NC_SELL, ONE, 2950e6, 0, 5); // floor 2950
        _order(dave, pid, NC_SELL, ONE, 2850e6, 0, 5); // floor 2850
        _sell(alice, pid, 2 * ONE, 2900e6);
        _buy(bob, pid, 4 * ONE, 2900e6);
        _settle(pid); // P* = 2900
        assertEq(core.balanceOf(carol, _r(pid)), 0, "P* below carol's floor");
        assertEq(core.balanceOf(dave, _r(pid)), ONE, "P* above dave's floor");
    }

    // ------------------------------------------------------------ H-2: dust cannot squat books or queues

    function test_H2_minNotional_rejectsDust() public {
        uint64 h = core.findHint(pid, SELL, 2900e6);
        vm.startPrank(mallory);
        vm.expectRevert(IConfluere.InvalidParams.selector);
        core.placeOrder(pid, _params(SELL, 1e16, 2900e6, 0, 1, h)); // 0.01 ETH * K = 30 USDC < 100
        vm.expectRevert(IConfluere.InvalidParams.selector);
        core.placeOrder(pid, _params(NC_BUY, 0, 0, 50e6, 1, 0));
        vm.expectRevert(IConfluere.InvalidParams.selector);
        core.placeOrder(pid, _params(NC_SELL, 1, 0, 0, 1000, 0));
        core.placeOrder(pid, _params(SELL, 4e16, 2900e6, 0, 1, h)); // 120 USDC: fine
        vm.stopPrank();
    }

    /// Before the fix 8 tiny NC buys with ttl 1000 blocked the queue for 1000 batches.
    function test_H2_ncQueue_largerOrderEvictsSmallest() public {
        for (uint256 i; i < 8; ++i) {
            _order(mallory, pid, NC_BUY, 0, 0, 100e6 + i, 1000);
        }
        // equal to the smallest: still full
        vm.prank(carol);
        vm.expectRevert(IConfluere.BookFull.selector);
        core.placeOrder(pid, _params(NC_BUY, 0, 0, 100e6, 5, 0));
        // larger: evicts mallory's smallest (refunded)
        _order(carol, pid, NC_BUY, 0, 0, 5000e6, 5);
        assertEq(_pend(address(usdc), mallory), 100e6);
        (, uint32 n) = core.bookHead(pid, NC_BUY);
        assertEq(n, 8);
    }

    function test_H2_ncQueue_expiredEvictedFirst() public {
        for (uint256 i; i < 8; ++i) {
            _order(mallory, pid, NC_SELL, ONE, 0, 0, i == 3 ? 1 : 1000);
        }
        _settle(pid); // the ttl-1 order expires
        _order(carol, pid, NC_SELL, ONE, 0, 0, 5); // same size, but an expired slot frees up
        assertEq(_pend(address(weth), mallory), ONE);
    }

    /// Dust at the best price used to lock honest orders out of a full book.
    function test_H2_sortedBook_samePriceLargerSizeEvicts() public {
        for (uint256 i; i < 8; ++i) {
            _sell(mallory, pid, 4e16, 2000e6);
        }
        uint64 h = core.findHint(pid, SELL, 2000e6);
        vm.prank(alice);
        vm.expectRevert(IConfluere.BookFull.selector);
        core.placeOrder(pid, _params(SELL, 4e16, 2000e6, 0, 5, h)); // same price, same size
        _sell(alice, pid, ONE, 2000e6); // same price, larger: evicts the tail
        assertEq(_pend(address(weth), mallory), 4e16);
    }

    function test_H2_sortedBook_expiredTailEvicted() public {
        for (uint256 i; i < 8; ++i) {
            _order(mallory, pid, SELL, ONE, 2000e6 + i * 10e6, 0, i == 7 ? 1 : 1000);
        }
        _buy(bob, pid, 4e16, 1000e6); // keeps the batch from crossing
        _settle(pid); // the tail (worst price, ttl 1) expires but is not at the head
        _sell(alice, pid, ONE, 2900e6); // worse than every live sell, but the tail is expired
        (address o,,,,,,) = core.order(pid, 8);
        assertEq(o, address(0), "expired tail evicted");
    }

    function test_H2_bidBook_samePriceLargerSizeEvicts() public {
        _sell(alice, pid, 4 * ONE, 2900e6);
        _buy(bob, pid, 4 * ONE, 2900e6);
        _settle(pid);
        vm.warp(E1);
        core.mature(pid);
        for (uint256 i; i < 4; ++i) {
            uint64 h = core.findHint(pid, BID, 1e6);
            vm.prank(mallory);
            core.bid(pid, 4e16, 1e6, h);
        }
        uint64 h2 = core.findHint(pid, BID, 1e6);
        vm.prank(eve);
        core.bid(pid, uint96(ONE), 1e6, h2);
        assertGt(_pend(address(usdc), mallory), 0, "dust bid evicted by a larger bid at the same surplus");
    }
}
