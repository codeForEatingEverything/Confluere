// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Base} from "../utils/Base.sol";
import {IConfluere} from "../../src/interfaces/IConfluere.sol";
import {PoolKeyLib, Kind} from "../../src/libraries/PoolKey.sol";
import {SELL, BUY, NC_SELL, NC_BUY} from "../../src/libraries/OrderSet.sol";

contract ClearingTest is Base {
    bytes32 internal pid;

    function setUp() public override {
        super.setUp();
        pid = _create();
    }

    function test_settle_notBeforeBoundary() public {
        vm.expectRevert(IConfluere.BatchNotReady.selector);
        core.settleBatch(pid);
        _settle(pid);
        vm.expectRevert(IConfluere.BatchNotReady.selector);
        core.settleBatch(pid);
    }

    function test_singlePair_midpointPrice() public {
        _sell(alice, pid, ONE, 2850e6);
        _buy(bob, pid, ONE, 2950e6);
        _settle(pid);

        IConfluere.PoolView memory v = core.pool(pid);
        assertEq(v.lastClearingPrice, 2900e6, "P* = midpoint");
        assertEq(core.balanceOf(alice, _r(pid)), ONE, "R to borrower");
        assertEq(core.balanceOf(bob, _c(pid)), ONE, "C to lender");
        // seller: P* less 0.015% trade fee (435,000) and 5% of K - P* (5e6) into the pool's spread escrow
        assertEq(_pend(address(usdc), alice), 2900e6 - 435_000 - 5e6, "borrower receives P* net of fees");
        // escrow 2950 + 0.015% + 2 wei x ttl 10; paid 2900 + 0.015%
        assertEq(_pend(address(usdc), bob), 50e6 + 7500 + 20, "lender refunded limit - P*, fee difference, reserve");
        assertEq(v.feeEscrow, 5e6);
        assertEq(_pend(address(usdc), treasury), 2 * 435_000, "trade fee from each side");
        assertEq(v.assetBal, ONE);
        assertEq(v.filledUnits, ONE);
    }

    function test_multiOrder_partialMarginal() public {
        uint64 a = _sell(alice, pid, ONE, 2800e6);
        uint64 b = _sell(dave, pid, 2 * ONE, 2900e6);
        _sell(dave, pid, ONE, 3100e6);
        uint64 x = _buy(bob, pid, 15e17, 3000e6);
        uint64 y = _buy(carol, pid, ONE, 2850e6);
        _settle(pid);

        // a (1) and half of b fill against x (1.5); b's rest (2900) cannot meet y (2850).
        assertEq(core.pool(pid).lastClearingPrice, 2950e6);
        assertEq(core.balanceOf(alice, _r(pid)), ONE);
        assertEq(core.balanceOf(dave, _r(pid)), 5e17);
        assertEq(core.balanceOf(bob, _c(pid)), 15e17);
        assertEq(core.balanceOf(carol, _c(pid)), 0);
        (address ao,,,,,,) = core.order(pid, a);
        assertEq(ao, address(0), "filled order removed");
        (,, uint96 bUnits,,,,) = core.order(pid, b);
        assertEq(bUnits, 15e17, "marginal partially filled");
        (address xo,,,,,,) = core.order(pid, x);
        assertEq(xo, address(0));
        (address yo,,,,,,) = core.order(pid, y);
        assertEq(yo, carol, "unfilled stays");
        // every filled seller got at least its limit, every filled buyer paid at most its limit
        assertEq(_pend(address(usdc), alice), 2950e6 - 442_500 - 2.5e6, "P* net of trade fee and spread share");
        assertEq(_pend(address(usdc), dave), 1475e6 - 221_250 - 1.25e6);
    }

    function test_noCross_noFill() public {
        _sell(alice, pid, ONE, 3000e6);
        _buy(bob, pid, ONE, 2900e6);
        _settle(pid);
        assertEq(core.pool(pid).lastClearingPrice, 0);
        assertEq(core.balanceOf(alice, _r(pid)), 0);
        assertEq(core.pool(pid).settleCount, 1);
    }

    function test_oneSided_rollsOver_thenFills() public {
        _sell(alice, pid, ONE, 2850e6);
        _settle(pid);
        assertEq(core.balanceOf(alice, _r(pid)), 0);
        _buy(bob, pid, ONE, 2850e6);
        _settle(pid);
        assertEq(core.balanceOf(alice, _r(pid)), ONE);
        assertEq(core.pool(pid).lastClearingPrice, 2850e6);
    }

    function test_ttl_expiresAndRefunds() public {
        uint64 s = _order(alice, pid, SELL, ONE, 3000e6, 0, 1);
        _settle(pid); // its only batch, no counterparty
        // expired orders are skipped and removed lazily when the walk reaches them
        _buy(bob, pid, ONE, 3100e6);
        _settle(pid);
        assertEq(core.balanceOf(alice, _r(pid)), 0, "expired order did not trade");
        (address o,,,,,,) = core.order(pid, s);
        assertEq(o, address(0));
        assertEq(_pend(address(weth), alice), ONE);
    }

    function test_purge_expired() public {
        uint64 s = _order(alice, pid, SELL, ONE, 3000e6, 0, 1);
        uint64 keep = _order(dave, pid, SELL, ONE, 3000e6, 0, 5);
        _settle(pid);
        uint64[] memory ids = new uint64[](2);
        (ids[0], ids[1]) = (s, keep);
        vm.prank(eve);
        core.purge(pid, ids);
        (address o1,,,,,,) = core.order(pid, s);
        (address o2,,,,,,) = core.order(pid, keep);
        assertEq(o1, address(0));
        assertEq(o2, dave, "live order not purgeable");
    }

    function test_buyEscrow_refundOnPartialKeepsReserve() public {
        _sell(alice, pid, ONE, 2900e6);
        uint64 x = _buy(bob, pid, 2 * ONE, 2900e6);
        _settle(pid);
        (,, uint96 units,, uint128 esc, uint32 deadline,) = core.order(pid, x);
        assertEq(units, ONE);
        uint256 left = deadline - core.pool(pid).settleCount;
        assertEq(esc, 2900e6 + 435_000 + 2 * left, "remaining escrow = remainder at limit + fee + reserve");
    }

    // ------------------------------------------------------------ non-competitive orders and band

    function test_nc_needsPriorPrice() public {
        _sell(alice, pid, 2 * ONE, 2900e6);
        _buy(bob, pid, 2 * ONE, 2900e6);
        _order(carol, pid, NC_BUY, 0, 0, 10_000e6, 10);
        _settle(pid);
        assertEq(core.balanceOf(carol, _c(pid)), 0, "first price only sets the band base");
        assertEq(core.pool(pid).bandBase, 2900e6);
    }

    function test_nc_fillsAgainstLeftover_cappedAt50pct() public {
        _seedPrice(2900e6);
        // competitive: 2 units cross at 2900; one extra seller willing at 2850 is left over
        _sell(alice, pid, 2 * ONE, 2900e6);
        _buy(bob, pid, 2 * ONE, 2900e6);
        _sell(dave, pid, 5 * ONE, 2850e6);
        _order(carol, pid, NC_BUY, 0, 0, 100_000e6, 10);
        _settle(pid);

        IConfluere.PoolView memory v = core.pool(pid);
        uint256 p = v.lastClearingPrice;
        assertEq(p, 2875e6, "marginal pair 2850/2900");
        // q = 2 (dave 2 vs bob 2 since dave's 2850 is cheaper); NC cap = 1
        assertEq(core.balanceOf(carol, _c(pid)), ONE, "nc capped at half of competitive volume");
        assertEq(core.balanceOf(dave, _r(pid)), 3 * ONE, "leftover seller served the nc buyer");
    }

    /// NC buy demand enters the price ahead of competitive buys (capped at 50% of q0), so it takes the competitive
    /// sells first and uses up the cap; the NC sell has no room left this batch.
    function test_nc_buyPricedInBeforeNcSell() public {
        _seedPrice(2900e6);
        _sell(alice, pid, 2 * ONE, 2900e6);
        _buy(bob, pid, 2 * ONE, 2900e6);
        _order(dave, pid, NC_SELL, ONE, 0, 0, 10);
        _order(carol, pid, NC_BUY, 0, 0, 100_000e6, 10);
        _settle(pid);
        assertEq(core.pool(pid).lastClearingPrice, 2900e6);
        assertEq(core.balanceOf(alice, _r(pid)), 2 * ONE);
        assertEq(core.balanceOf(carol, _c(pid)), ONE);
        assertEq(core.balanceOf(bob, _c(pid)), ONE);
        assertEq(core.balanceOf(dave, _r(pid)), 0);
    }

    function test_band_outOfBand_rollsNc_andBreaker() public {
        _seedPrice(2900e6);
        _order(carol, pid, NC_BUY, 0, 0, 100_000e6, 50);
        _order(dave, pid, NC_SELL, 10 * ONE, 0, 0, 50);
        // band 8%: 2000 is far outside
        for (uint256 i; i < 3; ++i) {
            _sell(alice, pid, ONE, 2000e6);
            _buy(bob, pid, ONE, 2000e6);
            _settle(pid);
            assertEq(core.balanceOf(carol, _c(pid)), 0, "nc sits out");
        }
        IConfluere.PoolView memory v = core.pool(pid);
        assertEq(v.bandFailures, 3);
        bytes32 m = PoolKeyLib.marketId(address(weth), address(usdc), Kind.American);
        assertTrue(core.marketStats(m, E1).bad, "breaker marks the expiry");
        // next competitive price resets the base; nc still sits out this batch
        _sell(alice, pid, ONE, 2000e6);
        _buy(bob, pid, ONE, 2000e6);
        _settle(pid);
        assertEq(core.pool(pid).bandBase, 2000e6);
        assertEq(core.balanceOf(carol, _c(pid)), 0);
        // and the batch after that trades nc again
        _sell(alice, pid, 2 * ONE, 2000e6);
        _buy(bob, pid, 2 * ONE, 2000e6);
        _settle(pid);
        assertEq(core.balanceOf(carol, _c(pid)), ONE);
    }

    function test_band_widensAfterFailure() public {
        _seedPrice(2900e6);
        _order(carol, pid, NC_BUY, 0, 0, 100_000e6, 50);
        _order(dave, pid, NC_SELL, 10 * ONE, 0, 0, 50);
        // 2900 * (1 - 0.10) = 2610: outside 8%, inside 12% after one failure
        _cross(2610e6);
        assertEq(core.balanceOf(carol, _c(pid)), 0);
        assertEq(core.pool(pid).bandFailures, 1);
        _cross(2610e6);
        assertEq(core.balanceOf(carol, _c(pid)), ONE, "widened band admits nc");
        assertEq(core.pool(pid).bandFailures, 0);
    }

    function test_volumeAndStrikeStats() public {
        _sell(alice, pid, ONE, 2900e6);
        _buy(bob, pid, ONE, 2900e6);
        _settle(pid);
        bytes32 m = PoolKeyLib.marketId(address(weth), address(usdc), Kind.American);
        IConfluere.MarketStats memory st = core.marketStats(m, E1);
        assertEq(st.volume, 2900e6);
        assertEq(st.minStrike, K);
        assertEq(st.maxStrike, K);
    }

    function _seedPrice(uint256 p) internal {
        _sell(eve, pid, ONE, p);
        _buy(eve, pid, ONE, p);
        _settle(pid);
    }

    function _cross(uint256 p) internal {
        _sell(alice, pid, 2 * ONE, p);
        _buy(bob, pid, 2 * ONE, p);
        _settle(pid);
    }
}
