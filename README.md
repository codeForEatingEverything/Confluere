<p align="center">
  <img src="apps/web/src/app/icon.svg" alt="Confluere" width="72" height="64" />
</p>

<h1 align="center">Confluere</h1>

<p align="center"><strong>Borrow and lend with no oracle, no intermediary, no MEV and no slippage.</strong></p>

<p align="center">
  <a href="https://soliditylang.org"><img alt="Solidity" src="https://img.shields.io/badge/Solidity-0.8.37-363636?logo=solidity&logoColor=white" /></a>
  <a href="https://getfoundry.sh"><img alt="Built with Foundry" src="https://img.shields.io/badge/Built%20with-Foundry-FFDB1C" /></a>
  <a href="https://nextjs.org"><img alt="Next.js" src="https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white" /></a>
  <a href="https://www.typescriptlang.org"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&logoColor=white" /></a>
  <a href="https://viem.sh"><img alt="viem" src="https://img.shields.io/badge/viem%20%2B%20wagmi-2%20%2F%203-1E1E1E" /></a>
  <a href="#license"><img alt="License" src="https://img.shields.io/badge/license-BUSL--1.1%20%2F%20MIT-blue" /></a>
</p>

<p align="center">
  <a href="https://github.com/codeForEatingEverything/Confluere/actions/workflows/contracts.yml"><img alt="contracts" src="https://github.com/codeForEatingEverything/Confluere/actions/workflows/contracts.yml/badge.svg" /></a>
  <a href="https://github.com/codeForEatingEverything/Confluere/actions/workflows/web.yml"><img alt="offchain" src="https://github.com/codeForEatingEverything/Confluere/actions/workflows/web.yml/badge.svg" /></a>
  <img alt="Monad Testnet" src="https://img.shields.io/badge/Monad-Testnet-836EF9" />
  <img alt="HyperEVM Testnet" src="https://img.shields.io/badge/HyperEVM-Testnet-50D2C1" />
  <img alt="Status" src="https://img.shields.io/badge/status-beta-orange" />
  <img alt="Audit" src="https://img.shields.io/badge/audit-internal%20only-lightgrey" />
</p>

Confluere is an **outright repo** lending protocol. A borrower sells tokens for cash today and keeps the right to buy them back at a fixed price by a fixed date. A lender buys that position and is paid the buy-back price at maturity, or keeps the tokens if the borrower walks away. No price feed, no liquidation, no curator in the middle: the margin goes back to the users.

> **Status: beta on testnets.** Live on Monad Testnet and HyperEVM Testnet with the same contracts at the same addresses. Test tokens have no value. Internal audit only; no external audit yet.

---

## Background -- Why Confluere exists

- **Intermediary problems.** Today's lending runs through a long chain of middlemen: curators, centralized exchanges, middleware and more. Users' actual earnings are split ex ante across this coalition, and users usually cannot see the split or the risk they are carrying. The information and the risk are both asymmetric.
- **Rigid structure.** DeFi lending today is built on the *pledged* repo: you lock collateral and borrow against it. That design needs over-collateralization and large haircuts, which makes lending capital-inefficient. It also needs oracles, liquidators and deep enough liquidity to sell collateral in a crash, and every one of those dependencies compounds the risk.
- **Unfriendly to average users.** Lending protocols are either rigid or verbose. The so-called decentralized code often wraps a complicated structure that only institutions and professionals can use well. Many protocols outsource risk management to third parties (curators, for example), which lowers the user's return and makes the experience harder to understand.

## Intro of Confluere -- A new lending primitive

To solve these problems, Confluere brings a new primitive to DeFi lending.

Confluere is an **Outright Repo** lending protocol. In an outright repo, ownership really changes hands: the borrower *sells* the asset and holds a right to repurchase it, instead of pledging it as collateral. This removes the reasons a lending protocol needs an oracle, a liquidator or a curator, closes the information gap that intermediaries live on, and gives users a structure they can understand at a glance.

### Advantages

- **Oracle-free.** Settlement compares token amounts and block numbers only. No price feed can be manipulated, go stale or trigger a sale.
- **No liquidation.** Nothing watches your position. Whatever the market does before maturity, nobody can force a sale.
- **No intermediary.** Borrowers and lenders meet in one immutable contract. No curator picks your risk, no liquidator profits from your position, no owner can change the rules.
- **Anti-MEV.** Orders gather for a round and fill together at one uniform price, so there is no execution order to front-run or sandwich.
- **No slippage.** Every order carries the worst price it accepts and never fills beyond it. If a round's price is worse, the order waits or comes back to you.
- **Fixed rate, fixed date.** The rate is set when your order fills and does not move until maturity.
- **Various asset support.** Anyone can open a market for any ERC-20 pair; rebasing and dividend tokens enter through a wrapper.

What's most important, **we give the margin back to the users!**

---

## How it works

Every market is defined by an asset, a loan token, a maturity, a buy-back price and a repayment style (repay any time, or at maturity only). A loan in that market is split into two transferable position tokens:

| Token | Who holds it | What it does |
|---|---|---|
| **C** -- lender token | The lender | At maturity, pays the buy-back price per unit if the borrower buys back, otherwise 1 unit of the asset. |
| **R** -- buy-back right | The borrower | Lets its holder pay the buy-back price and take 1 unit of the asset back until the repayment window ends. Worthless after. |

Together, 1 C and 1 R come to 1 unit of the asset at maturity.

A loan from start to end:

1. **Today.** The borrower sells the asset into the market at the next round's price and receives the loan token now, plus R. The lender's funds buy C at the same uniform price.
2. **Until maturity.** Nothing can force a sale. No price feed watches the position and the market price of the asset does not matter.
3. **By the deadline.** The borrower repays the fixed amount and takes the asset back, or does not: they keep the cash, and the lenders keep the asset. No penalty, nothing else happens.

Prices are discovered in **batch auctions**: an on-chain order book per market clears every round at one uniform price for everyone in it. C and R can also be traded with other holders before maturity, instantly or at your own price.

## Products

- **Borrow.** Sell an asset for cash with a fixed buy-back price and date. The router picks the market and maturity; you can choose both.
- **Earn.** Vaults that lend for you by a rule fixed at deployment, only into established markets that have already run cleanly for several maturities. There is no management fee: the protocol takes a share only of interest that is actually repaid.
- **Loop.** Borrow the coin against its staked version, stake it again and repeat, all inside the protocol, for leveraged staking with no liquidation.
- **LP.** Each market has one LP slot, a Harberger-taxed seat. The LP quotes the market every round and earns 35% of the market's protocol income plus the interest on its own fills, pays a 15% yearly tax on its self-declared price, and can be bought out at that price at any time.
- **Markets.** The professional view: order books, rounds, buy-back prices, vaults and LP slots. Anyone can create a market.
- **Flash loans.** The core is an ERC-3156 flash lender with a 0.05% fee.

Native coins are supported directly: HYPE on HyperEVM and MON on Monad can be paid in directly; the wrap is one step inside the same button flow.

## Design principles

These constraints are part of the protocol's identity, not implementation details:

1. **Settlement never reads a price.** No oracle, no DEX call, no TWAP inside the core contract. Reference prices exist only in the interface, labelled as such.
2. **Pools hold real tokens.** Funds are escrowed when an order is placed; clearing is a pure ledger operation.
3. **One immutable core.** A single singleton with no owner, no upgrade and no `selfdestruct`. The only privilege is a guardian that may pause a *new*, not yet established market for at most 7 days at a time. It cannot move funds.
4. **Everything is permissionless.** Settling a round, maturing a pool and closing a repayment window can be done by anyone. The keeper is a convenience, not a dependency.
5. **Pull, never push.** Refunds and proceeds wait in the contract until their owner withdraws them.
6. **Fees from the spread only.** The protocol takes 10%, 12.5% or 15% (set per market) of the interest a borrower actually repays, and nothing on a default.

## Architecture

| Component | Description |
|---|---|
| `contracts/` | The core singleton (order books, batch clearing, repayment windows, ERC-6909 position ledger, flash loans) and its periphery: Router, Vaults and VaultFactory, ERC-20 wrappers for C and R, the LP seat registry, the position market for trading C and R, the Guardian and the Chainlink CRE keeper receiver. Written in Solidity with Foundry. |
| `apps/web` | The Next.js interface: Borrow, Earn, Loop, LP, Markets and Portfolio, plus a demo mode that runs the same app on sample data. |
| `packages/sdk` | Typed ABIs, addresses, position ids and settlement math that mirror the contracts. |
| `services/keeper` | A polling keeper that settles rounds, matures pools and closes windows. `services/keeper-cre` runs the same job as a Chainlink CRE workflow. |
| `services/bootstrap-mm` | A rule-bound bootstrap market maker for new markets. |

## Deployments

Same bytecode at the same CREATE2 addresses on both networks.

| Contract | Monad Testnet (10143) and HyperEVM Testnet (998) |
|---|---|
| Confluere (core) | `0x7E023810Db3a9b894cdfA623AaA3dcE4ebccb1f7` |
| Router | `0xC21934727Fe7C3EeFb0a2452a67d0b79891DCe56` |
| VaultFactory | `0x3f8a54B7c4bEDce52e4B3D6B5cfD8Cc4984D594d` |
| C / R wrapper factory | `0xECE60ddCA37b3a649a294D834886fb680294D118` |
| PositionMarket | `0x545FE5379eDe03DC1Fd83c0Dc5376Def3D0a2359` |
| KeeperReceiver | `0x6eD0BbB98B9480462DcA280E91489e2de3bE53C5` |

Seat registries, vaults and every other address are listed per network in [`deployments/`](deployments/). Nothing is deployed on a mainnet.

## Security

- Contracts are immutable: no owner, no upgrade, no admin keys over user funds.
- The guardian role is an M-of-N multisig contract. On the testnets it is held by a single team key.
- Internal audit, October 2026, with a regression test for every finding (`contracts/test/audit`). The core is also covered by unit, fuzz and invariant tests, Halmos and SMT checks, Slither and Medusa.
- **No external audit yet.** Do not use with real funds.

## Built with

- [Solidity](https://soliditylang.org) 0.8.37 and [Foundry](https://getfoundry.sh) for the contracts, with [OpenZeppelin](https://github.com/OpenZeppelin/openzeppelin-contracts) and [Solady](https://github.com/Vectorized/solady).
- [Halmos](https://github.com/a16z/halmos), [Slither](https://github.com/crytic/slither) and [Medusa](https://github.com/crytic/medusa) for verification and analysis.
- [Next.js](https://nextjs.org), [TypeScript](https://www.typescriptlang.org), [viem](https://viem.sh) and [wagmi](https://wagmi.sh) for the app and SDK.
- [Chainlink CRE](https://chain.link) for the keeper workflow; [Kuru](https://kuru.io) and HyperCore for display-only reference prices.

## License

Each contract file carries its own SPDX header: the core and its storage and logic libraries are `BUSL-1.1`, the other libraries and the periphery are `MIT`. A repository-wide license file will be added before mainnet.
