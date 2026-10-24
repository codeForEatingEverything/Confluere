"use client";

/**
 * Vault drawer (FRONTEND_V3 §8.3). A vault is lender-side only: it lends the quote token to borrowers who sold their
 * tokens into established markets, by a rule fixed at deployment. It may receive borrowers' tokens only when they do not
 * repay, and passes them on at withdrawal. Deposits and withdrawals are carried out at the end of the vault's current period.
 */
import Link from "next/link";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { isWrappedNative } from "@/lib/native";
import { useConnection } from "wagmi";
import type { Address } from "viem";
import { useActiveChain } from "@/lib/activeChain";
import { tokenOf, useTokens, useVaults, type Token, type VaultRow } from "@/lib/data";
import { useVaultMe, useVaultPositions } from "@/lib/vaultMe";
import { useActionCtx } from "@/lib/useProduct";
import { vaultCollectWrites, vaultDepositWrites, vaultRedeemWrite } from "@/lib/actions";
import { vaultRole, vaultSharesValue } from "@/lib/product";
import { nativeSymbol, fmtToken, parseAmount, toInput } from "@/lib/format";
import { useTx } from "@/lib/tx";
import { vaultExplainer, vaultIcon, vaultLends, vaultLevel, vaultName, vaultSentences, vaultToken } from "@/lib/vocab";
import type { VaultRole } from "@/lib/product";
import { useAllowance } from "@/lib/allowance";
import { usePools } from "@/lib/data";
import { AmountInput, Address as Addr, Button, DateTime, DetailRows, Disclosure, Drawer, Segmented, Skeleton, Stat, StatusPill, StepsLine, TokenButton, TokenIcon, TxErrorLine, stageLabel, useLiveNow } from "../ui";
import { WalletAction } from "../layout/WalletMenu";
import { TokenShortfall } from "../common/TokenShortfall";
import { usePayWith } from "../common/PayWith";
import { ProvideLiquidity } from "../borrow/MarketDetail";
import { marketId } from "@confluere/sdk";
import { reviewSteps } from "../borrow/borrowFlow";

/**
 * `wrappedView`: opened from the WHYPE / WMON row of a coin vault (?pay=wrapped, lib/twins). The drawer then names the
 * vault and its money by the wrapped token (WHYPE Pegged vault, deposits in WHYPE); otherwise by the coin.
 */
export function useVaultLabels(v: VaultRow | undefined, tokens: Record<string, Token> | undefined, wrappedView = false) {
  const { chainId, deployment } = useActiveChain();
  if (!v) return undefined;
  const role = vaultRole(v, deployment?.vaults);
  const quote = tokenOf(tokens, v.quote);
  const asset = tokenOf(tokens, v.assets[0]);
  const wrapped = wrappedView && isWrappedNative(chainId, v.quote) && !!quote;
  const native = wrapped ? quote!.symbol : nativeSymbol(chainId);
  const icon = wrapped ? { address: quote!.address, symbol: quote!.symbol } : vaultIcon(role, quote, native);
  return { role, quote, asset, native, wrapped, icon, name: vaultName(role, quote?.symbol ?? "…", native) };
}

export function VaultDrawer({ address, onClose }: { address?: string; onClose: () => void }) {
  const vaults = useVaults();
  const v = address ? vaults.data?.find((x) => x.address.toLowerCase() === address.toLowerCase()) : undefined;
  const tokens = useTokens(v ? [v.quote, ...v.assets] : []).data;
  const l = useVaultLabels(v, tokens, useSearchParams()?.get("pay") === "wrapped");
  return (
    <Drawer
      open={!!address}
      onClose={onClose}
      title={
        l ? (
          <span className="inline-flex items-center gap-2">
            <TokenIcon {...l.icon} size={24} />
            {l.name}
          </span>
        ) : (
          "Vault"
        )
      }
      subtitle={l?.quote && l.asset ? `Lends ${vaultLends(l.role, l.quote.symbol, l.native)} to ${l.asset.symbol} borrowers by a fixed rule` : undefined}
      testId="vault-drawer"
    >
      {address && v && l?.quote ? (
        <VaultBody v={v} quote={l.quote} asset={l.asset} role={l.role} native={l.native} wrapped={l.wrapped} />
      ) : vaults.isLoading ? (
        <div className="space-y-3" aria-busy>
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : (
        <p className="text-body-sm text-ink-2">This vault is not on this network.</p>
      )}
    </Drawer>
  );
}

/**
 * `quote` is the vault's on-chain token and what every write uses; `shown` is how the screen names the money. A coin
 * vault (lends WHYPE / WMON) reads HYPE / MON throughout, like its list row: title, sentences, amounts, the deposit
 * token (HYPE first, WHYPE as the second row of the selector) and the payout ("Receive as" HYPE unwraps after the
 * withdrawal). WHYPE appears only where the person picks it, and in the market name of "Provide liquidity".
 */
function VaultBody({ v, quote, asset, role, native, wrapped = false }: { v: VaultRow; quote: Token; asset?: Token; role: VaultRole; native: string; wrapped?: boolean }) {
  const { address } = useConnection();
  const me = useVaultMe(v.address, v.assets).data;
  const tokens = useTokens([v.quote, ...v.assets]).data;
  const positions = useVaultPositions(v.address, useActiveChain().deployment?.confluere).data;
  const pools = usePools().data ?? [];
  const [tab, setTab] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");
  const [max, setMax] = useState(false);
  const shown = wrapped ? quote : (vaultToken(role, quote, native) ?? quote);
  const pw = usePayWith(quote);
  const rw = usePayWith(quote, { title: "Receive as", preferNative: false });
  const bal = pw.bal;
  const P = pw.P ?? quote;
  const R = rw.P ?? shown;
  const allowance = useAllowance(v.quote, v.address).data;
  const tx = useTx();
  const ctx = useActionCtx(tx);
  const amt = parseAmount(amount, quote.decimals);
  const assetSym = asset?.symbol ?? "the borrowers' tokens";
  const [s1, s2, s3] = vaultSentences(v, shown.symbol, assetSym);
  const worth = me ? vaultSharesValue(v, me.shares) : 0n;
  const sharesFor = (a: bigint) => (v.totalAssets > 0n ? (a * v.totalSupply) / v.totalAssets : 0n);
  const redeemShares = max && me ? me.shares : sharesFor(amt);
  const now = useLiveNow();
  const ended = now > 0 && v.targetExpiry <= now;
  const periodEnd = ended ? "when the vault rolls to its next period (anyone can trigger it)" : <DateTime ts={v.targetExpiry} />;

  const deposit = () => ctx && tx.run(() => vaultDepositWrites(ctx, { vault: v.address, quote, amount: amt, payNative: pw.nativeSymbol }), { onSuccess: () => setAmount(""), successMessage: `Deposited ${fmtToken(amt, P)}. It starts lending at the next period.` });
  const request = () => ctx && tx.run([vaultRedeemWrite(ctx, v.address, redeemShares)], { onSuccess: () => setAmount(""), successMessage: "Withdrawal requested. Paid at the end of this period." });
  const collect = (which: "shares" | "assets" | "credits") =>
    ctx &&
    me &&
    tx.run(
      vaultCollectWrites(ctx, v.address, { claimShares: which === "shares" ? me.claimShares : 0n, claimAssets: which === "assets" ? me.claimAssets : 0n, assetCredits: which === "credits" ? me.assetCredits : [] }, quote.symbol, rw.native ? { token: quote.address, native: rw.nat.symbol } : undefined),
      which === "assets" ? { successMessage: `Withdrawn ${fmtToken(me.claimAssets, R)} to your wallet.` } : which === "credits" ? { successMessage: "Collected to your wallet." } : undefined,
    );

  const short = tab === "deposit" && !!address && pw.max !== undefined && amt > pw.max;
  const tooMuch = tab === "withdraw" && !!me && redeemShares > me.shares;
  let label: string;
  let can = false;
  if (amt === 0n && !max) label = "Enter an amount";
  else if (short) label = `Not enough ${P.symbol}`;
  else if (tooMuch) label = "More than your share";
  else if (tab === "deposit") {
    label = pw.native ? `Wrap ${P.symbol} and deposit` : `Deposit ${fmtToken(amt, P)}`;
    can = true;
  } else {
    label = "Request withdrawal";
    can = redeemShares > 0n;
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Total deposits" value={fmtToken(v.totalAssets, shown, true, { compact: true })} />
        <Stat label="Your position" value={address ? fmtToken(worth, shown) : "—"} note={!address ? "Connect to see" : undefined} />
      </div>
      <p className="text-body-sm text-ink-2" data-testid="vault-thesis">{s1}</p>
      <Segmented
        label="Vault action"
        value={tab}
        onChange={(t) => {
          setTab(t);
          setAmount("");
          setMax(false);
          tx.reset();
        }}
        options={[
          { value: "deposit", label: "Deposit" },
          { value: "withdraw", label: "Withdraw" },
        ]}
      />
      {tab === "deposit" ? (
        <div className="space-y-3">
          <AmountInput
            label="Deposit"
            value={amount}
            onChange={setAmount}
            autoFocus
            readOnly={tx.busy}
            decimals={quote.decimals}
            token={pw.button}
            balance={address ? <span className="num">Balance {fmtToken(bal ?? 0n, P)}</span> : undefined}
            onMax={address && pw.max ? () => setAmount(toInput(pw.max!, quote.decimals)) : undefined}
          />
          {pw.picker}
          {short && <TokenShortfall token={quote} need={amt} onUseNative={pw.can && !pw.native ? () => pw.setNative(true) : undefined} />}
          <p className="text-caption text-ink-3">Deposits are collected now and start lending at the next period ({periodEnd}). Not instant: the vault takes in deposits once per period.</p>
          {me && me.pendingDeposit > 0n && <StatusPill tone="neutral">Queued for the next period: {fmtToken(me.pendingDeposit, shown)}.</StatusPill>}
          {me && me.claimShares > 0n && (
            <StatusPill tone="good" action={<Button size="sm" variant="primary" loading={tx.busy} onClick={() => void collect("shares")}>Collect shares</Button>}>
              Your vault shares are ready. One transaction records them in your wallet; your deposit is already lending.
            </StatusPill>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <AmountInput
            label="Withdraw"
            value={amount}
            onChange={(x) => {
              setAmount(x);
              setMax(false);
            }}
            readOnly={tx.busy}
            decimals={quote.decimals}
            token={rw.button}
            balance={address ? <span className="num">Position {fmtToken(worth, shown)}</span> : undefined}
            onMax={
              address && me && me.shares > 0n
                ? () => {
                    setAmount(toInput(worth, quote.decimals));
                    setMax(true);
                  }
                : undefined
            }
          />
          {rw.picker}
          <p className="text-caption text-ink-3">Withdrawals are requested now and paid at the end of this period ({periodEnd}), first come first served. If the vault&apos;s funds are out on loan, they are paid when those loans reach maturity. You are paid in the loan token: the vault lends only into markets that auto-sell defaulted collateral in the next maturity's rounds; any small part that does not sell is claimable by share.</p>
          {me && me.pendingRedeem > 0n && <StatusPill tone="neutral">Withdrawal requested · payable after {ended ? "the next roll" : <DateTime ts={v.targetExpiry} />}.</StatusPill>}
          {me && me.claimAssets > 0n && (
            <Button variant="secondary" size="md" block loading={tx.busy} onClick={() => void collect("assets")}>
              Withdraw {fmtToken(me.claimAssets, R)}
            </Button>
          )}
          {me && me.assetCredits.length > 0 && (
            <StatusPill tone="neutral" action={<Button size="sm" variant="secondary" loading={tx.busy} onClick={() => void collect("credits")}>Collect</Button>}>
              Also yours: {me.assetCredits.map((c) => fmtToken(c.amount, tokenOf(tokens, c.token as Address))).join(" and ")} of collateral from borrowers who didn&apos;t repay.
            </StatusPill>
          )}
        </div>
      )}
      <div className="space-y-2">
        <TxErrorLine error={tx.lastError} />
        <WalletAction>
          <Button variant="primary" size="lg" block disabled={!can || tx.busy} loading={tx.busy} onClick={() => void (tab === "deposit" ? deposit() : request())} data-testid="vault-button">
            {stageLabel(tx.steps, label)}
          </Button>
        </WalletAction>
        <StepsLine steps={tx.steps} labels={tab === "deposit" ? reviewSteps({ payNative: pw.native, needsApprove: allowance !== undefined && amt > 0n && allowance < amt, payToken: P }, quote.symbol, "Deposit") : undefined} />
      </div>
      <DetailRows
        rows={[
          { k: "Fees", v: "No management fee", hint: "the protocol only shares in interest that is repaid" },
          { k: "Rule", v: vaultLevel(v) === "lower" ? "Lower buy-back price" : "Higher buy-back price", hint: `≤ ${v.capBps / 100}% of idle funds per round, established markets only` },
          { k: "Worst case", v: `${asset?.symbol ?? "Collateral"} instead of ${shown.symbol}`, hint: "for the part lent to borrowers who don't repay, at the agreed price" },
        ]}
      />
      <Disclosure title="How this vault works">
        <div className="space-y-2 text-body-sm" data-testid="vault-sentences">
          <p>{s1}</p>
          <p>{s2}</p>
          <p className="text-ink-2">{s3}</p>
        </div>
        <dl className="mt-4 space-y-3 text-body-sm" data-testid="vault-explainer">
          {vaultExplainer(v, shown.symbol, assetSym).map((x) => (
            <div key={x.k}>
              <dt className="font-medium text-ink">{x.k}</dt>
              <dd className="mt-0.5 text-ink-2">{x.v}</dd>
            </div>
          ))}
        </dl>
      </Disclosure>
      {v.assets[0] && <ProvideLiquidity marketId={marketId(v.assets[0], v.quote, v.kind)} pair={`${asset?.symbol ?? "…"} / ${quote.symbol}`} />}
      <Disclosure title="Details">
        <dl className="space-y-2 text-body-sm">
          <Detail k="On-chain symbol" v={<span className="mono">{v.symbol}</span>} />
          <Detail k="Address" v={<Addr address={v.address} />} />
          <Detail k="This period" v={<span className="num">{String(v.epoch)}</span>} />
          <Detail k="Period ends" v={ended ? "Ended; waiting for the roll" : <DateTime ts={v.targetExpiry} />} />
          <Detail
            k="Lending into"
            v={
              positions && positions.length > 0 ? (
                <span className="flex flex-col items-end gap-1">
                  {/* three live maturities at most, the same rule as the market lists */}
                  {[...positions]
                    .map((p) => ({ p, pool: pools.find((x) => x.id.toLowerCase() === p.poolId.toLowerCase()) }))
                    .filter(({ pool }) => (pool?.expiry ?? 0) > now)
                    .sort((a, b) => (a.pool?.expiry ?? 0) - (b.pool?.expiry ?? 0))
                    .slice(0, 3)
                    .map(({ p, pool }) => {
                    return (
                      <Link key={p.poolId} href={`/markets?pool=${p.poolId}`} className="link">
                        {pool ? <DateTime ts={pool.expiry} /> : "a market"}
                      </Link>
                    );
                    })}
                </span>
              ) : (
                "Nothing yet this period"
              )
            }
          />
        </dl>
      </Disclosure>
    </div>
  );
}

const Detail = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div className="flex items-start justify-between gap-4">
    <dt className="text-ink-2">{k}</dt>
    <dd className="text-right">{v}</dd>
  </div>
);
