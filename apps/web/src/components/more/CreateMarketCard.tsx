"use client";

/** Create market (More, FRONTEND_V3 §8.7): one long card, not a wizard. The contract re-checks every rule. */
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { isAddress, type Address } from "viem";
import { Kind, cadenceMultiplier, isGridStrike, poolId } from "@confluere/sdk";
import { useActiveChain } from "@/lib/activeChain";
import { onchainSymbol, tokenOf, useGrid, usePools, usePoolStatus, useTokens } from "@/lib/data";
import { isNative, isWrappedNative, nativeTokenOf, NATIVE, useNativeBalance, wrappedNativeOf } from "@/lib/native";
import { tokenName } from "@/lib/logos";
import { launchTokens, wrapWrite } from "@/lib/tokens";
import { useBalances } from "@/lib/position";
import { BAND_TIERS, FEE_TIERS, gridExpiries, nearestGridStrikes } from "@/lib/grid";
import { fmtChip, fmtPer, fmtToken, fmtWait, parseAmount, toInput } from "@/lib/format";
import { marketKey, openMarketWrite } from "@/lib/proActions";
import { STYLE_LABEL } from "@/lib/vocab";
import { priceDigits } from "@/lib/view";
import { useTx, type Write } from "@/lib/tx";
import { AmountInput, Button, Card, ChipRow, Disclosure, Segmented, TokenButton, TokenSelect, TxErrorLine, useLiveNow } from "../ui";
import { WalletAction } from "../layout/WalletMenu";

const GUARD_NAME: Record<number, string> = { 150: "±1.5%, for tokens that track each other", 800: "±8%, for liquid tokens", 1500: "±15%, for new or volatile tokens" };

export function CreateMarketCard() {
  const { chainId, deployment } = useActiveChain();
  const router = useRouter();
  const tx = useTx();
  const now = useLiveNow();
  const grid = useGrid().data;
  const pools = usePools().data ?? [];
  const known = useMemo(() => [...new Set([...pools.flatMap((p) => [p.asset, p.quote]), ...launchTokens(chainId)].map((a) => a.toLowerCase()))] as Address[], [pools, chainId]);
  const [asset, setAsset] = useState("");
  const [quote, setQuote] = useState("");
  const [pick, setPick] = useState<"asset" | "quote">();
  const [kind, setKind] = useState<Kind>(Kind.American);
  const [expiry, setExpiry] = useState<number>();
  const [bbStr, setBb] = useState("");
  const [fee, setFee] = useState(1000);
  const [guard, setGuard] = useState(800);
  const [slow, setSlow] = useState(0);
  const [minVol, setMinVol] = useState("");
  const [lo, setLo] = useState("");
  const [hi, setHi] = useState("");
  // IA v3.1 item 11: the network's coin (HYPE / MON) is listed next to its wrapped token; a market on the coin is
  // created on WHYPE / WMON, since pools hold ERC-20 tokens, and the card keeps calling it HYPE / MON
  const nat = nativeTokenOf(chainId);
  const wrapped = wrappedNativeOf(chainId);
  const resolve = (a: string) => (isNative(a) ? (wrapped ?? "") : a);
  const assetAddr = resolve(asset);
  const quoteAddr = resolve(quote);
  const tokens = useTokens([...known, ...([assetAddr, quoteAddr].filter((a) => isAddress(a)) as Address[])]).data;
  const A = isAddress(assetAddr) ? tokenOf(tokens, assetAddr) : undefined;
  const Q = isAddress(quoteAddr) ? tokenOf(tokens, quoteAddr) : undefined;
  /** What the token button shows: the coin when it was picked, the wrapped token's own name when that was. */
  const shown = (picked: string, t?: { symbol: string; onchainSymbol?: string }) => (!t ? undefined : isNative(picked) ? nat.symbol : isWrappedNative(chainId, picked) ? onchainSymbol(t) : t.symbol);
  const nativeBal = useNativeBalance(chainId);
  const digits = priceDigits(grid);
  const base = grid?.batchInterval ?? deployment?.batchInterval ?? 1800;
  const period = grid?.period ?? deployment?.gridPeriod ?? 3600;
  const expiries = now ? gridExpiries(grid?.anchor ?? deployment?.gridAnchor ?? 0, period, now, Math.min(grid?.maxExpiries ?? 8, 8)) : [];
  const firstExpiry = expiries[0];
  useEffect(() => {
    if (!expiry && firstExpiry) setExpiry(firstExpiry);
  }, [expiry, firstExpiry]);
  const bb = Q ? parseAmount(bbStr, Q.decimals) : 0n;
  const bbOk = bb > 0n && isGridStrike(bb, digits);
  const near = Q && bb > 0n ? nearestGridStrikes(bb, digits) : undefined;
  const loV = Q ? parseAmount(lo, Q.decimals) : 0n;
  const hiV = Q ? parseAmount(hi, Q.decimals) : 0n;
  const minV = A ? parseAmount(minVol, A.decimals) : 0n;
  const tooSlow = (c: number) => base * cadenceMultiplier(c) > period;
  const m = A && Q && expiry && bbOk ? { asset: A.address, quote: Q.address, expiry, buyBack: bb, kind, feeBps: fee, guardBps: guard, slow, minVolume: minV, firstLow: loV, firstHigh: hiV } : undefined;
  const pid = m ? poolId(marketKey(m)) : undefined;
  const exists = (usePoolStatus(pid).data ?? 0) !== 0;
  const bal = useBalances(useMemo(() => [...new Set([...known, ...(A ? [A.address] : []), ...(Q ? [Q.address] : [])].map((a) => a.toLowerCase()))] as Address[], [known, A, Q])).data;
  const has = (t: { address: string }, picked: string) => (bal?.[t.address.toLowerCase()] ?? 0n) >= 1n || (isNative(picked) && (nativeBal ?? 0n) > 0n);
  const hasUnits = !!A && !!Q && has(A, asset) && has(Q, quote);
  /** Paying with the coin for a test transfer of WHYPE / WMON the wallet does not hold yet: wrap one unit first. */
  const needsWrap = !!wrapped && [asset, quote].some(isNative) && (bal?.[wrapped.toLowerCase()] ?? 0n) < 1n;
  const badRange = hiV > 0n && loV > hiV;
  const choices = [
    ...(wrapped ? [{ address: NATIVE as string, symbol: nat.symbol, name: tokenName(nat.symbol), balance: nativeBal !== undefined ? fmtToken(nativeBal, nat, false) : undefined }] : []),
    ...known.map((a) => {
      const t = tokenOf(tokens, a);
      const w = isWrappedNative(chainId, a);
      const symbol = (w ? onchainSymbol(t) : t?.symbol) ?? `${a.slice(0, 8)}…`;
      const b = bal?.[a.toLowerCase()];
      return { address: a as string, symbol, name: tokenName(symbol), wrapped: w || undefined, balance: t && b !== undefined ? fmtToken(b, t, false) : undefined };
    }),
  ];

  const go = async () => {
    if (!m || !deployment || !A || !Q) return;
    const core = deployment.confluere;
    const r = await tx.run(async () => {
      const a1 = await tx.ensureAllowance(A.address, 1n, core, { symbol: A.symbol, exact: true });
      const a2 = await tx.ensureAllowance(Q.address, 1n, core, { symbol: Q.symbol, exact: true });
      const wrap = needsWrap && wrapped ? wrapWrite(wrapped, 1n, nat.symbol) : null;
      return [wrap, a1, a2, openMarketWrite(core, m)].filter((x): x is Write => !!x);
    });
    if (r.ok && pid) router.push(`/markets?pool=${pid}`);
  };

  return (
    <div className="mx-auto max-w-[560px]">
      <h1 className="text-amount font-semibold leading-8">Create market</h1>
      <p className="mt-2 text-body leading-6 text-ink-2">Anyone can create a market. Borrowers post the collateral asset and buy it back with the loan asset by a fixed maturity.</p>
      <Card className="mt-6 space-y-6 p-6 max-sm:p-4">
        <div className="space-y-2">
          <p className="text-caption font-medium text-ink-2">Assets</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="well space-y-1.5 px-3 py-3">
              <p className="text-caption text-ink-2">Collateral asset</p>
              <TokenButton symbol={shown(asset, A)} address={A ? asset : undefined} onClick={() => setPick("asset")} label="Choose the collateral asset" />
            </div>
            <div className="well space-y-1.5 px-3 py-3">
              <p className="text-caption text-ink-2">Loan asset</p>
              <TokenButton symbol={shown(quote, Q)} address={Q ? quote : undefined} onClick={() => setPick("quote")} label="Choose the loan asset" />
            </div>
          </div>
          {A && Q && A.address === Q.address && <p className="text-caption text-bad">Pick two different tokens.</p>}
        </div>
        <div className="space-y-2">
          <p className="text-caption font-medium text-ink-2">Repayment</p>
          <Segmented label="Repayment" value={kind} onChange={setKind} options={[{ value: Kind.American, label: STYLE_LABEL[0] }, { value: Kind.European, label: STYLE_LABEL[1] }]} />
        </div>
        <div className="space-y-2">
          <ChipRow label="Maturity" value={expiry} onChange={setExpiry} options={expiries.map((e) => ({ value: e, label: fmtChip(e) }))} />
          <p className="text-caption text-ink-3">Times are UTC. A maturity too close to now may pass before the transaction lands.</p>
        </div>
        <div className="space-y-2">
          <AmountInput
            big={false}
            label={A && Q ? `Buy-back price (${Q.symbol} per 1 ${A.symbol})` : "Buy-back price"}
            value={bbStr}
            onChange={setBb}
            decimals={Q?.decimals ?? 18}
            token={<TokenButton symbol={Q?.symbol} />}
            error={bb > 0n && !bbOk ? `Use at most ${digits} significant digits` : undefined}
          />
          {near && Q && (
            <p className="text-caption text-ink-2">
              Nearest allowed:{" "}
              <button type="button" className="link num" onClick={() => setBb(toInput(near.lower, Q.decimals))}>
                {fmtPer(near.lower, Q)}
              </button>{" "}
              or{" "}
              <button type="button" className="link num" onClick={() => setBb(toInput(near.upper, Q.decimals))}>
                {fmtPer(near.upper, Q)}
              </button>
            </p>
          )}
        </div>
        <ChipRow label="Fee" value={fee} onChange={setFee} options={FEE_TIERS.map((f) => ({ value: f.bps, label: f.label }))} />
        <div className="space-y-1">
          <ChipRow label="Market-order price range" helper="Market orders fill only within this range of the last price." value={guard} onChange={setGuard} options={BAND_TIERS.map((b) => ({ value: b.bps, label: `±${b.bps / 100}%` }))} />
          <p className="text-caption text-ink-3">{GUARD_NAME[guard]}. At-market orders only fill this close to last traded.</p>
        </div>
        <Disclosure title="More settings">
          <div className="space-y-3">
            <ChipRow label="Rounds every" value={slow} onChange={setSlow} options={[0, 1, 2].filter((c) => !tooSlow(c)).map((c) => ({ value: c, label: fmtWait(base * cadenceMultiplier(c)) }))} />
            <AmountInput big={false} label="Minimum volume per round" value={minVol} onChange={setMinVol} decimals={A?.decimals ?? 18} token={<TokenButton symbol={A?.symbol} />} helper="A round below this does not trade; orders wait for the next." />
            <div className="grid grid-cols-2 gap-2">
              <AmountInput big={false} label="First-round low" value={lo} onChange={setLo} decimals={Q?.decimals ?? 18} />
              <AmountInput big={false} label="First-round high" value={hi} onChange={setHi} decimals={Q?.decimals ?? 18} error={badRange ? "Low is above high" : undefined} />
            </div>
          </div>
        </Disclosure>
        <p className="text-caption leading-[18px] text-ink-3">
          One market per set of settings; the first creator sets the fee and the market-order price range. New markets are not vault-eligible until they have traded cleanly for four maturities, and the guardian may pause them for up to 7 days at a time.
        </p>
        {exists && <p className="text-body-sm text-warn">A market with these exact settings already exists.</p>}
        {A && Q && !hasUnits && <p className="text-caption text-ink-3">You need a tiny amount of both tokens: the contract checks that each one transfers normally.</p>}
        <TxErrorLine error={tx.lastError} />
        <WalletAction>
          <Button variant="primary" size="lg" block disabled={!m || exists || !hasUnits || badRange || tx.busy} loading={tx.busy} onClick={() => void go()}>
            {!A || !Q ? "Select both assets" : A.address === Q.address ? "Pick two different assets" : !expiry ? "Pick a maturity" : !bbStr ? "Enter a buy-back price" : !bbOk ? `Use at most ${digits} significant digits` : exists ? "This market exists" : badRange ? "Low is above high" : !hasUnits ? "Need a little of both assets" : "Create market"}
          </Button>
        </WalletAction>
      </Card>
      <TokenSelect
        open={!!pick}
        onClose={() => setPick(undefined)}
        title={pick === "asset" ? "Select collateral asset" : "Select loan asset"}
        value={pick === "asset" ? asset : quote}
        allowAddress
        tokens={choices}
        onPick={(a) => (pick === "asset" ? setAsset(a) : setQuote(a))}
      />
    </div>
  );
}
