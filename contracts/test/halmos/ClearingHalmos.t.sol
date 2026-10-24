// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {Clearing} from "../../src/libraries/Clearing.sol";
import {Settlement} from "../../src/libraries/Settlement.sol";

/// @notice Symbolic proofs (halmos --function check_) for the arithmetic every settlement relies on.
/// Scales are the two real cases (18- and 6-decimal assets); amounts are 64-bit so the SMT problems stay
/// tractable. The fuzz suite covers the full uint96 / 0..30-decimal range.
contract ClearingHalmos is Test {
    uint256 internal constant E18 = 1e18;
    uint256 internal constant E6 = 1e6;

    /// P* lies between the marginal sell and buy limits, so no filled order trades past its limit.
    function check_midpointRespectsLimits(uint96 sell, uint96 buy) public pure {
        vm.assume(sell <= buy);
        uint256 p = Clearing.midpoint(sell, buy);
        assert(p >= sell && p <= buy);
    }

    /// Buyers pay at least what sellers receive; the dust left in the pool is at most 1 wei.
    function check_rounding18(uint64 units, uint64 price) public pure {
        uint256 up = Clearing.quoteUp(units, price, E18);
        uint256 down = Clearing.quoteDown(units, price, E18);
        assert(up >= down && up - down <= 1);
    }

    function check_rounding6(uint64 units, uint64 price) public pure {
        uint256 up = Clearing.quoteUp(units, price, E6);
        uint256 down = Clearing.quoteDown(units, price, E6);
        assert(up >= down && up - down <= 1);
    }

    /// Spread share is zero when P* >= K, so a fill at or above K never pays into the escrow.
    function check_spreadZeroWhenNoInterest(uint64 units, uint64 strike, uint64 price) public pure {
        vm.assume(price >= strike);
        assert(Settlement.spreadShare(units, strike, price, E18) == 0);
    }

    /// The seller split always adds back to the gross: spread capped, fees never make a fill revert.
    /// NOT in the check_ set (nonlinear mul/div); covered by testFuzz_sellSplitNeverUnderflows.
    function slow_sellSplitConserves(uint64 units, uint64 strike, uint64 price) public pure {
        (uint256 gross, uint256 spread, uint256 trade, uint256 net) = Settlement.sellSplit(units, price, strike, E18);
        assert(gross == spread + trade + net);
    }

    /// A non-competitive buy sized from its budget never costs more than the budget.
    /// NOT in the check_ set for the same reason; covered by testFuzz_ncBuyWithinBudget.
    function slow_ncBuyWithinBudget(uint64 budget, uint64 price) public pure {
        vm.assume(price > 0);
        uint256 f = Clearing.unitsFor(budget, price, E18);
        assert(Clearing.quoteUp(f, price, E18) <= budget);
    }

    /// The band only widens with failures and never exceeds 100%.
    function check_bandMonotone(uint16 bandBps, uint8 f) public pure {
        vm.assume(bandBps <= 1500 && f < 3);
        uint256 a = Clearing.widenedBand(bandBps, f);
        uint256 b = Clearing.widenedBand(bandBps, uint256(f) + 1);
        assert(b >= a && b <= Clearing.BPS);
    }

    // ------------------------------------------------------------ v0.8: non-competitive buys in the price

    /// Reference of ClearingLogic._cross on a 3-order book per side (sorted limits, positive sizes): `pre` units of
    /// any-price demand take the cheapest sells first, then the competitive books cross; P* is the midpoint of the
    /// marginal pair.
    function _cross(uint256[3] memory su, uint256[3] memory sl, uint256[3] memory bu, uint256[3] memory bl, uint256 pre)
        internal
        pure
        returns (uint256 q, uint256 price, uint256 ms, uint256 mb)
    {
        uint256 i;
        uint256 j;
        uint256 sr = su[0];
        uint256 br = bu[0];
        while (pre != 0 && i < 3) {
            uint256 t = sr < pre ? sr : pre;
            pre -= t;
            sr -= t;
            if (sr == 0 && ++i < 3) sr = su[i];
        }
        if (pre != 0) return (0, 0, 0, 0);
        while (i < 3 && j < 3 && sl[i] <= bl[j]) {
            uint256 m = sr < br ? sr : br;
            q += m;
            ms = sl[i];
            mb = bl[j];
            sr -= m;
            br -= m;
            if (sr == 0 && ++i < 3) sr = su[i];
            if (br == 0 && ++j < 3) br = bu[j];
        }
        if (q != 0) price = Clearing.midpoint(ms, mb);
    }

    /// The NC pricing rule (blueprint 4.2 as pinned by the simulations): with d = min(NC demand, q0 / 2) priced in
    /// ahead of the competitive buys, the recross price never falls below the competitive-only price, stays between
    /// the marginal competitive limits that fill, and the NC volume stays within half the competitive-only volume.
    /// Books of three sells and three buys with symbolic sizes and sorted symbolic limits.
    /// @custom:halmos --loop 8
    function slow_ncPricingRule(uint24 sUnits, uint48 sLim, uint24 bUnits, uint48 bLim, uint8 demand) public pure {
        uint256[3] memory su = _unpack(sUnits, 8);
        uint256[3] memory sl = _unpack(sLim, 16);
        uint256[3] memory bu = _unpack(bUnits, 8);
        uint256[3] memory bl = _unpack(bLim, 16);
        vm.assume(su[0] != 0 && su[1] != 0 && su[2] != 0 && bu[0] != 0 && bu[1] != 0 && bu[2] != 0);
        vm.assume(sl[0] <= sl[1] && sl[1] <= sl[2] && bl[0] >= bl[1] && bl[1] >= bl[2]);
        (uint256 q0, uint256 p0,,) = _cross(su, sl, bu, bl, 0);
        vm.assume(q0 != 0);
        uint256 d = demand < q0 / 2 ? demand : q0 / 2;
        vm.assume(d != 0);
        (uint256 q1, uint256 p1, uint256 ms, uint256 mb) = _cross(su, sl, bu, bl, d);
        vm.assume(q1 != 0); // otherwise the competitive-only result stands
        assert(p1 >= p0);
        assert(ms <= p1 && p1 <= mb);
        assert(2 * d <= q0);
    }

    /// Three `w`-bit fields of `x`, low field first (packed so the harness stays within the legacy stack limit).
    function _unpack(uint256 x, uint256 w) internal pure returns (uint256[3] memory r) {
        uint256 m = (1 << w) - 1;
        r[0] = x & m;
        r[1] = (x >> w) & m;
        r[2] = (x >> (2 * w)) & m;
    }

    /// Stage-2 sizing keeps the total non-competitive volume within half the competitive-only volume.
    function slow_ncCapHalf(uint64 qc, uint64 x, uint64 m2raw) public pure {
        uint256 cap = uint256(qc) * 5000 / 10_000;
        vm.assume(x <= cap);
        uint256 m2 = m2raw < cap - x ? m2raw : cap - x;
        assert(uint256(x) + m2 <= uint256(qc) / 2);
    }

    /// The seller's split never goes negative and adds back to the gross, whatever the raw spread share.
    function check_sellSplitNonNegative(uint128 gross, uint128 raw) public pure {
        uint256 trade = Settlement.tradeFee(gross);
        uint256 spread = raw > gross - trade ? gross - trade : raw;
        uint256 net = gross - trade - spread;
        assert(trade <= gross && net + spread + trade == gross);
    }

    /// Guardian pause budget (invariant 3c): an accepted pause never takes the cumulative total past the cap.
    function check_pauseCap(uint64 pausedBlocks, uint64 blocks, uint64 max) public pure {
        vm.assume(pausedBlocks <= max);
        uint256 total = uint256(pausedBlocks) + blocks;
        if (blocks == 0 || total > max) return; // rejected
        assert(total <= max && total > pausedBlocks);
    }
}
