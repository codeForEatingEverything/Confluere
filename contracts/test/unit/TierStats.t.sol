// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Base} from "../utils/Base.sol";
import {IConfluere} from "../../src/interfaces/IConfluere.sol";
import {Kind, PoolKeyLib} from "../../src/libraries/PoolKey.sol";
import {Clearing} from "../../src/libraries/Clearing.sol";

/// @notice Per-tier traded volume and the main tier (ARCH 2.8, spec 2.5).
contract TierStatsTest is Base {
    bytes32 internal m;

    function setUp() public override {
        super.setUp();
        m = PoolKeyLib.marketId(address(weth), address(usdc), Kind.American);
    }

    function _trade(bytes32 pid, uint256 units, uint256 price) internal {
        _sell(alice, pid, units, price);
        _buy(bob, pid, units, price);
        _settle(pid);
    }

    function _tv(uint128 strike, uint16 band, uint8 cad) internal view returns (uint256) {
        return core.tierVolume(m, E1, PoolKeyLib.tierKey(strike, band, cad));
    }

    function test_mainTier_followsLargestVolume() public {
        bytes32 a = _create(K, Kind.American, E1);
        bytes32 b = _create(K_HI, Kind.American, E1);
        _trade(a, ONE, 2900e6);
        IConfluere.MarketStats memory st = core.marketStats(m, E1);
        assertEq(st.mainStrike, K);
        assertEq(st.mainIndex, K_INDEX);
        _trade(b, 2 * ONE, 2900e6);
        st = core.marketStats(m, E1);
        assertEq(st.mainStrike, K_HI);
        assertEq(st.mainIndex, 808);
        assertEq(st.mainBand, 800);
        assertEq(st.mainCadence, 0);
        assertEq(st.mainVolume, _tv(K_HI, 800, 0));
        assertEq(st.volume, _tv(K, 800, 0) + _tv(K_HI, 800, 0));
        assertEq(_tv(K, 800, 0), 2900e6);
        assertEq(_tv(K_HI, 800, 0), 5800e6);
    }

    function test_mainTier_tieKeepsFirst() public {
        bytes32 a = _create(K, Kind.American, E1);
        bytes32 b = _create(K_HI, Kind.American, E1);
        _trade(a, ONE, 2900e6);
        _trade(b, ONE, 2900e6);
        assertEq(core.marketStats(m, E1).mainStrike, K, "equal volume: the first tier stays main");
    }

    function test_tierKey_separatesBandAndCadence() public {
        bytes32 a = _create(K, Kind.American, E1);
        bytes32 b = _createKey(core, _keyT(K, Kind.American, E1, 1500, 0), _noOpts());
        bytes32 c = _createKey(core, _keyT(K, Kind.American, E1, 800, 1), _noOpts());
        _trade(a, ONE, 2900e6);
        _trade(b, 2 * ONE, 2900e6);
        _trade(c, 3 * ONE, 2900e6);
        assertEq(_tv(K, 800, 0), 2900e6);
        assertEq(_tv(K, 1500, 0), 5800e6);
        assertEq(_tv(K, 800, 1), 8700e6);
        IConfluere.MarketStats memory st = core.marketStats(m, E1);
        assertEq(st.mainBand, 800);
        assertEq(st.mainCadence, 1);
        assertEq(st.volume, 17_400e6);
        assertTrue(PoolKeyLib.tierKey(K, 800, 0) != PoolKeyLib.tierKey(K, 800, 1));
    }

    function test_tierVolume_perExpiry() public {
        bytes32 a = _create(K, Kind.American, E1);
        bytes32 b = _create(K, Kind.American, E2);
        _trade(a, ONE, 2900e6);
        _trade(b, ONE, 2950e6);
        assertEq(_tv(K, 800, 0), 2900e6);
        assertEq(core.tierVolume(m, E2, PoolKeyLib.tierKey(K, 800, 0)), Clearing.quoteDown(ONE, 2950e6, ONE));
    }

    function testFuzz_mainIsArgmax(uint8[6] memory sizes, uint8[6] memory which) public {
        bytes32[3] memory ps =
            [_create(K, Kind.American, E1), _create(K_HI, Kind.American, E1), _create(K_LO, Kind.American, E1)];
        uint128[3] memory ks = [K, K_HI, K_LO];
        for (uint256 i; i < sizes.length; ++i) {
            uint256 u = (uint256(sizes[i]) % 4 + 1) * 1e17;
            _trade(ps[which[i] % 3], u, 2700e6);
        }
        IConfluere.MarketStats memory st = core.marketStats(m, E1);
        uint256 max;
        for (uint256 i; i < 3; ++i) {
            uint256 v = _tv(ks[i], 800, 0);
            if (v > max) max = v;
        }
        assertEq(st.mainVolume, max, "main volume is the largest tier volume");
        assertEq(_tv(st.mainStrike, st.mainBand, st.mainCadence), max);
    }
}
