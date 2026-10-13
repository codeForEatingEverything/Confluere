// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IConfluere} from "../interfaces/IConfluere.sol";

/// @notice M-of-N multisig whose only power is the core's time-limited pause of un-graduated pools.
/// Members and threshold are fixed at deployment; there is no admin and no way to call anything else.
/// The core's address is bound once by `binder` after the core exists (the core stores this guardian's address, so the
/// two cannot both be immutable). `binder` is a constructor argument rather than msg.sender because deployments go
/// through the CREATE2 factory, which would otherwise be the only account able to bind.
contract Guardian {
    IConfluere public core;
    address internal immutable _binder;
    uint256 public immutable threshold;
    mapping(address => bool) public isMember;
    mapping(bytes32 => mapping(address => bool)) public approved;
    mapping(bytes32 => uint256) public approvals;
    mapping(bytes32 => bool) public executed;

    error NotMember();
    error AlreadyApproved();
    error InvalidConfig();
    error AlreadyBound();

    event Approved(bytes32 indexed proposal, address indexed member, bytes32 poolId, uint64 blocks, uint256 nonce);
    event Executed(bytes32 indexed proposal, bytes32 indexed poolId, uint64 blocks);

    constructor(address binder, address[] memory members, uint256 threshold_) {
        if (threshold_ == 0 || threshold_ > members.length) revert InvalidConfig();
        _binder = binder;
        threshold = threshold_;
        for (uint256 i; i < members.length; ++i) {
            if (members[i] == address(0) || isMember[members[i]]) revert InvalidConfig();
            isMember[members[i]] = true;
        }
    }

    function bind(IConfluere core_) external {
        if (msg.sender != _binder || address(core) != address(0)) revert AlreadyBound();
        core = core_;
    }

    function proposalId(bytes32 poolId, uint64 blocks, uint256 nonce) public pure returns (bytes32) {
        return keccak256(abi.encode(poolId, blocks, nonce));
    }

    /// @notice Approve pausing `poolId` for `blocks`; executes when the threshold is reached.
    function approvePause(bytes32 poolId, uint64 blocks, uint256 nonce) external {
        if (!isMember[msg.sender]) revert NotMember();
        bytes32 p = proposalId(poolId, blocks, nonce);
        if (approved[p][msg.sender]) revert AlreadyApproved();
        approved[p][msg.sender] = true;
        uint256 n = ++approvals[p];
        emit Approved(p, msg.sender, poolId, blocks, nonce);
        if (n >= threshold && !executed[p]) {
            executed[p] = true;
            core.pause(poolId, blocks);
            emit Executed(p, poolId, blocks);
        }
    }
}
