// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Base} from "../utils/Base.sol";
import {Confluere} from "../../src/Confluere.sol";
import {SeatRegistry} from "../../src/periphery/SeatRegistry.sol";
import {SeatLPToken} from "../../src/periphery/SeatLPToken.sol";
import {Kind} from "../../src/libraries/PoolKey.sol";

/// @notice The LP receipt token mirrors the seat: holder's deposit after tax plus bond, zero for others, never moves.
contract SeatLPTokenTest is Base {
    SeatRegistry internal reg;
    SeatLPToken internal lp;
    address internal protocolMs = makeAddr("protocolMs");

    function setUp() public override {
        super.setUp();
        address[] memory qs = new address[](1);
        uint256[] memory obs = new uint256[](1);
        (qs[0], obs[0]) = (address(usdc), 1000e6);
        reg = new SeatRegistry(address(this), protocolMs, 3500, 1500, qs, obs);
        Confluere.Config memory c = _config();
        c.chains[0].treasury = address(reg);
        core = new Confluere(c);
        reg.bind(core);
        lp = new SeatLPToken(reg, address(weth), address(usdc), Kind.American);
        vm.prank(alice);
        usdc.approve(address(reg), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(reg), type(uint256).max);
    }

    function test_metadata() public view {
        assertEq(lp.decimals(), 6);
        assertEq(lp.symbol(), "cLP-WETH-USDC");
        assertEq(lp.name(), "Confluere LP WETH/USDC American");
    }

    function test_balanceFollowsTheSeat() public {
        assertEq(lp.balanceOf(alice), 0);
        assertEq(lp.totalSupply(), 0);
        vm.prank(alice);
        reg.buy(address(weth), address(usdc), Kind.American, 10_000e6, 500e6, type(uint256).max);
        (SeatRegistry.Seat memory st,) = reg.seatOf(address(weth), address(usdc), Kind.American);
        assertEq(lp.holder(), alice);
        assertEq(lp.balanceOf(alice), uint256(st.deposit) + st.bond);
        assertEq(lp.balanceOf(bob), 0);
        assertEq(lp.totalSupply(), lp.balanceOf(alice));
        // tax accrues: the balance falls like the seat's deposit
        uint256 before = lp.balanceOf(alice);
        vm.warp(block.timestamp + 30 days);
        uint256 tax = uint256(10_000e6) * 1500 * 30 days / (10_000 * 365 days);
        assertApproxEqAbs(before - lp.balanceOf(alice), tax, 1);
        // bought out: the old holder drops to zero, the buyer holds it
        vm.prank(bob);
        reg.buy(address(weth), address(usdc), Kind.American, 12_000e6, 500e6, type(uint256).max);
        assertEq(lp.balanceOf(alice), 0);
        assertGt(lp.balanceOf(bob), 0);
        // released: vacant
        vm.prank(bob);
        reg.release(address(weth), address(usdc), Kind.American);
        assertEq(lp.totalSupply(), 0);
    }

    function test_nonTransferable() public {
        vm.expectRevert(SeatLPToken.NonTransferable.selector);
        lp.transfer(bob, 1);
        vm.expectRevert(SeatLPToken.NonTransferable.selector);
        lp.approve(bob, 1);
        vm.expectRevert(SeatLPToken.NonTransferable.selector);
        lp.transferFrom(alice, bob, 1);
        assertEq(lp.allowance(alice, bob), 0);
    }
}
