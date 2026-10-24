// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Base} from "../utils/Base.sol";
import {IConfluere} from "../../src/interfaces/IConfluere.sol";
import {Kind, Status} from "../../src/libraries/PoolKey.sol";
import {SELL, BID, FLAG_AUTOSELL} from "../../src/libraries/OrderSet.sol";
import {Settlement} from "../../src/libraries/Settlement.sol";
import {Clearing} from "../../src/libraries/Clearing.sol";

/// @notice Decision B: a closed autoSell pool offers its defaulted asset in the same market's next expiry pool of the
/// same tier at K x discount (Base: 90%, ttl 4), owned by the core; claims wait while it is Selling.
contract AutoSellTest is Base {
    bytes32 internal p1;
    bytes32 internal p2;
    uint256 internal constant LIMIT = uint256(K) * 9000 / 10_000;

    function setUp() public override {
        super.setUp();
        p1 = _createKey(core, _key(K, Kind.American, E1), IConfluere.PoolOptions(0, 0, 0, true));
        p2 = _create(K, Kind.American, E2);
        _sell(alice, p1, ONE, 2900e6);
        _buy(bob, p1, ONE, 2900e6);
        _settle(p1);
    }

    /// @dev Default at E1: nobody repays, the window ends, the pool closes into Selling.
    function _closeP1() internal returns (uint64 id) {
        vm.warp(E1);
        core.mature(p1);
        vm.roll(block.number + WINDOW);
        assertTrue(core.closeWindow(p1, 10));
        id = core.pool(p1).autoSellOrder;
    }

    function _status(bytes32 pid) internal view returns (Status) {
        return core.pool(pid).status;
    }

    function test_autoSell_placesSellInNextExpirySameTier() public {
        uint64 id = _closeP1();
        IConfluere.PoolView memory v = core.pool(p1);
        assertEq(uint8(v.status), uint8(Status.Selling));
        assertEq(v.autoSellPool, p2);
        assertEq(v.autoSellUnits, ONE);
        (address owner, uint8 side, uint8 flags, uint96 units, uint96 limit,,,) = core.order(p2, id);
        assertEq(owner, address(core));
        assertEq(side, SELL);
        assertEq(flags, FLAG_AUTOSELL);
        assertEq(units, ONE);
        assertEq(limit, LIMIT);
        assertEq(core.linkedPool(p2, id), p1);
        assertEq(v.assetBal, ONE, "the units stay in the old pool until they sell");
    }

    function test_autoSell_offPool_noOrder() public {
        bytes32 plain = _create(K_HI, Kind.American, E1);
        _sell(alice, plain, ONE, 2900e6);
        _buy(bob, plain, ONE, 2900e6);
        _settle(plain);
        vm.warp(E1);
        core.mature(plain);
        vm.roll(block.number + WINDOW);
        core.closeWindow(plain, 10);
        assertEq(uint8(_status(plain)), uint8(Status.Closed));
        assertEq(core.pool(plain).autoSellOrder, 0);
    }

    function test_autoSell_ownerIsCore_cannotCancel() public {
        uint64 id = _closeP1();
        vm.prank(alice);
        vm.expectRevert(IConfluere.NotOwner.selector);
        core.cancelOrder(p2, id);
    }

    function test_autoSell_fill_creditsOldPoolNet() public {
        _closeP1();
        uint256 q0 = core.pool(p1).quoteBal;
        _buy(carol, p2, ONE, 2950e6);
        _settle(p2);
        uint256 price = Clearing.midpoint(LIMIT, 2950e6);
        (,,, uint256 net) = Settlement.sellSplit(ONE, price, K, ONE);
        IConfluere.PoolView memory v = core.pool(p1);
        assertEq(v.quoteBal, q0 + net, "net proceeds to the old pool's C holders");
        assertEq(v.assetBal, 0);
        assertEq(v.autoSellUnits, 0);
        assertEq(uint8(v.status), uint8(Status.Closed), "fully sold: closed");
        assertEq(core.pool(p2).assetBal, ONE);
        assertEq(core.balanceOf(address(core), _r(p2)), ONE, "the core holds the new R, never repaid");
        assertEq(core.balanceOf(carol, _c(p2)), ONE);
    }

    function test_autoSell_claimWaitsForSelling() public {
        _closeP1();
        vm.prank(bob);
        vm.expectRevert(IConfluere.InvalidState.selector);
        core.claim(p1);
        _buy(carol, p2, ONE, 2950e6);
        _settle(p2);
        uint256 q = core.pool(p1).quoteBal;
        vm.prank(bob);
        (uint256 qo, uint256 ao) = core.claim(p1);
        assertEq(qo, q, "lenders get quote only");
        assertEq(ao, 0);
    }

    function test_autoSell_ttlOut_fallbackInKind() public {
        _closeP1();
        for (uint256 i; i < 5; ++i) {
            _settle(p2);
        }
        assertEq(uint8(_status(p1)), uint8(Status.Closed), "expired order removed at clearing");
        vm.prank(bob);
        (, uint256 a) = core.claim(p1);
        assertEq(a, ONE, "unsold remainder in kind");
    }

    function test_autoSell_partialThenExpire() public {
        _closeP1();
        _buy(carol, p2, 4e17, 2950e6);
        _settle(p2);
        assertEq(core.pool(p1).autoSellUnits, 6e17);
        assertEq(uint8(_status(p1)), uint8(Status.Selling));
        for (uint256 i; i < 4; ++i) {
            _settle(p2);
        }
        assertEq(uint8(_status(p1)), uint8(Status.Closed));
        vm.prank(bob);
        (uint256 q, uint256 a) = core.claim(p1);
        assertEq(a, 6e17);
        assertGt(q, 0);
    }

    function test_autoSell_noTargetPool_closesDirectly() public {
        bytes32 lone = _createKey(core, _key(K_HI, Kind.American, E1), IConfluere.PoolOptions(0, 0, 0, true));
        _sell(alice, lone, ONE, 2900e6);
        _buy(bob, lone, ONE, 2900e6);
        _settle(lone);
        vm.warp(E1);
        core.mature(lone);
        vm.roll(block.number + WINDOW);
        core.closeWindow(lone, 10);
        assertEq(uint8(_status(lone)), uint8(Status.Closed));
    }

    function test_autoSell_targetBookFull_fallback() public {
        for (uint256 i; i < 8; ++i) {
            _order(dave, p2, SELL, ONE, 2000e6, 0, 100);
        }
        _closeP1();
        assertEq(uint8(_status(p1)), uint8(Status.Closed), "book full of better sells: no order, in kind");
        assertEq(core.pool(p1).assetBal, ONE);
    }

    function test_autoSell_evicted_fallback() public {
        for (uint256 i; i < 7; ++i) {
            _order(dave, p2, SELL, ONE, 2000e6, 0, 100);
        }
        _closeP1(); // the 8th order: the book is now full
        assertEq(uint8(_status(p1)), uint8(Status.Selling));
        _order(dave, p2, SELL, ONE, 2100e6, 0, 100); // a better sell evicts the worst, the autoSell order
        assertEq(uint8(_status(p1)), uint8(Status.Closed));
        assertEq(core.pool(p1).assetBal, ONE);
    }

    function test_autoSell_targetPaused_stillPlaced() public {
        vm.prank(guardian);
        core.pause(p2, 1000);
        _closeP1();
        assertEq(uint8(_status(p1)), uint8(Status.Selling));
    }

    function test_autoSell_closeWindowFinalizesDeadOrder() public {
        _closeP1();
        vm.expectRevert(IConfluere.InvalidState.selector);
        core.closeWindow(p1, 1); // the order can still trade
        vm.warp(E2); // the target stopped trading
        assertTrue(core.closeWindow(p1, 1));
        assertEq(uint8(_status(p1)), uint8(Status.Closed));
    }

    function test_autoSell_purgeFinalizes() public {
        uint64 id = _closeP1();
        vm.warp(E2);
        uint64[] memory ids = new uint64[](1);
        ids[0] = id;
        core.purge(p2, ids);
        assertEq(uint8(_status(p1)), uint8(Status.Closed));
        assertEq(core.pool(p1).autoSellUnits, 0);
    }

    function test_autoSell_coreR_burnedAndSurplusToLenders() public {
        _closeP1();
        _buy(carol, p2, ONE, 2950e6);
        _settle(p2);
        vm.warp(E2);
        core.mature(p2);
        uint64 hint = core.findHint(p2, BID, 50e6);
        vm.prank(eve);
        core.bid(p2, uint96(ONE), 50e6, hint);
        vm.roll(block.number + WINDOW);
        uint256 q0 = core.pool(p2).quoteBal;
        core.closeWindow(p2, 10);
        IConfluere.PoolView memory v = core.pool(p2);
        assertEq(core.balanceOf(address(core), _r(p2)), 0, "core R burned");
        assertEq(core.totalSupply(_r(p2)), 0);
        assertEq(v.surplusBal, 0, "the core's surplus share moved to C holders");
        assertEq(v.quoteBal, q0 + uint256(K) + 50e6 + v.feeEscrow, "K and the surplus of the bid unit, escrow split");
        assertEq(uint8(v.status), uint8(Status.Closed));
    }

    function test_autoSell_notUsedWhileOpen() public view {
        assertEq(core.pool(p1).autoSellOrder, 0);
        assertTrue(core.pool(p1).options.autoSell);
    }
}
