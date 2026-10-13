// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IConfluere} from "../interfaces/IConfluere.sol";
import {Vault} from "./Vault.sol";

/// @notice Deploys vaults with fixed strategies at deterministic addresses and keeps a public list. No admin.
contract VaultFactory {
    IConfluere public immutable core;
    address[] public vaults;

    event VaultCreated(address indexed vault, address indexed quote, string symbol);

    constructor(IConfluere core_) {
        core = core_;
    }

    function create(Vault.Strategy calldata s, string calldata name, string calldata symbol, bytes32 salt)
        external
        returns (Vault v)
    {
        v = new Vault{salt: keccak256(abi.encode(msg.sender, salt))}(core, s, name, symbol);
        vaults.push(address(v));
        emit VaultCreated(address(v), s.quote, symbol);
    }

    function vaultsLength() external view returns (uint256) {
        return vaults.length;
    }
}
