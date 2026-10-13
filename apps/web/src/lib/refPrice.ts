"use client";

/**
 * Reference prices, display only (ARCHITECTURE §4). They help a user pick a limit; they are never sent on-chain and
 * nothing in the protocol reads them.
 *
 * - HyperEVM: HyperCore's read precompile `spotPx(uint32 spotIndex)` at 0x…0808. The raw value is the spot price
 *   scaled by 10^(8 - szDecimals of the base token). Verified on testnet 2026-10-11: HYPE/USDC (@1035) raw 22526000,
 *   szDecimals 2 -> 22.526 USDC, against an API mid of 22.753.
 * - Monad: Kuru's public order book mid (via /api/ref/kuru, since Kuru sends no CORS headers). On testnet the demo
 *   tokens stand in for MON and USDC, so the mainnet MON_USDC book is the reference.
 * - An LST against its own native coin (shMON/WMON on Monad): the LST's ERC-4626 `convertToAssets(1 LST)`, i.e. how
 *   much native coin one LST redeems for. Still display only.
 * - Elsewhere: an optional HTTP endpoint (NEXT_PUBLIC_REF_PRICE_URL?asset=&quote= -> {"price": number}).
 */
import { useQuery } from "@tanstack/react-query";
import { encodeAbiParameters, hexToBigInt, parseAbi, type Address, type PublicClient } from "viem";
import { REF_PRICE_URL } from "./config";
import { launchTokensOf } from "./chains";
import { useChainCtx } from "./data";
import { appFetch } from "./demo/client";

const SPOT_PX = "0x0000000000000000000000000000000000000808" as const;
const erc4626Abi = parseAbi(["function convertToAssets(uint256 shares) view returns (uint256)"]);

type CorePair = { spotIndex: number; szDecimals: number };

/** EVM token (lowercase) -> its HyperCore spot pair against USDC. Extend as tokens are listed. */
export const HYPERCORE_USDC_PAIRS: Record<number, Record<string, CorePair>> = {
  998: {
    "0x5555555555555555555555555555555555555555": { spotIndex: 1035, szDecimals: 2 }, // WHYPE ~ HYPE/USDC
  },
  999: {
    "0x5555555555555555555555555555555555555555": { spotIndex: 107, szDecimals: 2 }, // WHYPE ~ HYPE/USDC
  },
};

/** USDC-like quote tokens per chain (the HyperCore-linked USDC on HyperEVM). */
export const USD_QUOTES: Record<number, string[]> = {
  998: ["0x2b3370ee501b4a559b57d449569354196457d8ab"],
};

/** Kuru symbol per token on Monad: the real tokens on mainnet, the demo stand-ins on testnet. */
export function kuruSymbol(chainId: number, token: string): string | undefined {
  if (chainId !== 10143 && chainId !== 143) return undefined;
  // mock deployments list their stand-ins under `tokens`; real-token deployments only under `pools`
  const t = launchTokensOf(chainId);
  if (t.native && token === t.native.toLowerCase()) return "MON";
  if (t.usdc && token === t.usdc.toLowerCase()) return "USDC";
  return undefined;
}

export function spotPxToPrice(raw: bigint, szDecimals: number): number {
  return Number(raw) / 10 ** (8 - szDecimals);
}

async function corePrice(client: PublicClient | undefined, pair: CorePair): Promise<number> {
  const data = encodeAbiParameters([{ type: "uint32" }], [pair.spotIndex]);
  const res = await client!.call({ to: SPOT_PX, data });
  return spotPxToPrice(hexToBigInt(res.data ?? "0x0"), pair.szDecimals);
}

/** Price of 1 `asset` in `quote`, or undefined when no source covers the pair. */
export function useRefPrice(asset: Address | undefined, quote: Address | undefined) {
  const { chainId, client } = useChainCtx();
  const a = (asset ?? "").toLowerCase();
  const q = (quote ?? "").toLowerCase();
  const pairs = HYPERCORE_USDC_PAIRS[chainId] ?? {};
  const usd = USD_QUOTES[chainId] ?? [];
  const coreA = pairs[a];
  const coreQ = pairs[q];
  const viaCore = !!coreA && (usd.includes(q) || !!coreQ);
  // the inverse pair (USD collateral, coin loan: USDC / WHYPE) is 1 / the coin's USD price
  const viaCoreInv = !coreA && usd.includes(a) && !!coreQ;
  const kA = kuruSymbol(chainId, a);
  const kQ = kuruSymbol(chainId, q);
  const viaKuru = !viaCore && !viaCoreInv && !!kA && !!kQ;
  const lt = launchTokensOf(chainId);
  const viaLst = !viaCore && !viaCoreInv && !viaKuru && !!lt.lst && !!lt.native && a === lt.lst.toLowerCase() && q === lt.native.toLowerCase();
  return useQuery({
    queryKey: ["ref", chainId, a, q],
    enabled: !!client && !!a && !!q && (viaCore || viaCoreInv || viaKuru || viaLst || !!REF_PRICE_URL),
    refetchInterval: 15_000,
    queryFn: async (): Promise<number | null> => {
      if (viaCoreInv) {
        const pq = await corePrice(client, coreQ!);
        return pq > 0 ? 1 / pq : null;
      }
      if (viaCore) {
        const pa = await corePrice(client, coreA!);
        if (usd.includes(q)) return pa;
        const pq = await corePrice(client, coreQ!); // cross through USDC, e.g. kHYPE/HYPE
        return pq > 0 ? pa / pq : null;
      }
      if (viaLst) {
        const assets = (await client!.readContract({ address: asset!, abi: erc4626Abi, functionName: "convertToAssets", args: [10n ** 18n] })) as bigint;
        return Number(assets) / 1e18;
      }
      if (viaKuru) {
        const r = await appFetch(`/api/ref/kuru?symbol=${kA}_${kQ}`);
        const j = r.ok ? ((await r.json()) as { price?: number | null }) : {};
        return typeof j.price === "number" ? j.price : null;
      }
      const r = await fetch(`${REF_PRICE_URL}?asset=${a}&quote=${q}`);
      if (!r.ok) return null;
      const j = (await r.json()) as { price?: number };
      return typeof j.price === "number" ? j.price : null;
    },
  });
}
