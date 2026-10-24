// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {Confluere} from "../src/Confluere.sol";
import {IConfluere} from "../src/interfaces/IConfluere.sol";
import {Router} from "../src/periphery/Router.sol";
import {ERC6909WrapperFactory} from "../src/periphery/ERC6909Wrapper.sol";
import {VaultFactory} from "../src/periphery/VaultFactory.sol";
import {KeeperReceiver} from "../src/periphery/KeeperReceiver.sol";
import {SeatRegistry} from "../src/periphery/SeatRegistry.sol";
import {Specials} from "../src/periphery/Specials.sol";
import {Guardian} from "../src/periphery/Guardian.sol";
import {DeployConfig} from "./DeployConfig.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

/// @notice Deploys the core (CREATE2, same address on every chain in the table) and the periphery, then writes
/// deployments/<chain>.json (or DEPLOYMENTS_FILE: scripts/deploy-testnet.sh points it at a staging copy and moves it
/// into place only after the broadcast landed, because forge writes files while simulating, before broadcasting).
/// Idempotent: a CREATE2 address that already has code is reused and an already bound registry / guardian is left
/// alone, so a failed run can be repeated.
/// Env: TREASURY (protocol multisig: receives taxes and the protocol's fee share),
///      DEMO (bool, default false; minute-scale grid, testnets and anvil only),
///      GRID ("daily" or unset; testnets and anvil only, not with DEMO): daily expiries listed 15 days ahead, 2-minute
///      batches, production windows (DeployConfig.Preset.Daily),
///      GUARDIAN_MEMBERS ("0xa,0xb,0xc") + GUARDIAN_THRESHOLD: deploy the Guardian multisig (CREATE2, same members and
///      threshold on every chain, so the same address; required on mainnets); or GUARDIAN: an existing address
///      (testnets and demos),
///      SALT (bytes32, optional), SEAT_SHARE_BPS (default 3500), SEAT_TAX_BPS (default 1500),
///      DEPLOYMENTS_FALLBACK (optional: a second deployments file to take the core's deploy block from on a re-run),
///      DEPLOY_BLOCK (only when re-running over a core that already exists but no deployments file records: its
///      creation block, where the app's log scans start),
///      MOCKS (bool, anvil only): deploy demo tokens first (CREATE2) and use them as graduation quotes,
///      GRAD_<chainId> ("0xquote:volume:minNotional:seatObligation,..."): per quote token on that chain (real
///      tokens): graduation baseline, minimum order notional, seat obligation per batch. Pass the same GRAD_* set
///      on every chain: each chain's SeatRegistry address (the core's treasury row) is derived from it. Required for
///      the chain being deployed (except anvil): without it nothing could ever graduate and no order minimum applies.
contract Deploy is Script {
    struct Tokens {
        address lst;
        address native;
        address usdc;
    }

    /// @dev The order of DeployConfig.build's table; new chains are appended.
    uint256[7] internal CHAIN_IDS = [
        DeployConfig.MONAD,
        DeployConfig.MONAD_TESTNET,
        DeployConfig.HYPEREVM,
        DeployConfig.HYPEREVM_TESTNET,
        DeployConfig.ANVIL,
        DeployConfig.ETHEREUM,
        DeployConfig.SEPOLIA
    ];

    struct Periphery {
        address router;
        address wrapperFactory;
        address vaultFactory;
        address keeperReceiver;
        address seatRegistry;
        address guardian;
        address specials;
    }

    function run() external returns (Confluere core) {
        bytes32 salt = vm.envOr("SALT", bytes32(uint256(0xc0f1)));
        bool mocks = vm.envOr("MOCKS", false);
        DeployConfig.Preset preset = _preset(vm.envOr("DEMO", false));
        _guards(preset, mocks);

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        Tokens memory t = mocks ? _mockTokens(salt) : Tokens(address(0), address(0), address(0));
        DeployConfig.Grad[7] memory grad = _grad(mocks, t);
        (address[7] memory registries, SeatRegistry reg) = _registries(salt, deployer, grad);
        Guardian g = _deployGuardian(salt, deployer);
        address guardian = address(g) != address(0) ? address(g) : vm.envAddress("GUARDIAN");
        Specials sp = _deploySpecials(salt, deployer);
        Confluere.Config memory cfg = DeployConfig.build(preset, registries, guardian, grad, address(sp));
        _preflight(cfg, preset);
        uint256 deployBlock;
        (core, deployBlock) = _deployCore(salt, cfg, reg, g);
        _bindSpecials(sp, core);
        Periphery memory p = _periphery(IConfluere(address(core)), salt);
        p.seatRegistry = address(reg);
        p.specials = address(sp);
        p.guardian = guardian;
        vm.stopBroadcast();

        _check(core, cfg);
        _write(core, cfg, preset, p, t, deployBlock);
        console2.log("Confluere", address(core));
    }

    /// @dev The core's treasury on each chain is that chain's SeatRegistry; precompute every row's so the core's init
    /// code (and address) is the same everywhere, and deploy this chain's.
    function _registries(bytes32 salt, address deployer, DeployConfig.Grad[7] memory grad)
        internal
        returns (address[7] memory registries, SeatRegistry reg)
    {
        for (uint256 i; i < CHAIN_IDS.length; ++i) {
            registries[i] = vm.computeCreate2Address(salt, keccak256(_registryInit(deployer, grad[i])));
        }
        reg = _deployRegistry(salt, deployer, grad);
        for (uint256 i; i < CHAIN_IDS.length; ++i) {
            if (CHAIN_IDS[i] == block.chainid) require(address(reg) == registries[i], "registry address mismatch");
        }
    }

    function _bindSpecials(Specials sp, Confluere core) internal {
        if (address(sp.core()) == address(0)) sp.bind(IConfluere(address(core)));
        require(address(sp.core()) == address(core), "specials bound to another core");
    }

    /// @dev Specials (ARCH 2.6.1): CREATE2 with (deployer, SPECIALS_MIN_FEE_BPS), the same address on every chain,
    /// deployed before the core (whose immutable SPECIALS names it) and bound to it afterwards.
    function _deploySpecials(bytes32 salt, address deployer) internal returns (Specials sp) {
        bytes memory init = abi.encodePacked(
            type(Specials).creationCode, abi.encode(deployer, uint16(vm.envOr("SPECIALS_MIN_FEE_BPS", uint256(0))))
        );
        sp = Specials(vm.computeCreate2Address(salt, keccak256(init)));
        if (address(sp).code.length == 0) {
            sp = new Specials{salt: salt}(deployer, uint16(vm.envOr("SPECIALS_MIN_FEE_BPS", uint256(0))));
        }
    }

    /// @dev Guardian multisig (ARCH 8.2). Members are still open (blueprint 13 Q1); without GUARDIAN_MEMBERS nothing is
    /// deployed and GUARDIAN is used as is.
    function _deployGuardian(bytes32 salt, address deployer) internal returns (Guardian g) {
        string memory spec = vm.envOr("GUARDIAN_MEMBERS", string(""));
        if (bytes(spec).length == 0) return Guardian(address(0));
        string[] memory items = vm.split(spec, ",");
        address[] memory members = new address[](items.length);
        for (uint256 i; i < items.length; ++i) {
            members[i] = vm.parseAddress(items[i]);
        }
        uint256 threshold = vm.envUint("GUARDIAN_THRESHOLD");
        bytes memory init = abi.encodePacked(type(Guardian).creationCode, abi.encode(deployer, members, threshold));
        g = Guardian(vm.computeCreate2Address(salt, keccak256(init)));
        if (address(g).code.length == 0) g = new Guardian{salt: salt}(deployer, members, threshold);
    }

    /// @dev DEMO=true picks the demo grid, GRID=daily the daily testnet grid (not both); neither, production.
    function _preset(bool demo) internal view returns (DeployConfig.Preset) {
        string memory g = vm.envOr("GRID", string(""));
        bool daily = keccak256(bytes(g)) == keccak256("daily");
        require(daily || bytes(g).length == 0, "GRID: daily or unset");
        require(!(daily && demo), "DEMO and GRID=daily are exclusive");
        if (daily) return DeployConfig.Preset.Daily;
        return demo ? DeployConfig.Preset.Demo : DeployConfig.Preset.Production;
    }

    /// @dev Checked before anything is broadcast. A forgotten env var must not put a demo or daily grid (immutable)
    /// or mintable mock tokens on a production chain, nor leave a mainnet with a single-key guardian.
    function _guards(DeployConfig.Preset preset, bool mocks) internal view {
        uint256 id = block.chainid;
        bool mainnet = id == DeployConfig.MONAD || id == DeployConfig.HYPEREVM || id == DeployConfig.ETHEREUM;
        bool test = id == DeployConfig.MONAD_TESTNET || id == DeployConfig.HYPEREVM_TESTNET
            || id == DeployConfig.SEPOLIA || id == DeployConfig.ANVIL;
        require(preset != DeployConfig.Preset.Demo || test, "demo: testnets and anvil only");
        require(preset != DeployConfig.Preset.Daily || test, "daily grid: testnets and anvil only");
        require(!mocks || id == DeployConfig.ANVIL, "mocks: anvil only");
        require(
            !mainnet || bytes(vm.envOr("GUARDIAN_MEMBERS", string(""))).length != 0,
            "mainnet: GUARDIAN_MEMBERS required"
        );
        // The graduation / min-notional row of this chain: empty means nothing can ever graduate and no order
        // minimum applies. Only anvil may run without one (local demos that bring their own tokens later).
        string memory gradVar = string.concat("GRAD_", vm.toString(id));
        require(
            id == DeployConfig.ANVIL || bytes(vm.envOr(gradVar, string(""))).length != 0, string.concat("set ", gradVar)
        );
    }

    /// @dev ARCH 7.2: before anything is deployed, the table must have a row for this chain, and a production
    /// deployment must use the documented grid and the calibrated windows (re-measure 24 h of blocks first:
    /// the ops package has a blocktime command).
    function _preflight(Confluere.Config memory cfg, DeployConfig.Preset preset) internal view {
        bool demo = preset == DeployConfig.Preset.Demo;
        bool found;
        for (uint256 i; i < cfg.chains.length; ++i) {
            if (cfg.chains[i].chainId != block.chainid) continue;
            found = true;
            require(cfg.chains[i].guardian != address(0) && cfg.chains[i].treasury != address(0), "roles unset");
            if (!demo) {
                uint64 w = cfg.chains[i].windowBlocks;
                if (block.chainid == DeployConfig.MONAD || block.chainid == DeployConfig.MONAD_TESTNET) {
                    require(w == 24_000, "Monad window must be 24,000 blocks");
                }
                if (block.chainid == DeployConfig.HYPEREVM || block.chainid == DeployConfig.HYPEREVM_TESTNET) {
                    require(w == 7200, "HyperEVM window must be 7,200 blocks");
                }
                if (block.chainid == DeployConfig.ETHEREUM || block.chainid == DeployConfig.SEPOLIA) {
                    require(w == 600, "Ethereum window must be 600 blocks");
                }
            }
        }
        require(found, "no chain parameters for this chain id");
        if (preset == DeployConfig.Preset.Daily) {
            require(cfg.grid.period == 1 days && cfg.grid.batchInterval == 2 minutes, "daily grid: 1 day, 2 min");
            require(cfg.grid.maxExpiries == 15, "daily grid: 15 expiries listed");
        } else if (!demo) {
            require(
                cfg.grid.period == 7 days && cfg.grid.batchInterval == 30 minutes, "production grid: weekly, 30 min"
            );
            require(
                (cfg.grid.anchor / 1 days + 4) % 7 == 5 && cfg.grid.anchor % 1 days == 8 hours, "anchor: Fri 08:00 UTC"
            );
        }
    }

    function _registryInit(address deployer, DeployConfig.Grad memory g) internal view returns (bytes memory) {
        return abi.encodePacked(
            type(SeatRegistry).creationCode,
            abi.encode(
                deployer,
                vm.envAddress("TREASURY"),
                uint16(vm.envOr("SEAT_SHARE_BPS", uint256(3500))),
                uint16(vm.envOr("SEAT_TAX_BPS", uint256(1500))),
                g.quotes,
                g.seatObligations
            )
        );
    }

    function _deployRegistry(bytes32 salt, address deployer, DeployConfig.Grad[7] memory grad)
        internal
        returns (SeatRegistry reg)
    {
        DeployConfig.Grad memory g;
        for (uint256 i; i < CHAIN_IDS.length; ++i) {
            if (CHAIN_IDS[i] == block.chainid) g = grad[i];
        }
        reg = SeatRegistry(vm.computeCreate2Address(salt, keccak256(_registryInit(deployer, g))));
        if (address(reg).code.length != 0) return reg;
        reg = new SeatRegistry{salt: salt}(
            deployer,
            vm.envAddress("TREASURY"),
            uint16(vm.envOr("SEAT_SHARE_BPS", uint256(3500))),
            uint16(vm.envOr("SEAT_TAX_BPS", uint256(1500))),
            g.quotes,
            g.seatObligations
        );
    }

    /// @dev Generic names so the bytecode, and therefore the address, is the same on every chain.
    function _mockTokens(bytes32 salt) internal returns (Tokens memory t) {
        t.lst = _mock(salt, "Confluere Demo Staked Native", "dLST", 18);
        t.native = _mock(salt, "Confluere Demo Native", "dNATIVE", 18);
        t.usdc = _mock(salt, "Confluere Demo USD", "dUSD", 6);
    }

    function _mock(bytes32 salt, string memory name, string memory symbol, uint8 dec) internal returns (address a) {
        bytes memory init = abi.encodePacked(type(MockERC20).creationCode, abi.encode(name, symbol, dec));
        a = vm.computeCreate2Address(salt, keccak256(init));
        if (a.code.length == 0) a = address(new MockERC20{salt: salt}(name, symbol, dec));
    }

    /// @dev Demo: the two quote tokens graduate after 1 native / 10 USD of volume per expiry, on every chain; the
    /// smallest order is worth 0.1 native / 1 USD at K.
    function _grad(bool mocks, Tokens memory t) internal view returns (DeployConfig.Grad[7] memory g) {
        for (uint256 i; i < CHAIN_IDS.length; ++i) {
            if (mocks) {
                g[i].quotes = new address[](2);
                g[i].fees = new uint256[](2);
                g[i].minNotionals = new uint256[](2);
                g[i].seatObligations = new uint256[](2);
                (g[i].quotes[0], g[i].fees[0], g[i].minNotionals[0], g[i].seatObligations[0]) =
                (t.native, 1e18, 1e17, 1e18);
                (g[i].quotes[1], g[i].fees[1], g[i].minNotionals[1], g[i].seatObligations[1]) =
                (t.usdc, 10e6, 1e6, 100e6);
            } else {
                g[i] = _parseGrad(vm.envOr(string.concat("GRAD_", vm.toString(CHAIN_IDS[i])), string("")));
            }
        }
    }

    function _parseGrad(string memory spec) internal pure returns (DeployConfig.Grad memory g) {
        if (bytes(spec).length == 0) {
            g.quotes = new address[](0);
            g.fees = new uint256[](0);
            g.minNotionals = new uint256[](0);
            g.seatObligations = new uint256[](0);
            return g;
        }
        string[] memory items = vm.split(spec, ",");
        g.quotes = new address[](items.length);
        g.fees = new uint256[](items.length);
        g.minNotionals = new uint256[](items.length);
        g.seatObligations = new uint256[](items.length);
        for (uint256 i; i < items.length; ++i) {
            string[] memory kv = vm.split(items[i], ":");
            g.quotes[i] = vm.parseAddress(kv[0]);
            g.fees[i] = vm.parseUint(kv[1]);
            g.minNotionals[i] = vm.parseUint(kv[2]);
            g.seatObligations[i] = vm.parseUint(kv[3]);
        }
    }

    function _periphery(IConfluere core, bytes32 salt) internal returns (Periphery memory p) {
        bytes memory arg = abi.encode(core);
        p.router = _existing(salt, abi.encodePacked(type(Router).creationCode, arg));
        if (p.router == address(0)) p.router = address(new Router{salt: salt}(core));
        p.wrapperFactory = _existing(salt, abi.encodePacked(type(ERC6909WrapperFactory).creationCode, arg));
        if (p.wrapperFactory == address(0)) p.wrapperFactory = address(new ERC6909WrapperFactory{salt: salt}(core));
        p.vaultFactory = _existing(salt, abi.encodePacked(type(VaultFactory).creationCode, arg));
        if (p.vaultFactory == address(0)) p.vaultFactory = address(new VaultFactory{salt: salt}(core));
        p.keeperReceiver =
            _existing(salt, abi.encodePacked(type(KeeperReceiver).creationCode, abi.encode(core, uint256(16))));
        if (p.keeperReceiver == address(0)) p.keeperReceiver = address(new KeeperReceiver{salt: salt}(core, 16));
    }

    /// @dev The CREATE2 address of `init` if a previous run already deployed it there, else zero.
    function _existing(bytes32 salt, bytes memory init) internal view returns (address a) {
        a = vm.computeCreate2Address(salt, keccak256(init));
        if (a.code.length == 0) a = address(0);
    }

    /// @dev The row the core picked must match this chain's intended parameters.
    function _check(Confluere core, Confluere.Config memory cfg) internal view {
        uint64 expectedWindow;
        for (uint256 i; i < cfg.chains.length; ++i) {
            if (cfg.chains[i].chainId == block.chainid) expectedWindow = cfg.chains[i].windowBlocks;
        }
        require(core.WINDOW_BLOCKS() == expectedWindow, "window mismatch");
        require(core.grid().period == cfg.grid.period, "grid mismatch");
    }

    /// @dev Reuses the core when an earlier run already deployed it at its CREATE2 address, and binds the registry and
    /// guardian only if they are still unbound.
    /// @return core the core at its CREATE2 address
    /// @return deployBlock the block of the core's first deployment (kept on a re-run: the log-scan start block)
    function _deployCore(bytes32 salt, Confluere.Config memory cfg, SeatRegistry reg, Guardian g)
        internal
        returns (Confluere core, uint256 deployBlock)
    {
        core = Confluere(
            vm.computeCreate2Address(salt, keccak256(abi.encodePacked(type(Confluere).creationCode, abi.encode(cfg))))
        );
        bool fresh = address(core).code.length == 0;
        if (fresh) core = new Confluere{salt: salt}(cfg);
        deployBlock = _deployBlock(core, fresh);
        if (address(reg.core()) == address(0)) reg.bind(IConfluere(address(core)));
        require(address(reg.core()) == address(core), "registry bound to another core");
        if (address(g) != address(0)) {
            if (address(g.core()) == address(0)) g.bind(IConfluere(address(core)));
            require(address(g.core()) == address(core), "guardian bound to another core");
        }
    }

    /// @dev The app's log-scan start block. A re-run over an existing core keeps the deploy block the deployments file
    /// records for this core (scripts/lib/testnet.sh keeps a failed Deploy attempt's staged file for this), or else
    /// DEPLOYMENTS_FALLBACK (the script points it at deployments/<chain>.json, for a staged file left by an attempt
    /// that named another core). When no file names this core, block.number would start the log scans after the core's
    /// first events, so the caller must pass DEPLOY_BLOCK (the core's creation block, from its creation transaction).
    function _deployBlock(Confluere core, bool fresh) internal view returns (uint256) {
        if (fresh) return block.number;
        (bool known, uint256 recorded) = _recordedBlock(DeployConfig.deploymentsFile(vm), core);
        if (known) return recorded;
        (known, recorded) = _recordedBlock(vm.envOr("DEPLOYMENTS_FALLBACK", string("")), core);
        if (known) return recorded;
        uint256 hint = vm.envOr("DEPLOY_BLOCK", uint256(0));
        require(hint != 0 && hint <= block.number, "core already deployed: set DEPLOY_BLOCK to its creation block");
        return hint;
    }

    /// @dev The deploy block file `f` records, if it names `core`.
    function _recordedBlock(string memory f, Confluere core) internal view returns (bool, uint256) {
        if (bytes(f).length == 0 || !vm.isFile(f)) return (false, 0);
        string memory old = vm.readFile(f);
        if (
            !vm.keyExistsJson(old, ".deployBlock") || !vm.keyExistsJson(old, ".confluere")
                || vm.parseJsonAddress(old, ".confluere") != address(core)
        ) return (false, 0);
        return (true, vm.parseJsonUint(old, ".deployBlock"));
    }

    function _write(
        Confluere core,
        Confluere.Config memory cfg,
        DeployConfig.Preset preset,
        Periphery memory p,
        Tokens memory t,
        uint256 deployBlock
    ) internal {
        string memory k = "deployment";
        if (t.usdc != address(0)) {
            string memory tk = "tokens";
            vm.serializeAddress(tk, "lst", t.lst);
            vm.serializeAddress(tk, "native", t.native);
            string memory tj = vm.serializeAddress(tk, "usdc", t.usdc);
            vm.serializeString(k, "tokens", tj);
        }
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeBool(k, "demo", preset == DeployConfig.Preset.Demo);
        vm.serializeString(
            k,
            "grid",
            preset == DeployConfig.Preset.Daily ? "daily" : preset == DeployConfig.Preset.Demo ? "demo" : "production"
        );
        vm.serializeUint(k, "maxExpiries", cfg.grid.maxExpiries);
        vm.serializeUint(k, "windowBlocks", core.WINDOW_BLOCKS());
        vm.serializeUint(k, "gridAnchor", cfg.grid.anchor);
        vm.serializeUint(k, "gridPeriod", cfg.grid.period);
        vm.serializeUint(k, "batchInterval", cfg.grid.batchInterval);
        vm.serializeUint(k, "deployBlock", deployBlock);
        vm.serializeAddress(k, "router", p.router);
        vm.serializeAddress(k, "wrapperFactory", p.wrapperFactory);
        vm.serializeAddress(k, "vaultFactory", p.vaultFactory);
        vm.serializeAddress(k, "keeperReceiver", p.keeperReceiver);
        vm.serializeAddress(k, "seatRegistry", p.seatRegistry);
        vm.serializeAddress(k, "guardian", p.guardian);
        vm.serializeAddress(k, "specials", p.specials);
        string memory json = vm.serializeAddress(k, "confluere", address(core));
        vm.writeJson(json, DeployConfig.deploymentsFile(vm));
    }
}
