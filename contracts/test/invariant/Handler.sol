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
    FlashBorrower public borrower = new FlashBorrower();
    mapping(uint64 => bool) internal _locked;

    uint256 public calls;
    bool public valueExtracted; // invariant 4

    struct Snap {
        uint256 value;
        uint256 cSupply;
        uint256 rSupply;
    }

    /// @dev Invariant 4: a pool's value (quote + surplus + asset at K) never falls unless C or R was burned.
    modifier guarded() {
        Snap[] memory before = _snaps();
        _;
        Snap[] memory afterS = _snaps();
        for (uint256 i; i < before.length; ++i) {
            bool burned = afterS[i].cSupply < before[i].cSupply || afterS[i].rSupply < before[i].rSupply;
            if (!burned && afterS[i].value < before[i].value) valueExtracted = true;
        }
    }

    function _snaps() internal view returns (Snap[] memory out) {
        out = new Snap[](pools.length);
        for (uint256 i; i < pools.length; ++i) {
            IConfluere.PoolView memory v = core.pool(pools[i]);
            uint256 scale = 10 ** uint256(v.assetDecimals);
            out[i] = Snap(
                v.quoteBal + v.surplusBal + v.assetBal * v.key.strike / scale,
                core.totalSupply(pools[i].cId()),
                core.totalSupply(pools[i].rId())
            );
        }
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
        (address owner,,,,,,) = core.order(ref.pid, ref.id);
        if (owner == address(0)) return;
        uint256 w = weth.balanceOf(address(core));
        uint256 u = usdc.balanceOf(address(core));
        IConfluere.PoolView memory v = core.pool(ref.pid);
        (,,,,, uint32 deadline,) = core.order(ref.pid, ref.id);
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
                (uint256 pr, uint256 compUnits, uint256 ncUnits) = abi.decode(logs[j].data, (uint256, uint256, uint256));
                if (ncUnits * 2 > compUnits) ncCapViolated = true;
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
        try core.repay(pid, uint96(units)) {}
        catch {
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
        vm.prank(address(0xdead)); // the guardian in Invariants.setUp
        try core.pause(_pool(p), uint64(bound(blocks, 1, 1000))) {} catch {}
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
        try core.closeWindow(pid, bound(maxBids, 1, 3)) {} catch {}
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
