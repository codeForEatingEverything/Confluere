/** Shared fixtures for the jsdom render tests: realistic pool rows, tokens and chain-free mocks. */
import { Kind, Status } from "@confluere/sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";

export const ME = "0x00000000000000000000000000000000000000e1" as const;
export const OTHER = "0x00000000000000000000000000000000000000f2" as const;
export const ZERO = "0x0000000000000000000000000000000000000000" as const;
export const WETH = "0x00000000000000000000000000000000000000a1" as const;
export const USDC = "0x00000000000000000000000000000000000000b2" as const;
export const LST = "0x00000000000000000000000000000000000000a3" as const;
export const NAT = "0x00000000000000000000000000000000000000a4" as const;
export const CORE = "0x00000000000000000000000000000000000000d4" as const;
export const ROUTER = "0x00000000000000000000000000000000000000d5" as const;
export const REG = "0x00000000000000000000000000000000000000c3" as const;
export const VAULT = "0x00000000000000000000000000000000000000c7" as const;
export const NOW = 1_791_600_000;
export const ANCHOR = 1_791_532_800;
export const E18 = 10n ** 18n;

export const pid = (b: string) => `0x${b.repeat(32)}` as `0x${string}`;

export const TOKENS = {
  [WETH]: { address: WETH, symbol: "WETH", decimals: 18 },
  [USDC]: { address: USDC, symbol: "USDC", decimals: 6 },
  [LST]: { address: LST, symbol: "kHYPE", decimals: 18 },
  [NAT]: { address: NAT, symbol: "HYPE", decimals: 18 },
};

export const row = (id: string, over: Record<string, unknown> = {}) => ({
  id: id as `0x${string}`,
  asset: WETH as `0x${string}`,
  quote: USDC as `0x${string}`,
  expiry: NOW + 3 * 86_400,
  strike: 3000_000000n,
  kind: Kind.American,
  status: Status.Open,
  assetDecimals: 18,
  feeBps: 1000,
  bandBps: 800,
  bandFailures: 0,
  bandBase: 2900_000000n,
  lastClearingPrice: 2900_000000n,
  vwap: 2900_000000n,
  settleCount: 3,
  windowEnd: 0n,
  pausedUntil: 0n,
  quoteBal: 0n,
  assetBal: E18,
  surplusBal: 0n,
  nextBatchAt: NOW + 600,
  batchInterval: 1800,
  cadence: 0,
  minFill: 0n,
  firstLo: 0n,
  firstHi: 0n,
  graduated: true,
  expiryWindowEnd: 0n,
  block: 1000n,
  ...over,
});

export const order = (id: bigint, side: number, units: bigint, limit: bigint, owner: string = OTHER, over: Record<string, unknown> = {}) => ({
  id,
  owner: owner as `0x${string}`,
  side,
  units,
  limit,
  escrow: 0n,
  deadline: 10,
  ...over,
});

export const wrap = (el: ReactElement) => render(<QueryClientProvider client={new QueryClient()}>{el}</QueryClientProvider>);

/** Mutable chain state behind the mocked data hooks; tests set fields, the mocks read them on render. */
export const DS: Record<string, any> = {};
export function resetDS() {
  for (const k of Object.keys(DS)) delete DS[k];
  Object.assign(DS, {
    pools: [] as any[],
    block: 1000n,
    book: { sells: [], buys: [], ncSells: [], ncBuys: [], bids: [] },
    books: {},
    batches: [],
    vaults: [],
    marketStats: undefined,
    supplies: {},
    minNotional: 100_000000n,
    poolStatus: 0,
    wrapper: ZERO,
    flash: {},
    rolloverIds: new Set<string>(),
    rolloverKeys: new Set<string>(),
    seatOrderKeys: new Set<string>(),
    rolloverSources: new Map<string, string>(), // orderKey -> old pool id of rollover orders
    blockTime: 1, // measured seconds per block
    lstShares: null, // ERC-4626 convertToShares of the loop's LST (null: not a vault)
    positions: {},
    pending: {},
    balances: {},
    isOperator: false,
    loading: false,
    connected: true,
    wrongChain: false,
    orders: [],
    vaultsMe: {},
    vaultPositions: [],
    allowance: undefined,
    ref: null,
    seat: undefined,
    grid: { anchor: ANCHOR, period: 3600, batchInterval: 120, maxExpiries: 8, strikeSigDigits: 2 },
  });
}
resetDS();

export function dataMock() {
  const q = (data: unknown) => ({ data, isLoading: false, error: null, refetch: () => {} });
  return {
    REFRESH_MS: 4000,
    usePools: () => ({ ...q(DS.pools), isLoading: DS.loading }),
    usePool: (id: string) => q(DS.pools.find((p: any) => p.id === id)),
    useTokens: () => q(TOKENS),
    tokenOf: (m: any, a?: string) => (a ? m?.[a.toLowerCase()] : undefined),
    onchainSymbol: (t: any) => t?.onchainSymbol ?? t?.symbol,
    useBook: () => q(DS.book),
    useBooks: () => q(DS.books),
    bookOrders: (b: any) => [...b.sells, ...b.buys, ...b.ncSells, ...b.ncBuys, ...b.bids],
    useBatches: () => q(DS.batches),
    useBatchesMany: (ids: string[]) => ({ data: Object.fromEntries(ids.map((id) => [id, DS.batchesBy?.[id] ?? DS.batches])), isLoading: false, isError: false }),
    useNow: () => q({ ts: NOW, block: DS.block, wall: Date.now() / 1000 }),
    useVaults: () => q(DS.vaults),
    useMarketStats: () => q(DS.marketStats),
    usePoolSupplies: () => q(DS.supplies),
    useMinNotional: () => q(DS.minNotional),
    useGrid: () => q(DS.grid),
    usePoolStatus: () => q(DS.poolStatus),
    useWrapper: () => q(DS.wrapper),
    useMaxFlashLoan: () => q(DS.flash),
    useRolloverIds: () => q(DS.rolloverIds),
    useRolloverKeys: () => q(DS.rolloverKeys),
    useSeatOrderKeys: () => q(DS.seatOrderKeys),
    useRolloverSources: () => q(DS.rolloverSources),
    orderKey: (pid: string, id: bigint) => `${pid.toLowerCase()}:${id}`,
    useBlockTime: () => q(DS.blockTime),
    useConvertToShares: () => q(DS.lstShares),
    usePoolIndex: () => ({ ...q({ status: { complete: true }, pools: [], last: {} }), ids: DS.pools.map((p: any) => p.id), fallback: false, complete: true }),
    useAccountOrders: () => q(DS.orders ?? []),
    useChainCtx: () => ({ chainId: 998, deployment: DEPLOY, client: {}, ready: true }),
  };
}

/** Deployment used by the UI tests (active chain 998). */
export const DEPLOY = {
  chainId: 998,
  demo: false,
  confluere: CORE,
  router: ROUTER,
  seatRegistry: REG,
  wrapperFactory: "0x00000000000000000000000000000000000000d6",
  vaultFactory: "0x00000000000000000000000000000000000000d7",
  vaults: { pegged: "0x00000000000000000000000000000000000000c8", usdLow: VAULT, usdHigh: "0x00000000000000000000000000000000000000c9" },
  gridAnchor: ANCHOR,
  gridPeriod: 3600,
  batchInterval: 120,
  windowBlocks: 300,
  deployBlock: 1,
  pools: { lst: LST, native: NAT, usdc: USDC, expiry: NOW, poolIds: [] },
} as any;

export const META = { id: 998, chain: { id: 998, name: "HyperEVM testnet" }, name: "HyperEVM", label: "HyperEVM testnet", native: "HYPE", testnet: true, rpcs: [] };
export const switchNetwork = { calls: [] as number[] };

export function activeChainMock() {
  return {
    useActiveChain: () => ({ chainId: 998, chain: META.chain, meta: META, deployment: DEPLOY, networks: [META], walletChainId: DS.connected === false ? undefined : 998, walletOnOtherChain: !!DS.wrongChain }),
    useActiveChainId: () => 998,
    useSwitchNetwork: () => ({ switchNetwork: async (id: number) => (switchNetwork.calls.push(id), { ok: true }), switching: false, error: undefined }),
    useChainChoice: () => 998,
    getChainChoice: () => 998,
    setChainChoice: () => {},
    ActiveChainProvider: ({ children }: any) => children,
  };
}

export function vaultMeMock() {
  const q = (data: unknown) => ({ data, isLoading: false });
  return {
    useVaultMe: (v?: string) => q(v ? DS.vaultsMe?.[v.toLowerCase()] : undefined),
    useVaultsMe: () => q(DS.vaultsMe ?? {}),
    useVaultPositions: () => q(DS.vaultPositions ?? []),
    SHARE_OFFSET: 6,
  };
}

export const allowanceMock = () => ({ useAllowance: () => ({ data: DS.allowance ?? 10n ** 40n }) });
export const refPriceMock = () => ({ useRefPrice: () => ({ data: DS.ref ?? null }) });
export const seatsMock = () => ({
  useSeat: () => ({ data: DS.seat }),
  useRegistryParams: () => ({ data: { share: 3500, tax: 1000 } }),
  isVacant: (s: any) => s.holder === ZERO,
  bondOf: (s: any) => (s.obligation * 1000n) / 10_000n,
  currentBatch: (now: number, anchor: number, iv: number) => Math.floor((now - anchor) / iv),
  holderUnsplitShare: () => 0n,
  obligationBand: () => ({}),
  obligationValue: () => 0n,
  withinObligationBand: () => true,
});

export function positionMock() {
  const q = (data: unknown) => ({ data, isLoading: false });
  return {
    usePositions: () => q(DS.positions),
    usePending: () => q(DS.pending),
    useBalances: () => q(DS.balances),
    useIsOperator: () => q(DS.isOperator),
  };
}

export const txMock = {
  run: async (..._a: unknown[]) => ({ ok: true }),
  lastError: undefined as unknown,
  ensureAllowance: async () => null,
  ensureOperator: async () => null,
  reset: () => {},
  steps: [],
  busy: false,
  account: ME,
};

export const configMock = (over: Record<string, unknown> = {}) => ({
  CHAIN_ID: 31337,
  IS_TEST: true,
  RPC_URL: "http://127.0.0.1:8545",
  PROJECT_ID: "",
  REF_PRICE_URL: "",
  chain: { id: 31337, name: "Anvil" },
  deployment: {
    chainId: 31337,
    confluere: CORE,
    router: ROUTER,
    seatRegistry: REG,
    wrapperFactory: "0x00000000000000000000000000000000000000d6",
    vaultFactory: "0x00000000000000000000000000000000000000d7",
    gridAnchor: ANCHOR,
    gridPeriod: 3600,
    batchInterval: 1800,
    windowBlocks: 300,
    deployBlock: 1,
    pools: { lst: LST, native: NAT, usdc: USDC },
    ...over,
  },
});

export const txModule = {
  useTx: () => txMock,
  useSwitchToApp: () => ({ wrongChain: false, switching: false, switchToApp: () => {} }),
  explorerTx: () => undefined,
};

export const wagmiModule = {
  useConnection: () => (DS.connected === false ? { address: undefined, isConnected: false, chainId: undefined } : { address: ME, isConnected: true, chainId: 998 }),
  useBalance: () => ({ data: { value: 5n * E18, decimals: 18, symbol: "HYPE" } }),
  usePublicClient: () => ({}),
  useConnect: () => ({ mutate: () => {}, isPending: false }),
  useConnectors: () => [],
  useDisconnect: () => ({ disconnect: () => {} }),
  useSwitchChain: () => ({ mutateAsync: async () => {}, isPending: false }),
  useWatchAsset: () => ({ mutate: () => {}, watchAsset: () => {}, isPending: false, isSuccess: false }),
  useSignMessage: () => ({ mutateAsync: async () => "0x" }),
};

export const tokensMock = (orig: Record<string, unknown>) => ({ ...orig, useTokenNeed: () => ({ data: DS.need }) });
