// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Base} from "../utils/Base.sol";
import {Confluere} from "../../src/Confluere.sol";
import {IConfluere} from "../../src/interfaces/IConfluere.sol";
import {PoolKeyLib, Kind} from "../../src/libraries/PoolKey.sol";
import {SELL, BUY, NC_BUY} from "../../src/libraries/OrderSet.sol";
import {SeatRegistry} from "../../src/periphery/SeatRegistry.sol";
import {MockFlashBorrower} from "../../src/mocks/MockFlashBorrower.sol";

contract SeatsTest is Base {
    SeatRegistry internal reg;
    address internal protocolMs = makeAddr("protocol");
    bytes32 internal pid;
    bytes32 internal market;

    uint256 internal constant OBLIGATION = 1000e6; // per-batch competitive notional at K
    uint128 internal constant PRICE = 10_000e6;
    uint128 internal constant DEPOSIT = 500e6;

    function setUp() public override {
        super.setUp();
        address[] memory qs = new address[](1);
        uint256[] memory obs = new uint256[](1);
        (qs[0], obs[0]) = (address(usdc), OBLIGATION);
        reg = new SeatRegistry(address(this), protocolMs, 3500, 1500, qs, obs); // 35% of fees, 15%/yr tax

        // a core whose treasury is the registry
        Confluere.Config memory c = _config();
        c.chains[0].treasury = address(reg);
        core = new Confluere(c);
        reg.bind(core);
        address[5] memory actors = [alice, dave, bob, carol, eve];
        for (uint256 i; i < actors.length; ++i) {
            vm.startPrank(actors[i]);
            weth.approve(address(core), type(uint256).max);
            usdc.approve(address(core), type(uint256).max);
            usdc.approve(address(reg), type(uint256).max);
            weth.approve(address(reg), type(uint256).max);
            vm.stopPrank();
        }
        weth.approve(address(core), type(uint256).max);
        usdc.approve(address(core), type(uint256).max);
        pid = _create();
        market = PoolKeyLib.marketId(address(weth), address(usdc), Kind.American);
    }

    function _buy(address who, uint128 price, uint128 deposit) internal {
        vm.prank(who);
        reg.buy(address(weth), address(usdc), Kind.American, price, deposit, type(uint256).max);
    }

    function _holder() internal view returns (address h) {
        (h,,,,,,) = reg.seats(market);
    }

    /// Everything the registry owes is backed by what it holds plus what the core owes it.
    function _assertSolvent() internal view {
        (address h,, uint128 dep, uint128 bond,,,) = reg.seats(market);
        uint256 owed = reg.claimable(address(usdc), alice) + reg.claimable(address(usdc), bob)
            + reg.claimable(address(usdc), protocolMs) + dep + bond;
        h;
        uint256 have = usdc.balanceOf(address(reg)) + core.pending(address(usdc), address(reg));
        assertGe(have, owed, "registry solvent");
    }

    function test_buyVacantSeat_postsDepositAndBond() public {
        uint256 u0 = usdc.balanceOf(alice);
        _buy(alice, PRICE, DEPOSIT);
        assertEq(_holder(), alice);
        assertEq(u0 - usdc.balanceOf(alice), DEPOSIT + OBLIGATION / 10, "deposit + 10% bond, no price while vacant");
        _assertSolvent();
    }

    function test_taxAccrues_andForecloses() public {
        _buy(alice, PRICE, DEPOSIT);
        vm.warp(block.timestamp + 30 days);
        (, uint256 owed) = reg.seatOf(address(weth), address(usdc), Kind.American);
        assertApproxEqAbs(owed, uint256(PRICE) * 1500 * 30 days / (365 days * 10_000), 1);
        // 15%/yr of 10,000 = 1,500/yr: a 500 deposit lasts four months
        vm.warp(block.timestamp + 120 days);
        vm.prank(alice);
        reg.topUp(address(weth), address(usdc), Kind.American, 1); // triggers accrual -> foreclosure
        assertEq(_holder(), address(0), "foreclosed");
        assertEq(reg.claimable(address(usdc), protocolMs), DEPOSIT, "whole deposit paid as tax");
        assertEq(reg.claimable(address(usdc), alice), OBLIGATION / 10, "bond returned");
        _assertSolvent();
    }

    function test_buyout_paysHolder_andCooldownBlocksLowering() public {
        _buy(alice, PRICE, DEPOSIT);
        vm.warp(block.timestamp + 1 days);
        _buy(bob, 12_000e6, DEPOSIT);
        assertEq(_holder(), bob);
        uint256 tax = uint256(PRICE) * 1500 * 1 days / (365 days * 10_000);
        assertEq(reg.claimable(address(usdc), alice), PRICE + DEPOSIT - tax + OBLIGATION / 10, "price + deposit + bond");

        vm.prank(bob);
        vm.expectRevert(SeatRegistry.Cooldown.selector);
        reg.setPrice(address(weth), address(usdc), Kind.American, 11_000e6);
        vm.prank(bob);
        reg.setPrice(address(weth), address(usdc), Kind.American, 13_000e6); // raising is always allowed
        vm.warp(block.timestamp + 7 days);
        vm.prank(bob);
        reg.setPrice(address(weth), address(usdc), Kind.American, 5000e6);

        uint256 a0 = usdc.balanceOf(alice);
        vm.prank(alice);
        reg.withdraw(address(usdc));
        assertEq(usdc.balanceOf(alice) - a0, PRICE + DEPOSIT - tax + OBLIGATION / 10);
        _assertSolvent();
    }

    function test_feeSplit_seatGets35pct() public {
        _buy(alice, PRICE, DEPOSIT);
        _sell(dave, pid, ONE, 2900e6);
        _buy(bob, pid, ONE, 2900e6);
        _settle(pid);
        vm.prank(dave);
        core.repay(pid, uint96(ONE)); // no fee on repay; the spread share waits in the escrow until close
        assertEq(core.marketFees(market), 2 * 435_000, "trade fees, 0.015% each side");
        reg.split(address(weth), address(usdc), Kind.American);
        assertEq(reg.claimable(address(usdc), alice), 304_500, "35% to the seat");
        uint256 protocolBefore = reg.claimable(address(usdc), protocolMs);
        reg.split(address(weth), address(usdc), Kind.American); // idempotent
        assertEq(reg.claimable(address(usdc), protocolMs), protocolBefore);

        uint256 a0 = usdc.balanceOf(alice);
        vm.prank(alice);
        reg.withdraw(address(usdc)); // pulls the fees out of the core
        assertEq(usdc.balanceOf(alice) - a0, 304_500);
        _assertSolvent();
    }

    function test_feesBeforeBuyoutGoToTheHolderThen() public {
        _buy(alice, PRICE, DEPOSIT);
        _sell(dave, pid, ONE, 2900e6);
        _buy(carol, pid, ONE, 2900e6);
        _settle(pid);
        vm.prank(dave);
        core.repay(pid, uint96(ONE));
        _buy(bob, PRICE, DEPOSIT); // buyout splits first: alice keeps her tenure's share
        assertGe(reg.claimable(address(usdc), alice), 3.5e6 + PRICE);
        _assertSolvent();
    }

    function test_flashFeesGoToProtocol() public {
        _sell(dave, pid, ONE, 2900e6);
        _buy(bob, pid, ONE, 2900e6);
        _settle(pid);
        MockFlashBorrower fb = new MockFlashBorrower();
        usdc.mint(address(fb), 1e6);
        core.flashLoan(fb, address(usdc), 1000e6, "");
        reg.splitFlash(address(usdc));
        assertEq(reg.claimable(address(usdc), protocolMs), 500_000);
        _assertSolvent();
    }

    function _post(address who, uint256 units, uint256 limit) internal {
        uint64 h = core.findHint(pid, BUY, uint96(limit));
        vm.prank(who);
        reg.postOrder(pid, _params(BUY, units, limit, 0, 1, h));
    }

    function test_obligation_metEveryBatch_noSlash() public {
        _buy(alice, PRICE, DEPOSIT);
        for (uint256 i; i < 3; ++i) {
            vm.warp(core.nextBatchAt(pid));
            core.settleBatch(pid);
            _post(alice, ONE, 2800e6); // 3000 USDC notional at K >= 1000 obligation
        }
        vm.expectRevert(SeatRegistry.NotMissed.selector);
        reg.slash(pid);
        assertEq(_holder(), alice);
    }

    function test_obligation_missedBatch_slashed() public {
        _buy(alice, PRICE, DEPOSIT);
        vm.warp(core.nextBatchAt(pid));
        core.settleBatch(pid);
        _post(alice, ONE, 2800e6);
        // skip the next batch entirely
        vm.warp(core.nextBatchAt(pid) + BATCH);
        vm.prank(eve);
        reg.slash(pid);
        assertEq(_holder(), address(0), "seat forfeited");
        uint256 bond = OBLIGATION / 10;
        assertEq(reg.claimable(address(usdc), protocolMs) >= bond / 5, true, "20% of the bond to the protocol");
        assertGe(reg.claimable(address(usdc), alice), bond - bond / 5, "rest of the bond back");
        _assertSolvent();
    }

    /// With a 6-hour long-tail pool as evidence, missing a 30-minute base batch is not a miss; a whole 6-hour batch is.
    function test_slashUsesTheEvidencePoolsBatchLength() public {
        bytes32 slow =
            core.createPoolWithOptions(_key(3100e6, Kind.American, E1), 1000, 1500, IConfluere.PoolOptions(1, 0, 0, 0));
        _buy(alice, PRICE, DEPOSIT);
        _post(alice, ONE, 2800e6);
        vm.warp(block.timestamp + 2 * BATCH); // two base batches without quoting
        vm.expectRevert(SeatRegistry.NotMissed.selector);
        reg.slash(slow); // the 6 h batch after the last quote is not over yet
        vm.warp(core.nextBatchAt(slow) + 6 hours);
        reg.slash(slow);
        assertEq(_holder(), address(0));
    }

    function test_postOrder_rules() public {
        _buy(alice, PRICE, DEPOSIT);
        uint64 h = core.findHint(pid, BUY, 2800e6);
        vm.prank(bob);
        vm.expectRevert(SeatRegistry.NotHolder.selector);
        reg.postOrder(pid, _params(BUY, ONE, 2800e6, 0, 1, h));
        vm.prank(alice);
        vm.expectRevert(SeatRegistry.InvalidParams.selector);
        reg.postOrder(pid, _params(BUY, 1e17, 2800e6, 0, 1, h)); // 300 USDC < 1000 obligation
        vm.prank(alice);
        vm.expectRevert(SeatRegistry.InvalidParams.selector);
        reg.postOrder(pid, _params(NC_BUY, 0, 0, 5000e6, 1, 0)); // non-competitive does not count
        // the order belongs to the holder in the core
        _post(alice, ONE, 2800e6);
        (uint64 head,) = core.bookHead(pid, BUY);
        (address owner,,,,,,) = core.order(pid, head);
        assertEq(owner, alice);
    }

    /// Posting to meet the obligation and cancelling right away must not work.
    function test_seatOrderCannotBeCancelledWhileLive() public {
        _buy(alice, PRICE, DEPOSIT);
        _post(alice, ONE, 2800e6);
        (uint64 id,) = core.bookHead(pid, BUY);
        vm.prank(alice);
        vm.expectRevert(IConfluere.Locked.selector);
        core.cancelOrder(pid, id);
        vm.warp(core.nextBatchAt(pid));
        core.settleBatch(pid); // its one batch (ttl 1) passed
        vm.prank(alice);
        core.cancelOrder(pid, id); // expired: the owner can take the escrow back
        assertGt(core.pending(address(usdc), alice), 0);
    }

    /// A holder who raises the price in front of a buyer cannot make the buyer pay more than intended.
    function test_buyerProtectedFromPriceFrontRun() public {
        _buy(alice, PRICE, DEPOSIT);
        vm.prank(alice);
        reg.setPrice(address(weth), address(usdc), Kind.American, 50_000e6);
        vm.prank(bob);
        vm.expectRevert(SeatRegistry.InvalidParams.selector);
        reg.buy(address(weth), address(usdc), Kind.American, PRICE, DEPOSIT, PRICE);
    }

    function test_release_returnsDepositAndBond() public {
        _buy(alice, PRICE, DEPOSIT);
        vm.expectEmit(true, true, false, true, address(reg));
        emit SeatRegistry.Vacated(market, alice, 2); // audit #8: indexers see the voluntary exit
        vm.prank(alice);
        reg.release(address(weth), address(usdc), Kind.American);
        assertEq(_holder(), address(0));
        assertEq(reg.claimable(address(usdc), alice), DEPOSIT + OBLIGATION / 10);
        _assertSolvent();
    }

    function test_topUp_emitsDeposit() public {
        _buy(alice, PRICE, DEPOSIT);
        vm.expectEmit(true, false, false, true, address(reg));
        emit SeatRegistry.DepositToppedUp(market, 100e6);
        vm.prank(alice);
        reg.topUp(address(weth), address(usdc), Kind.American, 100e6);
    }

    function _postSide(address who, uint8 side, uint256 units, uint256 limit) internal {
        uint64 h = core.findHint(pid, side, uint96(limit));
        vm.prank(who);
        reg.postOrder(pid, _params(side, units, limit, 0, 1, h));
    }

    /// Audit #13: before the first trade a buy counts at min(limit, K), so a 1-wei bid of a K-sized order does not
    /// meet the obligation.
    function test_postOrder_tokenBidDoesNotCount_beforeFirstTrade() public {
        _buy(alice, PRICE, DEPOSIT);
        uint64 h = core.findHint(pid, BUY, 1);
        vm.prank(alice);
        vm.expectRevert(SeatRegistry.InvalidParams.selector);
        reg.postOrder(pid, _params(BUY, ONE, 1, 0, 1, h)); // 3000 USDC at K, but escrows 1 wei
        vm.prank(alice);
        vm.expectRevert(SeatRegistry.InvalidParams.selector);
        reg.postOrder(pid, _params(BUY, 3e17, 3000e6, 0, 1, h)); // 900 USDC < 1000 even at K
        _postSide(alice, BUY, 4e17, 2500e6); // 1000 USDC at its own limit: counts
        _postSide(alice, SELL, ONE, 3500e6); // sells still count at K while there is no price
    }

    /// Audit #13: once the pool has a clearing price, the order must sit within the pool's band of it.
    function test_postOrder_mustBeNearTheClearingPrice() public {
        _sell(dave, pid, ONE, 2900e6);
        _buy(bob, pid, ONE, 2900e6);
        _settle(pid);
        assertEq(core.pool(pid).lastClearingPrice, 2900e6);
        _buy(alice, PRICE, DEPOSIT);
        // 8% band around 2900: buys from 2668, sells up to 3132
        uint64 h = core.findHint(pid, BUY, 2667e6);
        vm.prank(alice);
        vm.expectRevert(SeatRegistry.InvalidParams.selector);
        reg.postOrder(pid, _params(BUY, ONE, 2667e6, 0, 1, h));
        h = core.findHint(pid, SELL, 3133e6);
        vm.prank(alice);
        vm.expectRevert(SeatRegistry.InvalidParams.selector);
        reg.postOrder(pid, _params(SELL, ONE, 3133e6, 0, 1, h));
        _postSide(alice, BUY, ONE, 2668e6);
        _postSide(alice, SELL, ONE, 3132e6);
    }
}
