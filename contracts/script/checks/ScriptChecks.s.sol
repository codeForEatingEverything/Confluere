// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {Confluere} from "../../src/Confluere.sol";
import {IConfluere} from "../../src/interfaces/IConfluere.sol";
import {SELL, BUY} from "../../src/libraries/OrderSet.sol";
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
/// - Sepolia (the chain table's last row): no mocks, its GRAD_11155111 row is required, and the core picks the
///   600-block window (25 on the demo grid) with that row's graduation and order-minimum values.
/// - Deploy, CreatePools, CreateVaults and Seed can be re-run after a partial failure without reverting or doubling
///   the book; Seed.collect() claims closed pools and withdraws pending balances.
/// - A Deploy re-run keeps the core's deploy block (also from DEPLOYMENTS_FALLBACK), and refuses to guess one
///   (DEPLOY_BLOCK) when no file records it.
/// - CreatePools opens the EXPIRY scripts/roll-testnet.sh asks for and rejects one that is off-grid, too close or
///   not listable yet.
/// - An extra pair (EXTRA_ASSET / EXTRA_QUOTE / EXTRA_STRIKE_*) adds 2 strikes x 2 kinds after the launch pools, is
///   seeded at EXTRA_SEED_UNIT_BPS, and gets its own vault (`.vaults.nativeLend`); re-runs keep both.
/// - GRID=daily (testnets and anvil only, not with DEMO): daily expiries listed 15 days ahead, production windows;
///   CreatePools opens a single strike when both strikes are equal and adds LATER_EXPIRIES (1-, 7- and 14-day pools,
///   no id twice); Seed with SEED_APR_BPS (through the Router) leaves a two-sided book after the seed clears, and
///   trade() rounds clear again at a new price.
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
        _dailyGrid();
        _sepolia();
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
        vm.chainId(1);
        _expectRevert(new Deploy(), "mainnet: GUARDIAN_MEMBERS required");
        vm.setEnv("DEMO", "true");
        _expectRevert(new Deploy(), "demo: testnets and anvil only");
        vm.chainId(143);
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

    function _dailyGrid() internal {
        vm.setEnv("DEMO", "false");
        vm.setEnv("GRID", "daily");
        vm.chainId(999);
        _expectRevert(new Deploy(), "daily grid: testnets and anvil only");
        vm.chainId(1);
        _expectRevert(new Deploy(), "daily grid: testnets and anvil only");
        vm.setEnv("DEMO", "true");
        vm.chainId(10_143);
        _expectRevert(new Deploy(), "DEMO and GRID=daily are exclusive");
        vm.setEnv("DEMO", "false");
        vm.chainId(31_337);
        vm.setEnv("MOCKS", "true");
        vm.setEnv("SALT", vm.toString(bytes32(uint256(0xc0f2)))); // its own registry and core, apart from the rest
        Confluere core = new Deploy().run();
        require(core.grid().period == 1 days && core.grid().maxExpiries == 15, "daily grid: wrong grid");
        require(core.grid().batchInterval == 2 minutes && core.WINDOW_BLOCKS() == 7200, "daily grid: batch / window");

        uint256 e0 = core.grid().anchor + ((block.timestamp - core.grid().anchor) / 1 days + 1) * 1 days;
        if (e0 - block.timestamp < 12 hours) e0 += 1 days;
        vm.setEnv("EXPIRY", vm.toString(e0));
        vm.setEnv("LATER_EXPIRIES", string.concat(vm.toString(e0 + 6 days), ",", vm.toString(e0 + 13 days)));
        vm.setEnv("LST_STRIKE_LOW", "900000000000000000");
        vm.setEnv("LST_STRIKE_HIGH", "900000000000000000");
        vm.setEnv("USD_STRIKE_LOW", "22000000");
        vm.setEnv("USD_STRIKE_HIGH", "22000000");
        new CreatePools().run();
        new CreatePools().run(); // idempotent
        string memory json = vm.readFile(file);
        bytes32[] memory ids = vm.parseJsonBytes32Array(json, ".pools.poolIds");
        require(ids.length == 12, "daily: 2 pairs x 1 strike x 2 kinds x 3 expiries");
        require(vm.parseJsonUint(json, ".pools.expiry") == e0, "daily: .pools.expiry is the first expiry");
        require(vm.parseJsonUintArray(json, ".pools.expiries").length == 3, "daily: expiries not recorded");
        for (uint256 i; i < ids.length; ++i) {
            for (uint256 j; j < i; ++j) {
                require(ids[i] != ids[j], "daily: pool listed twice");
            }
            require(core.pool(ids[i]).status == Status.Open, "daily: pool not open");
        }
        require(core.pool(ids[11]).key.expiry == e0 + 13 days, "daily: last pool not at the 14-day expiry");

        vm.setEnv("SEED_APR_BPS", "1000");
        vm.setEnv("SEED_UNIT_BPS", "10000");
        vm.setEnv("SEED_TTL", "1000");
        vm.setEnv("SEED_ROUTER", vm.toString(vm.parseJsonAddress(json, ".router")));
        new Seed().run();
        new Seed().run(); // skipped: already seeded
        (, uint32 sells) = core.bookHead(ids[0], SELL);
        require(sells == 2, "book seed: one crossing and one resting sell");
        vm.warp(core.nextBatchAt(ids[0]));
        new Seed().tick();
        for (uint256 i; i < ids.length; ++i) {
            IConfluere.PoolView memory v = core.pool(ids[i]);
            require(
                v.settleCount == 1 && v.lastClearingPrice != 0 && v.lastClearingPrice < v.key.strike, "book: no fill"
            );
            (, uint32 s1) = core.bookHead(ids[i], SELL);
            (, uint32 b1) = core.bookHead(ids[i], BUY);
            require(s1 == 1 && b1 == 1, "book: not two-sided after clearing");
        }
        uint96 p0 = core.pool(ids[11]).lastClearingPrice;
        vm.setEnv("TRADE_ROUND", "1");
        new Seed().trade();
        vm.warp(core.nextBatchAt(ids[0]));
        new Seed().tick();
        IConfluere.PoolView memory w = core.pool(ids[11]);
        require(w.settleCount == 2 && w.lastClearingPrice < p0, "trade: round 1 (higher rate) did not clear lower");
        (, uint32 s2) = core.bookHead(ids[11], SELL);
        require(s2 == 1, "trade: crossed a resting order");

        vm.setEnv("GRID", "");
        vm.setEnv("SALT", vm.toString(bytes32(uint256(0xc0f1))));
        vm.setEnv("EXPIRY", "0");
        vm.setEnv("LATER_EXPIRIES", "");
        vm.setEnv("LST_STRIKE_LOW", "950000000000000000");
        vm.setEnv("LST_STRIKE_HIGH", "980000000000000000");
        vm.setEnv("USD_STRIKE_LOW", "20000000");
        vm.setEnv("USD_STRIKE_HIGH", "30000000");
        vm.setEnv("SEED_APR_BPS", "0");
        vm.setEnv("SEED_UNIT_BPS", "10000");
        vm.setEnv("SEED_TTL", "48");
        vm.setEnv("SEED_ROUTER", vm.toString(address(0)));
        vm.removeFile(file);
    }

    /// @dev Runs after _dailyGrid (MOCKS=true, GRID and DEMO off). Own salts: the registry does not depend on the grid,
    /// so each grid needs its own (as on the real testnets).
    function _sepolia() internal {
        vm.chainId(11_155_111);
        _expectRevert(new Deploy(), "mocks: anvil only");
        vm.setEnv("MOCKS", "false");
        vm.setEnv("GRID", "daily");
        vm.setEnv("GRAD_11155111", "");
        _expectRevert(new Deploy(), "set GRAD_11155111");
        address weth = address(0xE7);
        address usdc = address(0x05DC);
        vm.setEnv(
            "GRAD_11155111",
            string.concat(
                vm.toString(weth),
                ":100000000000000000:1000000000000000:100000000000000000,",
                vm.toString(usdc),
                ":1000:100:100000"
            )
        );
        vm.setEnv("SALT", vm.toString(bytes32(uint256(0xc0f3))));
        Confluere core = new Deploy().run();
        require(core.WINDOW_BLOCKS() == 600 && core.grid().period == 1 days, "sepolia: window / grid");
        require(core.graduationFee(weth) == 1e17 && core.minNotional(usdc) == 100, "sepolia: GRAD row");
        require(vm.parseJsonUint(vm.readFile(file), ".chainId") == 11_155_111, "sepolia: chain id not recorded");
        vm.setEnv("GRID", "");
        vm.setEnv("DEMO", "true");
        vm.setEnv("SALT", vm.toString(bytes32(uint256(0xc0f4))));
        core = new Deploy().run();
        require(core.WINDOW_BLOCKS() == 25 && core.grid().period == 1 hours, "sepolia demo: window / grid");

        vm.setEnv("DEMO", "false");
        vm.setEnv("GRAD_11155111", "");
        vm.setEnv("SALT", vm.toString(bytes32(uint256(0xc0f1))));
        vm.removeFile(file);
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
        (,,, uint96 units,,,,) = core.order(ids[8], head);
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

    /// @notice One seed of every launch pool (SEED_UNIT_BPS; the book layout with SEED_APR_BPS) plus TRADE_ROUNDS
    /// trade rounds must clear at least the graduation volume of its market on the daily grid, with the GRAD_<chainId> row, tokens (LST, NATIVE, USDC) and strikes given in env. The real token
    /// addresses get mintable stand-ins with the real decimals (18; USDC 6). In-memory, nothing is sent.
    function gradCovered(uint256 chainId) external {
        file = string.concat(vm.projectRoot(), "/../deployments/.grad-check.tmp");
        vm.setEnv("DEPLOYMENTS_FILE", file);
        vm.setEnv("TREASURY", vm.toString(address(0xBEEF)));
        vm.setEnv("GUARDIAN", vm.toString(address(0xBEEF)));
        vm.setEnv("DEMO", "false");
        vm.setEnv("GRID", "daily");
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
        // the trade rounds scripts/lib/testnet.sh runs after the seed (TRADE_ROUNDS), one batch apart
        uint256 rounds = vm.envOr("TRADE_ROUNDS", uint256(0));
        for (uint256 r; r < rounds; ++r) {
            vm.setEnv("TRADE_ROUND", vm.toString(r));
            new Seed().trade();
            vm.warp(core.nextBatchAt(ids[0]));
            new Seed().settle();
        }
        for (uint256 i; i < ids.length; ++i) {
            IConfluere.PoolView memory v = core.pool(ids[i]);
            uint256 threshold = core.graduationFee(v.key.quote);
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
