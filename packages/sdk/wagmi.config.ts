import { defineConfig } from "@wagmi/cli";
import { foundry } from "@wagmi/cli/plugins";

// ABIs come straight from the Foundry artifacts; run `forge build` in contracts/ first.
export default defineConfig({
  out: "src/generated.ts",
  plugins: [
    foundry({
      project: "../../contracts",
      forge: { build: false },
      // duplicate artifact copies: crytic-compile writes out/src/**, the vault size profile writes out/periphery/**
      exclude: ["src/**", "periphery/**", "**/*.size.json", "**/*.t.sol/**", "**/*.s.sol/**"],
      include: [
        "Confluere.sol/Confluere.json",
        "Vault.sol/Vault.json",
        "VaultFactory.sol/VaultFactory.json",
        "Router.sol/Router.json",
        "ERC6909Wrapper.sol/ERC6909Wrapper.json",
        "ERC6909Wrapper.sol/ERC6909WrapperFactory.json",
        "SeatRegistry.sol/SeatRegistry.json",
        "KeeperReceiver.sol/KeeperReceiver.json",
        "PositionMarket.sol/PositionMarket.json",
      ],
    }),
  ],
});
