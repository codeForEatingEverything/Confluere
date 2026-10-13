// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {VaultFactory} from "../src/periphery/VaultFactory.sol";
import {Vault} from "../src/periphery/Vault.sol";
import {Kind} from "../src/libraries/PoolKey.sol";
import {DeployConfig} from "./DeployConfig.sol";

/// @notice Launch vaults (blueprint §5), per chain, on the tokens CreatePools used:
/// - rv<NATIVE>-Pegged: lends the native coin into the LST/native loop pools, lowest traded strike.
/// - rvUSD-<NATIVE>-Low: lends USD into native/USD pools, lowest traded strike.
/// - rvUSD-<NATIVE>-High: lends USD into native/USD pools, highest traded strike (dual-currency style).
/// - rvNATIVE-Lend (only with an extra pair, `.pools.extraAsset` / `.pools.extraQuote`, see CreatePools.s.sol): lends
///   the extra pair's quote into its pools, lowest traded strike; recorded as `.vaults.nativeLend`. On HyperEVM testnet
///   the extra pair is USDC/WHYPE, so this vault lends the native coin there (the chain has no LST for a pegged vault).
/// Strategies are fixed at deployment; 25% of idle funds per batch; only graduated markets; never lend above
/// 99.5% (pegged) / 99% (USD) of K. Re-running it reuses the vaults an earlier run created.
contract CreateVaults is Script {
    function run() external {
        string memory path = DeployConfig.deploymentsFile(vm);
        string memory json = vm.readFile(path);
        VaultFactory f = VaultFactory(vm.parseJsonAddress(json, ".vaultFactory"));
        address lst = vm.parseJsonAddress(json, ".pools.lst");
        address native = vm.parseJsonAddress(json, ".pools.native");
        address usdc = vm.parseJsonAddress(json, ".pools.usdc");

        address xa;
        address xq;
        if (vm.keyExistsJson(json, ".pools.extraAsset")) {
            xa = vm.parseJsonAddress(json, ".pools.extraAsset");
            xq = vm.parseJsonAddress(json, ".pools.extraQuote");
        }

        vm.startBroadcast();
        Vault[3] memory v = _create(f, lst, native, usdc);
        // the native-coin lending vault only when the extra pair lends the native coin (HyperEVM USDC/WHYPE); Monad's
        // shMON/USDC extra pair lends USDC, which the USD vaults already cover
        Vault x = xa == address(0) || xq != native ? Vault(address(0)) : _extraVault(f, xa, xq);
        vm.stopBroadcast();

        string memory k = "vaults";
        if (address(x) != address(0)) vm.serializeAddress(k, "nativeLend", address(x));
        vm.serializeAddress(k, "pegged", address(v[0]));
        vm.serializeAddress(k, "usdLow", address(v[1]));
        string memory out = vm.serializeAddress(k, "usdHigh", address(v[2]));
        vm.writeJson(out, path, ".vaults");
        console2.log("vaults", address(v[0]), address(v[1]), address(v[2]));
        if (address(x) != address(0)) console2.log("vaults nativeLend", address(x));
    }

    /// @return v pegged (zero without an LST), USD low strike, USD high strike
    function _create(VaultFactory f, address lst, address native, address usdc) internal returns (Vault[3] memory v) {
        (, address me,) = vm.readCallers();
        address[] memory a1 = new address[](1);
        a1[0] = lst;
        address[] memory a2 = new address[](1);
        a2[0] = native;
        // no LST on the chain (HyperEVM testnet today): no loop pools, so no pegged vault
        if (lst != address(0)) {
            v[0] = _vault(
                f,
                me,
                Vault.Strategy(native, a1, Kind.American, Vault.StrikeRule.LowestTraded, 2500, 9950),
                "Confluere Pegged Loop Vault",
                "rvNATIVE-Pegged",
                bytes32("pegged")
            );
        }
        v[1] = _vault(
            f,
            me,
            Vault.Strategy(usdc, a2, Kind.American, Vault.StrikeRule.LowestTraded, 2500, 9900),
            "Confluere USD Low-Strike Vault",
            "rvUSD-NATIVE-Low",
            bytes32("usd-low")
        );
        v[2] = _vault(
            f,
            me,
            Vault.Strategy(usdc, a2, Kind.American, Vault.StrikeRule.HighestTraded, 2500, 9900),
            "Confluere USD High-Strike Vault",
            "rvUSD-NATIVE-High",
            bytes32("usd-high")
        );
    }

    /// @dev Lends `quote` into the extra pair's American pools, lowest traded strike (the most collateral per unit
    /// lent), at most 99% of K like the USD vaults (the pair is not pegged).
    function _extraVault(VaultFactory f, address asset, address quote) internal returns (Vault) {
        (, address me,) = vm.readCallers();
        address[] memory a = new address[](1);
        a[0] = asset;
        return _vault(
            f,
            me,
            Vault.Strategy(quote, a, Kind.American, Vault.StrikeRule.LowestTraded, 2500, 9900),
            "Confluere Native Lend Vault",
            "rvNATIVE-Lend",
            bytes32("native-lend")
        );
    }

    /// @dev Idempotent: the factory deploys each vault with CREATE2 (salt bound to the caller), so a vault an earlier
    /// run already created is found at its address and reused instead of colliding.
    function _vault(
        VaultFactory f,
        address me,
        Vault.Strategy memory s,
        string memory name,
        string memory symbol,
        bytes32 salt
    ) internal returns (Vault v) {
        bytes memory init = abi.encodePacked(type(Vault).creationCode, abi.encode(f.core(), s, name, symbol));
        v = Vault(vm.computeCreate2Address(keccak256(abi.encode(me, salt)), keccak256(init), address(f)));
        if (address(v).code.length == 0) v = f.create(s, name, symbol, salt);
    }
}
