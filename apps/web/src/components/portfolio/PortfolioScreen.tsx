"use client";

/**
 * Portfolio (FRONTEND_V3 §8.5): one page. Needs you first (repay before the window closes, claim, withdraw, collect),
 * Ready to withdraw first (in dollars at reference prices), then Loans, Lending, Vaults, Open orders. Every action opens a modal or a drawer here.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useConnection } from "wagmi";
import { useDemo } from "@/lib/demo/mode";
import { Check, TriangleAlert, Wallet } from "lucide-react";
import { Side, Status } from "@confluere/sdk";
import type { Hex } from "viem";
import { useActiveChain } from "@/lib/activeChain";
import { tokenOf, useBlockTime, type AccountOrder, type PoolRow, type Token, type VaultRow } from "@/lib/data";
import { usePortfolio, useActionCtx, useChainClock } from "@/lib/useProduct";
import { cancelWrite, vaultCollectWrites } from "@/lib/actions";
import { cancelCutoff, windowOpen } from "@/lib/window";
import { repayDeadline, windowLeft } from "@/lib/deadline";
import { orderProgress } from "@/lib/orderStatus";
import { readLoop, loopProgress, planLoop, savedToInput } from "@/lib/loop";
import { rolloverTargets } from "@/lib/rollover";
import { fmtExpiry, fmtPer, fmtToken, fmtWait, fmtWeekday, nativeSymbol } from "@/lib/format";
import { vaultRole, vaultSharesValue, type BorrowPosition, type LendPosition } from "@/lib/product";
import { buyBack, nextRoundAt, poolState, roundsDone } from "@/lib/view";
import { isCoinVault, positionName, vaultIcon, vaultName, vaultToken } from "@/lib/vocab";
import { tradable } from "@/lib/secondary";
import { useQueryParam } from "@/lib/url";
import { useTx } from "@/lib/tx";
import { LpPositions } from "../lp/LpPositions";
import { Button, Card, DateTime, Drawer, ErrorRow, List, OutcomeStrip, PositionIcon, SectionTitle, Skeleton, Stat, TokenIcon, TxErrorLine, stop, type Column } from "../ui";
import { useConnectWallet } from "../layout/WalletMenu";
import { useWithdraw } from "../common/useWithdraw";
import { UsdTotal } from "./UsdTotal";
import { ClaimAllButton, ClaimModal, ExtendDrawer, RepayModal, WrapModal } from "./Actions";

type Tokens = Record<string, Token> | undefined;

export function PortfolioScreen() {
  const { isConnected } = useConnection();
  const demo = useDemo();
  const params = useSearchParams();
  // old links: ?tab=attention goes to #needs-you
  useEffect(() => {
    if (params?.get("tab") === "attention") document.getElementById("needs-you")?.scrollIntoView();
  }, [params]);
  return (
    <div>
      <h1 className="text-amount font-semibold leading-8">Portfolio</h1>
      {isConnected ? (
        <Connected />
      ) : demo ? (
        <>
          {/* demo mode with no wallet: the sample account's positions; acting on them needs a wallet */}
          <p className="mt-2 text-body-sm text-ink-2" data-testid="demo-sample-account">
            Showing a sample account. Connect a wallet to act on these positions with signed messages.
          </p>
          <Connected />
        </>
      ) : (
        <NotConnected />
      )}
    </div>
  );
}

function NotConnected() {
  const { connect, connecting } = useConnectWallet();
  return (
    <Card className="mt-6 max-w-[560px] p-6 max-sm:p-4">
      <p className="text-body font-medium">Connect a wallet to see your positions.</p>
      <p className="mt-1 text-body-sm text-ink-2">Borrowed, lent, vault positions and anything ready to collect or withdraw appear here.</p>
      <div className="mt-5 max-w-[280px]">
        <Button variant="primary" size="lg" block loading={connecting} onClick={connect} icon={<Wallet size={18} strokeWidth={1.75} aria-hidden />}>
          Connect wallet
        </Button>
      </div>
      <p className="mt-4 text-caption text-ink-3">
        No positions yet?{" "}
        <Link href="/" className="link">
          Borrow
        </Link>{" "}
        or{" "}
        <Link href="/earn" className="link">
          Earn
        </Link>{" "}
        to get started.
      </p>
    </Card>
  );
}

function Connected() {
  const pf = usePortfolio();
  const { chainId, deployment, meta } = useActiveChain();
  const qc = useQueryClient();
  const { now, block } = useChainClock();
  const spb = useBlockTime().data;
  const [repay, setRepay] = useState<BorrowPosition>();
  const [extend, setExtend] = useState<BorrowPosition>();
  const [claim, setClaim] = useState<{ pool: PoolRow; lines: string[]; kind: "payout" | "surplus" }>();
  const [wrap, setWrap] = useState<{ pool: PoolRow; which: "lend" | "loan"; held: bigint; asset: Token }>();
  const [position, setPosition] = useQueryParam("position");
  const t = pf.tokens;
  const withdraw = useWithdraw();
  const tx = useTx();
  const ctx = useActionCtx(tx);
  const windowBlocks = deployment?.windowBlocks ?? 0;

  const failed = pf.isError && !pf.isLoading && pf.pools.length === 0 && pf.borrows.length === 0;
  if ((pf.isLoading || failed) && pf.borrows.length === 0 && pf.lends.length === 0)
    return (
      <div className="mt-6 space-y-8" data-testid="portfolio-loading">
        {failed && <ErrorRow network={meta.label} onRetry={() => void qc.refetchQueries({ predicate: (q) => q.queryKey[1] === chainId })} />}
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[76px] rounded-[12px]" label={i === 0 ? "Loading your positions" : undefined} />
          ))}
        </div>
        {["Borrowed", "Lent"].map((h) => (
          <div key={h}>
            <p className="mb-4 text-title font-medium text-ink-3">{h}</p>
            <Skeleton className="h-14 w-full" />
          </div>
        ))}
      </div>
    );

  const A = (p: PoolRow) => tokenOf(t, p.asset);
  const Q = (p: PoolRow) => tokenOf(t, p.quote);
  const due = pf.borrows.filter((b) => b.free > 0n && windowOpen(b.pool, now, block));
  const claimLend = pf.lends.filter((l) => l.claimable);
  const claimLoan = pf.borrows.filter((b) => b.claimable);
  const collect = pf.vaults.filter(({ me }) => me.claimShares > 0n || me.claimAssets > 0n || me.assetCredits.length > 0);
  // dust below what the screen can show (2 decimals for dollar-like tokens, 4 otherwise) is not listed
  const wList = pf.withdrawable
    .map((w) => ({ token: w.token, amount: w.amount, meta: tokenOf(t, w.token) }))
    .filter((w) => !w.meta || w.amount >= 10n ** BigInt(Math.max(0, w.meta.decimals - (w.meta.decimals <= 6 ? 2 : 4))));
  // shown only while a reference price is still loading or missing
  const wText = wList.map((w) => fmtToken(w.amount, w.meta)).join(" + ");
  const lendClaimText = (l: LendPosition) => {
    const q = Q(l.pool);
    const a = A(l.pool);
    if (!l.claim) return "your share";
    return [l.claim.quote > 0n ? fmtToken(l.claim.quote, q) : "", l.claim.asset > 0n ? fmtToken(l.claim.asset, a) : ""].filter(Boolean).join(" and ") || fmtToken(0n, q);
  };
  const deadlineOf = (p: PoolRow) => repayDeadline(p, { now, block, spb, windowBlocks });
  const nothing = pf.borrows.length + pf.lends.length + pf.vaults.length + pf.orders.length + pf.withdrawable.length === 0;
  const posPool = position ? pf.pools.find((p) => p.id.toLowerCase() === position.toLowerCase()) : undefined;

  const quotes = new Set(pf.borrows.map((b) => b.pool.quote.toLowerCase()));
  const oneQuote = quotes.size === 1 ? Q(pf.borrows[0]!.pool) : undefined;
  const toRepay = pf.borrows.reduce((s2, b) => s2 + b.repay, 0n);
  const next = pf.borrows.filter((b) => b.free > 0n && !b.claimable).map((b) => deadlineOf(b.pool)).filter((d) => d.known).sort((x, y) => x.ts - y.ts)[0];
  const lquotes = new Set(pf.lends.map((l) => l.pool.quote.toLowerCase()));
  const lq = lquotes.size === 1 ? Q(pf.lends[0]!.pool) : undefined;
  const lent = pf.lends.reduce((s2, l) => s2 + l.ifRepaid, 0n);
  const needs = due.length + (claimLend.length ? 1 : 0) + claimLoan.length + collect.length + wList.length;

  return (
    <div className="mt-6 space-y-12">
      {!nothing && (
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4" data-testid="portfolio-summary">
          <Stat label="Ready to withdraw" value={wList.length ? <UsdTotal items={wList} fallback={wText} /> : "—"} note={wList.length ? "at reference prices" : undefined} />
          <Stat label="To repay" value={pf.borrows.length === 0 ? "—" : oneQuote ? fmtToken(toRepay, oneQuote) : `${pf.borrows.length} positions`} note={next ? <>next by <DateTime ts={next.ts} approx /></> : pf.borrows.length ? `${pf.borrows.length} borrowed` : "nothing borrowed"} />
          <Stat label="Lent (paid if repaid)" value={pf.lends.length === 0 ? "—" : lq ? fmtToken(lent, lq) : `${pf.lends.length} positions`} note={`${pf.lends.length} position${pf.lends.length === 1 ? "" : "s"}`} />
          <Stat label="Vaults" value={String(pf.vaults.filter(({ me }) => me && me.shares > 0n).length)} note="with a position" />
        </div>
      )}
      {wList.length > 0 && (
        <section id="withdraw" aria-labelledby="w-title">
          <div className="card p-5 max-sm:p-4" data-testid="withdraw-card">
            <div className="flex items-center justify-between gap-3">
              <h2 id="w-title" className="text-title font-semibold">
                Ready to withdraw <span className="num ml-1 font-medium text-ink-2"><UsdTotal items={wList} fallback="" /></span>
              </h2>
              <Button size="sm" variant="primary" loading={withdraw.tx.busy} onClick={() => void withdraw.run(wList)} data-testid="withdraw-all">
                {withdraw.tx.busy && withdraw.tx.steps.length > 1 ? `${Math.min(withdraw.tx.steps.filter((s) => s.status === "success").length + 1, withdraw.tx.steps.length)} of ${withdraw.tx.steps.length}` : "Withdraw all"}
              </Button>
            </div>
            <ul className="mt-3 divide-y divide-[var(--line)]">
              {wList.map((w) => (
                <li key={w.token} className="flex items-center gap-3 py-3" data-testid="withdraw-row">
                  <TokenIcon symbol={w.meta?.symbol} address={w.token} size={28} />
                  <span className="flex-1 text-body-sm font-medium">{w.meta?.symbol ?? "…"}</span>
                  <span className="num text-right text-body-sm font-medium">{fmtToken(w.amount, w.meta, false)}</span>
                  <Button size="sm" variant="secondary" className="ml-2" disabled={withdraw.tx.busy} onClick={() => void withdraw.run([w])}>
                    Withdraw
                  </Button>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-caption text-ink-3">Fills, refunds and leftovers wait here until you withdraw them. Nothing moves without you.</p>
            <TxErrorLine error={withdraw.tx.lastError} />
          </div>
        </section>
      )}

      {/* Action required */}
      <section id="needs-you" aria-labelledby="needs-title" hidden={needs === 0}>
        <SectionTitle id="needs-title">Action required</SectionTitle>
        {needs === 0 ? null : (
          <ul className="space-y-2" data-testid="needs-you">
            {due.map((b) => {
              const d = deadlineOf(b.pool);
              const left = windowLeft(b.pool, block, spb);
              return (
                <NeedRow key={`r${b.pool.id}`} tone="warn" action={<Button size="sm" variant="primary" onClick={() => setRepay(b)}>Repay</Button>}>
                  Repay <strong className="num">{fmtToken(b.repay, Q(b.pool))}</strong> by {d.known ? <DateTime ts={d.ts} approx /> : <DateTime ts={b.pool.expiry} />}
                  {left > 0 && <span className="num"> (≈ {fmtWait(left)})</span>} to get <strong className="num">{fmtToken(b.free, A(b.pool))}</strong> back.
                </NeedRow>
              );
            })}
            {claimLend.length > 0 && (
              <NeedRow
                tone="good"
                testId="collect-payout"
                action={
                  claimLend.length > 1 ? (
                    <ClaimAllButton ids={claimLend.map((l) => l.pool.id) as Hex[]} label="Collect" />
                  ) : (
                    <Button size="sm" variant="primary" onClick={() => setClaim({ pool: claimLend[0]!.pool, lines: lendClaimText(claimLend[0]!).split(" and "), kind: "payout" })}>
                      Collect
                    </Button>
                  )
                }
              >
                <strong>
                  {claimLend.length} matured position{claimLend.length > 1 ? "s" : ""} — collect your payout
                </strong>
                <span className="block text-ink-2">
                  Your lending matured: repaid loans pay out in {[...new Set(claimLend.map((l) => Q(l.pool)?.symbol ?? ""))].join(" and ")}, unrepaid ones in collateral.
                  {claimLend.length === 1 && claimLend[0]!.claim ? <> Estimated: <span className="num">{lendClaimText(claimLend[0]!)}</span>.</> : null}
                </span>
              </NeedRow>
            )}
            {claimLoan.map((b) => (
              <NeedRow
                key={`s${b.pool.id}`}
                tone="good"
                action={
                  <Button size="sm" variant="primary" onClick={() => setClaim({ pool: b.pool, lines: ["Extra paid for your unrepaid collateral"], kind: "surplus" })}>
                    Collect auction surplus
                  </Button>
                }
              >
                Your {fmtToken(b.free, A(b.pool))} loan closed without repayment and a buyer paid more than the buy-back price for it. The extra is yours.
              </NeedRow>
            ))}
            {wList.length > 0 && (
              <NeedRow tone="good" action={<Button size="sm" variant="primary" loading={withdraw.tx.busy} onClick={() => void withdraw.run(wList)}>Withdraw all</Button>}>
                {wList.length === 1 ? (
                  <>
                    <strong className="num">{wText}</strong> is ready to withdraw.
                  </>
                ) : (
                  <>
                    Balances in <strong className="num">{wText}</strong> are ready to withdraw.
                  </>
                )}
              </NeedRow>
            )}
            {collect.map(({ vault, me }) => (
              <NeedRow
                key={`v${vault.address}`}
                tone="good"
                action={
                  <Button size="sm" variant="primary" loading={tx.busy} onClick={() => ctx && void tx.run(vaultCollectWrites(ctx, vault.address, me, tokenOf(t, vault.quote)?.symbol ?? ""), { successMessage: "Collected to your wallet." })}>
                    Collect
                  </Button>
                }
              >
                Your vault shares or withdrawal are ready to collect.
              </NeedRow>
            ))}
          </ul>
        )}
      </section>

      {nothing && !pf.isLoading && (
        <Card className="max-w-[560px] p-6 max-sm:p-4">
          <p className="text-body font-medium">No positions on {meta.label}</p>
          <p className="mt-1 text-body-sm text-ink-2">Borrowed, lent and vault positions appear here as soon as an order fills.</p>
          <div className="mt-4 flex gap-3">
            <Link href="/" className="btn btn-md btn-primary">
              Borrow
            </Link>
            <Link href="/earn" className="btn btn-md btn-secondary">
              Earn
            </Link>
          </div>
        </Card>
      )}

      {pf.borrows.length > 0 && (
        <section id="loans" aria-labelledby="loans-title">
          <SectionTitle id="loans-title">Borrowed</SectionTitle>
          <LoanRows rows={pf.borrows} pools={pf.pools} tokens={t} now={now} block={block} spb={spb} windowBlocks={windowBlocks} onRepay={setRepay} onExtend={setExtend} onOpen={(b) => setPosition(b.pool.id)} />
        </section>
      )}

      {pf.lends.length > 0 && (
        <section id="lending" aria-labelledby="lending-title">
          <SectionTitle id="lending-title">Lent</SectionTitle>
          <LendingRows rows={pf.lends} pools={pf.pools} tokens={t} now={now} block={block} onClaim={(l) => setClaim({ pool: l.pool, lines: lendClaimText(l).split(" and "), kind: "payout" })} onOpen={(l) => setPosition(l.pool.id)} />
        </section>
      )}

      {pf.vaults.length > 0 && (
        <section id="vaults" aria-labelledby="pv-title">
          <SectionTitle id="pv-title">Vaults</SectionTitle>
          <VaultRowsMine rows={pf.vaults} tokens={t} />
        </section>
      )}

      <LpPositions />

      {pf.orders.length > 0 && (
        <section id="orders" aria-labelledby="orders-title">
          <SectionTitle id="orders-title">Pending orders</SectionTitle>
          <OrderRows rows={pf.orders} pools={pf.pools} tokens={t} now={now} block={block} chainId={chainId} />
        </section>
      )}

      <RepayModal loan={repay} asset={repay ? A(repay.pool) : undefined} quote={repay ? Q(repay.pool) : undefined} onClose={() => setRepay(undefined)} />
      <ExtendDrawer loan={extend} asset={extend ? A(extend.pool) : undefined} quote={extend ? Q(extend.pool) : undefined} onClose={() => setExtend(undefined)} />
      <ClaimModal pool={claim?.pool} lines={claim?.lines ?? []} kind={claim?.kind} onClose={() => setClaim(undefined)} />
      <WrapModal target={wrap} onClose={() => setWrap(undefined)} />
      <PositionDrawer
        pool={posPool}
        pools={pf.pools}
        loan={pf.borrows.find((b) => b.pool.id === posPool?.id)}
        lend={pf.lends.find((l) => l.pool.id === posPool?.id)}
        tokens={t}
        onClose={() => setPosition(undefined)}
        onRepay={(b) => setRepay(b)}
        onExtend={(b) => setExtend(b)}
        onWrap={(w) => setWrap(w)}
      />
    </div>
  );
}

function NeedRow({ tone, children, action, testId }: { tone: "warn" | "good"; children: React.ReactNode; action: React.ReactNode; testId?: string }) {
  return (
    <li data-testid={testId} className={`flex flex-wrap items-center gap-x-4 gap-y-3 rounded-[var(--radius-control)] px-4 py-3 text-body-sm leading-6 ${tone === "warn" ? "bg-warn-soft" : "bg-good-soft"}`}>
      <span className={`flex-none ${tone === "warn" ? "text-warn" : "text-good"}`} aria-hidden>
        {tone === "warn" ? <TriangleAlert size={18} strokeWidth={1.75} /> : <Check size={18} strokeWidth={1.75} />}
      </span>
      <span className="min-w-0 flex-1 text-ink">{children}</span>
      <span className="max-sm:w-full max-sm:[&>button]:w-full">{action}</span>
    </li>
  );
}

function loanStatus(b: BorrowPosition, now: number, block: bigint, spb: number | null | undefined): string {
  if (b.locked > 0n && b.free === 0n) return "Rolling over";
  const s = poolState(b.pool, now, block);
  if (s === "open" || s === "paused") return "Open";
  if (s === "window") {
    const left = windowLeft(b.pool, block, spb);
    return left > 0 ? `Matured · repay within ${fmtWait(left)}` : "Matured · repay now";
  }
  if (s === "awaiting") return "Matured · repayment opens shortly";
  return b.claimable ? "Closed, auction surplus to collect" : "Expired: the repayment window ended; this right is now worth nothing";
}

function LoanRows({ rows, pools, tokens, now, block, spb, windowBlocks, onRepay, onExtend, onOpen }: { rows: BorrowPosition[]; pools: PoolRow[]; tokens: Tokens; now: number; block: bigint; spb: number | null | undefined; windowBlocks: number; onRepay: (b: BorrowPosition) => void; onExtend: (b: BorrowPosition) => void; onOpen: (b: BorrowPosition) => void }) {
  const cols: Column<BorrowPosition>[] = [
    {
      key: "loan",
      header: "Collateral",
      cell: (b) => {
        const a = tokenOf(tokens, b.pool.asset);
        const saved = readLoop(b.pool.id);
        const q = tokenOf(tokens, b.pool.quote);
        const plan = saved && a && q ? planLoop(savedToInput(saved, buyBack(b.pool), a.decimals, q.decimals)) : undefined;
        const done = plan ? loopProgress(plan, b.units) : 0;
        return (
          <span className="flex items-center gap-2.5">
            <PositionIcon t="br" asset={a ? { symbol: a.symbol, address: b.pool.asset } : undefined} size={28} expired={b.lapsed} />
            <span className="min-w-0">
              <span className="num block font-medium">
                {fmtToken(b.units, a)} · {a?.symbol ?? "…"} / {q?.symbol ?? "…"}
              </span>
              <span className="block text-caption text-ink-3">{q?.symbol} loan · buy-back {fmtPer(buyBack(b.pool), q)}</span>
              {a && q && (
                <span className="num block truncate text-caption text-ink-3" data-testid="loan-symbol">
                  {positionName("br", b.pool, a, q, { all: pools }).symbol}
                </span>
              )}
              {plan && done < plan.rounds.length && (
                <span className="block text-caption text-ink-3">
                  Loop round {done} of {plan.rounds.length} done.{" "}
                  <Link href={`/loop?pool=${b.pool.id}`} className="link" onClick={(e) => e.stopPropagation()}>
                    Next round
                  </Link>
                </span>
              )}
            </span>
          </span>
        );
      },
    },
    { key: "rep", header: "Repay", end: true, cell: (b) => <span className="num">{fmtToken(b.repay, tokenOf(tokens, b.pool.quote))}</span> },
    {
      key: "by",
      header: "Repay by",
      cell: (b) => {
        const d = repayDeadline(b.pool, { now, block, spb, windowBlocks });
        return <span className="text-ink-2">{d.known ? <DateTime ts={d.ts} approx /> : <DateTime ts={b.pool.expiry} />}</span>;
      },
    },
    { key: "st", header: "Status", cell: (b) => <span className="text-body-sm text-ink-2">{loanStatus(b, now, block, spb)}</span> },
    {
      key: "act",
      header: "",
      end: true,
      label: false,
      cell: (b) => (
        <span className="flex gap-2">
          {b.canRepay && (
            <Button size="sm" variant="primary" onClick={stop(() => onRepay(b))}>
              Repay
            </Button>
          )}
          {b.canRollover && rolloverTargets(b.pool, pools).length > 0 && (
            <Button size="sm" variant="secondary" onClick={stop(() => onExtend(b))}>
              Roll over
            </Button>
          )}
        </span>
      ),
    },
  ];
  return <List testId="loans" columns={cols} template="minmax(200px,1.3fr) minmax(120px,1fr) minmax(190px,1.2fr) minmax(170px,1.2fr) auto" rows={rows} rowKey={(b) => b.pool.id} onRow={onOpen} rowLabel={(b) => `Loan maturing ${fmtExpiry(b.pool.expiry)}`} />;
}

function lendStatus(l: LendPosition, tokens: Tokens, now: number, block: bigint): string {
  const s = poolState(l.pool, now, block);
  if (s === "open" || s === "paused") return "Open";
  if (s === "window" || s === "awaiting") return "Matured · payout ready after the repayment window ends";
  if (s === "closing") return "Closing";
  const q = tokenOf(tokens, l.pool.quote);
  const a = tokenOf(tokens, l.pool.asset);
  // the same estimate as Action required: the repaid part in the loan token and the unrepaid part in collateral
  if (l.claim && l.claim.asset > 0n && l.claim.quote > 0n) return `Matured, partly repaid: collect ${fmtToken(l.claim.quote, q)} and ${fmtToken(l.claim.asset, a)}`;
  if (l.claim && l.claim.asset > 0n) return `Matured, not repaid: collect ${fmtToken(l.claim.asset, a)}`;
  return `Matured: collect ${fmtToken(l.claim?.quote ?? l.ifRepaid, q)}`;
}

function LendingRows({ rows, pools, tokens, now, block, onClaim, onOpen }: { rows: LendPosition[]; pools: PoolRow[]; tokens: Tokens; now: number; block: bigint; onClaim: (l: LendPosition) => void; onOpen: (l: LendPosition) => void }) {
  const cols: Column<LendPosition>[] = [
    {
      key: "lend",
      header: "Lent",
      cell: (l) => {
        const a = tokenOf(tokens, l.pool.asset);
        const q = tokenOf(tokens, l.pool.quote);
        return (
          <span className="flex items-center gap-2.5">
            <PositionIcon t="ft" asset={a ? { symbol: a.symbol, address: l.pool.asset } : undefined} size={28} faded={l.pool.status === Status.Closed} />
            <span className="min-w-0">
              <span className="num block font-medium">
                {fmtToken(l.units, a, false)} C · {a?.symbol ?? "…"} / {q?.symbol ?? "…"}
              </span>
              <span className="num block text-caption text-ink-3">backed by {fmtToken(l.units, a)}</span>
              {a && q && (
                <span className="num block truncate text-caption text-ink-3" data-testid="lend-symbol">
                  {positionName("ft", l.pool, a, q, { all: pools }).symbol}
                </span>
              )}
            </span>
          </span>
        );
      },
    },
    { key: "pays", header: "Paid if repaid", end: true, cell: (l) => <span className="num">{fmtToken(l.ifRepaid, tokenOf(tokens, l.pool.quote))}</span> },
    { key: "on", header: "Maturity", cell: (l) => <span className="text-ink-2">{fmtWeekday(l.pool.expiry)}</span> },
    { key: "st", header: "Status", cell: (l) => <span className="text-body-sm text-ink-2">{lendStatus(l, tokens, now, block)}</span> },
    {
      key: "act",
      header: "",
      end: true,
      cell: (l) =>
        l.claimable ? (
          <Button size="sm" variant="primary" onClick={stop(() => onClaim(l))}>
            Collect
          </Button>
        ) : now > 0 && tradable(l.pool, false, now, block) ? (
          <Link href={`/borrow?pool=${l.pool.id}&token=ft&action=sell`} className="btn btn-sm btn-secondary" onClick={(e) => e.stopPropagation()}>
            Sell C
          </Link>
        ) : null,
    },
  ];
  return <List testId="lending" columns={cols} template="minmax(200px,1.3fr) minmax(130px,1fr) minmax(120px,1fr) minmax(200px,1.4fr) auto" rows={rows} rowKey={(l) => l.pool.id} onRow={onOpen} rowLabel={(l) => `Lending maturing ${fmtExpiry(l.pool.expiry)}`} />;
}

function VaultRowsMine({ rows, tokens }: { rows: { vault: VaultRow; me: import("@/lib/vaultMe").VaultMe }[]; tokens: Tokens }) {
  const { chainId, deployment } = useActiveChain();
  const native = nativeSymbol(chainId);
  return (
    <ul className="card p-2">
      {rows.map(({ vault, me }) => {
        const q = tokenOf(tokens, vault.quote);
        const role = vaultRole(vault, deployment?.vaults);
        return (
          <li key={vault.address} className="row flex flex-wrap items-center gap-x-6 gap-y-1.5 rounded-[var(--radius-control)] px-3 py-3.5 text-body-sm">
            <span className="flex min-w-[200px] items-center gap-2.5 font-medium">
              <TokenIcon {...vaultIcon(role, q, native)} size={28} />
              {vaultName(role, q?.symbol ?? "…", native)}
            </span>
            <span className="num flex-1 text-ink-2">Position {fmtToken(vaultSharesValue(vault, me.shares), vaultToken(role, q, native))}</span>
            {me.pendingDeposit > 0n && <span className="num text-ink-2">Queued: {fmtToken(me.pendingDeposit, vaultToken(role, q, native))} deposit</span>}
            <Link href={`/earn?vault=${vault.address}`} className="btn btn-sm btn-secondary">
              Open
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function orderText(o: AccountOrder, p: PoolRow | undefined, tokens: Tokens): string {
  const a = tokenOf(tokens, p?.asset);
  const q = tokenOf(tokens, p?.quote);
  if (o.side === Side.Sell) return `Borrow ${fmtToken(o.units, a)} at ${fmtPer(o.limit, q)} ${q?.symbol ?? ""} or more`;
  if (o.side === Side.NcSell) return `Borrow ${fmtToken(o.units, a)} at market price`;
  if (o.side === Side.Buy) return `Lend for ${fmtToken(o.units, a)} at ${fmtPer(o.limit, q)} ${q?.symbol ?? ""} or less`;
  if (o.side === Side.NcBuy) return `Lend ${fmtToken(o.escrow, q)} at market price`;
  return `Offer for unclaimed ${fmtToken(o.units, a)}`;
}

function OrderRows({ rows, pools, tokens, now, block, chainId }: { rows: AccountOrder[]; pools: PoolRow[]; tokens: Tokens; now: number; block: bigint; chainId: number }) {
  const cols: Column<AccountOrder>[] = [
    { key: "what", header: "Order", cell: (o) => <span className="num font-medium">{orderText(o, pools.find((p) => p.id === o.pid), tokens)}</span> },
    {
      key: "on",
      header: "Maturity",
      cell: (o) => {
        const p = pools.find((x) => x.id === o.pid);
        return <span className="text-ink-2">{p ? fmtWeekday(p.expiry) : "—"}</span>;
      },
    },
    {
      key: "st",
      header: "Status",
      cell: (o) => {
        const p = pools.find((x) => x.id === o.pid);
        if (!p) return null;
        const prog = orderProgress(chainId, o, roundsDone(p));
        const s = poolState(p, now, block);
        if (o.side === Side.Bid) return <span className="text-caption text-ink-2">Waiting for the window to close</span>;
        if (s !== "open") return <span className="text-caption text-ink-2">Not filled; cancel to get it back</span>;
        return <span className="text-caption text-ink-2">{prog ? `Trying again (${prog.i} of ${prog.n})` : `Open, fills in about ${fmtWait(nextRoundAt(p, now) - now)}`}</span>;
      },
    },
    { key: "act", header: "", end: true, cell: (o) => <CancelButton o={o} pool={pools.find((p) => p.id === o.pid)} now={now} block={block} /> },
  ];
  return <List testId="orders" columns={cols} template="minmax(260px,2fr) minmax(120px,1fr) minmax(200px,1.4fr) auto" rows={rows} rowKey={(o) => `${o.pid}:${o.id}`} />;
}

function CancelButton({ o, pool, now, block }: { o: AccountOrder; pool?: PoolRow; now: number; block: bigint }) {
  const tx = useTx();
  const ctx = useActionCtx(tx);
  if (!pool) return null;
  const cut = cancelCutoff(pool, o, now, block);
  return (
    <span className="flex flex-col items-end gap-1">
      <Button size="sm" variant="secondary" disabled={!!cut || tx.busy} loading={tx.busy} onClick={() => ctx && void tx.run([cancelWrite(ctx, o.pid, o.id)])}>
        Cancel
      </Button>
      {cut && <span className="text-label text-ink-3">Can&apos;t cancel in the last minute before a round.</span>}
    </span>
  );
}

function PositionDrawer({ pool, pools, loan, lend, tokens, onClose, onRepay, onExtend, onWrap }: { pool?: PoolRow; pools: PoolRow[]; loan?: BorrowPosition; lend?: LendPosition; tokens: Tokens; onClose: () => void; onRepay: (b: BorrowPosition) => void; onExtend: (b: BorrowPosition) => void; onWrap: (w: { pool: PoolRow; which: "lend" | "loan"; held: bigint; asset: Token }) => void }) {
  const a = tokenOf(tokens, pool?.asset);
  const q = tokenOf(tokens, pool?.quote);
  const { now, block } = useChainClock();
  return (
    <Drawer open={!!pool} onClose={onClose} title={pool ? `Matures ${fmtExpiry(pool.expiry)}` : "Position"} testId="position-drawer">
      {pool && a && q && (
        <div className="space-y-6">
          {loan && (
            <div className="space-y-3">
              <h3 className="text-body font-semibold">Your loan</h3>
              <p className="flex items-center gap-2 text-caption text-ink-3">
                <PositionIcon t="br" asset={{ symbol: a.symbol, address: pool.asset }} size={20} expired={loan.lapsed} />
                <span className="num">{positionName("br", pool, a, q, { all: pools }).symbol}</span>
              </p>
              <p className="text-body-sm leading-6">
                Repay <strong className="num">{fmtToken(loan.repay, q)}</strong> to get <strong className="num">{fmtToken(loan.free, a)}</strong> back.
              </p>
              <OutcomeStrip
                left={{ title: "If you repay", body: <>You get <span className="num">{fmtToken(loan.free, a)}</span> back.</> }}
                right={{ title: "If you don't", body: <>You keep the {q.symbol} you received, lenders keep your <span className="num">{fmtToken(loan.free, a)}</span>.</> }}
              />
              <div className="flex flex-wrap gap-2">
                {loan.canRepay && (
                  <Button variant="primary" size="md" onClick={() => onRepay(loan)}>
                    Repay
                  </Button>
                )}
                {loan.canRollover && (
                  <Button variant="secondary" size="md" onClick={() => onExtend(loan)}>
                    Extend
                  </Button>
                )}
                {tradable(pool, true, now, block) && now > 0 && (
                  <Link href={`/borrow?pool=${pool.id}&token=br&action=sell`} className="btn btn-md btn-secondary">
                    Sell R
                  </Link>
                )}
                <Button variant="quiet" size="md" onClick={() => onWrap({ pool, which: "loan", held: loan.free, asset: a })}>
                  Wrap as ERC-20
                </Button>
              </div>
            </div>
          )}
          {lend && (
            <div className="space-y-3">
              <h3 className="text-body font-semibold">Your lending</h3>
              <p className="flex items-center gap-2 text-caption text-ink-3">
                <PositionIcon t="ft" asset={{ symbol: a.symbol, address: pool.asset }} size={20} faded={pool.status === Status.Closed} />
                <span className="num">{positionName("ft", pool, a, q, { all: pools }).symbol}</span>
              </p>
              <p className="text-body-sm leading-6">
                Backed by <span className="num">{fmtToken(lend.units, a)}</span>. Paid <strong className="num">{fmtToken(lend.ifRepaid, q)}</strong> if repaid.
              </p>
              <OutcomeStrip
                left={{ title: "If they repay", body: <>You receive <span className="num">{fmtToken(lend.ifRepaid, q)}</span>.</> }}
                right={{ title: "If they don't", body: <>You receive <span className="num">{fmtToken(lend.units, a)}</span> instead.</> }}
              />
              <div className="flex flex-wrap gap-2">
                {tradable(pool, false, now, block) && now > 0 && (
                  <Link href={`/borrow?pool=${pool.id}&token=ft&action=sell`} className="btn btn-md btn-secondary">
                    Sell C
                  </Link>
                )}
                <Button variant="quiet" size="md" onClick={() => onWrap({ pool, which: "lend", held: lend.units, asset: a })}>
                  Wrap as ERC-20
                </Button>
              </div>
            </div>
          )}
          <Link href={`/markets?pool=${pool.id}`} className="link text-body-sm">
            View market details
          </Link>
        </div>
      )}
    </Drawer>
  );
}

