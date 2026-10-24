// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Base} from "../utils/Base.sol";
import {IConfluere} from "../../src/interfaces/IConfluere.sol";
import {Settlement} from "../../src/libraries/Settlement.sol";
import {Clearing} from "../../src/libraries/Clearing.sol";
import {Grid, GridConfig} from "../../src/libraries/Grid.sol";

contract ClearingFuzzTest is Base {
    uint256[] internal sl;
    uint256[] internal su;
    uint256[] internal bl;
    uint256[] internal bu;

    /// @dev Volume must equal max_p min(S(p), D(p)) over all candidate prices; every fill respects its limit.
    function testFuzz_volumeMatchesReference(uint256 seed) public {
        bytes32 pid = _create();
        _placeRandom(pid, seed);
        _settle(pid);
        uint256 rSupply = core.totalSupply(_r(pid));
        assertEq(rSupply, _reference(), "volume == reference max crossing");
        assertEq(core.totalSupply(_c(pid)), rSupply, "C == R");
        assertEq(core.pool(pid).assetBal, rSupply);
        assertEq(
            usdc.balanceOf(address(core)),
            _pendQ() + _escQ(pid) + core.pool(pid).quoteBal + core.pool(pid).feeEscrow,
            "quote conserved"
        );
    }

    function _placeRandom(bytes32 pid, uint256 seed) internal {
        uint256 n = 1 + seed % 6;
        uint256 m = 1 + (seed >> 8) % 6;
        for (uint256 i; i < n; ++i) {
            sl.push((25 + uint256(keccak256(abi.encode(seed, "sl", i))) % 9) * 100e6);
            su.push(1e15 + uint256(keccak256(abi.encode(seed, "su", i))) % 5e18);
            _sell(i % 2 == 0 ? alice : dave, pid, su[i], sl[i]);
        }
        for (uint256 i; i < m; ++i) {
            bl.push((25 + uint256(keccak256(abi.encode(seed, "bl", i))) % 9) * 100e6);
            bu.push(1e15 + uint256(keccak256(abi.encode(seed, "bu", i))) % 5e18);
            _buy(i % 2 == 0 ? bob : carol, pid, bu[i], bl[i]);
        }
    }

    function _reference() internal view returns (uint256 best) {
        for (uint256 c; c < sl.length + bl.length; ++c) {
            uint256 p = c < sl.length ? sl[c] : bl[c - sl.length];
            uint256 sv;
            uint256 dv;
            for (uint256 i; i < sl.length; ++i) {
                if (sl[i] <= p) sv += su[i];
            }
            for (uint256 i; i < bl.length; ++i) {
                if (bl[i] >= p) dv += bu[i];
            }
            uint256 v = sv < dv ? sv : dv;
            if (v > best) best = v;
        }
    }

    function _pendQ() internal view returns (uint256) {
        return _pend(address(usdc), alice) + _pend(address(usdc), dave) + _pend(address(usdc), bob)
            + _pend(address(usdc), carol) + _pend(address(usdc), treasury);
    }

    function _escQ(bytes32 pid) internal view returns (uint256 escQ) {
        for (uint64 id = 1; id < 20; ++id) {
            (address owner, uint8 side,,, uint128 esc,,) = core.order(pid, id);
            if (owner != address(0) && side == 1) escQ += esc;
        }
    }

    function testFuzz_sellSplitNeverUnderflows(uint96 units, uint96 price, uint96 strike, uint8 dec) public pure {
        uint256 scale = 10 ** uint256(bound(dec, 0, 30));
        (uint256 gross, uint256 spread, uint256 trade, uint256 net) = Settlement.sellSplit(units, price, strike, scale);
        assertEq(gross, spread + trade + net);
        if (price >= strike) assertEq(spread, 0);
        assertLe(spread, Settlement.spreadShare(units, strike, price, scale));
    }

    function testFuzz_roundingFavoursPool(uint96 units, uint96 price, uint8 dec) public pure {
        uint256 scale = 10 ** uint256(bound(dec, 0, 30));
        assertGe(Clearing.quoteUp(units, price, scale), Clearing.quoteDown(units, price, scale));
        assertLe(Clearing.quoteUp(units, price, scale) - Clearing.quoteDown(units, price, scale), 1);
    }

    function testFuzz_ncBuyWithinBudget(uint128 budget, uint96 price, uint8 dec) public pure {
        vm.assume(price > 0);
        uint256 scale = 10 ** uint256(bound(dec, 0, 30));
        uint256 f = Clearing.unitsFor(budget, price, scale);
        vm.assume(f <= type(uint96).max);
        assertLe(Clearing.quoteUp(f, price, scale), budget);
    }

    /// Solady's mulDiv equals plain arithmetic where the plain form cannot overflow: carries PlainMathHalmos over.
    function testFuzz_soladyMatchesPlain(uint64 a, uint64 b, uint64 c) public pure {
        uint256 s = 1e18;
        assertEq(Clearing.quoteDown(a, b, s), uint256(a) * b / s);
        assertEq(Clearing.quoteUp(a, b, s), (uint256(a) * b + s - 1) / s);
        if (b > 0) assertEq(Clearing.unitsFor(a, b, s), uint256(a) * s / b);
        if (c > b) assertEq(Settlement.spreadShare(a, c, b, s), uint256(a) * (c - b) * 500 / (s * 10_000));
        assertEq(Settlement.repayAmount(a, c, s), (uint256(a) * c + s - 1) / s);
    }

    function testFuzz_midpointBetween(uint96 a, uint96 b) public pure {
        (uint256 lo, uint256 hi) = a <= b ? (uint256(a), uint256(b)) : (uint256(b), uint256(a));
        uint256 p = Clearing.midpoint(lo, hi);
        assertGe(p, lo);
        assertLe(p, hi);
    }

    function testFuzz_gridStrike(uint64 mantissa, uint8 zeros) public pure {
        GridConfig memory g = GridConfig(0, 1, 1, 1, 2);
        uint256 m_ = bound(mantissa, 1, 99);
        uint256 z = bound(zeros, 0, 20);
        assertTrue(Grid.isGridStrike(g, m_ * 10 ** z));
        uint256 three = bound(mantissa, 101, 999);
        if (three % 10 != 0) assertFalse(Grid.isGridStrike(g, three * 10 ** z));
    }
}
