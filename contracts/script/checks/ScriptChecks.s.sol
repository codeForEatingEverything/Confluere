// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {Confluere} from "../../src/Confluere.sol";
import {IConfluere} from "../../src/interfaces/IConfluere.sol";
import {SELL} from "../../src/libraries/OrderSet.sol";
import {Status, PoolKeyLib} from "../../src/libraries/PoolKey.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {Deploy} from "../Deploy.s.sol";
import {CreatePools} from "../CreatePools.s.sol";
import {Seed} from "../Seed.s.sol";
import {CreateVaults} from "../CreateVaults.s.sol";
import {Vault} from "../../src/periphery/Vault.sol";

/// @notice Regression checks for the deploy scripts, run in forge's in-memory EVM (no RPC, nothing is sent):
///   forge script script/checks/ScriptChecks.s.sol
/// - Deploy refuses a demo grid or mocks on production chains, a mainnet without GUARDIAN_MEMBERS, and a public chain
///   without its GRAD_<chainId> row; DEMO defaults to false.
/// - Deploy, CreatePools, CreateVaults and Seed can be re-run after a partial failure without reverting or doubling
///   the book; Seed.collect() claims closed pools and withdraws pending balances.
/// - A Deploy re-run keeps the core's deploy block (also from DEPLOYMENTS_FALLBACK), and refuses to guess one
///   (DEPLOY_BLOCK) when no file records it.
/// - CreatePools opens the EXPIRY scripts/roll-testnet.sh asks for and rejects one that is off-grid, too close or
///   not listable yet.
/// - An extra pair (EXTRA_ASSET / EXTRA_QUOTE / EXTRA_STRIKE_*) adds 2 strikes x 2 kinds after the launch pools, is
///   seeded at EXTRA_SEED_UNIT_BPS, and gets its own vault (`.vaults.nativeLend`); re-runs keep both.
/// - gradCovered(chainId) (scripts/test/grad-seed.test.sh passes the testnet GRAD rows, tokens and strikes of
///   scripts/lib/testnet.sh): one small seed at SEED_UNIT_BPS clears at least the graduation volume of every market.
/// Output goes to deployments/.script-checks.tmp (removed at the end), never to a real deployments file.
contract ScriptChecks is Script {
    string internal file;
    address internal me;

    function run() external {
        file = string.concat(vm.projectRoot(), "/../deployments/.script-checks.tmp");
        vm.setEnv("DEPLOYMENTS_FILE", file);
        vm.setEnv("TREASURY", vm.toString(address(0xBEEF)));
        vm.setEnv("GUARDIAN", vm.toString(address(0xBEEF)));
        (, me,) = vm.readCallers();
        vm.warp(vm.unixTime() / 1000); // the in-memory chain starts at timestamp 1, before the grid anchor

        // DEMO and GUARDIAN_MEMBERS are still unset here (forge has no unsetEnv), so these two run first.
        _demoDefaultsOff();
        _guards();
        _idempotentLifecycle();

        vm.removeFile(file);
        console2.log("script checks OK");
    }

    function _demoDefaultsOff() internal {
        vm.chainId(31_337);
        Confluere core = new Deploy().run();
        require(core.grid().period == 7 days, "DEMO must default to false");
    }

    function _guards() internal {
        vm.chainId(143);
        _expectRevert(new Deploy(), "mainnet: GUARDIAN_MEMBERS required");
        vm.setEnv("DEMO", "true");
        _expectRevert(new Deploy(), "demo: testnets and anvil only");
        vm.chainId(999);
        _expectRevert(new Deploy(), "demo: testnets and anvil only");
        vm.chainId(10_143);
        vm.setEnv("MOCKS", "true");
        _expectRevert(new Deploy(), "mocks: anvil only");
        try new CreatePools().run() {
            revert("CreatePools accepted MOCKS on a testnet");
        } catch Error(string memory r) {
            _eq(r, "mocks: anvil only");
        }
        vm.setEnv("MOCKS", "false");
        _expectRevert(new Deploy(), "set GRAD_10143");
    }

    function _idempotentLifecycle() internal {
        vm.chainId(31_337);
        vm.setEnv("DEMO", "true");
        vm.setEnv("MOCKS", "true");
        Confluere core = new Deploy().run();
        address router = vm.parseJsonAddress(vm.readFile(file), ".router");
        uint256 deployBlock = vm.parseJsonUint(vm.readFile(file), ".deployBlock");
        vm.roll(block.number + 5);
        require(address(new Deploy().run()) == address(core), "re-run: core moved");
        require(vm.parseJsonAddress(vm.readFile(file), ".router") == router, "re-run: periphery moved");
        require(vm.parseJsonUint(vm.readFile(file), ".deployBlock") == deployBlock, "re-run: deploy block moved");
        // No file names this core (a failed first attempt without its staged file): block.number would start the
        // log scans after the core's first events, so Deploy asks for the creation block instead.
        vm.removeFile(file);
        try new Deploy().run() {
            revert("Deploy guessed a deploy block");
        } catch Error(string memory r) {
            _eq(r, "core already deployed: set DEPLOY_BLOCK to its creation block");
            vm.stopBroadcast(); // the revert comes after Deploy started broadcasting
        }
        vm.setEnv("DEPLOY_BLOCK", vm.toString(deployBlock));
        new Deploy().run();
        require(vm.parseJsonUint(vm.readFile(file), ".deployBlock") == deployBlock, "DEPLOY_BLOCK ignored");
        vm.setEnv("DEPLOY_BLOCK", "0");
        // A staged file left by an attempt that named another core: the block comes from DEPLOYMENTS_FALLBACK.
        string memory fallbackFile = string.concat(file, ".fallback");
        vm.copyFile(file, fallbackFile);
        vm.writeFile(file, '{"confluere":"0x00000000000000000000000000000000000000d0","deployBlock":1}');
        vm.setEnv("DEPLOYMENTS_FALLBACK", fallbackFile);
        new Deploy().run();
        require(vm.parseJsonUint(vm.readFile(file), ".deployBlock") == deployBlock, "DEPLOYMENTS_FALLBACK ignored");
        vm.setEnv("DEPLOYMENTS_FALLBACK", "");
        vm.removeFile(fallbackFile);

        new CreatePools().run();
        bytes32[] memory ids = vm.parseJsonBytes32Array(vm.readFile(file), ".pools.poolIds");
        new CreatePools().run();
        bytes32[] memory again = vm.parseJsonBytes32Array(vm.readFile(file), ".pools.poolIds");
        require(ids.length == 8 && again.length == 8, "pools: count");
        for (uint256 i; i < 8; ++i) {
            require(ids[i] == again[i], "pools: re-run changed the ids");
        }

        new CreateVaults().run();
        address low = vm.parseJsonAddress(vm.readFile(file), ".vaults.usdLow");
        new CreateVaults().run();
        require(vm.parseJsonAddress(vm.readFile(file), ".vaults.usdLow") == low, "vaults: re-run moved");

        new Seed().run();
        (, uint32 sells) = core.bookHead(ids[0], SELL);
        require(sells == 3, "seed: three sells");
        new Seed().run();
        (, uint32 sellsAgain) = core.bookHead(ids[0], SELL);
        require(sellsAgain == sells, "seed: re-run doubled the book");

        _runToClosed(core, ids);
        new Seed().collect();
        for (uint256 i; i < ids.length; ++i) {
            require(core.balanceOf(me, uint256(ids[i])) == 0, "collect: C units left");
            IConfluere.PoolView memory v = core.pool(ids[i]);
            require(core.pending(v.key.asset, me) == 0 && core.pending(v.key.quote, me) == 0, "collect: pending left");
        }
        _expiryOverride(core, core.pool(ids[0]).key.expiry);
        _extraPair(core);
    }

    /// @dev The extra pair (the launch USD token lent against the native coin, as on HyperEVM testnet).
    function _extraPair(Confluere core) internal {
        string memory json = vm.readFile(file);
        address native = vm.parseJsonAddress(json, ".tokens.native");
        address usdc = vm.parseJsonAddress(json, ".tokens.usdc");
        vm.setEnv("EXTRA_ASSET", vm.toString(usdc));
        vm.setEnv("EXTRA_QUOTE", vm.toString(native));
        vm.setEnv("EXTRA_STRIKE_LOW", "28000000000000000");
        vm.setEnv("EXTRA_STRIKE_HIGH", "30000000000000000");
        vm.setEnv("EXTRA_SEED_UNIT_BPS", "50000"); // 5 USD per unit: the demo min order is 0.1 native at K
        new CreatePools().run();
        new CreatePools().run();
        json = vm.readFile(file);
        bytes32[] memory ids = vm.parseJsonBytes32Array(json, ".pools.poolIds");
        require(ids.length == 12, "extra pair: pool count");
        require(vm.parseJsonAddress(json, ".pools.extraAsset") == usdc, "extra pair: not recorded");
        for (uint256 i = 8; i < 12; ++i) {
            IConfluere.PoolView memory v = core.pool(ids[i]);
            require(v.key.asset == usdc && v.key.quote == native, "extra pair: wrong tokens");
            require(v.status == Status.Open, "extra pair: pool not open");
        }
        new CreateVaults().run();
        address x = vm.parseJsonAddress(vm.readFile(file), ".vaults.nativeLend");
        require(x.code.length != 0 && Vault(x).asset() == native, "extra pair: vault");
        new CreateVaults().run();
        require(vm.parseJsonAddress(vm.readFile(file), ".vaults.nativeLend") == x, "extra pair: vault moved");
        new Seed().run();
        (uint64 head,) = core.bookHead(ids[8], SELL);
        (,, uint96 units,,,,) = core.order(ids[8], head);
        require(units == 3 * 5e6, "extra pair: not seeded at EXTRA_SEED_UNIT_BPS"); // head = the 3-unit sell at 94% K
        vm.setEnv("EXTRA_ASSET", vm.toString(address(0)));
        vm.setEnv("EXTRA_SEED_UNIT_BPS", "10000");
    }

    /// @dev Called just after expiry `e` (now = e + 1): the roll script's EXPIRY = e + period is opened as asked.
    function _expiryOverride(Confluere core, uint64 e) internal {
        uint64 p = core.grid().period;
        vm.setEnv("EXPIRY", vm.toString(uint256(e + p)));
        new CreatePools().run();
        require(vm.parseJsonUint(vm.readFile(file), ".pools.expiry") == e + p, "EXPIRY not opened");
        vm.setEnv("EXPIRY", vm.toString(uint256(e + 5 * p)));
        _expectPoolsRevert("EXPIRY: not listable yet");
        vm.setEnv("EXPIRY", vm.toString(uint256(e + p + 1)));
        _expectPoolsRevert("EXPIRY: not on the grid");
        vm.warp(e + p - 60);
        vm.setEnv("EXPIRY", vm.toString(uint256(e + p)));
        _expectPoolsRevert("EXPIRY: less than a quarter period ahead");
        vm.setEnv("EXPIRY", "0");
    }

    /// @notice One seed of every launch pool (SEED_UNIT_BPS) must clear at least the graduation volume of its market
    /// in one batch, with the GRAD_<chainId> row, tokens (LST, NATIVE, USDC) and strikes given in env. The real token
    /// addresses get mintable stand-ins with the real decimals (18; USDC 6). In-memory, nothing is sent.
    function gradCovered(uint256 chainId) external {
        file = string.concat(vm.projectRoot(), "/../deployments/.grad-check.tmp");
        vm.setEnv("DEPLOYMENTS_FILE", file);
        vm.setEnv("TREASURY", vm.toString(address(0xBEEF)));
        vm.setEnv("GUARDIAN", vm.toString(address(0xBEEF)));
        vm.setEnv("DEMO", "true");
        vm.setEnv("MOCKS", "false");
        (, me,) = vm.readCallers();
        vm.warp(vm.unixTime() / 1000);
        vm.chainId(chainId);
        address lst = vm.envOr("LST", address(0));
        if (lst != address(0)) _standIn(lst, 18);
        _standIn(vm.envAddress("NATIVE"), 18);
        _standIn(vm.envAddress("USDC"), 6);
        address xa = vm.envOr("EXTRA_ASSET", address(0)); // the launch tokens on the testnets; others get 18 decimals
        if (xa != address(0) && xa.code.length == 0) _standIn(xa, 18);
        if (xa != address(0) && vm.envAddress("EXTRA_QUOTE").code.length == 0) {
            _standIn(vm.envAddress("EXTRA_QUOTE"), 18);
        }

        Confluere core = new Deploy().run();
        new CreatePools().run();
        new Seed().run();
        bytes32[] memory ids = vm.parseJsonBytes32Array(vm.readFile(file), ".pools.poolIds");
        vm.warp(core.nextBatchAt(ids[0]));
        new Seed().settle();
        for (uint256 i; i < ids.length; ++i) {
            IConfluere.PoolView memory v = core.pool(ids[i]);
            uint256 threshold = core.graduationVolume(v.key.quote);
            uint256 vol =
                core.marketStats(PoolKeyLib.marketId(v.key.asset, v.key.quote, v.key.kind), v.key.expiry).volume;
            require(threshold != 0, "no GRAD row for this quote");
            require(
                vol >= threshold,
                string.concat("seed volume ", vm.toString(vol), " below graduation volume ", vm.toString(threshold))
            );
            console2.log("market volume", vol, "graduation volume", threshold);
        }
        vm.removeFile(file);
        console2.log("grad check OK on", chainId);
    }

    function _standIn(address token, uint8 dec) internal {
        vm.etch(token, address(new MockERC20("", "", dec)).code);
        MockERC20(token).mint(me, 1e30);
    }

    function _expectPoolsRevert(string memory reason) internal {
        try new CreatePools().run() {
            revert(string.concat("CreatePools did not revert: ", reason));
        } catch Error(string memory r) {
            _eq(r, reason);
        }
    }

    function _runToClosed(Confluere core, bytes32[] memory ids) internal {
        vm.warp(core.nextBatchAt(ids[0]));
        new Seed().settle();
        vm.warp(core.pool(ids[0]).key.expiry + 1);
        for (uint256 i; i < ids.length; ++i) {
            core.mature(ids[i]);
        }
        vm.roll(block.number + core.WINDOW_BLOCKS() + 1);
        for (uint256 i; i < ids.length; ++i) {
            while (!core.closeWindow(ids[i], 64)) {}
            require(core.pool(ids[i]).status == Status.Closed, "pool not closed");
        }
    }

    function _expectRevert(Deploy d, string memory reason) internal {
        try d.run() {
            revert(string.concat("Deploy did not revert: ", reason));
        } catch Error(string memory r) {
            _eq(r, reason);
        }
    }

    function _eq(string memory got, string memory want) internal pure {
        require(keccak256(bytes(got)) == keccak256(bytes(want)), string.concat("got '", got, "', want '", want, "'"));
    }
}
