// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Base} from "../utils/Base.sol";
import {IConfluere} from "../../src/interfaces/IConfluere.sol";
import {PoolKey, Kind} from "../../src/libraries/PoolKey.sol";
import {Grid} from "../../src/libraries/Grid.sol";

/// @notice The 1% log strike grid (blueprint 3.3): K = floor(10^qd * 1.01^n) with the integer routine the SDK copies.
contract LogGridTest is Base {
    /// Vectors computed independently (Python, same integer algorithm); the SDK asserts the same table.
    function test_vectors() public pure {
        assertEq(Grid.strikeAt(0, 6), 1_000_000);
        assertEq(Grid.strikeAt(1, 6), 1_010_000);
        assertEq(Grid.strikeAt(-1, 6), 990_099);
        assertEq(Grid.strikeAt(-2, 6), 980_296);
        assertEq(Grid.strikeAt(-3, 6), 970_590);
        assertEq(Grid.strikeAt(-384, 6), 21_907);
        assertEq(Grid.strikeAt(434, 6), 75_071_695);
        assertEq(Grid.strikeAt(769, 6), 2_104_439_470);
        assertEq(Grid.strikeAt(773, 6), 2_189_888_152);
        assertEq(Grid.strikeAt(805, 6), 3_010_966_302);
        assertEq(Grid.strikeAt(806, 6), 3_041_075_965);
        assertEq(Grid.strikeAt(1157, 6), 99_960_740_922);
        assertEq(Grid.strikeAt(-7, 18), 932_718_054_707_135_373);
        assertEq(Grid.strikeAt(-8, 18), 923_483_222_482_312_251);
        assertEq(Grid.strikeAt(-11, 18), 896_323_717_517_805_234);
        assertEq(Grid.strikeAt(-453, 18), 11_025_992_086_967_947);
        assertLe(Grid.strikeAt(2522, 18), type(uint96).max);
        assertGt(Grid.strikeAt(2523, 18), type(uint96).max);
    }

    function test_createPool_storesIndex() public {
        bytes32 pid = _create();
        assertEq(core.pool(pid).strikeIndex, K_INDEX);
    }

    function test_rejectsOffGrid() public {
        vm.expectRevert(IConfluere.InvalidParams.selector);
        core.createPool(_key(K + 1, Kind.American, E1), K_INDEX, _noOpts());
    }

    function test_rejectsWrongIndex() public {
        vm.expectRevert(IConfluere.InvalidParams.selector);
        core.createPool(_key(K, Kind.American, E1), K_INDEX + 1, _noOpts());
    }

    /// Below ~100 base units neighbouring indices round to the same strike; only the smallest index is canonical.
    function test_rejectsNonCanonicalIndex() public {
        int256 n = -1000;
        while (Grid.strikeAt(n, 6) != Grid.strikeAt(n + 1, 6)) ++n;
        uint256 k = Grid.strikeAt(n, 6);
        (int256 canon, bool ok) = Grid.indexOf(k, 6);
        assertTrue(ok);
        assertEq(canon, n);
        assertTrue(Grid.isGridStrike(k, n, 6));
        assertFalse(Grid.isGridStrike(k, n + 1, 6));
        vm.expectRevert(IConfluere.InvalidParams.selector);
        core.createPool(_key(uint128(k), Kind.American, E1), int16(n + 1), _noOpts());
        core.createPool(_key(uint128(k), Kind.American, E1), int16(n), _noOpts());
    }

    function test_rejectsIndexOutOfRange() public pure {
        assertFalse(Grid.isGridStrike(Grid.strikeAt(4096, 0), 4096, 0));
        assertFalse(Grid.isGridStrike(Grid.strikeAt(-4096, 30), -4096, 30));
    }

    function test_rejectsAboveUint96() public pure {
        uint256 k = Grid.strikeAt(2523, 18);
        assertFalse(Grid.isGridStrike(k, 2523, 18));
        assertTrue(Grid.isGridStrike(Grid.strikeAt(2522, 18), 2522, 18));
    }

    function test_indexOf_roundTrips() public pure {
        (int256 n, bool ok) = Grid.indexOf(3_010_966_302, 6);
        assertTrue(ok);
        assertEq(n, 805);
        (, ok) = Grid.indexOf(3000e6, 6);
        assertFalse(ok);
    }
}
