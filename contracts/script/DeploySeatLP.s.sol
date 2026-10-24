// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {IConfluere} from "../src/interfaces/IConfluere.sol";
import {SeatRegistry} from "../src/periphery/SeatRegistry.sol";
import {SeatLPToken} from "../src/periphery/SeatLPToken.sol";
import {Kind} from "../src/libraries/PoolKey.sol";
import {DeployConfig} from "./DeployConfig.sol";

/// @notice Deploys one LP receipt token (SeatLPToken) per market of the pools in deployments/<chain>.json (CREATE2,
/// skipped when already deployed) and records them under .seatLPTokens as "asset-quote-kind" => token. Reads and writes
/// DEPLOYMENTS_FILE when set (the staging copy of scripts/deploy-testnet.sh, step seatlp).
contract DeploySeatLP is Script {
    function run() external {
        string memory path = DeployConfig.deploymentsFile(vm);
        string memory json = vm.readFile(path);
        IConfluere core = IConfluere(vm.parseJsonAddress(json, ".confluere"));
        SeatRegistry reg = SeatRegistry(vm.parseJsonAddress(json, ".seatRegistry"));
        bytes32[] memory ids = vm.parseJsonBytes32Array(json, ".pools.poolIds");
        bytes32 salt = vm.envOr("SALT", bytes32(uint256(0xc0f1)));

        string memory k = "seatLP";
        string memory out;
        bytes32[] memory seen = new bytes32[](ids.length);
        uint256 n;
        vm.startBroadcast();
        for (uint256 i; i < ids.length; ++i) {
            IConfluere.PoolView memory v = core.pool(ids[i]);
            bytes32 m = keccak256(abi.encode(v.key.asset, v.key.quote, v.key.kind));
            bool dup;
            for (uint256 j; j < n; ++j) {
                if (seen[j] == m) dup = true;
            }
            if (dup) continue;
            seen[n++] = m;
            bytes memory init =
                abi.encodePacked(type(SeatLPToken).creationCode, abi.encode(reg, v.key.asset, v.key.quote, v.key.kind));
            address a = vm.computeCreate2Address(salt, keccak256(init));
            if (a.code.length == 0) {
                a = address(new SeatLPToken{salt: salt}(reg, v.key.asset, v.key.quote, Kind(v.key.kind)));
            }
            string memory key = string.concat(
                vm.toString(v.key.asset), "-", vm.toString(v.key.quote), "-", vm.toString(uint256(uint8(v.key.kind)))
            );
            out = vm.serializeAddress(k, key, a);
            console2.log("lp token", key, a);
        }
        vm.stopBroadcast();
        vm.writeJson(out, path, ".seatLPTokens");
    }
}
