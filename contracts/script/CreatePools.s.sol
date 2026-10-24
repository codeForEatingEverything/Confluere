// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Confluere} from "../src/Confluere.sol";
import {IConfluere} from "../src/interfaces/IConfluere.sol";
import {PoolKey, PoolKeyLib, Kind, Status} from "../src/libraries/PoolKey.sol";
import {GridConfig} from "../src/libraries/Grid.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {DeployConfig} from "./DeployConfig.sol";

/// @notice Opens the launch pools on the nearest expiry: per pair 2 strikes x 2 kinds. Monad testnet: shMON/WMON and
/// WMON/USDC (8 pools). HyperEVM testnet: WHYPE/USDC and the extra pair USDC/WHYPE (8 pools; LST=0, no mintable LST
/// there, so the extra pair is how the native coin is lent on that chain). Sepolia: wstETH/WETH and WETH/USDC, plus
/// the extra pair wstETH/USDC.
/// Optional extra pair (env EXTRA_ASSET, EXTRA_QUOTE, EXTRA_STRIKE_LOW / EXTRA_STRIKE_HIGH, EXTRA_BAND default 800 bps;
/// none when EXTRA_ASSET is unset or zero): 2 strikes x 2 kinds more, listed after the launch pairs' pools, and recorded
/// as `.pools.extraAsset` / `.pools.extraQuote` for Seed.s.sol and CreateVaults.s.sol.
/// Token addresses come from env (LST, NATIVE, USDC): real tokens on every public chain. Mock tokens (the ones
/// Deploy.s.sol wrote with MOCKS=true, or fresh stand-ins with MOCKS=true here) exist on anvil only.
/// Idempotent: a pool that already exists is kept (and listed), not created again, so a failed run can be repeated
/// and scripts/roll-testnet.sh can run twice inside one period. Writes deployments/<chain>.json `.pools` (or
/// DEPLOYMENTS_FILE, see DeployConfig.deploymentsFile).
/// Env EXPIRY (optional, 0 = unset): open this grid expiry instead of the nearest one. scripts/roll-testnet.sh passes
/// the expiry one period after the previous roll's, so its runs open consecutive expiries (graduation needs four in a
/// row) however early they start; it must be on the grid, listable, and at least a quarter period ahead.
/// Env LATER_EXPIRIES (optional, comma-separated grid expiries): the same pools are also opened at each of these
/// (same checks as EXPIRY), listed after the first expiry's pools in `.pools.poolIds` and recorded with it in
/// `.pools.expiries`; `.pools.expiry` stays the first one (scripts/roll-testnet.sh continues the daily chain from it).
/// A pair whose two strikes are equal opens one strike (2 pools per expiry instead of 4, never the same id twice).
contract CreatePools is Script {
    struct Pair {
        address asset;
        address quote;
        uint128[2] strikes;
    }

    function run() external {
        require(!vm.envOr("MOCKS", false) || block.chainid == DeployConfig.ANVIL, "mocks: anvil only");
        string memory path = _path();
        Confluere core = Confluere(vm.parseJsonAddress(vm.readFile(path), ".confluere"));
        uint64[] memory expiries = _expiries(core); // checked before anything is broadcast
        vm.startBroadcast();
        (address lst, address native, address usdc) = _tokens(core);
        Pair memory extra = _extra(core);
        bytes32[] memory ids = new bytes32[](12 * expiries.length);
        uint256 n;
        for (uint256 i; i < expiries.length; ++i) {
            n = _create(core, lst, native, usdc, extra, expiries[i], ids, n);
        }
        assembly ("memory-safe") {
            mstore(ids, n) // shrink to the pools actually listed
        }
        vm.stopBroadcast();
        uint256[] memory all = new uint256[](expiries.length);
        for (uint256 i; i < expiries.length; ++i) {
            all[i] = expiries[i];
        }

        string memory k2 = "pools";
        if (extra.asset != address(0)) {
            vm.serializeAddress(k2, "extraAsset", extra.asset);
            vm.serializeAddress(k2, "extraQuote", extra.quote);
        }
        vm.serializeAddress(k2, "lst", lst);
        vm.serializeAddress(k2, "native", native);
        vm.serializeAddress(k2, "usdc", usdc);
        vm.serializeUint(k2, "expiry", expiries[0]);
        vm.serializeUint(k2, "expiries", all);
        string memory out = vm.serializeBytes32(k2, "poolIds", ids);
        vm.writeJson(out, path, ".pools");
        console2.log("pools created", ids.length, "expiry", expiries[0]);
    }

    /// @dev Token source, in order: env LST / NATIVE / USDC; the demo tokens Deploy.s.sol wrote (minted to the
    /// caller, mock only); legacy MOCKS=true deploys fresh stand-ins.
    function _tokens(Confluere core) internal returns (address lst, address native, address usdc) {
        string memory json = vm.readFile(_path());
        (, address me,) = vm.readCallers(); // the broadcaster, also when this script is driven by another one
        if (vm.envOr("USDC", address(0)) != address(0)) {
            lst = vm.envOr("LST", address(0)); // zero: no LST on this chain, so no loop pair
            native = vm.envAddress("NATIVE");
            usdc = vm.envAddress("USDC");
        } else if (vm.keyExistsJson(json, ".tokens")) {
            require(block.chainid == DeployConfig.ANVIL, "mock tokens: anvil only; set LST/NATIVE/USDC");
            lst = vm.parseJsonAddress(json, ".tokens.lst");
            native = vm.parseJsonAddress(json, ".tokens.native");
            usdc = vm.parseJsonAddress(json, ".tokens.usdc");
            MockERC20(lst).mint(me, 1e30);
            MockERC20(native).mint(me, 1e30);
            MockERC20(usdc).mint(me, 1e18);
        } else {
            require(vm.envOr("MOCKS", false), "set LST/NATIVE/USDC (on anvil: deploy with MOCKS=true for demo tokens)");
            lst = address(new MockERC20("Demo LST", "dLST", 18));
            native = address(new MockERC20("Demo Native", "dNATIVE", 18));
            usdc = address(new MockERC20("Demo USD", "dUSD", 6));
            MockERC20(lst).mint(me, 1e30);
            MockERC20(native).mint(me, 1e30);
            MockERC20(usdc).mint(me, 1e18);
        }
        _approve(lst, me, core);
        _approve(native, me, core);
        _approve(usdc, me, core);
    }

    /// @dev The optional extra pair from env (asset zero = none), approved like the launch tokens.
    function _extra(Confluere core) internal returns (Pair memory x) {
        x.asset = vm.envOr("EXTRA_ASSET", address(0));
        if (x.asset == address(0)) return x;
        x.quote = vm.envAddress("EXTRA_QUOTE");
        x.strikes = [uint128(vm.envUint("EXTRA_STRIKE_LOW")), uint128(vm.envUint("EXTRA_STRIKE_HIGH"))];
        require(x.quote != address(0) && x.quote != x.asset, "EXTRA_QUOTE: zero or the asset");
        (, address me,) = vm.readCallers();
        _approve(x.asset, me, core);
        _approve(x.quote, me, core);
    }

    /// @dev Unlimited approval of the core, sent only when it is not in place yet (one transaction less per token on
    /// every re-run and roll).
    function _approve(address token, address me, Confluere core) internal {
        if (token != address(0) && IERC20(token).allowance(me, address(core)) < type(uint128).max) {
            IERC20(token).approve(address(core), type(uint256).max);
        }
    }

    function _path() internal view returns (string memory) {
        return DeployConfig.deploymentsFile(vm);
    }

    function _create(
        Confluere core,
        address lst,
        address native,
        address usdc,
        Pair memory extra,
        uint64 expiry,
        bytes32[] memory ids,
        uint256 n
    ) internal returns (uint256) {
        // Loop pair at two LST strikes; lending pair at two USD strikes (env, defaults for demos); optional extra pair.
        Pair[3] memory pairs;
        // LST strikes default to 0.98 / 0.95 native per LST (1:1 LSTs); share-priced LSTs such as shMON (~12.9 MON)
        // pass their own via LST_STRIKE_LOW / LST_STRIKE_HIGH.
        pairs[0] = Pair(
            lst,
            native,
            [uint128(vm.envOr("LST_STRIKE_HIGH", uint256(98e16))), uint128(vm.envOr("LST_STRIKE_LOW", uint256(95e16)))]
        );
        pairs[1] = Pair(
            native,
            usdc,
            [uint128(vm.envOr("USD_STRIKE_LOW", uint256(20e6))), uint128(vm.envOr("USD_STRIKE_HIGH", uint256(30e6)))]
        );
        pairs[2] = extra;
        // pegged loop pools: 1.5% band; USD pools: 8% band; extra pair: EXTRA_BAND (default 8%); spread share 10%
        uint16[3] memory bands = [uint16(150), 800, uint16(vm.envOr("EXTRA_BAND", uint256(800)))];
        for (uint256 p; p < 3; ++p) {
            if (pairs[p].asset == address(0)) continue; // no LST (HyperEVM) / no extra pair
            n = _open(core, pairs[p], expiry, bands[p], ids, n);
        }
        return n;
    }

    /// @dev 2 strikes (1 when both are equal) x 2 kinds of one pair into `ids` from index `n`; existing pools are kept,
    /// not created again.
    function _open(Confluere core, Pair memory pair, uint64 expiry, uint16 band, bytes32[] memory ids, uint256 n)
        internal
        returns (uint256)
    {
        for (uint256 s; s < 2; ++s) {
            if (s == 1 && pair.strikes[1] == pair.strikes[0]) break; // single strike
            for (uint256 k; k < 2; ++k) {
                PoolKey memory key = PoolKey(pair.asset, pair.quote, expiry, pair.strikes[s], Kind(k), band, 0);
                bytes32 id = PoolKeyLib.toId(key);
                if (core.pool(id).status == Status.None) {
                    id = core.createPool(key, IConfluere.PoolOptions(0, 0, 0, true));
                }
                ids[n++] = id;
            }
        }
        return n;
    }

    /// @dev EXPIRY (or the nearest expiry), then LATER_EXPIRIES; each checked, none listed twice.
    function _expiries(Confluere core) internal view returns (uint64[] memory out) {
        string memory later = vm.envOr("LATER_EXPIRIES", string(""));
        string[] memory items = bytes(later).length == 0 ? new string[](0) : vm.split(later, ",");
        out = new uint64[](1 + items.length);
        uint256 e = vm.envOr("EXPIRY", uint256(0));
        out[0] = e == 0 ? _nextExpiry(core) : _checked(core, e);
        for (uint256 i; i < items.length; ++i) {
            out[i + 1] = _checked(core, vm.parseUint(items[i]));
            for (uint256 j; j <= i; ++j) {
                require(out[j] != out[i + 1], "LATER_EXPIRIES: expiry listed twice");
            }
        }
    }

    function _checked(Confluere core, uint256 e) internal view returns (uint64) {
        GridConfig memory g = core.grid();
        require(e >= g.anchor && (e - g.anchor) % g.period == 0, "EXPIRY: not on the grid");
        require(e >= block.timestamp + g.period / 4, "EXPIRY: less than a quarter period ahead");
        require(e - block.timestamp <= uint256(g.period) * g.maxExpiries, "EXPIRY: not listable yet");
        return uint64(e);
    }

    /// @dev Next expiry with at least a quarter period of headroom: a multi-transaction broadcast can take long
    /// enough to cross an expiry that was barely in the future at simulation time (seen on a Monad testnet fork
    /// with the 1-hour demo grid), which would make createPool revert.
    function _nextExpiry(Confluere core) internal view returns (uint64) {
        GridConfig memory g = core.grid();
        uint256 e = g.anchor + ((block.timestamp - g.anchor) / g.period + 1) * g.period;
        if (e - block.timestamp < g.period / 4) e += g.period;
        return uint64(e);
    }
}
