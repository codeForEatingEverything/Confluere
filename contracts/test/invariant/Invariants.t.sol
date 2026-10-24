// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {Confluere} from "../../src/Confluere.sol";
import {IConfluere} from "../../src/interfaces/IConfluere.sol";
import {PoolKey, PoolKeyLib, Kind, Status} from "../../src/libraries/PoolKey.sol";
import {GridConfig} from "../../src/libraries/Grid.sol";
import {SELL, BUY, NC_SELL, NC_BUY, BID} from "../../src/libraries/OrderSet.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {Handler} from "./Handler.sol";

/// @notice Invariant table from docs/ARCHITECTURE.md section 2.11.
/// forge-config: default.invariant.depth = 128
contract InvariantsTest is Test {
    using PoolKeyLib for bytes32;

    uint64 internal constant ANCHOR = 1_791_532_800;
    uint64 internal constant WEEK = 7 days;

    Confluere internal core;
    MockERC20 internal weth;
    MockERC20 internal usdc;
    Handler internal h;
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        vm.warp(ANCHOR + 1 days);
        vm.roll(1_000_000);
        weth = new MockERC20("WETH", "WETH", 18);
        usdc = new MockERC20("USDC", "USDC", 6);
        Confluere.Config memory c;
        c.grid = GridConfig(ANCHOR, WEEK, 30 minutes, 4, 2);
        c.maxOrdersPerSide = 8;
        c.maxBids = 4;
        c.chains = new Confluere.ChainParams[](1);
        c.chains[0].chainId = block.chainid;
        c.chains[0].windowBlocks = 7200;
        c.chains[0].maxPauseBlocks = 1000;
        c.chains[0].treasury = treasury;
        c.chains[0].guardian = address(0xdead);
        core = new Confluere(c);

        weth.mint(address(this), 10);
        usdc.mint(address(this), 10);
        weth.approve(address(core), type(uint256).max);
        usdc.approve(address(core), type(uint256).max);
        bytes32[] memory ps = new bytes32[](3);
        ps[0] = core.createPool(PoolKey(address(weth), address(usdc), ANCHOR + WEEK, 3000e6, Kind.American), 1000, 800);
        ps[1] =
            core.createPool(PoolKey(address(weth), address(usdc), ANCHOR + 2 * WEEK, 3000e6, Kind.American), 1000, 800);
        ps[2] = core.createPool(PoolKey(address(weth), address(usdc), ANCHOR + WEEK, 3100e6, Kind.European), 1500, 150);

        address[] memory as_ = new address[](4);
        for (uint256 i; i < 4; ++i) {
            as_[i] = makeAddr(string(abi.encodePacked("actor", i)));
            weth.mint(as_[i], 1e24);
            usdc.mint(as_[i], 1e15);
        }
        h = new Handler(core, weth, usdc, treasury, ps, as_);
        for (uint256 i; i < 4; ++i) {
            vm.startPrank(as_[i]);
            weth.approve(address(core), type(uint256).max);
            usdc.approve(address(core), type(uint256).max);
            vm.stopPrank();
        }
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](18);
        sel[0] = Handler.place.selector;
        sel[1] = Handler.place.selector;
        sel[2] = Handler.cancel.selector;
        sel[3] = Handler.settle.selector;
        sel[4] = Handler.repay.selector;
        sel[5] = Handler.rollover.selector;
        sel[6] = Handler.matureAll.selector;
        sel[7] = Handler.placeBid.selector;
        sel[8] = Handler.rollBlocks.selector;
        sel[9] = Handler.close.selector;
        sel[10] = Handler.claim.selector;
        sel[11] = Handler.withdraw.selector;
        sel[12] = Handler.placePair.selector;
        sel[13] = Handler.matureOne.selector;
        sel[14] = Handler.flash.selector;
        sel[15] = Handler.purge.selector;
        sel[16] = Handler.pause.selector;
        sel[17] = Handler.placeLocked.selector;
        targetSelector(FuzzSelector(address(h), sel));
    }

    /// @dev Invariant 1, strengthened to equality: every token the core holds is owed to someone exactly once.
    function invariant_solvencyExact() public view {
        (uint256 escAsset, uint256 escQuote) = _escrows();
        uint256 poolAsset;
        uint256 poolQuote;
        for (uint256 i; i < h.poolsLength(); ++i) {
            IConfluere.PoolView memory v = core.pool(h.pools(i));
            poolAsset += v.assetBal;
            poolQuote += v.quoteBal + v.surplusBal + v.feeEscrow;
        }
        (uint256 pendAsset, uint256 pendQuote) = _pending();
        assertEq(weth.balanceOf(address(core)), escAsset + poolAsset + pendAsset, "asset accounting");
        assertEq(usdc.balanceOf(address(core)), escQuote + poolQuote + pendQuote, "quote accounting");
    }

    /// @dev Invariant 2: before close, the pool's asset backs exactly the outstanding R; C equals cumulative fills.
    function invariant_supplies() public view {
        for (uint256 i; i < h.poolsLength(); ++i) {
            bytes32 pid = h.pools(i);
            IConfluere.PoolView memory v = core.pool(pid);
            if (v.status == Status.Open || v.status == Status.Window) {
                assertEq(core.totalSupply(pid.rId()), v.assetBal, "R == pool asset");
            }
            if (v.status != Status.Closed) {
                assertEq(core.totalSupply(pid.cId()), h.filledUnits(pid), "C == cumulative fills");
            }
        }
    }

    /// @dev Invariant 3: limits respected, non-competitive volume capped at 50%.
    function invariant_clearingRules() public view {
        assertFalse(h.limitViolated(), "limit violated");
        assertFalse(h.ncCapViolated(), "nc cap violated");
    }

    /// @dev Invariant 4: nobody can take value out of a pool without burning the matching C or R.
    function invariant_noValueExtraction() public view {
        assertFalse(h.valueExtracted(), "pool value fell without a burn");
    }

    /// @dev Invariant 5: repayment inside the window always succeeds.
    function invariant_repayAlwaysWorks() public view {
        assertFalse(h.repayFailed(), "repay failed");
    }

    /// @dev Invariant 7: settleBatch, closeWindow and cancelOrder never move tokens out.
    function invariant_noPushOnSettle() public view {
        assertFalse(h.pushedDuringNoPushCall(), "token left during a no-push call");
    }

    /// @dev Invariant 3c: the guardian's pause budget per pool is cumulative and a running pause cannot be extended.
    function invariant_pauseCap() public view {
        assertFalse(h.pauseExtended(), "running pause extended");
        for (uint256 i; i < h.poolsLength(); ++i) {
            assertLe(core.pool(h.pools(i)).pausedBlocks, 1000, "pause budget exceeded");
        }
    }

    /// @dev Blueprint 3.5: pools of one expiry share a window however late each is matured.
    function invariant_windowsAligned() public view {
        assertFalse(h.windowMisaligned(), "window not aligned per expiry");
    }

    /// @dev Locked (seat obligation) orders cannot be withdrawn while they can still trade.
    function invariant_lockedOrdersStay() public view {
        assertFalse(h.lockedCancelled(), "live locked order cancelled");
    }

    /// @dev Deterministic coverage: the handler path really clears, and the invariants hold afterwards.
    function test_handlerProducesFills() public {
        for (uint256 i; i < 30; ++i) {
            h.place(i, 0, i % 2, 1e18, 25 + (i % 8), 6);
            if (i % 5 == 4) h.settle(0);
        }
        assertGt(h.fills(), 0);
        invariant_solvencyExact();
        invariant_supplies();
        invariant_clearingRules();
    }

    function _escrows() internal view returns (uint256 a, uint256 q) {
        for (uint256 i; i < h.refsLength(); ++i) {
            (bytes32 pid, uint64 id) = h.refs(i);
            (address owner, uint8 side, uint96 units,, uint128 escrow,,) = core.order(pid, id);
            if (owner == address(0)) continue;
            if (side == SELL || side == NC_SELL) {
                if (core.rolloverSource(pid, id) != bytes32(0)) q += escrow;
                else a += units;
            } else {
                q += escrow;
            }
        }
    }

    function _pending() internal view returns (uint256 a, uint256 q) {
        a = core.pending(address(weth), treasury);
        q = core.pending(address(usdc), treasury);
        for (uint256 i; i < h.actorsLength(); ++i) {
            address who = h.actors(i);
            a += core.pending(address(weth), who);
            q += core.pending(address(usdc), who);
        }
    }
}
