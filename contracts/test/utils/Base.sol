// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {Confluere} from "../../src/Confluere.sol";
import {IConfluere} from "../../src/interfaces/IConfluere.sol";
import {PoolKey, PoolKeyLib, Kind, Status} from "../../src/libraries/PoolKey.sol";
import {GridConfig} from "../../src/libraries/Grid.sol";
import {SELL, BUY, NC_SELL, NC_BUY, BID} from "../../src/libraries/OrderSet.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";

abstract contract Base is Test {
    using PoolKeyLib for bytes32;

    uint64 internal constant ANCHOR = 1_791_532_800; // Friday 2026-10-09 08:00 UTC
    uint64 internal constant WEEK = 7 days;
    uint64 internal constant BATCH = 30 minutes;
    uint64 internal constant WINDOW = 7200;
    uint64 internal constant E1 = ANCHOR + WEEK;
    uint64 internal constant E2 = ANCHOR + 2 * WEEK;
    uint128 internal constant K = 3000e6; // 3000 USDC per ETH
    uint256 internal constant ONE = 1e18;

    Confluere internal core;
    MockERC20 internal weth;
    MockERC20 internal usdc;

    address internal treasury = makeAddr("treasury");
    address internal guardian = makeAddr("guardian");
    address internal alice = makeAddr("alice"); // borrower
    address internal dave = makeAddr("dave"); // borrower
    address internal bob = makeAddr("bob"); // lender
    address internal carol = makeAddr("carol"); // lender
    address internal eve = makeAddr("eve"); // searcher / bidder

    function setUp() public virtual {
        vm.warp(ANCHOR + 1 days);
        vm.roll(1_000_000);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        core = new Confluere(_config());

        address[5] memory actors = [alice, dave, bob, carol, eve];
        for (uint256 i; i < actors.length; ++i) {
            weth.mint(actors[i], 1000 * ONE);
            usdc.mint(actors[i], 10_000_000e6);
            vm.startPrank(actors[i]);
            weth.approve(address(core), type(uint256).max);
            usdc.approve(address(core), type(uint256).max);
            vm.stopPrank();
        }
        weth.mint(address(this), ONE);
        usdc.mint(address(this), 1e6);
        weth.approve(address(core), type(uint256).max);
        usdc.approve(address(core), type(uint256).max);
    }

    function _config() internal view virtual returns (Confluere.Config memory c) {
        c.grid = GridConfig({anchor: ANCHOR, period: WEEK, batchInterval: BATCH, maxExpiries: 4, strikeSigDigits: 2});
        c.maxOrdersPerSide = 8;
        c.maxBids = 4;
        c.chains = new Confluere.ChainParams[](1);
        c.chains[0].chainId = block.chainid;
        c.chains[0].windowBlocks = WINDOW;
        c.chains[0].maxPauseBlocks = 7 days;
        c.chains[0].treasury = treasury;
        c.chains[0].guardian = guardian;
    }

    // ------------------------------------------------------------ helpers

    function _key(uint128 strike, Kind kind, uint64 expiry) internal view returns (PoolKey memory) {
        return PoolKey({asset: address(weth), quote: address(usdc), expiry: expiry, strike: strike, kind: kind});
    }

    function _create(uint128 strike, Kind kind, uint64 expiry) internal returns (bytes32) {
        return core.createPool(_key(strike, kind, expiry), 1000, 800);
    }

    function _create() internal returns (bytes32) {
        return _create(K, Kind.American, E1);
    }

    function _params(uint8 side, uint256 units, uint256 limit, uint256 budget, uint16 ttl, uint64 hint)
        internal
        pure
        returns (IConfluere.OrderParams memory)
    {
        return IConfluere.OrderParams({
            side: side,
            units: uint96(units),
            limit: uint96(limit),
            budget: uint128(budget),
            ttl: ttl,
            hint: hint,
            owner: address(0)
        });
    }

    function _sell(address who, bytes32 pid, uint256 units, uint256 limit) internal returns (uint64) {
        return _order(who, pid, SELL, units, limit, 0, 10);
    }

    function _buy(address who, bytes32 pid, uint256 units, uint256 limit) internal returns (uint64) {
        return _order(who, pid, BUY, units, limit, 0, 10);
    }

    function _order(address who, bytes32 pid, uint8 side, uint256 units, uint256 limit, uint256 budget, uint16 ttl)
        internal
        returns (uint64 id)
    {
        uint64 hint = core.findHint(pid, side, uint96(limit));
        vm.prank(who);
        id = core.placeOrder(pid, _params(side, units, limit, budget, ttl, hint));
    }

    function _settle(bytes32 pid) internal {
        vm.warp(core.nextBatchAt(pid));
        core.settleBatch(pid);
    }

    function _r(bytes32 pid) internal pure returns (uint256) {
        return pid.rId();
    }

    function _c(bytes32 pid) internal pure returns (uint256) {
        return pid.cId();
    }

    function _pend(address token, address who) internal view returns (uint256) {
        return core.pending(token, who);
    }

    /// @dev Mature at expiry and move past the window.
    function _matureAndEndWindow(bytes32 pid) internal {
        vm.warp(core.pool(pid).key.expiry);
        core.mature(pid);
        vm.roll(block.number + WINDOW);
    }
}
