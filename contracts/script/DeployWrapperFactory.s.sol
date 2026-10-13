// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {IConfluere} from "../src/interfaces/IConfluere.sol";
import {ERC6909WrapperFactory} from "../src/periphery/ERC6909Wrapper.sol";
import {DeployConfig} from "./DeployConfig.sol";

/// @notice Deploys the ERC-20 wrapper factory (and with it the wrapper implementation) for the core in
/// deployments/<chain>.json and records it under .wrapperFactory: CREATE2 with the same salt as Deploy, so the address
/// matches across chains that share the core and equals what a Deploy re-run computes. One transaction; skips the
/// broadcast when it is already deployed. Used to replace the factory without redeploying anything else (2026-10-13:
/// wrapper names derived from the pool key).
contract DeployWrapperFactory is Script {
    function run() external {
        string memory path =
            string.concat(vm.projectRoot(), "/../deployments/", DeployConfig.chainName(block.chainid), ".json");
        string memory json = vm.readFile(path);
        IConfluere core = IConfluere(vm.parseJsonAddress(json, ".confluere"));
        bytes32 salt = vm.envOr("SALT", bytes32(uint256(0xc0f1)));

        bytes memory init = abi.encodePacked(type(ERC6909WrapperFactory).creationCode, abi.encode(core));
        address a = vm.computeCreate2Address(salt, keccak256(init));
        if (a.code.length == 0) {
            vm.startBroadcast();
            a = address(new ERC6909WrapperFactory{salt: salt}(core));
            vm.stopBroadcast();
        }
        console2.log("wrapperFactory", a);
        vm.writeJson(vm.toString(a), path, ".wrapperFactory");
    }
}
