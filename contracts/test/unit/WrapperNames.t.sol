// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Base} from "../utils/Base.sol";
import {IConfluere} from "../../src/interfaces/IConfluere.sol";
import {Confluere} from "../../src/Confluere.sol";
import {Kind, PoolKey} from "../../src/libraries/PoolKey.sol";
import {ERC6909Wrapper, ERC6909WrapperFactory} from "../../src/periphery/ERC6909Wrapper.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";

/// @notice Wrapper names derived from the pool key.
contract WrapperNamesTest is Base {
    /// Expiries less than a day apart carry the UTC time (the app's -HHMM when two maturities share a day).
    function test_wrapper_subDailyGridNamesCarryTime() public {
        Confluere.Config memory cfg = _config();
        cfg.grid.period = 1 hours;
        cfg.lendCutoff = 10 minutes;
        Confluere hourly = new Confluere(cfg);
        weth.approve(address(hourly), 1);
        usdc.approve(address(hourly), 1);
        // now = 2026-10-10 08:00 UTC; next hourly expiry 09:00
        bytes32 id =
            _createKey(IConfluere(address(hourly)), _key(K, Kind.European, ANCHOR + 1 days + 1 hours), _noOpts());
        ERC6909WrapperFactory f = new ERC6909WrapperFactory(IConfluere(address(hourly)));
        ERC6909Wrapper w = ERC6909Wrapper(f.create(uint256(id) | 1));
        assertEq(w.symbol(), "R-WETH-10OCT-0900");
        assertEq(w.name(), "Confluere R WETH/USDC 10 Oct 2026, 09:00 UTC");
    }

    /// A token whose symbol() reverts, returns bytes32, burns gas or carries spoofing characters cannot break or
    /// spoof the wrapper's strings.
    function test_wrapper_hostileSymbols() public {
        ERC6909WrapperFactory f = new ERC6909WrapperFactory(core);
        assertEq(_wrapped(f, new OddSymbol(0)).symbol(), "C-?-16OCT", "reverts");
        assertEq(_wrapped(f, new OddSymbol(1)).symbol(), "C-MKR-16OCT", "bytes32");
        assertEq(_wrapped(f, new OddSymbol(2)).symbol(), "C-?-16OCT", "gas bomb");
        ERC6909Wrapper w = _wrapped(f, new OddSymbol(3));
        assertEq(w.symbol(), "C-USDCxofficialABC-16OCT", "filtered and capped");
        assertEq(w.name(), "Confluere C USDCxofficialABC/USDC 16 Oct 2026");
        assertEq(ERC6909Wrapper(f.create(uint256(keccak256("no pool")) & ~uint256(1))).symbol(), "C-?-01JAN");
    }

    function _wrapped(ERC6909WrapperFactory f, OddSymbol t) internal returns (ERC6909Wrapper) {
        PoolKey memory k = _key(K, Kind.American, E1);
        k.asset = address(t);
        t.mint(address(this), 1);
        t.approve(address(core), 1);
        return ERC6909Wrapper(f.create(uint256(_createKey(core, k, _noOpts()))));
    }
}

/// @notice Token with a misbehaving symbol(): 0 reverts, 1 returns bytes32, 2 burns all gas, 3 returns spoofing text.
contract OddSymbol is MockERC20 {
    uint8 internal immutable mode;

    constructor(uint8 m) MockERC20("Odd", "ODD", 18) {
        mode = m;
    }

    function symbol() public view override returns (string memory) {
        if (mode == 0) revert("no");
        if (mode == 1) {
            assembly ("memory-safe") {
                mstore(0, "MKR")
                return(0, 32)
            }
        }
        if (mode == 2) {
            while (true) {}
        }
        return "USDC\u2009x official/ABCDEFGHIJ";
    }
}
