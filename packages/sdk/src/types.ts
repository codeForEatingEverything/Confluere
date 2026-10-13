import type { Address, Hex } from "viem";

export type Deployment = {
  chainId: number;
  demo: boolean;
  confluere: Address;
  router: Address;
  wrapperFactory: Address;
  vaultFactory: Address;
  /** Chainlink CRE report receiver and batch keeper entry point (absent on older deployments). */
  keeperReceiver?: Address;
  /** Harberger-tax market-maker seats; also the core's treasury (fee split). */
  seatRegistry?: Address;
  /** Secondary market for C and R positions (PositionMarket: asks, bids, fill, hit; absent on older deployments). */
  positionMarket?: Address;
  vaults?: { pegged: Address; usdLow: Address; usdHigh?: Address; /** HyperEVM: lends the native coin (WHYPE) in the USDC / WHYPE market, the counterpart of Monad's pegged vault. */ nativeLend?: Address };
  /** Guardian multisig (or the demo address) allowed to pause un-graduated pools. */
  guardian?: Address;
  /** LP receipt token (SeatLPToken) per market, keyed "asset-quote-kind". */
  seatLPTokens?: Record<string, Address>;
  /** Demo tokens deployed with MOCKS=true (stand-ins for the chain's LST, native coin and USD). */
  tokens?: { lst: Address; native: Address; usdc: Address };
  windowBlocks: number;
  /** Grid preset the core was deployed with (Deploy.s.sol): "production", "demo" or "daily" (absent on older files). */
  grid?: "production" | "demo" | "daily";
  /** How many expiries ahead may be listed (absent on older files). */
  maxExpiries?: number;
  gridAnchor: number;
  gridPeriod: number;
  batchInterval: number;
  deployBlock: number;
  pools?: {
    lst: Address;
    native: Address;
    usdc: Address;
    /** Optional extra pair opened on every roll (HyperEVM testnet: asset USDC, quote WHYPE); its pools follow the launch pools in `poolIds`. */
    extraAsset?: Address;
    extraQuote?: Address;
    /** The first (nearest) expiry opened; scripts/roll-testnet.sh continues the daily chain from it. */
    expiry: number;
    /** Every expiry the last CreatePools run opened (daily grid: the 1-, 7- and 14-day maturities). */
    expiries?: number[];
    poolIds: Hex[];
  };
};

export type PoolKey = {
  asset: Address;
  quote: Address;
  expiry: bigint;
  strike: bigint;
  kind: Kind;
};

export enum Kind {
  American = 0,
  European = 1,
}

export enum Status {
  None = 0,
  Open = 1,
  Window = 2,
  Closing = 3,
  Closed = 4,
}

export enum Side {
  Sell = 0,
  Buy = 1,
  NcSell = 2,
  NcBuy = 3,
  Bid = 4,
}
