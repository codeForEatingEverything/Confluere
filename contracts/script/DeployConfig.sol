// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Vm} from "forge-std/Vm.sol";
import {Confluere} from "../src/Confluere.sol";
import {GridConfig} from "../src/libraries/Grid.sol";

/// @notice The chain table baked into every deployment. Every chain gets the same init code, so the same CREATE2
/// address; the core picks its row by block.chainid. The treasury of each row is that chain's SeatRegistry, whose
/// CREATE2 address the deploy script precomputes for every chain; the guardian must be the same on every chain.
library DeployConfig {
    uint64 internal constant FRIDAY_ANCHOR = 1_791_532_800; // 2026-10-09 08:00 UTC

    uint256 internal constant MONAD = 143;
    uint256 internal constant MONAD_TESTNET = 10_143;
    uint256 internal constant HYPEREVM = 999;
    uint256 internal constant HYPEREVM_TESTNET = 998;
    uint256 internal constant ANVIL = 31_337;

    /// @notice Per-chain quote-token parameters: graduation baseline (per-expiry volume, blueprint §10) and the
    /// anti-dust minimum order notional (valued at K). Same index in all three arrays.
    struct Grad {
        address[] quotes;
        uint256[] volumes;
        uint256[] minNotionals;
        uint256[] seatObligations; // per-batch competitive notional a seat holder must post (blueprint §13 Q2 open)
    }

    /// @param demo minute-scale grid and short windows so the whole lifecycle fits in a live demo
    /// @param grad one entry per chain, in the order of the table below (Monad, Monad testnet, HyperEVM,
    /// HyperEVM testnet, anvil). The whole table is part of the init code, so pass the same table on every chain.
    function build(bool demo, address[5] memory treasury, address guardian, Grad[5] memory grad)
        internal
        pure
        returns (Confluere.Config memory c)
    {
        c.grid = demo
            ? GridConfig({
                anchor: FRIDAY_ANCHOR, period: 1 hours, batchInterval: 2 minutes, maxExpiries: 4, strikeSigDigits: 2
            })
            : GridConfig({
                anchor: FRIDAY_ANCHOR, period: 7 days, batchInterval: 30 minutes, maxExpiries: 4, strikeSigDigits: 2
            });
        c.maxOrdersPerSide = 128; // ~6.6M gas worst case: fits Monad blocks and HyperEVM big blocks
        c.maxBids = 64;
        c.chains = new Confluere.ChainParams[](5);
        // windowBlocks: ~2h (demo: ~5 min). Monad measured ~0.3 s/block, HyperEVM small blocks 1 s, anvil 1 s.
        c.chains[0] = _chain(MONAD, demo ? 1000 : 24_000, 2_016_000, treasury[0], guardian, grad[0]);
        c.chains[1] = _chain(MONAD_TESTNET, demo ? 1000 : 24_000, 2_016_000, treasury[1], guardian, grad[1]);
        c.chains[2] = _chain(HYPEREVM, demo ? 300 : 7200, 604_800, treasury[2], guardian, grad[2]);
        c.chains[3] = _chain(HYPEREVM_TESTNET, demo ? 300 : 7200, 604_800, treasury[3], guardian, grad[3]);
        c.chains[4] = _chain(ANVIL, demo ? 300 : 7200, 604_800, treasury[4], guardian, grad[4]);
    }

    function _chain(uint256 id, uint64 window, uint64 maxPause, address treasury, address guardian, Grad memory g)
        private
        pure
        returns (Confluere.ChainParams memory p)
    {
        p.chainId = id;
        p.windowBlocks = window;
        p.maxPauseBlocks = maxPause;
        p.treasury = treasury;
        p.guardian = guardian;
        // Empty means no market can graduate on that chain (and vaults never invest there), and no order minimum.
        p.graduationQuotes = g.quotes;
        p.graduationVolumes = g.volumes;
        p.minNotionalQuotes = g.quotes;
        p.minNotionals = g.minNotionals;
    }

    /// @notice deployments/<chain>.json, or DEPLOYMENTS_FILE when set (scripts/deploy-testnet.sh points the scripts at
    /// a staging copy and moves it into place only once the broadcast has landed on chain).
    function deploymentsFile(Vm vm) internal view returns (string memory) {
        string memory canonical = string.concat(vm.projectRoot(), "/../deployments/", chainName(block.chainid), ".json");
        return vm.envOr("DEPLOYMENTS_FILE", canonical);
    }

    function chainName(uint256 id) internal pure returns (string memory) {
        if (id == MONAD) return "monad";
        if (id == MONAD_TESTNET) return "monad-testnet";
        if (id == HYPEREVM) return "hyperevm";
        if (id == HYPEREVM_TESTNET) return "hyperevm-testnet";
        if (id == ANVIL) return "anvil";
        revert("unsupported chain");
    }
}
