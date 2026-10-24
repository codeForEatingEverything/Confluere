// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Confluere} from "../../src/Confluere.sol";
import {IConfluere} from "../../src/interfaces/IConfluere.sol";
import {PoolKeyLib, Status, Kind} from "../../src/libraries/PoolKey.sol";
import {SELL, BUY, NC_SELL, NC_BUY, BID} from "../../src/libraries/OrderSet.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {IERC3156FlashBorrower} from "@openzeppelin/contracts/interfaces/IERC3156FlashBorrower.sol";

/// @dev Repays every flash loan with the fee; holds tokens minted for the fee only.
contract FlashBorrower is IERC3156FlashBorrower {
    function onFlashLoan(address, address token, uint256 amount, uint256 fee, bytes calldata)
        external
        returns (bytes32)
    {
        MockERC20(token).approve(msg.sender, amount + fee);
        return keccak256("ERC3156FlashBorrower.onFlashLoan");
    }
}

/// @notice Drives random but valid-ish actions against the core and records ghost violations.
contract Handler is Test {
    using PoolKeyLib for bytes32;

    Confluere public core;
    MockERC20 public weth;
    MockERC20 public usdc;
    address public treasury;
    bytes32[] public pools;
    address[] public actors;

    struct Ref {
        bytes32 pid;
        uint64 id;
    }

    Ref[] public refs;

    // ghost flags, each must stay false
    bool public limitViolated;
    bool public ncCapViolated;
    bool public repayFailed;
    bool public pushedDuringNoPushCall;
    bool public windowMisaligned; // blueprint 3.5: every pool of an expiry shares one window
    bool public lockedCancelled; // a live locked order was cancelled
    bool public pauseExtended; // invariant 3c: a running pause was extended
    FlashBorrower public borrower = new FlashBorrower();
    mapping(uint64 => bool) internal _locked;

    uint256 public calls;
    bool public valueExtracted; // invariant 4

    struct Snap {
        uint256 value;
        uint256 cSupply;
        uint256 rSupply;
        uint256 out; // lent + short units: the forfeiture at close swaps them for their margin
    }

    address public constant SPECIALS = address(0x5bec1a15); // Invariants.setUp makes this the core's Specials
    bool public lendingRule; // invariant 3b: a lending call that must fail succeeded
    mapping(bytes32 => uint256) public marginIn; // margin and top-ups escrowed per pool
    mapping(bytes32 => uint256) public marginOut; // margin released, paid to repayers, or forfeited to C holders

    /// @dev Invariant 4: a pool's value (quote + surplus + asset at K) never falls unless C or R was burned.
    modifier guarded() {
        Snap[] memory before = _snaps();
        _;
        Snap[] memory afterS = _snaps();
        for (uint256 i; i < before.length; ++i) {
            bool burned = afterS[i].cSupply < before[i].cSupply || afterS[i].rSupply < before[i].rSupply
                || afterS[i].out < before[i].out;
            if (!burned && afterS[i].value < before[i].value) valueExtracted = true;
        }
    }

    function _snaps() internal view returns (Snap[] memory out) {
        out = new Snap[](pools.length);
        for (uint256 i; i < pools.length; ++i) {
            out[i] = _snap(pools[i]);
        }
    }

    function _snap(bytes32 pid) internal view returns (Snap memory sn) {
        IConfluere.PoolView memory v = core.pool(pid);
        sn.value = v.quoteBal + v.surplusBal + v.assetBal * v.key.strike / 10 ** uint256(v.assetDecimals);
        sn.cSupply = core.totalSupply(pid.cId());
        sn.rSupply = core.totalSupply(pid.rId());
        sn.out = uint256(v.lentUnits) + v.shortUnits;
    }

    constructor(Confluere c, MockERC20 w, MockERC20 u, address t, bytes32[] memory ps, address[] memory as_) {
        core = c;
        weth = w;
        usdc = u;
        treasury = t;
        pools = ps;
        actors = as_;
    }

    function refsLength() external view returns (uint256) {
        return refs.length;
    }

    function poolsLength() external view returns (uint256) {
        return pools.length;
    }

    function actorsLength() external view returns (uint256) {
        return actors.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _pool(uint256 seed) internal view returns (bytes32) {
        return pools[seed % pools.length];
    }

    // ------------------------------------------------------------ actions

    function place(uint256 a, uint256 p, uint256 sideSeed, uint256 units, uint256 limit, uint256 ttl) public {
        _place(a, p, sideSeed, units, limit, ttl, false);
    }

    /// @dev Commitment order (seat obligations): cannot be cancelled while it can still trade.
    function placeLocked(uint256 a, uint256 p, uint256 sideSeed, uint256 units, uint256 limit, uint256 ttl) external {
        _place(a, p, sideSeed % 2, units, limit, ttl, true);
    }

    function _place(uint256 a, uint256 p, uint256 sideSeed, uint256 units, uint256 limit, uint256 ttl, bool locked)
        internal
    {
        calls++;
        bytes32 pid = _pool(p);
        uint8 side = uint8(sideSeed % 4);
        units = bound(units, 1e15, 5e18);
        limit = bound(limit, 25, 32) * 100e6;
        ttl = bound(ttl, 1, 6);
        IConfluere.OrderParams memory op;
        op.side = side;
        op.ttl = uint16(ttl);
        if (side == SELL || side == BUY) {
            op.units = uint96(units);
            op.limit = uint96(limit);
            op.hint = core.findHint(pid, side, uint96(limit));
        } else if (side == NC_SELL) {
            op.units = uint96(units);
        } else {
            op.budget = uint128(units * 3000e6 / 1e18);
        }
        try this.placeAs(_actor(a), pid, op, locked) returns (uint64 id) {
            refs.push(Ref(pid, id));
            _limits[id] = op.limit;
            _sides[id] = side;
            _locked[id] = locked;
        } catch {}
    }

    /// @dev External so `_place` can try/catch either entry point; only callable by the handler itself.
    function placeAs(address who, bytes32 pid, IConfluere.OrderParams memory op, bool locked)
        external
        returns (uint64)
    {
        require(msg.sender == address(this));
        vm.prank(who);
        return locked ? core.placeLockedOrder(pid, op) : core.placeOrder(pid, op);
    }

    /// @dev A sell and a buy in the same pool whose limits overlap, so batches actually clear.
    function placePair(uint256 a, uint256 b, uint256 p, uint256 units, uint256 lo, uint256 spread) external {
        lo = bound(lo, 25, 31);
        uint256 hi = lo + bound(spread, 0, 32 - lo);
        place(a, p, SELL, units, lo, 6);
        place(b, p, BUY, units, hi, 6);
    }

    function cancel(uint256 a, uint256 r) external guarded {
        calls++;
        if (refs.length == 0) return;
        Ref memory ref = refs[r % refs.length];
        (address owner,,,,,,,) = core.order(ref.pid, ref.id);
        if (owner == address(0)) return;
        uint256 w = weth.balanceOf(address(core));
        uint256 u = usdc.balanceOf(address(core));
        IConfluere.PoolView memory v = core.pool(ref.pid);
        (,,,,,, uint32 deadline,) = core.order(ref.pid, ref.id);
        bool live = v.status == Status.Open && block.timestamp < v.key.expiry && deadline > v.settleCount;
        vm.prank(a % 2 == 0 ? owner : _actor(a));
        try core.cancelOrder(ref.pid, ref.id) {
            if (_locked[ref.id] && live) lockedCancelled = true;
        } catch {}
        if (weth.balanceOf(address(core)) != w || usdc.balanceOf(address(core)) != u) pushedDuringNoPushCall = true;
    }

    function settle(uint256) external guarded {
        calls++;
        for (uint256 i; i < pools.length; ++i) {
            _settleOne(pools[i]);
        }
    }

    function _settleOne(bytes32 pid) internal {
        IConfluere.PoolView memory v = core.pool(pid);
        uint256 next = core.nextBatchAt(pid);
        if (v.status != Status.Open || next >= v.key.expiry) return;
        vm.warp(next);

        uint256 w = weth.balanceOf(address(core));
        uint256 u = usdc.balanceOf(address(core));
        vm.recordLogs();
        core.settleBatch(pid);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        if (weth.balanceOf(address(core)) != w || usdc.balanceOf(address(core)) != u) pushedDuringNoPushCall = true;

        uint256 price;
        for (uint256 j; j < logs.length; ++j) {
            if (logs[j].topics[0] == IConfluere.BatchSettled.selector) {
                (uint256 pr, uint256 compUnits, uint256 ncUnits,,, uint256 capBase) =
                    abi.decode(logs[j].data, (uint256, uint256, uint256, uint256, uint256, uint256));
                if (ncUnits * 2 > capBase || compUnits > capBase) ncCapViolated = true;
                filledUnits[pid] += compUnits + ncUnits;
                price = pr;
            }
        }
        if (price == 0) return;
        for (uint256 j; j < logs.length; ++j) {
            if (logs[j].topics[0] != IConfluere.OrderFilled.selector) continue;
            uint64 id = uint64(uint256(logs[j].topics[2]));
            fills++;
            uint8 side = _sides[id];
            uint96 limit = _limits[id];
            if (side == SELL && limit > price) limitViolated = true;
            if (side == BUY && limit < price) limitViolated = true;
        }
    }

    mapping(uint64 => uint96) internal _limits;
    mapping(uint64 => uint8) internal _sides;
    mapping(bytes32 => uint256) public filledUnits;
    uint256 public fills;

    function repay(uint256 a, uint256 p, uint256 units) external guarded {
        calls++;
        bytes32 pid = _pool(p);
        address who = _actor(a);
        uint256 free = core.balanceOf(who, pid.rId()) - core.lockedR(who, pid);
        if (free == 0) return;
        units = bound(units, 1, free);
        IConfluere.PoolView memory v = core.pool(pid);
        uint64 shared = core.expiryWindowEnd(v.key.expiry);
        bool inWindow = (v.status == Status.Window && block.number < v.windowEnd)
            || (v.status == Status.Open && block.timestamp >= v.key.expiry && (shared == 0 || block.number < shared));
        bool allowed =
            inWindow || (v.key.kind == Kind.American && v.status == Status.Open && block.timestamp < v.key.expiry);
        vm.prank(who);
        try core.repay(pid, uint96(units)) returns (uint256, uint256 m) {
            marginOut[pid] += m;
        } catch {
            if (allowed) repayFailed = true;
        }
    }

    function rollover(uint256 a, uint256 units, uint256 minPrice) external guarded {
        calls++;
        bytes32 oldP = pools[0];
        bytes32 newP = pools[1];
        address who = _actor(a);
        uint256 free = core.balanceOf(who, oldP.rId()) - core.lockedR(who, oldP);
        if (free == 0) return;
        units = bound(units, 1, free);
        minPrice = bound(minPrice, 25, 32) * 100e6;
        uint256 topUp = (3000e6 > minPrice ? (units * (3000e6 - minPrice) + 1e18 - 1) / 1e18 : 0) + 20;
        uint64 hint = core.findHint(newP, SELL, uint96(minPrice));
        vm.prank(who);
        try core.rollover(oldP, newP, uint96(units), uint96(minPrice), uint128(topUp), 10, hint) returns (uint64 id) {
            refs.push(Ref(newP, id));
            _limits[id] = uint96(minPrice);
            _sides[id] = SELL;
        } catch {}
    }

    function matureAll() external guarded {
        calls++;
        if (calls < 40) return; // let the books trade for a while first
        IConfluere.PoolView memory v = core.pool(pools[0]);
        if (v.status != Status.Open) return;
        vm.warp(v.key.expiry);
        for (uint256 i; i < pools.length; ++i) {
            try core.mature(pools[i]) {} catch {}
        }
    }

    /// @dev Mature one pool at a time, at different blocks: its window must still end with its expiry's window.
    function matureOne(uint256 p, uint256 gap) external guarded {
        calls++;
        if (calls < 40) return;
        bytes32 pid = _pool(p);
        IConfluere.PoolView memory v = core.pool(pid);
        if (v.status != Status.Open) return;
        if (block.timestamp < v.key.expiry) vm.warp(v.key.expiry);
        vm.roll(block.number + bound(gap, 0, 3000));
        uint64 shared = core.expiryWindowEnd(v.key.expiry); // set by an earlier pool of this expiry, or 0
        core.mature(pid);
        uint64 end = core.pool(pid).windowEnd;
        if (shared != 0 && end != shared) windowMisaligned = true;
        if (shared == 0 && end != block.number + core.WINDOW_BLOCKS()) windowMisaligned = true;
    }

    /// @dev Flash loans of either token: atomic, must leave every pool's value and the accounting untouched.
    function flash(uint256 t, uint256 amount) external guarded {
        calls++;
        MockERC20 token = t % 2 == 0 ? weth : usdc;
        uint256 bal = token.balanceOf(address(core));
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        token.mint(address(borrower), core.flashFee(address(token), amount));
        core.flashLoan(borrower, address(token), amount, "");
    }

    /// @dev Permissionless cleanup: refunds go to pending, nothing is pushed.
    function purge(uint256 r) external guarded {
        calls++;
        if (refs.length == 0) return;
        Ref memory ref = refs[r % refs.length];
        uint64[] memory ids = new uint64[](1);
        ids[0] = ref.id;
        uint256 w = weth.balanceOf(address(core));
        uint256 u = usdc.balanceOf(address(core));
        core.purge(ref.pid, ids);
        if (weth.balanceOf(address(core)) != w || usdc.balanceOf(address(core)) != u) pushedDuringNoPushCall = true;
    }

    function pause(uint256 p, uint256 blocks) external guarded {
        calls++;
        bytes32 pid = _pool(p);
        bool running = block.number < core.pool(pid).pausedUntil;
        vm.prank(address(0xdead)); // the guardian in Invariants.setUp
        try core.pause(pid, uint64(bound(blocks, 1, 600))) {
            if (running) pauseExtended = true;
        } catch {}
    }

    function _marginOwed(bytes32 pid) internal view returns (Status, uint256) {
        IConfluere.PoolView memory v = core.pool(pid);
        return (v.status, uint256(v.lentMargin) + v.shortMargin);
    }

    // ------------------------------------------------------------ Specials lending (invariant 3b)

    /// @dev Lend as Specials: bounded inside the rules most of the time, sometimes past the cap or under the margin
    /// (those must revert), and sometimes from a non-Specials caller (must revert).
    function lend(uint256 p, uint256 units, uint256 extra, uint256 fee, uint256 mode) external guarded {
        calls++;
        bytes32 pid = _pool(p);
        (uint256 u, uint256 margin, bool legal) = _lendArgs(pid, units, extra, mode % 4);
        vm.prank(mode % 4 == 3 ? _actor(mode) : SPECIALS);
        try core.lend(pid, uint96(u), SPECIALS, uint128(margin), uint128(bound(fee, 0, 10e6))) {
            if (!legal) lendingRule = true;
            marginIn[pid] += margin;
        } catch {}
    }

    /// @dev mode 0: inside the rules; 1: past the 50% cap; 2: one wei under the margin floor; 3: not Specials.
    function _lendArgs(bytes32 pid, uint256 units, uint256 extra, uint256 mode)
        internal
        view
        returns (uint256 u, uint256 margin, bool legal)
    {
        IConfluere.PoolView memory v = core.pool(pid);
        uint256 room = v.assetBal / 2 > v.lentUnits ? v.assetBal / 2 - v.lentUnits : 0;
        u = mode == 1 ? room + 1 : bound(units, 1, room == 0 ? 1 : room);
        uint256 need = (u * uint256(v.lastClearingPrice) * 12_000 + 1e22 - 1) / 1e22;
        margin = mode == 2 ? (need == 0 ? 0 : need - 1) : need + bound(extra, 0, 1000e6);
        legal = mode == 0 && room != 0 && v.lastClearingPrice != 0 && v.key.kind == Kind.European
            && v.status == Status.Open && block.timestamp + 12 hours < v.key.expiry && block.number >= v.pausedUntil;
    }

    function returnLent(uint256 p, uint256 units, uint256 all) external guarded {
        calls++;
        bytes32 pid = _pool(p);
        IConfluere.PoolView memory v = core.pool(pid);
        if (v.lentUnits == 0) return;
        bool full = all % 3 == 0;
        units = full ? v.lentUnits : bound(units, 1, v.lentUnits);
        uint256 out = units == v.lentUnits ? v.lentMargin : uint256(v.lentMargin) * units / v.lentUnits;
        vm.prank(SPECIALS);
        try core.returnLent(pid, uint96(units), uint128(out), SPECIALS) {
            marginOut[pid] += out;
            if (block.timestamp + 12 hours >= v.key.expiry) lendingRule = true;
        } catch {}
    }

    function topUpLent(uint256 p, uint256 amount) external guarded {
        calls++;
        bytes32 pid = _pool(p);
        amount = bound(amount, 1, 100e6);
        vm.prank(SPECIALS);
        try core.topUpLent(pid, uint128(amount)) {
            marginIn[pid] += amount;
        } catch {}
    }

    /// @dev Jump past a pool's lending cutoff (but before its expiry) so short units get recorded.
    function warpPastCutoff(uint256 p) external guarded {
        calls++;
        IConfluere.PoolView memory v = core.pool(_pool(p));
        if (block.timestamp + 12 hours < v.key.expiry) vm.warp(v.key.expiry - 6 hours);
    }

    function placeBid(uint256 a, uint256 p, uint256 units, uint256 surplus) external guarded {
        calls++;
        bytes32 pid = _pool(p);
        units = bound(units, 1e15, 3e18);
        surplus = bound(surplus, 0, 300e6);
        uint64 hint = core.findHint(pid, BID, uint96(surplus));
        vm.prank(_actor(a));
        try core.bid(pid, uint96(units), uint96(surplus), hint) returns (uint64 id) {
            refs.push(Ref(pid, id));
        } catch {}
    }

    function rollBlocks(uint256 n) external guarded {
        calls++;
        vm.roll(block.number + bound(n, 1, 4000));
    }

    function close(uint256 p, uint256 maxBids) external guarded {
        calls++;
        bytes32 pid = _pool(p);
        uint256 w = weth.balanceOf(address(core));
        uint256 u = usdc.balanceOf(address(core));
        (Status st, uint256 owed) = _marginOwed(pid);
        try core.closeWindow(pid, bound(maxBids, 1, 3)) {
            if (st == Status.Window) marginOut[pid] += owed; // forfeited to C holders when the window closes
        } catch {}
        if (weth.balanceOf(address(core)) != w || usdc.balanceOf(address(core)) != u) pushedDuringNoPushCall = true;
    }

    function claim(uint256 a, uint256 p) external guarded {
        calls++;
        vm.prank(_actor(a));
        try core.claim(_pool(p)) {} catch {}
    }

    function withdraw(uint256 a, uint256 t) external guarded {
        calls++;
        vm.prank(_actor(a));
        core.withdraw(t % 2 == 0 ? address(weth) : address(usdc), _actor(a));
    }

    function transferPosition(uint256 a, uint256 b, uint256 p, uint256 amt, bool isR) external guarded {
        calls++;
        bytes32 pid = _pool(p);
        address from = _actor(a);
        uint256 id = isR ? pid.rId() : pid.cId();
        uint256 bal = core.balanceOf(from, id);
        if (bal == 0) return;
        vm.prank(from);
        try core.transfer(_actor(b), id, bound(amt, 1, bal)) {} catch {}
    }
}
