---
showAskAi: false
outline: false
---

# Privacy Pools v1

**Coming soon to Puddle.**

Ordinary ETH or token transfer → Puddle receive address → recipient-owned v1 note.
Contracts, a client SDK, a manual-relay web demo and independent recovery are available for development.
**Unaudited; local and Sepolia testing only.**

## Preparing to receive

**Puddle's receiving page takes only public destination data.** RAILGUN supplies a
`0zk` address; Privacy Pools v1 supplies a single-use precommitment, the public hash
of wallet-derived deposit secrets. An Ethereum address alone is insufficient.
The receiving wallet owns the mnemonic and secrets. Puddle does not create accounts,
generate deposit secrets, or ask for private backups in its receiving page.

The integration code contains exactly these public fields:

```json
{
  "format": "privacy-pools-v1-receive",
  "version": 1,
  "chainId": "1",
  "entrypoint": "0x1111111111111111111111111111111111111111",
  "pool": "0x2222222222222222222222222222222222222222",
  "asset": "0x0000000000000000000000000000000000000000",
  "precommitment": "123456",
  "recovery": "0x3333333333333333333333333333333333333333"
}
```

These are illustrative addresses, not deployment configuration. Zero address means
native ETH in Puddle; the adapter translates it to v1's native asset identifier.
The format is a Puddle integration proposal, not an existing official PP export.
Cloaked's local test build exports it behind a team-only feature flag; the wallet
implementation lives in the separate Cloaked repository.

```ts
import { parseV1ReceiveCode, createV1ReceiveLink, prepareV1PublicReceive,
  relayDeposit, createPrivacyPoolsV1Adapter } from './client/index.ts';

// Receiving wallet: export ONLY the public code, after allocating a fresh deposit index.
const link = createV1ReceiveLink('https://puddle.link/receive', code);
// The request is in the URL fragment (#request=...), not the server request/query.

// Puddle: accept pasted JSON, a receive link, or its own /receive#request=... URL.
const receiveCode = parseV1ReceiveCode(pastedCodeOrLink);
const { deposit, recovery } = await prepareV1PublicReceive(provider,
  { chainId, factory, pool: entrypoint },
  { relayer, feeRecipient, token, amount, gasFee, deadline }, receiveCode);
// Save the public recovery file. Sender makes an ordinary transfer to deposit.address.
await relayDeposit(createPrivacyPoolsV1Adapter({ chainId, factory, pool: entrypoint }), deposit, relayerWallet);
```

The browser entry point is `client/index.ts`; `client/node.ts` additionally exports
the RAILGUN adapter, whose engine currently needs Node. `client/recovery.ts` is the
separate recipient-operated recovery interface. Low-level adapters remain in `protocols/`.

Each address fixes the asset, original asset pool, precommitment, recovery owner,
relayer and fee recipient. A new quote can change the amount while preserving those
terms. The receive-code parser rejects extra fields, including private secrets.
The receiving wallet includes its recovery address in the public code. Puddle uses
that address directly; the sender cannot override it when preparing the deposit.
Preparation checks the configured chain, entrypoint, asset pool, unused precommitment
and deposit quote. A receive link identifies a deposit; although non-secret, it can
still link browser activity to that deposit. Do not put it in analytics.

The exporting wallet must reserve a fresh deposit index, track pending exports and
avoid reusing them in its normal deposit flow. It must also discover/register the
external deposit so it appears in the user's balance. A code cannot be made reusable
by changing its amount. The recovery wallet should belong to the recipient; paying
does not automatically grant the sender refund rights. Initial funding is public.

## Local UI testing

Privacy Pools v1 is coming soon to the website. For development testing, start the
opt-in experiment with `PUDDLE_EXPERIMENTAL_V1=1 npm run dev`.
Choose Privacy Pools v1, paste a code for the demo's chain and pool, then choose the
matching ETH or USDC asset and amount. Save the recovery file before funding.
**Relay deposit manually** moves the funded balance into the pool. Before that,
**Recover test tokens** exercises receive-address recovery with the local test owner.
The page never generates or imports the wallet's deposit secrets. Pool recovery is
performed from the receiving wallet or the separate recovery tool.

The demo starts a fresh local chain and rejects codes for other chains or pools.
The browser tests use a separate wallet fixture built from the pinned official PP SDK.
Only its public code enters the Puddle page. The official SDK then restores the
resulting deposit from its mnemonic alone. This tests SDK compatibility, not the
live privacypools.com UI.

For Cloaked's Sepolia export, run `npm run dev:sepolia` and open
`http://127.0.0.1:5176`. Choose **Settings → Generate Puddle Code** in the feature-enabled
Cloaked test build, then paste its code into Puddle. This page supports Sepolia ETH
only and reads the current pool minimum. No wallet connection is needed to prepare
an address. The configured relay wallet performs manual relay; the designated
recovery wallet recovers funds. Save and share the public recovery file before funding.
Reloading that file restores receive-address recovery, not an expired relay quote.

The public deployment configuration is in `deployments/sepolia.json`. A real Sepolia
deposit was recognised by Cloaked and [publicly recovered to its fixed wallet](https://sepolia.etherscan.io/tx/0xc3db82807d800a8b7506002361169b0f8f5382792ce59e1ed2730df412db31a7).
Receive-address recovery is covered locally; a separate live test remains outstanding.
Cloaked's secure UI currently handles pool recovery only. These tests do not establish
production readiness.

Puddle deducts 0.1% plus the capped gas charge. V1 deducts its configured vetting fee
from the amount it receives. The pool creates the note with the remaining amount.
Pool fees and availability can change. Screening approval is still required for
normal private withdrawals; test-network approval does not guarantee acceptance on other networks.

## Two recovery paths

| Funds | Required | Result |
| --- | --- | --- |
| At the receive address | Puddle recovery file + recovery wallet | Deploy if necessary, then return the balance. No note secrets or pool availability required. |
| In the pool | Puddle recovery file + current private note backup + recovery wallet | Generate a proof locally; the receive contract calls the pool and forwards the returned amount to the fixed recovery wallet in one transaction. |

The standalone [recovery tool](/recovery) supports both paths, even if Puddle's API,
relayer and screening service are unavailable. A wallet connection, blockchain RPC
and transaction gas are still needed. Its build bundles the v1 emergency proof files
and checks their hashes before use; no secrets are uploaded and no CDN is required.

V1 requires the original depositor to call its emergency exit, called ragequit.
That depositor is the Puddle receive contract. Calling the pool directly from the
recovery wallet fails. The contract keeps the original pool address, so registry
removal and pool wind-down do not prevent this exit. No screening approval is needed.

The returned amount is forwarded only to the fixed recovery wallet. If forwarding
fails, the entire pool exit is reversed and can be retried. Existing excess funds at
the receive address stay separate. Pool recovery is public, and paid fees are not refunded.

## Backups and partial withdrawals

The Puddle recovery file contains configuration, not spending keys. The separate
v1 note backup **contains private spending secrets**: store it securely and never
send it to the service. This is Puddle's note JSON format, not an official-wallet
seed phrase or the official wallet's import format. Cloaked generates the recovery
proof inside its existing private wallet flow, so its users do not need to export
those secrets to Puddle. Other wallets need to export a current note backup or
generate the public recovery proof themselves.

A backup created before deposit contains the secrets and pool. Recovery discovers
the deposit's amount and label from onchain events. A starting block can shorten
the search without changing recovery rights.

After a normal partial withdrawal, the remaining note has new secrets. Save a new
backup with `createV1NoteBackup(chainId, pool, { value, label, nullifier, secret })`
using that current note. The original backup cannot spend the replacement note.
Losing the current secrets prevents pool recovery; the recovery wallet alone cannot
replace them. Puddle does not implement a full v1 private-withdrawal wallet.

Both locations can hold funds at once. Check the receive-address balance and pool
note separately. A deposit and recovery transaction can race; the first successful
transaction determines the location. Withdrawing funds from an unused address does
not cancel its ability to process a later payment. Each address deposits only once.

## Validation

```sh
npm run privacy-pools-v1:setup
npm run test:privacy-pools-v1
FOUNDRY_PROFILE=ci npm run test:contracts
```

The public upstream is pinned to `d494b63e79f33bb2b0c8ece6cdacdca465c3b884`.
Tests deploy its real contracts and verifiers on a temporary local chain and generate
real withdrawal and emergency-exit proofs from pinned ceremony artifacts. They cover
ETH and ERC-20 deposits, restored backups, partial withdrawals, rejected ETH payments,
repeat/invalid proofs, wrong owners, closed/removed pools, fee rollback and late funds.
A real-browser test loads saved files and executes both recovery paths using only
the static site and wallet RPC. Randomized contract tests check fund conservation
and eventual recovery across different action orders. Tests run in public CI.
Client tests receive a code from a separate upstream-SDK wallet, restore the real
deposit using its `AccountService`, and check that public exits remove the balance.
UI tests cover receive links, manual relay, reload, duplicate codes, both recovery
paths, and verify that the phrase and raw secrets never enter the receiving page or
its requests. The separate static recovery tool tests private-note import locally.

These checks do not establish production screening acceptance, the security of the
upstream ceremony or live deployments. Puddle has no upgrade authority; v1's entrypoint
has its own upgrade governance. This change also changes the shared contract build;
keep the matching recovery build for any previously deployed factory.
