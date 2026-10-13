"use client";

/**
 * Developers (More, FRONTEND_V3 IA v3.1 item 12): addresses, network settings, and the flash-loan developer reference.
 * Everything stated here mirrors contracts/src/Confluere.sol (flashLoan, flashFee, maxFlashLoan, flashFees).
 */
import Link from "next/link";
import { useMemo, useState } from "react";
import type { Address } from "viem";
import { chainById, deployments } from "@confluere/sdk";
import { useActiveChain } from "@/lib/activeChain";
import { onchainSymbol, tokenOf, useBlockTime, useGrid, useMaxFlashLoan, usePools, useTokens } from "@/lib/data";
import { fmtToken, fmtWait } from "@/lib/format";
import { priceDigits } from "@/lib/view";
import { Address as Addr, Card, SectionTitle } from "../ui";

const CALLBACK = 'keccak256("ERC3156FlashBorrower.onFlashLoan")';

const borrowerSol = (core: string) => `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC3156FlashBorrower} from "@openzeppelin/contracts/interfaces/IERC3156FlashBorrower.sol";
import {IERC3156FlashLender} from "@openzeppelin/contracts/interfaces/IERC3156FlashLender.sol";

contract Borrower is IERC3156FlashBorrower {
    IERC3156FlashLender public constant CORE = IERC3156FlashLender(${core});
    bytes32 private constant OK = keccak256("ERC3156FlashBorrower.onFlashLoan");

    error UntrustedLender();
    error UntrustedInitiator();

    function run(address token, uint256 amount, bytes calldata params) external {
        CORE.flashLoan(this, token, amount, params);
    }

    function onFlashLoan(address initiator, address token, uint256 amount, uint256 fee, bytes calldata params)
        external
        returns (bytes32)
    {
        if (msg.sender != address(CORE)) revert UntrustedLender();
        if (initiator != address(this)) revert UntrustedInitiator();

        // ... use \`amount\` of \`token\` here (arbitrage, collateral swap, self-liquidation elsewhere) ...
        params;

        // end the call holding amount + fee; the core pulls it with transferFrom
        IERC20(token).approve(address(CORE), amount + fee);
        return OK;
    }
}`;

const foundryTest = (core: string) => `// forge test --fork-url $RPC_URL --match-contract BorrowerTest -vvv
contract BorrowerTest is Test {
    IERC3156FlashLender constant CORE = IERC3156FlashLender(${core});

    function test_flashLoan() public {
        address token = vm.envAddress("TOKEN");
        uint256 amount = CORE.maxFlashLoan(token) / 2;
        uint256 fee = CORE.flashFee(token, amount);   // amount * 5 / 10_000, rounded down

        Borrower b = new Borrower();
        deal(token, address(b), fee);                 // the borrower must be able to pay the fee
        b.run(token, amount, "");

        assertEq(IERC20(token).balanceOf(address(b)), 0);
    }
}`;

const viemSnippet = (core: string) => `import { createPublicClient, http } from "viem";
import { confluereAbi } from "@confluere/sdk";

const core = "${core}";
const client = createPublicClient({ transport: http(process.env.RPC_URL) });

const [max, fee] = await Promise.all([
  client.readContract({ address: core, abi: confluereAbi, functionName: "maxFlashLoan", args: [token] }),
  client.readContract({ address: core, abi: confluereAbi, functionName: "flashFee", args: [token, amount] }),
]);

// start the loan through your contract (Borrower.run above) so that the
// initiator passed to onFlashLoan is the borrower itself
const logs = await client.getContractEvents({ address: core, abi: confluereAbi, eventName: "FlashLoan", fromBlock: "latest" });`;

const SNIPPETS = [
  { key: "sol", label: "Borrower.sol", code: borrowerSol },
  { key: "test", label: "Foundry test", code: foundryTest },
  { key: "viem", label: "viem", code: viemSnippet },
] as const;

const INTERFACE = `interface IERC3156FlashLender {
    function maxFlashLoan(address token) external view returns (uint256);
    function flashFee(address token, uint256 amount) external view returns (uint256);
    function flashLoan(IERC3156FlashBorrower receiver, address token, uint256 amount, bytes calldata data)
        external returns (bool);
}

interface IERC3156FlashBorrower {
    function onFlashLoan(address initiator, address token, uint256 amount, uint256 fee, bytes calldata data)
        external returns (bytes32);   // must return ${CALLBACK}
}

// Confluere extras
uint256 public constant FLASH_FEE_BPS = 5;                      // 0.05%
function flashFees(address token) external view returns (uint256); // cumulative fees collected
event FlashLoan(address indexed receiver, address indexed token, uint256 amount, uint256 fee);
error InvalidParams();   // amount == 0 or amount > maxFlashLoan(token)
error FlashFailed();     // wrong callback return value, or balance short after repayment`;

export function DevelopersScreen() {
  const { chainId, deployment, meta } = useActiveChain();
  const pools = usePools().data ?? [];
  const addrs = useMemo(() => [...new Set(pools.flatMap((p) => [p.asset, p.quote]).map((a) => a.toLowerCase()))] as Address[], [pools]);
  const tokens = useTokens(addrs).data;
  const flash = useMaxFlashLoan(addrs).data;
  const grid = useGrid().data;
  const spb = useBlockTime().data;
  const [tab, setTab] = useState<(typeof SNIPPETS)[number]["key"]>("sol");
  if (!deployment) return <p className="text-ink-2">No deployment on this network.</p>;
  // flash loans lend the ERC-20 itself, so this page names tokens by their contract symbol (WHYPE, not HYPE)
  const sym = (a: string) => onchainSymbol(tokenOf(tokens, a)) ?? "…";
  const core = deployment.confluere;
  const ext = deployment as unknown as { libraries?: Record<string, Address> };
  const list: [string, Address | undefined][] = [
    ["Core", core],
    ...Object.entries(ext.libraries ?? {}).map(([k, v]) => [`Library ${k}`, v] as [string, Address]),
    ["Router", deployment.router],
    ["Vault factory", deployment.vaultFactory],
    ["ERC-20 wrapper factory", deployment.wrapperFactory],
    ["Seat registry", deployment.seatRegistry],
    ["Keeper receiver", deployment.keeperReceiver],
    ["Guardian", deployment.guardian],
  ];
  const peers = Object.values(deployments).filter((d) => d.chainId !== chainId && d.chainId !== 31337 && d.confluere.toLowerCase() === core.toLowerCase());
  const snippet = SNIPPETS.find((s) => s.key === tab) ?? SNIPPETS[0];
  return (
    <div className="space-y-12">
      <div>
        <h1 className="text-amount font-semibold leading-8">Developers</h1>
        <p className="mt-2 max-w-[70ch] text-body leading-6 text-ink-2">
          Contract addresses, network settings and the flash-loan reference. Every function that moves a market forward is permissionless; ABIs ship in{" "}
          <code className="mono">@confluere/sdk</code>. Want to try the interface with sample data?{" "}
          <Link href="/developers/demo" className="link">
            Open the demo
          </Link>
          .
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        <Card className="p-6 max-sm:p-4">
          <h2 className="text-title font-semibold">Addresses</h2>
          <dl className="mt-4 space-y-2.5 text-body-sm">
            {list.map(([k, v]) => (
              <div key={k} className="flex flex-wrap items-center justify-between gap-2">
                <dt className="text-ink-2">{k}</dt>
                <dd>{v ? <Addr address={v} /> : <span className="text-ink-3">—</span>}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-caption text-ink-3">
            {peers.length > 0 ? `Same core address on ${peers.map((d) => chainById(d.chainId)?.name ?? d.chainId).join(", ")}. ` : ""}ABIs ship in @confluere/sdk.
          </p>
        </Card>
        <Card className="p-6 max-sm:p-4">
          <h2 className="text-title font-semibold">Network settings</h2>
          <dl className="mt-4 space-y-2.5 text-body-sm">
            <Row k="Network" v={`${meta.label} (${chainId})`} />
            <Row k="Repayment window" v={`${deployment.windowBlocks.toLocaleString("en-US")} blocks${spb ? ` (≈ ${fmtWait(deployment.windowBlocks * spb)})` : ""}`} />
            <Row k="Block time, measured" v={spb ? `${spb.toFixed(2)} s` : "—"} />
            <Row k="A new term every" v={fmtWait(grid?.period ?? deployment.gridPeriod)} />
            <Row k="A round every" v={fmtWait(grid?.batchInterval ?? deployment.batchInterval)} />
            <Row k="Terms open at once" v={grid ? String(grid.maxExpiries) : "—"} />
            <Row k="Buy-back price digits" v={grid ? String(priceDigits(grid)) : "—"} />
          </dl>
        </Card>
      </div>

      <section data-testid="flash-docs" className="space-y-10">
        <div>
          <SectionTitle>Flash loans</SectionTitle>
          <p className="max-w-[75ch] text-body-sm leading-6 text-ink-2">
            The core contract is an <a className="link" href="https://eips.ethereum.org/EIPS/eip-3156" target="_blank" rel="noreferrer">ERC-3156</a> flash lender. Borrow any
            token it holds, use it inside one transaction, and return it plus a fee before the call ends. No collateral, no allowlist, no oracle; the only check is
            the token balance after your callback.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Fact k="Standard" v="ERC-3156" note="supportsInterface(IERC3156FlashLender) = true" />
          <Fact k="Fee" v="0.05%" note="5 bps of the amount, rounded down" />
          <Fact k="Lender" v={<Addr address={core} />} note="Same address on every network" />
        </div>

        <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
          <div>
            <h3 className="text-body font-semibold">Available now on {meta.label}</h3>
            <p className="mt-1 text-caption text-ink-3">maxFlashLoan(token) = the core&apos;s whole balance of that token.</p>
            <ul data-testid="flash-table" className="card mt-3 p-2">
              {addrs.length === 0 && <li className="px-1 py-2.5 text-body-sm text-ink-3">No tokens listed on this network yet.</li>}
              {addrs.map((a) => (
                <li key={a} className="row flex items-center justify-between gap-3 px-1 py-2.5 text-body-sm">
                  <span className="flex items-center gap-2">
                    <span className="font-medium">{sym(a)}</span>
                    <Addr address={a as Address} />
                  </span>
                  <span className="num">{fmtToken(flash?.[a], tokenOf(tokens, a))}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="text-body font-semibold">How a loan executes</h3>
            <ol className="mt-3 list-decimal space-y-2 pl-5 text-body-sm leading-6 text-ink-2">
              <li>
                You call <code className="mono">flashLoan(receiver, token, amount, data)</code>. It reverts with <code className="mono">InvalidParams</code> if{" "}
                <code className="mono">amount</code> is 0 or above <code className="mono">maxFlashLoan(token)</code>.
              </li>
              <li>
                The core computes <code className="mono">fee = amount × 5 / 10,000</code> and transfers <code className="mono">amount</code> to{" "}
                <code className="mono">receiver</code>.
              </li>
              <li>
                It calls <code className="mono">receiver.onFlashLoan(msg.sender, token, amount, fee, data)</code>; the first argument is the account that started the
                loan. The callback must return <code className="mono">{CALLBACK}</code>, otherwise <code className="mono">FlashFailed</code>.
              </li>
              <li>
                The core pulls <code className="mono">amount + fee</code> from <code className="mono">receiver</code> with <code className="mono">transferFrom</code>, so
                approve the core for that sum inside the callback.
              </li>
              <li>
                It checks that its balance is at least the starting balance plus the fee (<code className="mono">FlashFailed</code> otherwise), credits the fee to the
                treasury&apos;s withdrawable balance, adds it to <code className="mono">flashFees(token)</code> and emits <code className="mono">FlashLoan</code>.
              </li>
            </ol>
          </div>
        </div>

        <div>
          <h3 className="text-body font-semibold">Interface</h3>
          <Code code={INTERFACE} />
        </div>

        <div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-body font-semibold">Examples</h3>
            <div role="tablist" className="inline-flex rounded-[var(--radius-control)] bg-well p-1">
              {SNIPPETS.map((s) => (
                <button
                  key={s.key}
                  role="tab"
                  aria-selected={tab === s.key}
                  onClick={() => setTab(s.key)}
                  className={`rounded-[var(--radius-control)] px-3 py-1.5 text-caption font-medium ${tab === s.key ? "bg-surface text-ink shadow-sm" : "text-ink-2 hover:text-ink"}`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <Code code={snippet.code(core)} />
        </div>

        <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
          <div>
            <h3 className="text-body font-semibold">Security checklist</h3>
            <ul className="mt-3 list-disc space-y-2 pl-5 text-body-sm leading-6 text-ink-2">
              <li>
                Check <code className="mono">msg.sender == core</code> in <code className="mono">onFlashLoan</code>; anyone can call your callback directly.
              </li>
              <li>
                Check <code className="mono">initiator</code>. Anyone can start a loan that names your contract as receiver; if your callback acts on stored approvals or
                balances, accept only loans you started.
              </li>
              <li>
                Approve exactly <code className="mono">amount + fee</code> and hold that much when the callback returns, or the pull reverts.
              </li>
              <li>
                Every state-changing function of the core is guarded by one reentrancy lock, so inside the callback you cannot place orders, repay, withdraw or take a
                nested flash loan from the core. Use the funds elsewhere, or bundle core actions before or after the loan in your own contract.
              </li>
              <li>
                Tokens in pools are plain ERC-20s (rebasing and dividend tokens enter only through a wrapper), so the amount you receive is the amount you asked for.
              </li>
            </ul>
          </div>
          <div>
            <h3 className="text-body font-semibold">Fees, limits and errors</h3>
            <dl className="mt-3 space-y-2.5 text-body-sm">
              <Row k="Fee formula" v="amount × 5 / 10,000 (floor)" />
              <Row k="Fee on amounts below 2,000 base units" v="0" />
              <Row k="Tokens per call" v="1" />
              <Row k="Maximum" v="core balance of the token" />
              <Row k="Paused pools" v="no effect on flash loans" />
              <Row k="Fee recipient" v="treasury (pull withdrawal)" />
            </dl>
            <ul className="mt-4 space-y-1.5 text-caption leading-5 text-ink-2">
              <li>
                <code className="mono">InvalidParams()</code>: amount is 0 or above the available balance.
              </li>
              <li>
                <code className="mono">FlashFailed()</code>: the callback returned something else, or the balance is short after repayment.
              </li>
              <li>
                <code className="mono">SafeERC20FailedOperation(token)</code>: the pull failed, usually a missing approval or balance.
              </li>
              <li>
                <code className="mono">ReentrancyGuardReentrantCall()</code>: the callback called back into the core.
              </li>
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}

function Code({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative mt-3">
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="absolute right-2 top-2 rounded-[var(--radius-control)] bg-surface px-2 py-1 text-label text-ink-2 hover:text-ink"
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <pre className="mono overflow-x-auto rounded-[var(--radius-control)] bg-well p-4 pr-16 text-caption leading-5 text-ink">{code}</pre>
    </div>
  );
}

const Fact = ({ k, v, note }: { k: string; v: React.ReactNode; note: string }) => (
  <Card className="p-4">
    <div className="text-caption text-ink-3">{k}</div>
    <div className="mt-1 text-title font-semibold">{v}</div>
    <div className="mt-1 text-caption text-ink-3">{note}</div>
  </Card>
);

const Row = ({ k, v }: { k: string; v: string }) => (
  <div className="flex flex-wrap justify-between gap-3">
    <dt className="text-ink-2">{k}</dt>
    <dd className="num text-right">{v}</dd>
  </div>
);
