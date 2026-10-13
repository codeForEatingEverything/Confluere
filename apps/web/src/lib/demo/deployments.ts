/**
 * Deployments the demo runs on: the live testnet deployments (same core, router, registry and token addresses, so
 * logos and token rules stay exactly the same), with what a fuller network would have on top: on HyperEVM a staked HYPE
 * market (kHYPE, made-up address) and a kHYPE / USDC market (on Monad shMON / USDC), a HYPE lending market (USDC / WHYPE) with its HYPE Lending vault and a pegged vault, an LP token per demo market, daily maturities and
 * the production repayment windows (7,200 blocks on HyperEVM, 24,000 on Monad).
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
    vaults: { ...d.vaults!, pegged: DEMO_ADDR.peggedVault998, nativeLend: DEMO_ADDR.nativeLendVault998 },
    seatLPTokens: {
      ...d.seatLPTokens,
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
    seatLPTokens: {
      ...d.seatLPTokens,
      [`${d.pools!.lst}-${d.pools!.usdc}-0`]: DEMO_ADDR.lpShmonUsdcAm10143,
      [`${d.pools!.lst}-${d.pools!.usdc}-1`]: DEMO_ADDR.lpShmonUsdcEu10143,
    },
  };
}

let cache: Record<number, Deployment> | undefined;

/** The demo deployment of a network (HyperEVM testnet and Monad testnet only). */
export function demoDeploymentOf(id: number): Deployment | undefined {
  cache ??= { 998: hyper(), 10143: monad() };
  return cache[id];
}
