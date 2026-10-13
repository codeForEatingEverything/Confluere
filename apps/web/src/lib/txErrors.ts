/**
 * Wallet and contract errors mapped to plain sentences (FRONTEND_DESIGN §5.2). A wallet rejection is a neutral
 * outcome, never an error; reverts are decoded against every ABI the app talks to.
 */
import {
  BaseError,
  ChainMismatchError,
  ContractFunctionRevertedError,
  HttpRequestError,
  InsufficientFundsError,
  TimeoutError,
  UserRejectedRequestError,
  decodeErrorResult,
  erc20Abi,
  formatUnits,
  parseAbi,
  type Abi,
  type Hex,
} from "viem";
import { confluereAbi, erc6909WrapperAbi, seatRegistryAbi, vaultAbi } from "@confluere/sdk";

export type TxErrorKind = "rejected" | "reverted" | "chain" | "funds" | "rpc" | "unknown";
export type TxError = { kind: TxErrorKind; title: string; detail?: string; raw?: string; errorName?: string };

export const extraErrorsAbi = parseAbi([
  "error InvalidHint()",
  "error InvalidGrid()",
  "error NotClone()",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
]);

const ALL_ERRORS = [
  ...confluereAbi,
  ...vaultAbi,
  ...seatRegistryAbi,
  ...erc6909WrapperAbi,
  ...erc20Abi,
  ...extraErrorsAbi,
].filter((x) => x.type === "error") as Abi;

/** errorName -> function name -> sentence. `default` covers every other function. */
/** Shown on screen, so in the user vocabulary (FRONTEND_V3 §4): rounds, buy-back price, repayment window, no protocol names. */
export const ERROR_COPY: Record<string, Record<string, string>> = {
  InvalidState: {
    placeOrder: "This market is not taking orders now: it has matured, it is paused, or a round is about to run.",
    cancelOrder:
      "This order can't be cancelled right now. Slower markets don't allow it in the last minutes before a round, and offers for unclaimed units can only be cancelled during the repayment window.",
    repay: "Repayment is not open: markets that repay at maturity only open at maturity, and the repayment window of this date has ended.",
    bid: "Offers for unclaimed units are taken only during the repayment window.",
    settleBatch: "This round can't run yet.",
    mature: "This market has not reached its date yet.",
    closeWindow: "The repayment window has not ended.",
    claim: "This market has not closed yet.",
    graduate: "Not all of the last four maturities traded cleanly.",
    rollover: "This loan's repayment window has ended, or the later maturity is not open.",
    default: "The market is not at the right stage for this.",
  },
  InvalidParams: {
    createPoolWithOptions:
      "These terms are not allowed: the date or buy-back price is not on this network's grid, rounds are slower than one maturity period, or the first-round low is above the high.",
    graduate: "This market can't be marked established yet.",
    default: "A value is out of range: the amount is below the minimum, or the price or number of rounds is not allowed.",
  },
  BookFull: {
    default: "Too many orders are waiting in this market and your price is not better than the worst of them. Improve the price or wait for the next round.",
  },
  BatchNotReady: { default: "The next round has not started yet." },
  IsPaused: { default: "The guardian paused this market. You can still cancel, repay, claim and withdraw." },
  BadToken: {
    default: "This token failed the transfer check (it takes a fee on transfer or behaves unusually). Tokens whose balance changes by itself must be wrapped first.",
  },
  Locked: {
    cancelOrder: "Seat quotes can't be cancelled while they can still fill.",
    default: "This position is rolling over to the next maturity, so it can't be used here.",
  },
  NotOwner: { default: "Only the person who placed this order can cancel it." },
  InvalidPool: { default: "A market with these exact settings already exists. Use it instead." },
  InvalidHint: { default: "Orders changed while you were signing. Trying again." },
  InvalidGrid: { default: "These settings are not on this network's grid." },
  NotReady: {
    poke: "The vault already lent this round, or its period has ended.",
    roll: "Not every market of this period has closed yet.",
    default: "The vault is not ready for this yet.",
  },
  AsyncOnly: { default: "This vault works by request. Use Deposit or Request withdrawal." },
  NotHolder: { default: "You don't hold this seat." },
  NoSeat: { default: "The seat is vacant." },
  Cooldown: { default: "The price can't be lowered yet: a seat price may only drop 7 days after the last change." },
  NotMissed: { default: "The holder did quote that round; there is nothing to report." },
  FlashFailed: { default: "The flash loan receiver did not confirm repayment." },
  NotClone: { default: "This address is not one of the app's ERC-20 tokens." },
  InsufficientBalance: { default: "Not enough wrapped tokens for this." },
  ERC20InsufficientBalance: { default: "Not enough tokens in your wallet for this step." },
  ERC20InsufficientAllowance: { default: "The approval is too low. Approve again and retry." },
  SafeERC20FailedOperation: { default: "A token transfer failed. Check your balance, and that the token is not frozen." },
  ReentrancyGuardReentrantCall: { default: "This call was rejected because another one was still running." },
};

export type ClassifyContext = {
  fn: string;
  chainName?: string;
  gasSymbol?: string;
  token?: { symbol: string; decimals: number };
  /** Caller-specific sentences keyed by errorName (e.g. a Cooldown with its date). */
  copy?: Record<string, string>;
};

function isRejection(e: unknown): boolean {
  if (e instanceof BaseError && e.walk((x) => x instanceof UserRejectedRequestError)) return true;
  let x: any = e;
  for (let i = 0; x && i < 6; i++, x = x.cause) {
    if (x?.code === 4001 || x?.name === "UserRejectedRequestError") return true;
    if (typeof x?.message === "string" && /user (rejected|denied)/i.test(x.message)) return true;
  }
  return false;
}

function decodeName(raw?: Hex): { name?: string; args?: readonly unknown[] } {
  if (!raw || raw === "0x") return {};
  try {
    const r = decodeErrorResult({ abi: ALL_ERRORS, data: raw });
    return { name: r.errorName, args: r.args as readonly unknown[] | undefined };
  } catch {
    return {};
  }
}

/** Revert error name of a failed simulation or write, if any (also used to detect InvalidHint). */
export function revertName(e: unknown): string | undefined {
  if (!(e instanceof BaseError)) return undefined;
  const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
  if (!r) return undefined;
  return r.data?.errorName ?? decodeName(r.raw).name;
}

export function copyFor(name: string, fn: string, override?: Record<string, string>): string | undefined {
  return override?.[name] ?? ERROR_COPY[name]?.[fn] ?? ERROR_COPY[name]?.default;
}

export function classify(e: unknown, ctx: ClassifyContext): TxError {
  const short = e instanceof BaseError ? e.shortMessage : String((e as Error)?.message ?? e).slice(0, 200);
  if (isRejection(e)) return { kind: "rejected", title: "You cancelled in your wallet. Nothing was sent." };
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (r) {
      let name = r.data?.errorName;
      let args = r.data?.args as readonly unknown[] | undefined;
      if (!name) ({ name, args } = decodeName(r.raw));
      if (name) {
        let title = copyFor(name, ctx.fn, ctx.copy) ?? "The contract rejected this.";
        if (name === "ERC20InsufficientBalance" && ctx.token && args && args.length >= 3) {
          const t = ctx.token;
          title = `Not enough ${t.symbol} in your wallet: you have ${formatUnits(args[1] as bigint, t.decimals)}, this needs ${formatUnits(args[2] as bigint, t.decimals)}.`;
        }
        return { kind: "reverted", title, raw: short, errorName: name };
      }
      return { kind: "reverted", title: r.reason ? `The contract rejected this: ${r.reason}.` : "The contract rejected this call.", raw: short };
    }
    if (e.walk((x) => x instanceof ChainMismatchError))
      return { kind: "chain", title: `Your wallet is on another network. Switch to ${ctx.chainName ?? "the app's network"}.`, raw: short };
    if (e.walk((x) => x instanceof InsufficientFundsError))
      return { kind: "funds", title: `Not enough ${ctx.gasSymbol ?? "native coin"} for gas.`, raw: short };
    if (e.walk((x) => x instanceof HttpRequestError || x instanceof TimeoutError))
      return {
        kind: "rpc",
        title: "The network did not answer. Your transaction may still be pending; check Portfolio in a moment.",
        raw: short,
      };
  }
  return { kind: "unknown", title: short || "The request failed. Try again.", raw: short };
}

export const REVERTED_ON_CHAIN: TxError = {
  kind: "reverted",
  title:
    "The transaction failed on-chain, usually because something changed between your signature and inclusion (for example a round ran). Only the network fee was spent.",
};
