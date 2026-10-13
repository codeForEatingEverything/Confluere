"use client";

/**
 * The only way the app writes to a chain (FRONTEND_DESIGN §5). `run` is a state machine per step:
 * idle → wallet → pending → success | rejected | reverted | failed. It never throws and never rejects; a wallet
 * rejection is a neutral outcome. Each write is simulated first so reverts are decoded before the wallet opens.
 *
 * Demo mode (lib/demo, IA v3.1 item 13) changes one step: instead of sending the write, the wallet signs a plain message
 * that describes it (never a contract call, never a network switch), then the write is applied to the sample network
 * and the step goes through the same pending and success states with a made-up hash.
 */
import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConnection, usePublicClient, useSignMessage, useSwitchChain, useWriteContract } from "wagmi";
import { erc20Abi, maxUint256, type Abi, type Address, type Hex } from "viem";
import { confluereAbi } from "@confluere/sdk";
import { useActiveChain } from "./activeChain";
import { explorerTxUrl } from "./chains";
import { CHAIN_ID } from "./config";
import { nativeSymbol } from "./format";
import { classify, REVERTED_ON_CHAIN, revertName, type TxError } from "./txErrors";
import { pushToast } from "./txStore";
import { useDemo } from "./demo/mode";
import { useDemoClientOr } from "./demo/hooks";
import { applyWrite } from "./demo/chain";
import { demoHash, demoMessage } from "./demo/sign";

export type StepStatus = "idle" | "wallet" | "pending" | "success" | "rejected" | "reverted" | "failed";
export type TxStep = { label: string; status: StepStatus; hash?: Hex; error?: TxError };
export type { TxError };

export type Write = {
  label: string;
  address: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
  /** Simulate before sending (default true; approvals skip it). */
  simulate?: boolean;
  /** Rebuild this write with a fresh book hint after an InvalidHint revert (retried once). */
  refresh?: () => Promise<Write>;
  /** Token context for "not enough {token}" messages. */
  token?: { symbol: string; decimals: number };
  /** Caller-specific sentences keyed by errorName. */
  copy?: Record<string, string>;
};

type RunOpts = { onSuccess?: () => void; successMessage?: string };

const debug = (...a: unknown[]) => {
  if (process.env.NODE_ENV !== "production") console.debug("[tx]", ...a);
};

/** Explorer link of a transaction (on the active chain unless `chainId` is given). */
export const explorerTx = (hash: string, chainId: number = CHAIN_ID) => explorerTxUrl(chainId, hash);

export function useTx() {
  const { chainId: appChainId, chain, deployment } = useActiveChain();
  const demo = useDemo();
  const client = useDemoClientOr(usePublicClient({ chainId: appChainId }), appChainId);
  const { address: account, chainId } = useConnection();
  const signMessageAsync = useSignMessage().mutateAsync;
  const w = useWriteContract();
  const writeContractAsync = w.mutateAsync;
  const sw = useSwitchChain();
  const qc = useQueryClient();
  const [steps, setSteps] = useState<TxStep[]>([]);
  const [busy, setBusy] = useState(false);
  const [lastError, setLastError] = useState<TxError>();
  const running = useRef(false);

  const ctx = (write: Write) => ({
    fn: write.functionName,
    chainName: chain.name,
    gasSymbol: nativeSymbol(appChainId),
    token: write.token,
    copy: write.copy,
  });

  const run = useCallback(
    async (writes: Write[] | (() => Promise<Write[]>), opts: RunOpts = {}): Promise<{ ok: boolean }> => {
      if (running.current) return { ok: false };
      running.current = true;
      setBusy(true);
      setLastError(undefined);
      let list: Write[] = [];
      let state: TxStep[] = [];
      const update = (i: number, patch: Partial<TxStep>) => {
        state = state.map((s, j) => (j === i ? { ...s, ...patch } : s));
        setSteps(state);
      };
      const fail = (err: TxError, i?: number) => {
        if (i !== undefined) update(i, { status: err.kind === "rejected" ? "rejected" : err.kind === "reverted" ? "reverted" : "failed", error: err });
        setLastError(err);
        pushToast({
          status: err.kind === "rejected" ? "rejected" : "failed",
          title: err.title,
          error: err,
          hash: i !== undefined ? state[i]?.hash : undefined,
          chainId: appChainId,
          retry: err.kind === "rejected" ? undefined : () => void run(writes, opts),
        });
        return { ok: false };
      };
      try {
        if (!account || !client) return fail({ kind: "unknown", title: "Connect a wallet first." });
        try {
          list = typeof writes === "function" ? await writes() : writes;
        } catch (e) {
          debug("prepare failed", e);
          setSteps([]);
          return fail(classify(e, { fn: "prepare", chainName: chain.name }));
        }
        state = list.map((x) => ({ label: x.label, status: "idle" as StepStatus }));
        setSteps(state);
        if (list.length === 0) return { ok: true };

        // the wallet must be on the network the user is looking at before anything is signed
        if (!demo && chainId !== appChainId) {
          try {
            await sw.mutateAsync({ chainId: appChainId });
          } catch (e) {
            debug("switch failed", e);
            const c = classify(e, { fn: "switchChain", chainName: chain.name });
            return fail(c.kind === "rejected" ? c : { ...c, kind: "chain", title: `Your wallet is on another network. Switch to ${chain.name}.` }, 0);
          }
        }

        let hash: Hex | undefined;
        for (let i = 0; i < list.length; i++) {
          let write = list[i]!;
          update(i, { status: "wallet" });
          if (write.simulate !== false) {
            let simulated = false;
            for (let attempt = 0; !simulated; attempt++) {
              try {
                await client.simulateContract({
                  account,
                  address: write.address,
                  abi: write.abi as Abi,
                  functionName: write.functionName,
                  args: write.args as unknown[],
                  value: write.value,
                } as never);
                simulated = true;
              } catch (e) {
                if (attempt === 0 && write.refresh && revertName(e) === "InvalidHint") {
                  try {
                    write = await write.refresh();
                    list[i] = write;
                    continue;
                  } catch {}
                }
                debug("simulation reverted", e);
                return fail(classify(e, ctx(write)), i);
              }
            }
          }
          if (demo) {
            let signature: string;
            try {
              signature = await signMessageAsync({ message: demoMessage(write, { chainId: appChainId, account }) });
            } catch (e) {
              debug("demo signature failed", e);
              return fail(classify(e, ctx(write)), i);
            }
            hash = demoHash(signature, write.label);
            update(i, { status: "pending", hash });
            await new Promise((r) => setTimeout(r, 700));
            try {
              applyWrite(appChainId, account, write);
            } catch (e) {
              debug("demo write reverted", e);
              return fail(classify(e, ctx(write)), i);
            }
            update(i, { status: "success" });
            continue;
          }
          try {
            hash = await writeContractAsync({
              address: write.address,
              abi: write.abi as Abi,
              functionName: write.functionName,
              args: write.args as unknown[],
              value: write.value,
              chainId: appChainId,
            } as never);
          } catch (e) {
            debug("write failed", e);
            return fail(classify(e, ctx(write)), i);
          }
          update(i, { status: "pending", hash });
          try {
            const rc = await client.waitForTransactionReceipt({ hash });
            if (rc.status !== "success") return fail(REVERTED_ON_CHAIN, i);
          } catch (e) {
            debug("receipt failed", e);
            return fail(classify(e, ctx(write)), i);
          }
          update(i, { status: "success" });
        }
        try {
          await qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === appChainId || typeof q.queryKey[1] !== "number" });
        } catch {}
        pushToast({ status: "success", title: opts.successMessage ?? `${list[list.length - 1]!.label} confirmed`, hash, chainId: appChainId });
        try {
          opts.onSuccess?.();
        } catch {}
        return { ok: true };
      } catch (e) {
        debug("unexpected", e);
        return fail(classify(e, { fn: "unknown" }));
      } finally {
        running.current = false;
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [account, chainId, appChainId, chain, client, qc, sw, writeContractAsync, demo, signMessageAsync],
  );

  /** The approve step needed for `spender` (default: the core) to pull `amount` of `token`, or null. */
  const ensureAllowance = useCallback(
    async (
      token: Address,
      amount: bigint,
      spender: Address | undefined = deployment?.confluere,
      o: { symbol?: string; exact?: boolean } = {},
    ): Promise<Write | null> => {
      if (amount === 0n || !account || !client || !spender) return null;
      const a = (await client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account, spender] })) as bigint;
      if (a >= amount) return null;
      return {
        label: `Approve ${o.symbol ?? "token"}`,
        address: token,
        abi: erc20Abi,
        functionName: "approve",
        args: [spender, o.exact ? amount : maxUint256],
        simulate: false,
      };
    },
    [account, client, deployment],
  );

  /** The ERC-6909 operator grant `spender` needs on the core (Router claimMany, a wrapper), or null. */
  const ensureOperator = useCallback(
    async (spender: Address, label: string): Promise<Write | null> => {
      if (!account || !client || !deployment) return null;
      const ok = (await client.readContract({
        address: deployment.confluere,
        abi: confluereAbi,
        functionName: "isOperator",
        args: [account, spender],
      })) as boolean;
      if (ok) return null;
      return { label, address: deployment.confluere, abi: confluereAbi, functionName: "setOperator", args: [spender, true] };
    },
    [account, client, deployment],
  );

  const reset = useCallback(() => {
    setSteps([]);
    setLastError(undefined);
  }, []);

  return { steps, busy, account, chainId: appChainId, lastError, run, ensureAllowance, ensureOperator, reset };
}

export type Tx = ReturnType<typeof useTx>;

/** Ask the wallet to switch to the active chain; a rejection is silent. `wrongChain`: connected elsewhere. */
export function useSwitchToApp() {
  const sw = useSwitchChain();
  const { chainId: appChainId, walletOnOtherChain } = useActiveChain();
  return {
    wrongChain: walletOnOtherChain,
    switching: sw.isPending,
    switchToApp: () => {
      sw.mutateAsync({ chainId: appChainId }).catch((e: unknown) => debug("switch", e));
    },
  };
}
