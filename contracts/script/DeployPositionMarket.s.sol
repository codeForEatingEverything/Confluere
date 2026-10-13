// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {IConfluere} from "../src/interfaces/IConfluere.sol";
import {PositionMarket} from "../src/periphery/PositionMarket.sol";
import {DeployConfig} from "./DeployConfig.sol";

/// @notice Deploys the C/R secondary market (PositionMarket) for the core in deployments/<chain>.json (CREATE2 with
/// the same salt as Deploy, so the address matches across chains that share the core) and records it under
/// .positionMarket. Skips the broadcast when it is already deployed.
contract DeployPositionMarket is Script {
    function run() external {
        string memory path =
            string.concat(vm.projectRoot(), "/../deployments/", DeployConfig.chainName(block.chainid), ".json");
        string memory json = vm.readFile(path);
        IConfluere core = IConfluere(vm.parseJsonAddress(json, ".confluere"));
        bytes32 salt = vm.envOr("SALT", bytes32(uint256(0xc0f1)));

        bytes memory init = abi.encodePacked(type(PositionMarket).creationCode, abi.encode(core));
        address a = vm.computeCreate2Address(salt, keccak256(init));
        if (a.code.length == 0) {
            vm.startBroadcast();
            a = address(new PositionMarket{salt: salt}(core));
            vm.stopBroadcast();
        }
        console2.log("positionMarket", a);
        vm.writeJson(vm.toString(a), path, ".positionMarket");
    }
}
