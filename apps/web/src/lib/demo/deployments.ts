/**
 * Deployments the demo runs on: the live testnet deployments (same core, router, registry and token addresses, so
 * logos and token rules stay exactly the same), with what a fuller network would have on top: on HyperEVM a staked HYPE
 * market (kHYPE, made-up address) and a kHYPE / USDC market (on Monad shMON / USDC), a HYPE lending market (USDC / WHYPE) with its HYPE Lending vault and a pegged vault, an LP token per demo market, daily maturities and
 * the production repayment windows (7,200 blocks on HyperEVM, 24,000 on Monad, 600 on Sepolia).
 *
 * Sepolia has no live deployment yet (deployments/sepolia.json comes with the founder's deploy), so its demo deployment
 * uses the real Sepolia tokens (WETH, USDC, wstETH: real logos and token rules) with made-up contract addresses; once
 * the SDK has the live deployment, the demo takes its contract addresses like on the other networks.
 */
import { deployments, type Deployment } from "@confluere/sdk";
import type { Address } from "viem";

/** Made-up addresses for contracts that only exist in the demo (lowercase, never deployed anywhere). */
export const DEMO_ADDR = {
  khype: "0xd3a0000000000000000000000000000000000a01",
  peggedVault998: "0xd3a0000000000000000000000000000000000b01",
  lpKhype998: "0xd3a0000000000000000000000000000000000c01",
  nativeLendVault998: "0xd3a0000000000000000000000000000000000b02",
  lpUsdcHypeAm998: "0xd3a0000000000000000000000000000000000c02",
  lpUsdcHypeEu998: "0xd3a0000000000000000000000000000000000c03",
  lpKhypeUsdcAm998: "0xd3a0000000000000000000000000000000000c04",
  lpKhypeUsdcEu998: "0xd3a0000000000000000000000000000000000c05",
  lpShmonUsdcAm10143: "0xd3a0000000000000000000000000000000000c06",
  lpShmonUsdcEu10143: "0xd3a0000000000000000000000000000000000c07",
  // the demo owns every vault and LP token address, so it never depends on what the live deployment has created yet
  usdLowVault998: "0xd3a0000000000000000000000000000000000b03",
  usdHighVault998: "0xd3a0000000000000000000000000000000000b04",
  peggedVault10143: "0xd3a0000000000000000000000000000000000b05",
  usdLowVault10143: "0xd3a0000000000000000000000000000000000b06",
  usdHighVault10143: "0xd3a0000000000000000000000000000000000b07",
  lpHypeUsdcAm998: "0xd3a0000000000000000000000000000000000c08",
  lpHypeUsdcEu998: "0xd3a0000000000000000000000000000000000c09",
  lpShmonMonAm10143: "0xd3a0000000000000000000000000000000000c0a",
  lpShmonMonEu10143: "0xd3a0000000000000000000000000000000000c0b",
  lpMonUsdcAm10143: "0xd3a0000000000000000000000000000000000c0c",
  lpMonUsdcEu10143: "0xd3a0000000000000000000000000000000000c0d",
  // Sepolia: the contracts too until the live deployment exists
  coreSepolia: "0xd3a0000000000000000000000000000000000d01",
  routerSepolia: "0xd3a0000000000000000000000000000000000d02",
  wrapperFactorySepolia: "0xd3a0000000000000000000000000000000000d03",
  vaultFactorySepolia: "0xd3a0000000000000000000000000000000000d04",
  seatRegistrySepolia: "0xd3a0000000000000000000000000000000000d05",
  keeperReceiverSepolia: "0xd3a0000000000000000000000000000000000d06",
  positionMarketSepolia: "0xd3a0000000000000000000000000000000000d07",
  guardianSepolia: "0xd3a0000000000000000000000000000000000d08",
  peggedVaultSepolia: "0xd3a0000000000000000000000000000000000b08",
  usdLowVaultSepolia: "0xd3a0000000000000000000000000000000000b09",
  usdHighVaultSepolia: "0xd3a0000000000000000000000000000000000b0a",
  lpWstethWethAmSepolia: "0xd3a0000000000000000000000000000000000c0e",
  lpWstethWethEuSepolia: "0xd3a0000000000000000000000000000000000c0f",
  lpWethUsdcAmSepolia: "0xd3a0000000000000000000000000000000000c10",
  lpWethUsdcEuSepolia: "0xd3a0000000000000000000000000000000000c11",
  lpWstethUsdcAmSepolia: "0xd3a0000000000000000000000000000000000c12",
  lpWstethUsdcEuSepolia: "0xd3a0000000000000000000000000000000000c13",
} as const satisfies Record<string, Address>;

/** The real Sepolia tokens (scripts/lib/testnet.sh): Uniswap's WETH9, Circle's USDC, Lido's wstETH. */
export const SEPOLIA_TOKENS = {
  weth: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
  usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  wsteth: "0xB82381A3fBD3FaFA77B3a7bE693342618240067b",
} as const satisfies Record<string, Address>;

/** Daily maturities at 08:00 UTC, one round a minute. */
export const DEMO_GRID = { anchor: 1791532800, period: 86_400, batchInterval: 60, maxExpiries: 60, strikeSigDigits: 2 };

const live = (id: number) => deployments[id]!;

function hyper(): Deployment {
  const d = live(998);
  return {
    ...d,
    windowBlocks: 7_200,
    gridAnchor: DEMO_GRID.anchor,
    gridPeriod: DEMO_GRID.period,
    batchInterval: DEMO_GRID.batchInterval,
    pools: { ...d.pools!, lst: DEMO_ADDR.khype, poolIds: [] },
    vaults: { pegged: DEMO_ADDR.peggedVault998, nativeLend: DEMO_ADDR.nativeLendVault998, usdLow: DEMO_ADDR.usdLowVault998, usdHigh: DEMO_ADDR.usdHighVault998 },
    seatLPTokens: {
      [`${d.pools!.native}-${d.pools!.usdc}-0`]: DEMO_ADDR.lpHypeUsdcAm998,
      [`${d.pools!.native}-${d.pools!.usdc}-1`]: DEMO_ADDR.lpHypeUsdcEu998,
      [`${DEMO_ADDR.khype}-${d.pools!.native}-0`]: DEMO_ADDR.lpKhype998,
      [`${d.pools!.usdc}-${d.pools!.native}-0`]: DEMO_ADDR.lpUsdcHypeAm998,
      [`${d.pools!.usdc}-${d.pools!.native}-1`]: DEMO_ADDR.lpUsdcHypeEu998,
      [`${DEMO_ADDR.khype}-${d.pools!.usdc}-0`]: DEMO_ADDR.lpKhypeUsdcAm998,
      [`${DEMO_ADDR.khype}-${d.pools!.usdc}-1`]: DEMO_ADDR.lpKhypeUsdcEu998,
    },
  };
}

function monad(): Deployment {
  const d = live(10143);
  return {
    ...d,
    windowBlocks: 24_000,
    gridAnchor: DEMO_GRID.anchor,
    gridPeriod: DEMO_GRID.period,
    batchInterval: DEMO_GRID.batchInterval,
    pools: { ...d.pools!, poolIds: [] },
    vaults: { pegged: DEMO_ADDR.peggedVault10143, usdLow: DEMO_ADDR.usdLowVault10143, usdHigh: DEMO_ADDR.usdHighVault10143 },
    seatLPTokens: {
      [`${d.pools!.lst}-${d.pools!.native}-0`]: DEMO_ADDR.lpShmonMonAm10143,
      [`${d.pools!.lst}-${d.pools!.native}-1`]: DEMO_ADDR.lpShmonMonEu10143,
      [`${d.pools!.native}-${d.pools!.usdc}-0`]: DEMO_ADDR.lpMonUsdcAm10143,
      [`${d.pools!.native}-${d.pools!.usdc}-1`]: DEMO_ADDR.lpMonUsdcEu10143,
      [`${d.pools!.lst}-${d.pools!.usdc}-0`]: DEMO_ADDR.lpShmonUsdcAm10143,
      [`${d.pools!.lst}-${d.pools!.usdc}-1`]: DEMO_ADDR.lpShmonUsdcEu10143,
    },
  };
}

function sepolia(): Deployment {
  const live: Deployment | undefined = deployments[11155111];
  const d: Deployment = live ?? {
    chainId: 11155111,
    demo: false,
    confluere: DEMO_ADDR.coreSepolia,
    router: DEMO_ADDR.routerSepolia,
    wrapperFactory: DEMO_ADDR.wrapperFactorySepolia,
    vaultFactory: DEMO_ADDR.vaultFactorySepolia,
    keeperReceiver: DEMO_ADDR.keeperReceiverSepolia,
    seatRegistry: DEMO_ADDR.seatRegistrySepolia,
    positionMarket: DEMO_ADDR.positionMarketSepolia,
    guardian: DEMO_ADDR.guardianSepolia,
    windowBlocks: 600,
    grid: "daily",
    maxExpiries: 15,
    gridAnchor: DEMO_GRID.anchor,
    gridPeriod: DEMO_GRID.period,
    batchInterval: 120,
    deployBlock: 11_900_000,
  };
  const { weth, usdc, wsteth } = SEPOLIA_TOKENS;
  return {
    ...d,
    windowBlocks: 600,
    gridAnchor: DEMO_GRID.anchor,
    gridPeriod: DEMO_GRID.period,
    batchInterval: DEMO_GRID.batchInterval,
    pools: { expiry: DEMO_GRID.anchor, ...d.pools, lst: wsteth, native: weth, usdc, poolIds: [] },
    vaults: { pegged: DEMO_ADDR.peggedVaultSepolia, usdLow: DEMO_ADDR.usdLowVaultSepolia, usdHigh: DEMO_ADDR.usdHighVaultSepolia },
    seatLPTokens: {
      [`${wsteth}-${weth}-0`]: DEMO_ADDR.lpWstethWethAmSepolia,
      [`${wsteth}-${weth}-1`]: DEMO_ADDR.lpWstethWethEuSepolia,
      [`${weth}-${usdc}-0`]: DEMO_ADDR.lpWethUsdcAmSepolia,
      [`${weth}-${usdc}-1`]: DEMO_ADDR.lpWethUsdcEuSepolia,
      [`${wsteth}-${usdc}-0`]: DEMO_ADDR.lpWstethUsdcAmSepolia,
      [`${wsteth}-${usdc}-1`]: DEMO_ADDR.lpWstethUsdcEuSepolia,
    },
  };
}

let cache: Record<number, Deployment> | undefined;

/** The demo deployment of a network (HyperEVM testnet, Monad testnet and Sepolia). */
export function demoDeploymentOf(id: number): Deployment | undefined {
  cache ??= { 998: hyper(), 10143: monad(), 11155111: sepolia() };
  return cache[id];
}
