// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IConfluere} from "../interfaces/IConfluere.sol";
import {Vault} from "./Vault.sol";

/// @notice Deploys vaults with fixed strategies at deterministic addresses and keeps a public list. No admin.
/// @dev The Vault init code is too large to embed (EIP-170), so the caller passes it and the factory checks it against
/// the code hash fixed at construction: only the one audited Vault bytecode can be deployed through it.
contract VaultFactory {
    IConfluere public immutable core;
    bytes32 public immutable vaultCodeHash;
    address[] public vaults;

    event VaultCreated(address indexed vault, address indexed quote, string symbol);

    error WrongVaultCode();
    error DeployFailed();

    constructor(IConfluere core_, bytes32 vaultCodeHash_) {
        core = core_;
        vaultCodeHash = vaultCodeHash_;
    }

    /// @param initCode `type(Vault).creationCode`; must hash to `vaultCodeHash`.
    function create(
        bytes calldata initCode,
        Vault.Strategy calldata s,
        string calldata name,
        string calldata symbol,
        bytes32 salt
    ) external returns (Vault v) {
        if (keccak256(initCode) != vaultCodeHash) revert WrongVaultCode();
        bytes memory init = abi.encodePacked(initCode, abi.encode(core, s, name, symbol));
        bytes32 k = keccak256(abi.encode(msg.sender, salt));
        address a;
        assembly ("memory-safe") {
            a := create2(0, add(init, 0x20), mload(init), k)
        }
        if (a == address(0)) revert DeployFailed();
        v = Vault(a);
        vaults.push(a);
        emit VaultCreated(a, s.quote, symbol);
    }

    function vaultsLength() external view returns (uint256) {
        return vaults.length;
    }
}
