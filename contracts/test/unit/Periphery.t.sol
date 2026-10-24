// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Base} from "../utils/Base.sol";
import {IConfluere} from "../../src/interfaces/IConfluere.sol";
import {Confluere} from "../../src/Confluere.sol";
import {Kind, PoolKey} from "../../src/libraries/PoolKey.sol";
import {SELL, BUY} from "../../src/libraries/OrderSet.sol";
import {ERC6909Wrapper, ERC6909WrapperFactory} from "../../src/periphery/ERC6909Wrapper.sol";
import {RwaWrapper} from "../../src/periphery/RwaWrapper.sol";
import {Guardian} from "../../src/periphery/Guardian.sol";
import {Router} from "../../src/periphery/Router.sol";
import {VaultFactory} from "../../src/periphery/VaultFactory.sol";
import {Vault} from "../../src/periphery/Vault.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";

contract PeripheryTest is Base {
    bytes32 internal pid;

    function setUp() public override {
        super.setUp();
        pid = _create();
        _sell(alice, pid, ONE, 2900e6);
        _buy(bob, pid, ONE, 2900e6);
        _settle(pid);
    }

    function test_wrapper_roundTrip() public {
        ERC6909WrapperFactory f = new ERC6909WrapperFactory(core);
        address predicted = f.wrapperOf(_c(pid));
        ERC6909Wrapper w = ERC6909Wrapper(f.create(_c(pid)));
        assertEq(address(w), predicted);
        assertEq(w.symbol(), "C-WETH-16OCT");
        assertEq(w.name(), "Confluere C WETH/USDC 16 Oct 2026");
        assertEq(w.decimals(), 18);
        vm.startPrank(bob);
        core.approve(address(w), _c(pid), ONE);
        w.wrap(6e17, bob);
        assertEq(w.balanceOf(bob), 6e17);
        assertEq(core.balanceOf(address(w), _c(pid)), 6e17);
        w.transfer(carol, 1e17);
        vm.stopPrank();
        vm.prank(carol);
        w.unwrap(1e17, carol);
        assertEq(core.balanceOf(carol, _c(pid)), 1e17);
        ERC6909Wrapper r = ERC6909Wrapper(f.create(_r(pid)));
        assertEq(r.symbol(), "R-WETH-16OCT");
        assertEq(r.name(), "Confluere R WETH/USDC 16 Oct 2026");
    }

    function test_rwaWrapper_rebaseAccruesToShares() public {
        MockERC20 stock = new MockERC20("Stock", "STK", 18);
        RwaWrapper w = new RwaWrapper(address(stock), "Wrapped Stock", "wSTK");
        stock.mint(alice, 100e18);
        vm.startPrank(alice);
        stock.approve(address(w), type(uint256).max);
        uint256 shares = w.wrap(100e18, alice);
        vm.stopPrank();
        // a 5% dividend paid as a rebase lands in the wrapper
        stock.mint(address(w), 5e18);
        assertEq(w.balanceOf(alice), shares, "balance fixed");
        vm.prank(alice);
        uint256 out = w.unwrap(shares, alice);
        assertApproxEqAbs(out, 105e18, 1e6);
    }

    /// L-1 (audit 2026-10-11): donation attack on the RWA wrapper's exchange rate.
    function test_rwaWrapper_donationAttackFails() public {
        MockERC20 stock = new MockERC20("Stock", "STK", 18);
        RwaWrapper w = new RwaWrapper(address(stock), "Wrapped Stock", "wSTK");
        stock.mint(eve, 2_000_000e18);
        stock.mint(alice, 1000e18);
        vm.startPrank(eve);
        stock.approve(address(w), type(uint256).max);
        w.wrap(1, eve);
        stock.transfer(address(w), 1_000_000e18); // donation
        vm.stopPrank();
        vm.startPrank(alice);
        stock.approve(address(w), type(uint256).max);
        uint256 shares = w.wrap(1000e18, alice);
        uint256 back = w.unwrap(shares, alice);
        vm.stopPrank();
        assertGe(back, 999e18, "victim keeps >= 99.9%");
    }

    function test_guardian_multisigPause() public {
        address[] memory m = new address[](3);
        (m[0], m[1], m[2]) = (alice, bob, carol);
        Guardian g = new Guardian(address(this), m, 2);
        Confluere.Config memory c = _config();
        c.chains[0].guardian = address(g);
        Confluere core2 = new Confluere(c);
        g.bind(core2);
        vm.expectRevert(Guardian.AlreadyBound.selector);
        g.bind(core);
        vm.prank(eve);
        vm.expectRevert(Guardian.AlreadyBound.selector);
        g.bind(core); // only the named binder, and only once
        weth.approve(address(core2), type(uint256).max);
        usdc.approve(address(core2), type(uint256).max);
        bytes32 p2 = _createKey(IConfluere(address(core2)), _key(K, Kind.American, E1), _noOpts());

        vm.prank(alice);
        g.approvePause(p2, 10, 1);
        vm.prank(eve);
        vm.expectRevert(Guardian.NotMember.selector);
        g.approvePause(p2, 10, 1);
        vm.prank(alice);
        vm.expectRevert(Guardian.AlreadyApproved.selector);
        g.approvePause(p2, 10, 1);
        assertEq(core2.pool(p2).pausedUntil, 0);
        vm.prank(bob);
        g.approvePause(p2, 10, 1);
        assertEq(core2.pool(p2).pausedUntil, block.number + 10, "threshold reached, core paused");
    }

    function test_unsupportedChain() public {
        Confluere.Config memory c = _config();
        c.chains[0].chainId = 999;
        vm.expectRevert(Confluere.UnsupportedChain.selector);
        new Confluere(c);
    }

    function test_router_placeOrders_ownedByCaller() public {
        Router r = new Router(core);
        vm.startPrank(dave);
        usdc.approve(address(r), type(uint256).max);
        weth.approve(address(r), type(uint256).max);
        bytes32[] memory pids = new bytes32[](2);
        (pids[0], pids[1]) = (pid, pid);
        IConfluere.OrderParams[] memory ps = new IConfluere.OrderParams[](2);
        ps[0] = _params(SELL, ONE, 3000e6, 0, 3, core.findHint(pid, SELL, 3000e6));
        ps[1] = _params(BUY, ONE, 2000e6, 0, 3, core.findHint(pid, BUY, 2000e6));
        uint64[] memory ids = r.placeOrders(pids, ps);
        vm.stopPrank();
        (address o0,,,,,,) = core.order(pid, ids[0]);
        (address o1,,,, uint128 esc,,) = core.order(pid, ids[1]);
        assertEq(o0, dave);
        assertEq(o1, dave);
        assertEq(esc, 2000e6 + 300_000 + 6);
        assertEq(usdc.balanceOf(address(r)), 0);
    }

    function test_router_repayAndClaim() public {
        Router r = new Router(core);
        vm.startPrank(alice);
        core.setOperator(address(r), true);
        usdc.approve(address(r), type(uint256).max);
        uint256 w0 = weth.balanceOf(alice);
        r.repay(pid, uint96(ONE));
        assertEq(weth.balanceOf(alice), w0 + ONE);
        vm.stopPrank();

        _matureAndEndWindow(pid);
        core.closeWindow(pid, 10);
        vm.startPrank(bob);
        core.setOperator(address(r), true);
        bytes32[] memory pids = new bytes32[](1);
        pids[0] = pid;
        uint256 u0 = usdc.balanceOf(bob);
        r.claimMany(pids);
        vm.stopPrank();
        assertEq(usdc.balanceOf(bob) - u0, 3000e6);
    }

    function test_vaultFactory() public {
        VaultFactory f = new VaultFactory(core);
        address[] memory as_ = new address[](1);
        as_[0] = address(weth);
        Vault v = f.create(
            Vault.Strategy(address(usdc), as_, Kind.American, Vault.StrikeRule.HighestTraded, 2500, 9900),
            "rvUSDC-ETH-High",
            "rvUSDC-ETH-High",
            bytes32(0)
        );
        assertEq(f.vaultsLength(), 1);
        assertEq(v.asset(), address(usdc));
        assertEq(uint8(v.strikeRule()), 1);
    }
}
