import { parseAbiItem, type Address, type Hex } from "viem";
import type { Clients } from "./chain.js";

const poolCreated = parseAbiItem(
  "event PoolCreated(bytes32 indexed poolId, (address asset, address quote, uint64 expiry, uint128 strike, uint8 kind) key, uint16 feeBps, uint16 bandBps, bytes32 indexed marketId)",
);
const orderPlaced = parseAbiItem(
  "event OrderPlaced(bytes32 indexed poolId, uint64 indexed orderId, address indexed owner, uint8 side, uint96 units, uint96 limit, uint128 escrow, uint32 deadline)",
);
const vaultCreated = parseAbiItem("event VaultCreated(address indexed vault, address indexed quote, string symbol)");

/**
 * Incremental log scanner: keeps the last scanned block and the ids seen so far. `touched` collects pools that got a
 * new order since the consumer last cleared it (read in the same getLogs call as PoolCreated, so it costs no extra
 * request); the keeper uses it to re-read a book it had cached as empty.
 */
export class Discovery {
  pools = new Set<Hex>();
  vaults = new Set<Address>();
  touched = new Set<Hex>();
  private from: bigint;

  constructor(
    private c: Clients,
    private core: Address,
    private vaultFactory: Address,
    startBlock: bigint,
    private chunk: bigint,
  ) {
    this.from = startBlock;
  }

  async scan(): Promise<void> {
    const head = await this.c.pub.getBlockNumber();
    while (this.from <= head) {
      const to = this.from + this.chunk - 1n < head ? this.from + this.chunk - 1n : head;
      const [p, v] = await Promise.all([
        this.c.pub.getLogs({ address: this.core, events: [poolCreated, orderPlaced], fromBlock: this.from, toBlock: to }),
        this.c.pub.getLogs({ address: this.vaultFactory, event: vaultCreated, fromBlock: this.from, toBlock: to }),
      ]);
      for (const l of p) {
        if (!l.args.poolId) continue;
        if (l.eventName === "PoolCreated") this.pools.add(l.args.poolId);
        else this.touched.add(l.args.poolId);
      }
      for (const l of v) if (l.args.vault) this.vaults.add(l.args.vault);
      this.from = to + 1n;
    }
  }
}
