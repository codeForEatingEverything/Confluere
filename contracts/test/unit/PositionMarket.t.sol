// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Base} from "../utils/Base.sol";
import {Kind, Status} from "../../src/libraries/PoolKey.sol";
import {PositionMarket} from "../../src/periphery/PositionMarket.sol";

contract PositionMarketTest is Base {
    PositionMarket internal mkt;
    bytes32 internal pid;

    // alice holds 1 R (borrowed 1 WETH at 2900), bob holds 1 C (lent).
    function setUp() public override {
        super.setUp();
        mkt = new PositionMarket(core);
        pid = _create();
        _sell(alice, pid, ONE, 2900e6);
        _buy(bob, pid, ONE, 2900e6);
        _settle(pid);
        address[5] memory actors = [alice, dave, bob, carol, eve];
        for (uint256 i; i < actors.length; ++i) {
            vm.startPrank(actors[i]);
            core.setOperator(address(mkt), true);
            usdc.approve(address(mkt), type(uint256).max);
            vm.stopPrank();
        }
    }

    // ------------------------------------------------------------ asks

    function test_list_fill_partial_then_full() public {
        vm.prank(alice);
        uint256 id = mkt.list(pid, true, uint96(ONE), 100e6, 0);
        assertEq(core.balanceOf(address(mkt), _r(pid)), ONE);
        assertEq(mkt.askCount(_r(pid)), 1);

        uint256 a0 = usdc.balanceOf(alice);
        vm.prank(carol);
        uint256 paid = mkt.fill(id, uint96(ONE / 4), 25e6);
        assertEq(paid, 25e6);
        assertEq(usdc.balanceOf(alice) - a0, 25e6);
        assertEq(core.balanceOf(carol, _r(pid)), ONE / 4);
        assertEq(mkt.offer(id).units, 3 * ONE / 4);

        vm.prank(carol);
        mkt.fill(id, uint96(3 * ONE / 4), type(uint256).max);
        assertEq(core.balanceOf(carol, _r(pid)), ONE);
        assertEq(mkt.askCount(_r(pid)), 0);
        assertEq(mkt.offer(id).maker, address(0));
        // carol now owns the buy-back right and can repay it in the core
        vm.prank(carol);
        core.repay(pid, uint96(ONE));
        assertEq(core.balanceOf(carol, _r(pid)), 0);
    }

    function test_fill_roundsUpAgainstBuyer() public {
        vm.prank(alice);
        uint256 id = mkt.list(pid, true, uint96(ONE), 3, 0); // 3 base units per whole asset
        vm.prank(carol);
        uint256 paid = mkt.fill(id, 1, type(uint256).max); // 1 wei of asset
        assertEq(paid, 1);
        assertEq(mkt.quoteFill(id, 1), 1);
    }

    function test_fill_slippage() public {
        vm.prank(alice);
        uint256 id = mkt.list(pid, true, uint96(ONE), 100e6, 0);
        vm.prank(carol);
        vm.expectRevert(PositionMarket.Slippage.selector);
        mkt.fill(id, uint96(ONE), 100e6 - 1);
    }

    function test_cancel_returnsUnits_onlyMaker() public {
        vm.prank(bob);
        uint256 id = mkt.list(pid, false, uint96(ONE), 2950e6, 0);
        vm.prank(carol);
        vm.expectRevert(PositionMarket.NotMaker.selector);
        mkt.cancel(id);
        vm.prank(bob);
        mkt.cancel(id);
        assertEq(core.balanceOf(bob, _c(pid)), ONE);
        vm.prank(bob);
        vm.expectRevert(PositionMarket.NoOffer.selector);
        mkt.cancel(id);
    }

    function test_expiredListing_cannotBeFilled_butCancels() public {
        vm.prank(bob);
        uint256 id = mkt.list(pid, false, uint96(ONE), 2950e6, uint64(block.timestamp + 60));
        vm.warp(block.timestamp + 60);
        vm.prank(carol);
        vm.expectRevert(PositionMarket.Expired.selector);
        mkt.fill(id, 1, type(uint256).max);
        (uint256[] memory ids,) = mkt.best(_c(pid), false, 5);
        assertEq(ids.length, 0);
        vm.prank(bob);
        mkt.cancel(id);
    }

    function test_list_rejects() public {
        vm.startPrank(alice);
        vm.expectRevert(PositionMarket.InvalidParams.selector);
        mkt.list(pid, true, 0, 1, 0);
        vm.expectRevert(PositionMarket.InvalidParams.selector);
        mkt.list(pid, true, 1, 0, 0);
        vm.expectRevert(PositionMarket.InvalidParams.selector);
        mkt.list(pid, true, 1, uint256(type(uint128).max) + 1, 0);
        vm.expectRevert(PositionMarket.InvalidParams.selector);
        mkt.list(pid, true, 1, 1, uint64(block.timestamp));
        vm.expectRevert(PositionMarket.InvalidPool.selector);
        mkt.list(bytes32(uint256(2)), true, 1, 1, 0);
        vm.expectRevert(PositionMarket.InvalidPool.selector);
        mkt.list(bytes32(uint256(pid) | 1), true, 1, 1, 0);
        vm.stopPrank();
    }

    function test_list_lockedOrMissingUnitsReverts() public {
        vm.prank(carol); // holds nothing
        vm.expectRevert();
        mkt.list(pid, true, 1, 1, 0);
    }

    // ------------------------------------------------------------ bids

    function test_bid_hit_partial_then_full_refundsDust() public {
        // 3 units at 1 base unit per whole asset → escrow ceil(3/1e18) = 1
        vm.prank(carol);
        uint256 id = mkt.bid(pid, false, 3, 1, 0);
        assertEq(mkt.offer(id).escrow, 1);
        uint256 c0 = usdc.balanceOf(carol);
        vm.prank(bob);
        uint256 got = mkt.hit(id, 2, 0);
        assertEq(got, 0);
        vm.prank(bob);
        mkt.hit(id, 1, 0);
        assertEq(core.balanceOf(carol, _c(pid)), 3);
        assertEq(usdc.balanceOf(carol), c0 + 1, "dust back to maker");
        assertEq(usdc.balanceOf(address(mkt)), 0);
        assertEq(mkt.bidCount(_c(pid)), 0);
    }

    function test_bid_hit_paysSeller() public {
        vm.prank(carol);
        uint256 id = mkt.bid(pid, false, uint96(ONE), 2950e6, 0);
        assertEq(usdc.balanceOf(address(mkt)), 2950e6);
        uint256 b0 = usdc.balanceOf(bob);
        vm.prank(bob);
        vm.expectRevert(PositionMarket.Slippage.selector);
        mkt.hit(id, uint96(ONE), 2950e6 + 1);
        vm.prank(bob);
        uint256 got = mkt.hit(id, uint96(ONE / 2), 1475e6);
        assertEq(got, 1475e6);
        assertEq(usdc.balanceOf(bob) - b0, 1475e6);
        assertEq(core.balanceOf(carol, _c(pid)), ONE / 2);
        assertEq(mkt.offer(id).escrow, 1475e6);
        vm.prank(carol);
        mkt.cancelBid(id);
        assertEq(usdc.balanceOf(address(mkt)), 0);
    }

    function test_cancelBid_wrongKind() public {
        vm.prank(bob);
        uint256 id = mkt.list(pid, false, uint96(ONE), 1, 0);
        vm.prank(bob);
        vm.expectRevert(PositionMarket.NoOffer.selector);
        mkt.cancelBid(id);
        vm.prank(carol);
        vm.expectRevert(PositionMarket.NoOffer.selector);
        mkt.hit(id, 1, 0);
    }

    function test_best_sorted() public {
        vm.startPrank(carol);
        mkt.bid(pid, true, 10, 5e6, 0);
        uint256 top = mkt.bid(pid, true, 10, 9e6, 0);
        mkt.bid(pid, true, 10, 7e6, 0);
        vm.stopPrank();
        (uint256[] memory ids, PositionMarket.Offer[] memory os) = mkt.best(_r(pid), true, 2);
        assertEq(ids.length, 2);
        assertEq(ids[0], top);
        assertEq(os[0].price, 9e6);
        assertEq(os[1].price, 7e6);
        (ids,) = mkt.page(_r(pid), true, 1, 10);
        assertEq(ids.length, 2);
        (ids,) = mkt.page(_r(pid), true, 0, type(uint256).max);
        assertEq(ids.length, 3);
        (ids,) = mkt.page(_r(pid), true, 5, 10);
        assertEq(ids.length, 0);
    }

    // ------------------------------------------------------------ lifecycle gates

    function test_R_stopsAfterWindow_C_tradesUntilClosed() public {
        vm.prank(alice);
        uint256 rAsk = mkt.list(pid, true, uint96(ONE), 1e6, 0);
        vm.prank(bob);
        uint256 cAsk = mkt.list(pid, false, uint96(ONE / 2), 2900e6, 0);

        vm.warp(E1);
        assertTrue(mkt.tradable(pid, true), "unmatured past expiry: window not started yet");
        core.mature(pid);
        assertTrue(mkt.tradable(pid, true), "inside window");
        vm.roll(block.number + WINDOW);
        assertFalse(mkt.tradable(pid, true), "window over");
        assertTrue(mkt.tradable(pid, false));
        vm.prank(carol);
        vm.expectRevert(PositionMarket.NotTradable.selector);
        mkt.fill(rAsk, 1, type(uint256).max);
        vm.prank(alice);
        vm.expectRevert(PositionMarket.NotTradable.selector);
        mkt.bid(pid, true, 1, 1, 0);

        core.closeWindow(pid, 10);
        assertEq(uint8(core.pool(pid).status), uint8(Status.Closed));
        assertFalse(mkt.tradable(pid, false));
        vm.prank(carol);
        vm.expectRevert(PositionMarket.NotTradable.selector);
        mkt.fill(cAsk, 1, type(uint256).max);

        // escrow always comes back; the C can then be claimed
        vm.prank(alice);
        mkt.cancel(rAsk);
        vm.prank(bob);
        mkt.cancel(cAsk);
        assertEq(core.balanceOf(bob, _c(pid)), ONE);
        vm.prank(bob);
        core.claim(pid);
    }

    function test_R_europeanBeforeExpiry_tradable() public {
        bytes32 eu = _create(K, Kind.European, E1);
        assertTrue(mkt.tradable(eu, true));
        assertTrue(mkt.tradable(eu, false));
        assertFalse(mkt.tradable(bytes32(uint256(4)), false));
    }

    function test_R_otherPoolOfExpiryStartsWindow() public {
        bytes32 other = _create(2800e6, Kind.American, E1);
        vm.warp(E1);
        core.mature(other); // starts the shared window of E1
        vm.roll(block.number + WINDOW);
        assertFalse(mkt.tradable(pid, true), "shared window over even though pid never matured");
    }

    // ------------------------------------------------------------ fuzz: rounding and escrow conservation

    function testFuzz_bidEscrowConservation(uint96 units, uint128 price, uint96[4] memory hits) public {
        units = uint96(bound(units, 1, 100 * ONE));
        price = uint128(bound(price, 1, 1e12));
        uint256 escrow = (uint256(units) * price + ONE - 1) / ONE;
        vm.assume(escrow <= 5_000_000e6);
        // carol bids; eve gets enough C from a second trade and sells it into the bid in up to four hits
        vm.prank(carol);
        uint256 id = mkt.bid(pid, false, units, price, 0);
        _giveC(eve, units);
        uint256 paidOut;
        uint96 left = units;
        for (uint256 i; i < hits.length && left != 0; ++i) {
            uint96 u = uint96(bound(hits[i], 1, left));
            if (i == hits.length - 1) u = left;
            vm.prank(eve);
            paidOut += mkt.hit(id, u, 0);
            assertLe(paidOut, escrow, "never pays out more than escrowed");
            left -= u;
            if (left != 0) {
                assertGe(mkt.offer(id).escrow, (uint256(left) * price + ONE - 1) / ONE, "escrow covers the rest");
                assertEq(usdc.balanceOf(address(mkt)), mkt.offer(id).escrow, "market holds exactly the escrow");
            }
        }
        if (left == 0) {
            assertEq(usdc.balanceOf(address(mkt)), 0, "fully hit: nothing stuck");
        } else {
            vm.prank(carol);
            mkt.cancelBid(id);
            assertEq(usdc.balanceOf(address(mkt)), 0);
        }
        assertEq(core.balanceOf(carol, _c(pid)), units - left);
    }

    function testFuzz_askConservation(uint96 units, uint128 price, uint96 a, uint96 b) public {
        units = uint96(bound(units, 1, ONE));
        price = uint128(bound(price, 1, 1e12));
        vm.prank(bob);
        uint256 id = mkt.list(pid, false, units, price, 0);
        a = uint96(bound(a, 1, units));
        uint256 b0 = usdc.balanceOf(bob);
        vm.prank(carol);
        uint256 p1 = mkt.fill(id, a, type(uint256).max);
        assertGe(p1 * ONE, uint256(a) * price, "buyer pays at least the exact amount");
        assertLt((p1 - 1) * ONE, uint256(a) * price, "and at most one base unit more");
        uint256 rest = units - a;
        assertEq(core.balanceOf(address(mkt), _c(pid)), rest);
        if (rest != 0) {
            b = uint96(bound(b, 1, rest));
            vm.prank(dave);
            uint256 p2 = mkt.fill(id, b, type(uint256).max);
            p1 += p2;
            rest -= b;
            if (rest != 0) {
                vm.prank(bob);
                mkt.cancel(id);
            }
        }
        assertEq(usdc.balanceOf(bob) - b0, p1, "seller receives every payment");
        assertEq(core.balanceOf(address(mkt), _c(pid)), 0);
        assertEq(core.balanceOf(bob, _c(pid)) + core.balanceOf(carol, _c(pid)) + core.balanceOf(dave, _c(pid)), ONE);
    }

    /// @dev Mint `units` of C to `who` by lending into a fresh batch.
    function _giveC(address who, uint96 units) internal {
        weth.mint(dave, units);
        _sell(dave, pid, units, 1e6);
        _buy(who, pid, units, 1e6);
        _settle(pid);
        assertGe(core.balanceOf(who, _c(pid)), units);
    }
}
