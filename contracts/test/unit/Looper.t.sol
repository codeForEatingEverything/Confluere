// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Base} from "../utils/Base.sol";
import {Kind} from "../../src/libraries/PoolKey.sol";
import {Looper, LoopAccount, ILoopMinter} from "../../src/periphery/Looper.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Stands in for an LST mint path: 1 asset per 3000 quote.
contract MockMinter is ILoopMinter {
    function mint(address quote, address asset, uint256 amountIn, address to) external returns (uint256 out) {
        IERC20(quote).transferFrom(msg.sender, address(this), amountIn);
        out = amountIn * 1e18 / 3000e6;
        MockERC20(asset).mint(to, out);
    }
}

contract LooperTest is Base {
    Looper internal looper;
    MockMinter internal minter;
    bytes32 internal pid;

    function setUp() public override {
        super.setUp();
        looper = new Looper(core);
        minter = new MockMinter();
        pid = _create(K, Kind.American, E1);
        vm.prank(alice);
        weth.approve(address(looper), type(uint256).max);
    }

    function test_loop_twoRounds_thenExit() public {
        _buy(bob, pid, 100 * ONE, 2950e6);
        vm.prank(alice);
        LoopAccount acct = looper.open(pid, uint96(10 * ONE), 2900e6, 4, 2, minter);
        assertTrue(acct.live());
        assertEq(acct.roundsLeft(), 1);

        _settle(pid);
        assertFalse(acct.live());
        acct.step(); // anyone: collects ~29.5k USDC, mints ~9.8 ETH, sells again
        assertTrue(acct.live());
        assertEq(acct.roundsLeft(), 0);

        vm.expectRevert(LoopAccount.Busy.selector);
        acct.step();

        _settle(pid);
        acct.step(); // collects the last proceeds, no rounds left
        assertFalse(acct.live());

        vm.expectRevert(LoopAccount.NotOwner.selector);
        acct.exit(bob);

        uint256 q = usdc.balanceOf(alice);
        vm.prank(alice);
        acct.exit(alice);
        uint256 r = core.balanceOf(alice, _r(pid));
        assertGt(r, 19 * ONE); // 10 + ~9.8 units of repurchase right
        assertGt(usdc.balanceOf(alice), q);
        assertEq(core.balanceOf(address(acct), _r(pid)), 0);
        assertEq(weth.balanceOf(address(acct)), 0);
        assertEq(usdc.balanceOf(address(acct)), 0);
    }

    function test_exit_cancelsLiveOrder() public {
        uint256 w = weth.balanceOf(alice);
        vm.startPrank(alice);
        LoopAccount acct = looper.open(pid, uint96(10 * ONE), 2900e6, 4, 3, minter);
        acct.exit(alice);
        vm.stopPrank();
        assertEq(weth.balanceOf(alice), w);
        assertFalse(acct.live());
    }

    function test_open_badParams_revert() public {
        vm.prank(alice);
        vm.expectRevert(Looper.InvalidParams.selector);
        looper.open(pid, uint96(10 * ONE), 2900e6, 4, 0, minter);
    }
}
