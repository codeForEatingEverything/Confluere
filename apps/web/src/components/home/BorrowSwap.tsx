"use client";

/**
 * Home card, Borrow mode (IA v3.1 item 1): You pay = collateral, You receive = the quote token plus the right to buy
 * the collateral back. The router picks the maturity and the pool (lib/bestPool `routeBorrow`); the person may change
 * the maturity. Shows what arrives, what to repay and by when, and what happens if they don't.
 */
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useConnection } from "wagmi";
import type { Address } from "viem";
import { ArrowDown } from "lucide-react";
import { useActiveChain } from "@/lib/activeChain";
import { usePools, tokenOf, type Token } from "@/lib/data";
import { usePairs, useTerms } from "@/lib/useProduct";
import { selectorTokens } from "@/lib/product";
import { routeBorrow } from "@/lib/bestPool";
import { fmtChip, fmtPer, fmtToken, fmtWait, toInput } from "@/lib/format";
import { fixedReturn, rateShort } from "@/lib/quote";
import { SelectField } from "./RouteSelectors";
import { buyBack, repaysAnyTime } from "@/lib/view";
import { tokenName } from "@/lib/logos";
import { useBalances } from "@/lib/position";
import { NATIVE, isNative, isWrappedNative, nativeTokenOf, useNativeBalance, wrappedNativeOf } from "@/lib/native";
import { AmountInput, Button, ChipRow, Skeleton, TokenButton, TokenSelect, TxErrorLine, type TokenChoice } from "../ui";
import { WalletAction } from "../layout/WalletMenu";
import { TokenShortfall } from "../common/TokenShortfall";
import { NothingOpen } from "../borrow/BorrowEmpty";
import { BorrowReview, BorrowSettings, BorrowStatus, BorrowTerms, useBorrowOrder } from "../borrow/borrowFlow";

/**
 * Default pair: the native coin's market (HYPE on HyperEVM, MON on Monad, paid in the native coin) when it is open, else
 * the pair with the most open pools. Never a staked token by default.
 */
export function defaultPair<P extends { asset: Address; quote: Address; openPools: number }>(pairs: P[], wrappedNative?: string): P | undefined {
  const open = pairs.filter((p) => p.openPools > 0);
  const nat = wrappedNative ? open.filter((p) => p.asset.toLowerCase() === wrappedNative.toLowerCase()).sort((a, b) => b.openPools - a.openPools)[0] : undefined;
  return nat ?? [...open].sort((a, b) => b.openPools - a.openPools)[0];
}

export function SwapSkeleton() {
  return (
    <div aria-busy>
      <Skeleton className="h-[108px] w-full rounded-[12px]" label="Loading markets" />
      <Skeleton className="mt-1 h-[108px] w-full rounded-[12px]" />
      <div className="mt-4 flex gap-2">
        <Skeleton className="h-9 w-32 rounded-full" />
        <Skeleton className="h-9 w-32 rounded-full" />
      </div>
      <Skeleton className="mt-6 h-[52px] w-full rounded-[12px]" />
    </div>
  );
}

/** The arrow between the two wells (decorative; the card has one direction per mode). */
export function SwapArrow() {
  return (
    <div className="relative z-[1] -my-3 flex justify-center" aria-hidden>
      <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-surface text-ink-2 shadow-whisper ring-4 ring-surface">
        <ArrowDown size={18} strokeWidth={1.75} />
      </span>
    </div>
  );
}

export function BorrowSwap({ settingsOpen }: { settingsOpen: boolean }) {
  const { chainId } = useActiveChain();
  const { address } = useConnection();
  const pools = usePools();
  const { pairs, tokens, isLoading } = usePairs();
  const wNative = wrappedNativeOf(chainId);
  const [asset, setAsset] = useState<Address>();
  const [payNative, setPayNative] = useState(false);
  // receiving a WHYPE / WMON loan as the coin (HYPE / MON): the withdraw after the fill unwraps it (a DEX starts on ETH)
  const [receiveNative, setReceiveNative] = useState(false); // never unwrap unless the person picks the coin (no automatic unwrapping)
  const [quote, setQuote] = useState<Address>();
  const [expiry, setExpiry] = useState<number>();
  const [poolPick, setPoolPick] = useState<string>();
  const [amount, setAmount] = useState("");
  const [picker, setPicker] = useState<"asset" | "quote">();

  useEffect(() => {
    if (asset && pairs.some((p) => p.asset === asset && p.openPools > 0)) return;
    const d = defaultPair(pairs, wNative);
    if (d) {
      setAsset(d.asset);
      setQuote(d.quote);
      setPayNative(isWrappedNative(chainId, d.asset));
    }
  }, [pairs, asset, wNative, chainId]);
  const quotesForAsset = useMemo(() => {
    const all = pairs.filter((p) => p.asset === asset);
    return all.some((p) => p.openPools > 0) ? all.filter((p) => p.openPools > 0) : all;
  }, [pairs, asset]);
  useEffect(() => {
    if (asset && !quotesForAsset.some((p) => p.quote === quote)) setQuote(quotesForAsset.find((p) => p.openPools > 0)?.quote ?? quotesForAsset[0]?.quote);
  }, [asset, quote, quotesForAsset]);

  const t = useTerms({ asset, quote });
  const route = routeBorrow(t.terms, expiry, poolPick);
  const pool = route.offer?.pool;
  const A: Token | undefined = tokenOf(tokens ?? t.tokens, asset);
  const Q: Token | undefined = tokenOf(tokens ?? t.tokens, quote);
  const native = payNative && isWrappedNative(chainId, asset);
  const recvNative = receiveNative && isWrappedNative(chainId, quote);
  const o = useBorrowOrder({ pool, A, Q, amount, ref: t.ref, payNative: native, receiveNative: recvNative });
  // a token is offered only when open pools stand behind it (every pair while nothing is open), and the coin
  // (HYPE / MON) is its own row right before its wrapped token (WHYPE / WMON) wherever that one is offered
  const assetChoices = useMemo(() => selectorTokens(pairs, "asset", wNative), [pairs, wNative]);
  const quoteChoices = useMemo(() => selectorTokens(quotesForAsset, "quote", wNative), [quotesForAsset, wNative]);
  const walletBals = useBalances(assetChoices.filter((a) => !isNative(a))).data;
  // the coin and its wrapped token are a 1:1 wrap, not a market: with either as collateral the other is listed as the
  // conversion it is ("Wrap / Unwrap 1:1"), never as a pool
  const wTok = tokenOf(tokens, wNative);
  const conversionRow: TokenChoice | undefined =
    wNative && asset && isWrappedNative(chainId, asset)
      ? native
        ? { address: wNative, symbol: wTok?.symbol ?? `W${nativeTokenOf(chainId).symbol}`, name: "Wrap / Unwrap 1:1", note: "A 1:1 wrap, not a loan", wrapped: true, conversion: true }
        : { address: NATIVE, symbol: nativeTokenOf(chainId).symbol, name: "Wrap / Unwrap 1:1", note: "A 1:1 unwrap, not a loan", conversion: true }
      : undefined;
  const nativeBal = useNativeBalance(chainId);

  if (isLoading || pools.isLoading) return <SwapSkeleton />;
  if (!pairs.some((p) => p.openPools > 0)) {
    if ((pools.isError && !pools.data) || pools.discovering) return <SwapSkeleton />;
    const closed = new Set((pools.data ?? []).map((p) => p.expiry)).size;
    const last = Math.max(0, ...(pools.data ?? []).map((p) => p.expiry));
    const fa = tokenOf(tokens, pairs[0]?.asset);
    const fq = tokenOf(tokens, pairs[0]?.quote);
    return (
      <div data-testid="borrow-swap">
        <div className="pointer-events-none opacity-60" aria-hidden>
          <AmountInput label="You pay" value="" readOnly token={<TokenButton symbol={fa?.symbol ?? "Collateral"} address={fa?.address} />} />
          <SwapArrow />
          <AmountInput label="You receive" value="" readOnly token={<TokenButton symbol={fq?.symbol ?? "USDC"} address={fq?.address} />} />
        </div>
        <Button variant="primary" size="lg" block disabled className="mt-4">
          No open market
        </Button>
        <NothingOpen what="borrow" closedTerms={closed} lastExpiry={last || undefined} />
      </div>
    );
  }

  const P = o.payToken ?? A;
  const sym = P?.symbol ?? "";
  const qsym = Q?.symbol ?? "";
  const nt = nativeTokenOf(chainId);
  /** What arrives: the coin when the person picked it for a WHYPE / WMON loan, else the loan token itself. */
  const R: Token | undefined = recvNative ? nt : Q;
  const receive = o.q && o.units > 0n && o.q.receive > 0n ? fmtToken(o.q.receive, Q, false) : "";

  const selectors = route.term ? (
    <div data-testid="route-selectors">
      <div className="grid grid-cols-2 gap-2">
        <SelectField
          label="Maturity"
          title="Choose a maturity"
          value={route.term.expiry}
          onChange={(e) => {
            setExpiry(e);
            setPoolPick(undefined);
          }}
          testId="maturity-select"
          display={`${fmtChip(route.term.expiry)} UTC`}
          options={route.terms.map((x) => ({
            value: x.expiry,
            label: `${fmtChip(x.expiry)} UTC`,
            sub: x.secondsLeft > 0 ? `in ${fmtWait(x.secondsLeft)}` : undefined,
            aside: `${x.offers.filter((f) => f.open).length} pool${x.offers.filter((f) => f.open).length === 1 ? "" : "s"}`,
            testId: "term-chip",
          }))}
        />
        <SelectField
          label="Pool"
          title={`Pools maturing ${fmtChip(route.term.expiry)} UTC`}
          value={pool?.id}
          onChange={(id) => setPoolPick(id)}
          testId="pool-select"
          display={pool && Q ? `Buy back at ${fmtPer(buyBack(pool), Q)}` : "—"}
          options={route.offers.map((f, i) => {
            const r = fixedReturn(f.pool, o.now);
            return {
              value: f.id,
              label: `${A?.symbol ?? ""} / ${qsym}, buy back at ${Q ? fmtPer(buyBack(f.pool), Q) : ""}`,
              sub: `${repaysAnyTime(f.pool) ? "Repay any time" : "Repay at maturity only"}${f.graduated ? "" : ". New market"}`,
              aside: r.priced ? `${rateShort(r)} to borrow` : "No trades yet",
              best: i === 0,
              testId: "pool-option",
            };
          })}
        />
      </div>
      {pool && Q && (
        <p className="mt-2 text-caption text-ink-3" data-testid="route-line">
          {route.picked ? "Your pick" : "Best pool for this date"}: {repaysAnyTime(pool) ? "repay any time" : "repay at maturity only"}, buy-back price {fmtPer(buyBack(pool), Q)} {qsym}.{" "}
          <Link href={`/borrow?pool=${pool.id}`} className="link">
            Details
          </Link>
        </p>
      )}
    </div>
  ) : undefined;

  return (
    <div data-testid="borrow-swap">
      {settingsOpen && (
        <div className="mb-3">
          <BorrowSettings o={o} />
        </div>
      )}
      <AmountInput
        label="You pay"
        value={amount}
        onChange={(v) => {
          setAmount(v);
          o.tx.reset?.();
        }}
        readOnly={o.tx.busy}
        decimals={P?.decimals ?? 18}
        testId="pay-input"
        token={<TokenButton symbol={sym} address={P?.address} onClick={assetChoices.length > 1 ? () => setPicker("asset") : undefined} />}
        helper={o.min > 0n && P ? <span className="num">Min {fmtToken(o.min, P)}</span> : undefined}
        balance={address && P ? <span className="num">Balance {fmtToken(o.bal ?? 0n, P)}</span> : undefined}
        onMax={address && P && o.maxPay ? () => setAmount(toInput(o.maxPay!, P.decimals)) : undefined}
      />
      <SwapArrow />
      <AmountInput
        label="You receive"
        value={receive}
        placeholder={o.q && o.q.price === 0n ? "—" : "0"}
        readOnly
        testId="receive-output"
        token={<TokenButton symbol={R?.symbol ?? ""} address={R?.address} onClick={quoteChoices.length > 1 ? () => setPicker("quote") : undefined} />}
        helper={
          pool && A && Q && o.qs ? (
            o.qs.price === 0n ? (
              "No price yet. Set a limit price in settings."
            ) : (
              <span className="num" data-testid="buyback-right">
                Plus the right to buy back {fmtToken(o.show, A)} for {fmtToken(o.qs.repay, Q)}
              </span>
            )
          ) : undefined
        }
      />
      {o.balanceShort && A && (
        <div className="mt-2">
          <TokenShortfall token={A} need={o.units} onUseNative={isWrappedNative(chainId, asset) && !native ? () => setPayNative(true) : undefined} />
        </div>
      )}

      {selectors && <div className="mt-3">{selectors}</div>}
      <div className="mt-4 space-y-2">
        <TxErrorLine error={o.review ? undefined : o.tx.lastError} />
        <WalletAction>
          <Button variant="primary" size="lg" block disabled={!o.can || o.tx.busy} loading={o.tx.busy} onClick={() => o.setReview(true)} data-testid="borrow-button">
            {o.label}
          </Button>
        </WalletAction>
      </div>
      <div className="mt-3">
        <BorrowTerms o={o} collapsible footer={o.watch ? undefined : <BorrowStatus o={o} />} />
      </div>
      {o.watch && (
        <div className="mt-4">
          <BorrowStatus o={o} />
        </div>
      )}

      <TokenSelect
        open={picker === "asset"}
        onClose={() => setPicker(undefined)}
        title="Select collateral"
        value={native ? NATIVE : asset}
        tokens={assetChoices.map((a) => {
          // the coin is paid in and wrapped inside the same button flow; the wrapped token is paid directly
          const nat = isNative(a);
          const under = nat && wNative ? wNative : a;
          const tk = nat ? nt : tokenOf(tokens, a);
          const n = pairs.filter((x) => x.asset.toLowerCase() === under.toLowerCase()).reduce((s, x) => s + x.openPools, 0);
          const wb = nat ? nativeBal : walletBals?.[a.toLowerCase()];
          const w = isWrappedNative(chainId, a);
          return {
            address: a,
            symbol: tk?.symbol ?? "…",
            name: tokenName(tk?.symbol) ?? (w ? `Wrapped ${nt.symbol}` : undefined),
            note: n > 0 ? `${n} open market${n > 1 ? "s" : ""}` : "No open markets",
            balance: address && wb !== undefined && tk ? fmtToken(wb, tk, false) : undefined,
            wrapped: w || undefined,
          };
        })}
        onPick={(a) => {
          const nat = isNative(a);
          setAsset(nat && wNative ? wNative : (a as Address));
          setPayNative(nat);
          setExpiry(undefined);
          setPoolPick(undefined);
          setAmount("");
        }}
      />
      <TokenSelect
        open={picker === "quote"}
        onClose={() => setPicker(undefined)}
        title="Select token to receive"
        value={recvNative ? NATIVE : quote}
        tokens={quoteChoices.map((a): TokenChoice => {
          // the loan is lent in the wrapped token; the coin row unwraps it when the proceeds are withdrawn
          const nat = isNative(a);
          const under = nat && wNative ? wNative : a;
          const tk = nat ? nt : tokenOf(tokens, a);
          const n = quotesForAsset.find((p) => p.quote.toLowerCase() === under.toLowerCase())?.openPools ?? 0;
          const w = isWrappedNative(chainId, a);
          return { address: a, symbol: tk?.symbol ?? "…", name: tokenName(tk?.symbol) ?? (w ? `Wrapped ${nt.symbol}` : undefined), note: n > 0 ? `${n} open market${n > 1 ? "s" : ""}` : "No open markets", wrapped: w || undefined };
        }).concat(conversionRow ? [conversionRow] : [])}
        onPick={(a) => {
          const nat = isNative(a);
          setQuote(nat && wNative ? wNative : (a as Address));
          setReceiveNative(nat);
          setExpiry(undefined);
          setPoolPick(undefined);
        }}
      />
      <BorrowReview o={o} onPlaced={() => setAmount("")} />
    </div>
  );
}
