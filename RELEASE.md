# Release status

Selected architecture: **ZeroDev Kernel + RAILGUN**. Package candidate:
`@cloakedxyz/puddle@0.1.0-rc.1`, unpublished and unaudited.

## Correction to previous evidence

The 4 November 2026 live Arbitrum RAILGUN test used the superseded custom receiving
contracts. It confirmed that older deposit and late-fund recovery path only.
It was not a ZeroDev test and does not validate this release. The earlier Kernel
pilot targeted Privacy Pools v2, not RAILGUN. Both facts must remain distinct.
The superseded contracts, experiments and deployment manifests have been removed.

## Current implementation

- Unmodified pinned Kernel v3.3 account, factory and ECDSA owner validator.
- One RAILGUN executor module: fixed encrypted recipient/fee parties, variable amount
  quotes, immutable gas ceiling, atomic fees, approval cleanup and single-use settlement.
- Browser/Node SDK that reconstructs account initialization and checks code, ownership,
  installed terms and recovery from saved data.
- SDK-driven receiving/recovery interface and disposable localhost demo.
- Optional Relay quote adapter; production bridge routes are disabled.
- Optional persistent operator worker for Arbitrum WETH; the automatic local demo
  uses the same module and browser flow with disposable wrapped-native funds.

## Verified after migration — 4 November 2026

- A fresh checkout installed public dependencies, fetched pinned sources and passed
  `FOUNDRY_PROFILE=ci npm run check`: 28 tests, including 2,048 runs of each Solidity
  fuzz test, strict types, real protocol integration, browser and public-site checks.
- The intended disposable recipient decrypted the Kernel-to-RAILGUN note using the
  official engine. The browser completed funding, deposit and recovery after reload.
- Recovery covers undeployed accounts, expired quotes, excess/wrong/late assets,
  module removal and a contract-wallet owner. Pool upgrades block deposits while
  leaving owner recovery available.
- An isolated Arbitrum fork at block **521261161** used the actual deployed ZeroDev
  factory and implementation, the live WETH/RAILGUN route, and locally deployed
  validator/module. Deposit, intended-note decryption, late-fund recovery and
  undeployed-account recovery passed. No production transactions were sent.
- The packed SDK installed, type-checked and bundled in a separate consumer project;
  its runnable example and shipped artifacts passed. Its runtime lockfile audit
  reported zero known advisories. The development/test dependency findings remain
  documented in SECURITY.md.
- Gitleaks v8.30.1 scanned current candidate sources and Git history. Reviewed matches
  were public token addresses, artifact checksums and filenames; no credentials were
  identified. This is a scoped scan, not a guarantee against every kind of secret.
- The read-only live planner simulated ten exact transactions on an isolated
  Arbitrum fork, using the selected recovery owner and encrypted recipient. It covers
  the two shared deployments, owner recovery before shielding, the RAILGUN deposit
  and late-fund recovery. The proposed native spending cap is 0.00031 ETH; the plan
  reserves 0.000308225 ETH at its maximum gas limits and fee caps. Private plan and
  recovery files stay outside version control. No live approval or execution is implied.
- The private pilot runner passed a second isolated-fork rehearsal: wrong hashes,
  caps, wallets and altered transfer instructions were rejected; interruption after
  recording a transaction hash resumed without duplication; a completed rerun sent
  no transactions. Exact encrypted-note and both recovery checks passed. This does
  not establish live execution or recipient-wallet discovery.
- Browser recovery also passed after module removal and a simulated pool upgrade,
  including deploying a funded account from its saved file. Used accounts and
  restored recovery files no longer expose new-funding instructions. Funded quotes
  refresh their expiry while retaining the same account and recipient.
- Fresh read-only Base WETH → Arbitrum WETH quotes addressed the planned Kernel
  account. The 0.0001 WETH sample failed the 2% bridge shortfall policy; 0.001 and
  0.01 WETH samples passed. No bridge transfer, refund or recovery ownership has
  been proven. Across's deposit-address option was assessed as an alternative;
  see [bridge scope](docs/bridges.md).
- Authenticated Relay quotes succeeded using a server-side API key. Enabled routes
  now require that key; it is excluded from the browser, source and recovery files.
- Automatic worker tests cover persistence before broadcast, uncertain broadcast
  recovery, confirmed-block reorganization, one operator per queue, fixed fee
  parties, per-transaction/cumulative native budgets and independent owner recovery
  when a deposit is too expensive. Confirmed reservations survive restarts.
- The automatic browser demo saved recovery before registration and funding,
  received an ordinary transfer and shielded into real local RAILGUN without a
  recipient wallet connection or manual relay action. This is local evidence only.
- The website build includes the selected architecture, receiving/recovery guides
  and an SDK API reference checked against every public export. Desktop, dark-mode
  and mobile layouts passed browser checks. Legacy protocol-guide redirects are
  configured to point to the selected architecture.
- A configured static receiving build used a direct RPC without a Puddle backend.
  In the browser, a separate operator session restored the saved file, prepared a
  fresh manual quote and shielded the funded account into real local RAILGUN. The
  intended recipient decrypted the note. Private input fields were excluded from
  published configuration. Live receiving still requires the approved deployments.
- The final clean Ubuntu checkout passed all 35 checks and the separate SDK package
  consumer installation in [GitHub Actions](https://github.com/cloakedxyz/clkd-puddle/actions/runs/41908723240).
  The source migration merged through [PR #1](https://github.com/cloakedxyz/clkd-puddle/pull/1).
  The updated [website docs](https://puddle.link/docs/) and [API reference](https://puddle.link/docs/api/)
  are published. Live receiving remains disabled pending the new deployed route.

## Outstanding before public funds

1. Confirm screening and private spend readiness on the new live route. Discovery
   and owner recovery are confirmed; private spending has not been tested.
2. Validate automatic WETH relaying on the approved live route and review operating
   controls, monitoring, pricing buffers and deployment before a public service.
3. Test a funded bridge route, refunds and failure recovery before enabling it.
4. Independently review the exact module, browser note encoder, dependencies and
   service; resolve findings and finalize namespace/tag before publication.

## Live ZeroDev pilot — 4 November 2026

The explicitly approved ten-transaction Arbitrum plan completed with a native debit
of **0.000178924348548002 ETH**, below its **0.00031 ETH** cap. Network fees were
0.000078924348548 ETH. It used the stock Kernel factory and implementation above,
a new standard validator and the current restricted RAILGUN executor.

- The counterfactual account's owner recovered a small transfer before shielding.
- The Kernel deposit emitted the exact intended encrypted recipient, token and value.
  The recipient's RAILGUN wallet independently discovered **0.00007471275 WETH**
  (displayed as ETH). Screening remains pending in the wallet's standby period.
- The account ended with zero token balance and zero pool allowance; its deposit
  action was marked spent. A later transfer was recovered by the same owner.
- Native and token balances reconciled with the receipts and charged fees. Private
  approval, recipient, recovery file and transaction journal remain outside Git.
- Follow-up SDK verification now pins the WETH proxy implementation as well as the
  pool implementation. Previously saved recovery files remain readable and owner
  recovery remains available without those deposit checks. No contract changed.
- Sourcify matched the creation and runtime code for the deployed
  [standard validator](https://repo.sourcify.dev/42161/0xDb8D974998Ee6918D5CDC9E09eB3BEC31DFB0d95)
  and [RAILGUN executor](https://repo.sourcify.dev/42161/0x107784Ffa2cAdEE9f5Fa3C9c607C09A842eBE589).
  Source verification establishes a code match; it is not a security audit.
- After the token pin and website changes, all 36 local checks passed, with one
  deployment-publication check skipped because no public receiving release is
  enabled. A fresh Arbitrum fork at block **521291782** and an installed SDK package
  consumer also passed. The package runtime audit still reports zero known advisories.
- The manual static site built against the real deployed route, with matching source
  and runtime hashes. A separate hosting-checkout test used no compiler cache or
  prebuilt SDK and completed the manual deposit flow on a disposable local chain.

The website/docs update is published; public receiving remains disabled. A manual
static receiving build is being checked against the deployed route. Automatic live
operation, funded bridging, independent security review and npm publication remain
outstanding.
See [release preparation](docs/releasing.md).
