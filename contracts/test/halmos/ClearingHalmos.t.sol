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
}
