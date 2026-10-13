// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IConfluere} from "../interfaces/IConfluere.sol";
import {IReceiver} from "../interfaces/IReceiver.sol";
import {Status} from "../libraries/PoolKey.sol";

interface IVaultKeep {
    function poke() external;
    function roll() external;
}

/// @notice Batch keeper entry point, also the Chainlink CRE report receiver.
/// It reads each pool's state and performs only the transitions that are due: settle, mature or close.
/// Every call it makes is permissionless on the core, so this contract needs no privileges and does not
/// restrict who calls it. The CRE workflow only has to deliver the list of pools and vaults on a schedule.
/// Unknown pool ids read as Status.None and are skipped; failing calls are caught so one bad entry blocks nothing.
contract KeeperReceiver is IReceiver {
    IConfluere public immutable core;
    uint256 public immutable maxBidsPerClose;

    event Ticked(uint256 settled, uint256 matured, uint256 closed, uint256 vaultCalls);

    constructor(IConfluere core_, uint256 maxBidsPerClose_) {
        core = core_;
        maxBidsPerClose = maxBidsPerClose_;
    }

    /// @inheritdoc IReceiver
    /// @dev report = abi.encode(bytes32[] pools, address[] vaults). Metadata is ignored: nothing here is privileged.
    function onReport(bytes calldata, bytes calldata report) external {
        (bytes32[] memory pools, address[] memory vaults) = abi.decode(report, (bytes32[], address[]));
        _tick(pools, vaults);
    }

    function tick(bytes32[] calldata pools, address[] calldata vaults) external {
        _tick(pools, vaults);
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == type(IReceiver).interfaceId || id == type(IERC165).interfaceId;
    }

    function _tick(bytes32[] memory pools, address[] memory vaults) internal {
        uint256 settled;
        uint256 matured;
        uint256 closed;
        uint256 vaultCalls;
        for (uint256 i; i < pools.length; ++i) {
            bytes32 pid = pools[i];
            IConfluere.PoolView memory v = core.pool(pid);
            if (v.status == Status.Open) {
                if (block.timestamp >= v.key.expiry) {
                    try core.mature(pid) {
                        matured++;
                    } catch {}
                } else if (block.number >= v.pausedUntil && block.timestamp >= core.nextBatchAt(pid)) {
                    try core.settleBatch(pid) {
                        settled++;
                    } catch {}
                }
            } else if ((v.status == Status.Window && block.number >= v.windowEnd) || v.status == Status.Closing) {
                try core.closeWindow(pid, maxBidsPerClose) {
                    closed++;
                } catch {}
            }
        }
        for (uint256 i; i < vaults.length; ++i) {
            // try/catch cannot catch the pre-call code-size check, so skip addresses without code
            if (vaults[i].code.length == 0) continue;
            try IVaultKeep(vaults[i]).poke() {
                vaultCalls++;
            } catch {}
            try IVaultKeep(vaults[i]).roll() {
                vaultCalls++;
            } catch {}
        }
        emit Ticked(settled, matured, closed, vaultCalls);
    }
}
