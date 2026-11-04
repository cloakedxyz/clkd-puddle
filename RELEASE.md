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
  and mobile layouts passed browser checks. Old protocol-guide URLs redirect to
  the selected architecture.
- A configured static receiving build used a direct RPC without a Puddle backend.
  In the browser, a separate operator session restored the saved file, prepared a
  fresh manual quote and shielded the funded account into real local RAILGUN. The
  intended recipient decrypted the note. Private input fields were excluded from
  published configuration. Live receiving still requires the approved deployments.

## Outstanding before public funds

1. Obtain approval for and execute the bounded live ZeroDev + RAILGUN plan using the
   verified production factory/pool route and the current module build.
2. Confirm intended-wallet discovery, screening, private spending and owner recovery
   on that actual live route. Do not substitute the old pilot's receipts.
3. Validate automatic WETH relaying on the approved live route and review operating
   controls, monitoring, pricing buffers and deployment before a public service.
4. Test a funded bridge route, refunds and failure recovery before enabling it.
5. Independently review the exact module, browser note encoder, dependencies and
   service; resolve findings and finalize namespace/tag before publication.

No new live transactions, public deployment or npm publication have been performed
as part of this migration. See [release preparation](docs/releasing.md).
