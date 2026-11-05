# Release status

Selected architecture: **ZeroDev Kernel + RAILGUN**. SDK version
`@cloakedxyz/puddle@0.1.0-rc.1` is distributed as a repository build.
Security review status is recorded in [SECURITY.md](SECURITY.md).

An earlier live RAILGUN test used the retired custom contracts; it does not validate
this implementation. The live ZeroDev evidence below comes from a separate test.

## Current implementation

- Unmodified pinned Kernel v3.3 account, factory and ECDSA owner validator.
- One restricted RAILGUN executor: fixed encrypted recipient and fee parties,
  variable amount quotes, immutable gas ceiling, atomic fees and single-use settlement.
- Browser/Node SDK with public recipient preparation, deployment and owner checks,
  versioned recovery files and a runnable integration example.
- One receiving/recovery interface, public API reference and disposable localhost demo.
- Optional persistent operator worker with local restart and budget coverage.
- Optional Relay quote adapter; live bridging is disabled.

## Verification — 4 November 2026

The [clean Ubuntu checkout](https://github.com/cloakedxyz/clkd-puddle/actions/runs/41917818553)
passed all **37 checks**: 27 Node tests, four Solidity tests, two browser flows and
four website checks. Each Solidity fuzz test ran 2,048 cases. The same job installed,
type-checked and bundled the packed SDK in a separate consumer project.

- The official RAILGUN engine decrypted both browser ciphertext components for
  independent disposable recipients. Local browser flows funded, shielded and
  recovered through the real Kernel and RAILGUN contracts.
- Recovery covers undeployed accounts, expired quotes, excess/wrong/late assets,
  module removal and a contract-wallet owner. Pool and WETH implementation changes
  block deposits while saved owner recovery remains usable, including earlier files.
- An isolated Arbitrum fork at block **521291782** passed using the deployed stock
  Kernel factory/implementation and live WETH/pool, with local validator/module
  deployments. Fork transactions never reached the public chain.
- The website deployment bundle matched independently compiled SDK runtime templates
  and source hashes. A hosting checkout without a compiler cache or prebuilt SDK
  completed the manual browser deposit on a disposable chain.
- The package runtime dependency audit reported zero known advisories. Development
  findings and the limits of build checks remain in [SECURITY.md](SECURITY.md).
- Candidate source, Git history, package contents and static output were checked for
  credentials and private pilot data. Reviewed scanner matches were public token
  addresses; no credentials were identified. This is a scoped check, not a guarantee.

## Live ZeroDev pilot

The approved ten-transaction Arbitrum plan completed with a native debit of
**0.000178924348548002 ETH**, below its **0.00031 ETH** cap. Network fees were
0.000078924348548 ETH.

- The owner recovered a small transfer from the counterfactual account before shielding.
- The deposit emitted the exact intended encrypted recipient, token and value. The
  intended RAILGUN wallet independently discovered **0.00007471275 WETH** (displayed
  as ETH). The wallet subsequently marked this deposit **Synced** after screening.
- The account ended with zero token balance and pool allowance; its deposit action
  was marked spent. The same owner recovered a later transfer.
- Native and token balances reconciled with the receipts and charged fees. Private
  recipient, approval, recovery and transaction records remain outside Git.
- Sourcify matched creation and runtime code for the
  [standard validator](https://repo.sourcify.dev/42161/0xDb8D974998Ee6918D5CDC9E09eB3BEC31DFB0d95)
  and [RAILGUN executor](https://repo.sourcify.dev/42161/0x107784Ffa2cAdEE9f5Fa3C9c607C09A842eBE589).
  Source verification establishes a code match; it is not a security audit.

## Website and bridge scope

The [website](https://puddle.link) and [API reference](https://puddle.link/docs/api/)
are published. The receiving interface accepts 0.0001 WETH per address on
Arbitrum One. It saves recovery before revealing funding instructions and requires
arranging with the operator before funding. It has no hosted signer or automatic
service. Browser preparation against the real deployed route passed without signing
or funding another live account.

Authenticated Relay quotes passed for Base WETH → Arbitrum WETH. The 0.0001 WETH
sample failed the 2% bridge shortfall policy; 0.001 and 0.01 WETH samples passed.
These expired samples are not funding instructions.

A separate two-case rehearsal transferred tokens on local chain copies, simulated
solver delivery, then checked destination shielding and owner recovery after failure.
It did **not** prove Relay delivery, refunds or recorded source recovery ownership.
The approved live bridge test delivered 0.000985477626940850 WETH on Arbitrum
and shielded 0.000957093418940626 WETH to the intended private wallet. The Base
depository event recorded the selected recovery owner. The recipient wallet discovered
the new note and marked it **Synced** after screening. The separate refund case has
not been executed. Provider-assisted
bridge recovery is an accepted dependency; destination owner recovery remains independent
of Puddle. See [bridge scope](docs/bridges.md).

## Remaining gates

1. Complete the funded bridge refund case. Both the same-chain and bridged deposits
   are marked Synced in the recipient wallet; no private spending transaction has
   been sent.
2. Complete funded bridge success, refund and failure checks before enabling a route.
3. Independently review the exact executor, browser encoder, SDK and dependencies;
   resolve relevant findings before general availability.
4. Before an automatic service, validate the worker on the live route and review
   hosting, monitoring, budgets and realistic gas pricing.
5. Confirm npm namespace, version and tag, then publish only the inspected artifact
   and verify a fresh registry installation. No automatic publishing is configured.

See the [release checklist](docs/releasing.md).

## Token-independent receiving implementation

The repository adds `MultiAssetRailgunExecutor`, extending the same restricted
Kernel module to choose a token after funding. Native ETH is wrapped atomically;
other standard ERC-20s use the same fixed encrypted recipient and recovery owner.
The public website remains on its deployed WETH-only executor until the new module
is deployed and its route is reviewed.

Local protocol and browser checks cover ETH, 6- and 18-decimal tokens, tokens with no
return value, taxed/blocked token rollback, proxy implementation changes, one-time
settlement and independent recovery of other or late assets. New Solidity fuzz
checks cover amount/fee bounds, native wrapping and failed token operations. The
copyable token-independent integration module is checked against the installed SDK.

Token discovery does not establish safe token behavior. Unfamiliar tokens require
operator review; rebasing, lottery and taxed tokens are excluded. There is no generic
token-to-gas pricing service: the manual operator agrees to the quoted reimbursement.
The existing automatic WETH worker rejects multi-asset mode. A new deployment and a
bounded live rehearsal are still required before changing the public receiving route.
