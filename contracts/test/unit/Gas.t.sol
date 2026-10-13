// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Base} from "../utils/Base.sol";
import {Confluere} from "../../src/Confluere.sol";
import {NC_SELL, NC_BUY} from "../../src/libraries/OrderSet.sol";
import {console2} from "forge-std/Test.sol";

/// @notice Worst-case settlement gas with full books, to size MAX_ORDERS_PER_SIDE per chain.
contract GasTest is Base {
    function _config() internal view override returns (Confluere.Config memory c) {
        c = super._config();
        c.maxOrdersPerSide = 128;
    }

    function _fullBook(uint256 n) internal returns (bytes32 pid) {
        pid = _create();
        for (uint256 i; i < n; ++i) {
            _sell(i % 2 == 0 ? alice : dave, pid, 1e16, 2800e6 + (i % 10) * 10e6);
            _buy(i % 2 == 0 ? bob : carol, pid, 1e16, 2950e6 - (i % 10) * 10e6);
        }
    }

    function test_gas_settle_32() public {
        _measure(32);
    }

    function test_gas_settle_64() public {
        _measure(64);
    }

    function test_gas_settle_128() public {
        _measure(128);
    }

    function _measure(uint256 n) internal {
        bytes32 pid = _fullBook(n);
        vm.warp(core.nextBatchAt(pid));
        uint256 g = gasleft();
        core.settleBatch(pid);
        console2.log("orders per side", n, "settle gas", g - gasleft());
        assertGt(core.totalSupply(_r(pid)), n * 1e16 / 2);
    }
}
