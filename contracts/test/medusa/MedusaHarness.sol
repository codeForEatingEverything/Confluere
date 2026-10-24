// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Confluere} from "../../src/Confluere.sol";
import {IConfluere} from "../../src/interfaces/IConfluere.sol";
import {PoolKey, PoolKeyLib, Kind, Status} from "../../src/libraries/PoolKey.sol";
import {GridConfig} from "../../src/libraries/Grid.sol";
import {SELL, BUY, NC_SELL, NC_BUY, BID} from "../../src/libraries/OrderSet.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";

interface IHevm {
    function warp(uint256) external;
    function roll(uint256) external;
    function prank(address) external;
}

/// @notice Coverage-guided fuzzing harness for Medusa (`medusa fuzz` from contracts/). Every public function is an
/// action; every `property_*` must stay true. Mirrors ARCHITECTURE §2.11 invariants 1, 2, 4 and 5.
contract MedusaHarness {
    using PoolKeyLib for bytes32;

    IHevm internal constant vm = IHevm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    uint64 internal constant ANCHOR = 1_791_532_800;
    uint64 internal constant WEEK = 7 days;

    Confluere public core;
    MockERC20 public weth;
    MockERC20 public usdc;
    address internal constant TREASURY = address(0x7EA5);
    address[3] internal actors = [address(0xA11CE), address(0xB0B), address(0xCA401)];
    bytes32[2] internal pools;
    uint64[] internal orderIds;
    bytes32[] internal orderPools;

    bool internal extracted;
    bool internal repayFailed;

    constructor() {
        vm.warp(ANCHOR + 1 days);
        vm.roll(1000);
        weth = new MockERC20("WETH", "WETH", 18);
        usdc = new MockERC20("USDC", "USDC", 6);
        Confluere.Config memory c;
        c.grid = GridConfig(ANCHOR, WEEK, 30 minutes, 4);
        c.maxOrdersPerSide = 6;
        c.maxBids = 4;
        c.chains = new Confluere.ChainParams[](1);
        c.chains[0].chainId = block.chainid;
        c.chains[0].windowBlocks = 50;
        c.chains[0].maxPauseBlocks = 10;
        c.chains[0].treasury = TREASURY;
        c.chains[0].guardian = address(this);
        core = new Confluere(c);
        weth.mint(address(this), 10);
        usdc.mint(address(this), 10);
        weth.approve(address(core), type(uint256).max);
        usdc.approve(address(core), type(uint256).max);
        pools[0] = core.createPool(
            PoolKey(address(weth), address(usdc), ANCHOR + WEEK, 3_010_966_302, Kind.American, 800, 0),
            805,
            IConfluere.PoolOptions(0, 0, 0, false)
        );
        pools[1] = core.createPool(
            PoolKey(address(weth), address(usdc), ANCHOR + WEEK, 3_010_966_302, Kind.European, 150, 0),
            805,
            IConfluere.PoolOptions(0, 0, 0, false)
        );
        for (uint256 i; i < 3; ++i) {
            weth.mint(actors[i], 1e24);
            usdc.mint(actors[i], 1e15);
            vm.prank(actors[i]);
            weth.approve(address(core), type(uint256).max);
            vm.prank(actors[i]);
            usdc.approve(address(core), type(uint256).max);
        }
    }

    // ------------------------------------------------------------ actions

    function place(uint8 a, bool p1, uint8 sideSeed, uint96 units, uint8 limitStep, uint8 ttl) public {
        bytes32 pid = pools[p1 ? 1 : 0];
        uint8 side = sideSeed % 4;
        IConfluere.OrderParams memory o;
        o.side = side;
        o.ttl = uint16(ttl % 6) + 1;
        uint96 u = uint96(units % 5e18) + 1e15;
        uint96 lim = uint96(2500e6 + uint256(limitStep % 8) * 100e6);
        if (side == SELL || side == BUY) {
            o.units = u;
            o.limit = lim;
            o.hint = core.findHint(pid, side, lim);
        } else if (side == NC_SELL) {
            o.units = u;
            o.limit = limitStep % 3 == 0 ? lim : 0;
        } else {
            o.budget = uint128(uint256(u) * 3000e6 / 1e18) + 1;
            o.limit = limitStep % 3 == 0 ? lim : 0;
        }
        _as(a);
        try core.placeOrder(pid, o) returns (uint64 id) {
            orderIds.push(id);
            orderPools.push(pid);
        } catch {}
    }

    function cancel(uint8 a, uint256 r) public guarded {
        if (orderIds.length == 0) return;
        uint256 i = r % orderIds.length;
        _as(a);
        try core.cancelOrder(orderPools[i], orderIds[i]) {} catch {}
    }

    function settle(bool p1) public guarded {
        bytes32 pid = pools[p1 ? 1 : 0];
        uint256 next = core.nextBatchAt(pid);
        if (next > block.timestamp) vm.warp(next);
        try core.settleBatch(pid) {} catch {}
    }

    function repay(uint8 a, bool p1, uint96 units) public guarded {
        bytes32 pid = pools[p1 ? 1 : 0];
        address who = actors[a % 3];
        uint256 free = core.balanceOf(who, pid.rId()) - core.lockedR(who, pid);
        if (free == 0) return;
        uint96 u = uint96(uint256(units) % free) + 1;
        IConfluere.PoolView memory v = core.pool(pid);
        bool allowed = (v.status == Status.Window && block.number < v.windowEnd)
            || (v.key.kind == Kind.American && v.status == Status.Open);
        vm.prank(who);
        try core.repay(pid, u) {}
        catch {
            if (allowed) repayFailed = true;
        }
    }

    function matureBoth() public guarded {
        if (block.timestamp < ANCHOR + WEEK) vm.warp(ANCHOR + WEEK);
        try core.mature(pools[0]) {} catch {}
        try core.mature(pools[1]) {} catch {}
    }

    function bid(uint8 a, bool p1, uint96 units, uint32 surplus) public guarded {
        bytes32 pid = pools[p1 ? 1 : 0];
        uint96 u = uint96(units % 3e18) + 1e15;
        uint64 h = core.findHint(pid, BID, surplus);
        _as(a);
        try core.bid(pid, u, surplus, h) returns (uint64 id) {
            orderIds.push(id);
            orderPools.push(pid);
        } catch {}
    }

    function mine(uint8 n) public guarded {
        vm.roll(block.number + uint256(n) + 1);
    }

    function close(bool p1, uint8 maxBids) public guarded {
        try core.closeWindow(pools[p1 ? 1 : 0], uint256(maxBids % 3) + 1) {} catch {}
    }

    function claim(uint8 a, bool p1) public guarded {
        _as(a);
        try core.claim(pools[p1 ? 1 : 0]) {} catch {}
    }

    function withdraw(uint8 a, bool quote) public guarded {
        _as(a);
        core.withdraw(quote ? address(usdc) : address(weth), actors[a % 3]);
    }

    function pausePool(bool p1, uint8 blocks) public guarded {
        try core.pause(pools[p1 ? 1 : 0], uint64(blocks % 10) + 1) {} catch {}
    }

    // ------------------------------------------------------------ properties

    /// Invariant 1, as equality: every token the core holds is owed to someone exactly once.
    function property_solvencyExact() public view returns (bool) {
        (uint256 escA, uint256 escQ) = _escrows();
        uint256 pa;
        uint256 pq;
        for (uint256 i; i < 2; ++i) {
            IConfluere.PoolView memory v = core.pool(pools[i]);
            pa += v.assetBal;
            pq += v.quoteBal + v.surplusBal + v.feeEscrow;
        }
        uint256 penA = core.pending(address(weth), TREASURY);
        uint256 penQ = core.pending(address(usdc), TREASURY);
        for (uint256 i; i < 3; ++i) {
            penA += core.pending(address(weth), actors[i]);
            penQ += core.pending(address(usdc), actors[i]);
        }
        return weth.balanceOf(address(core)) == escA + pa + penA && usdc.balanceOf(address(core)) == escQ + pq + penQ;
    }

    /// Invariant 2: before close, the pool's asset backs exactly the outstanding R.
    function property_rBackedByAsset() public view returns (bool) {
        for (uint256 i; i < 2; ++i) {
            IConfluere.PoolView memory v = core.pool(pools[i]);
            if (
                (v.status == Status.Open || v.status == Status.Window) && core.totalSupply(pools[i].rId()) != v.assetBal
            ) {
                return false;
            }
        }
        return true;
    }

    /// Invariant 4: no value leaves a pool without burning C or R.
    function property_noValueExtraction() public view returns (bool) {
        return !extracted;
    }

    /// Invariant 5: repayment inside the window always succeeds.
    function property_repayAlwaysWorks() public view returns (bool) {
        return !repayFailed;
    }

    // ------------------------------------------------------------ internals

    function _as(uint8 a) internal {
        vm.prank(actors[a % 3]);
    }

    modifier guarded() {
        uint256[2] memory before = _values();
        uint256[2] memory cs = _supplies(true);
        uint256[2] memory rs = _supplies(false);
        _;
        uint256[2] memory afterV = _values();
        uint256[2] memory cs2 = _supplies(true);
        uint256[2] memory rs2 = _supplies(false);
        for (uint256 i; i < 2; ++i) {
            if (afterV[i] < before[i] && cs2[i] >= cs[i] && rs2[i] >= rs[i]) extracted = true;
        }
    }

    function _values() internal view returns (uint256[2] memory v) {
        for (uint256 i; i < 2; ++i) {
            IConfluere.PoolView memory p = core.pool(pools[i]);
            v[i] = p.quoteBal + p.surplusBal + p.assetBal * p.key.strike / 1e18;
        }
    }

    function _supplies(bool c) internal view returns (uint256[2] memory s) {
        for (uint256 i; i < 2; ++i) {
            s[i] = core.totalSupply(c ? pools[i].cId() : pools[i].rId());
        }
    }

    function _escrows() internal view returns (uint256 a, uint256 q) {
        for (uint256 i; i < orderIds.length; ++i) {
            (address owner, uint8 side, uint96 units,, uint128 escrow,,) = core.order(orderPools[i], orderIds[i]);
            if (owner == address(0)) continue;
            if (side == SELL || side == NC_SELL) a += units;
            else q += escrow;
        }
    }
}
