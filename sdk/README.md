# Puddle SDK

Create receiving addresses, estimate fees and recover funds for RAILGUN deposits.
Version `0.1.0-rc.1` is distributed as a repository build.

Prepare an ordinary ERC-20 receiving account from a public RAILGUN address and
recovery owner. The SDK runs in browsers and Node 24.12+, without recipient keys,
setup signatures or the full wallet engine. Kernel supplies the account and factory;
Puddle's restricted module supplies settlement rules.

## Build and install

From the repository, after `npm ci --ignore-scripts` and `npm run setup`:

```sh
npm run build:sdk
npm pack ./sdk
```

Install the generated `@cloakedxyz/puddle` tarball and ethers v6 in your integration. Normal packing verifies build hashes;
rebuild after source edits. Do not bypass the guard with `--ignore-scripts` when packing.

## Prepare

```ts
import { prepareRailgunReceive } from "@cloakedxyz/puddle";
import artifacts from "@cloakedxyz/puddle/contracts" with { type: "json" };

const { deposit, recovery } = await prepareRailgunReceive(
  provider,
  reviewedDeployment,
  { recipient: publicRailgunAddress, recovery: owner, relayer, feeRecipient },
  { token, amount, gasFee, deadline },
  artifacts,
);
// Save recovery privately before displaying deposit.address for funding.
```

`Deployment` specifies chain ID, stock Kernel factory/implementation/validator,
Puddle executor, pool and asset (including their proxy implementation pins), immutable gas ceiling and code hashes. It is a trusted
application input, not data to accept from an untrusted API. `amount` and `gasFee`
are token base units; `deadline` is a Unix timestamp. Use bigint values.

`createRailgunAdapter(deployment)` exposes preparation and quote refresh. A quote
can change amount, expiry and gas reimbursement while preserving the account and
encrypted recipient. The relayer can charge up to the module's immutable gas ceiling;
an individual estimate is not an on-chain commitment to that exact charge. Show the
ceiling before funding. The service fee remains 0.1%.
`inspectDeposit` reads funding/use state. `relayDeposit` submits through the executor
using the bound relayer and returns the transaction immediately; `mined` waits for
confirmation. Confirmation is separate from recipient discovery and screening.

The runnable [example](examples/receive.mjs) reads a reviewed UI configuration and
public profile, saves recovery/quote files and prints the account only after saving:

```sh
node node_modules/@cloakedxyz/puddle/examples/receive.mjs --help
```

It signs nothing and sends no transactions. The profile contains only public
`recipient` and `recovery` fields. Configuration contains the deployment pins above,
`token`, `rpcUrl`, `decimals`, `relayer`, `feeRecipient`, `gasFee` and `maxAmount`.
Store profiles and generated files outside version control.

## Recovery

`parseRecoveryFile` strictly checks saved data and independently derives the account.
`inspectRecovery(provider, file, artifacts)` checks deployment and owner and reads its
balance. `recoveryTransaction(..., owner, asset, 'deploy')` returns the standard Kernel
factory call if undeployed; `'recover'` returns an owner-authorized Kernel transfer.
The recovery owner signs these ordinary wallet transactions. Contract owners must be
able to call Kernel directly; contract-wallet signature compatibility is a separate concern. Neither step needs the
Puddle operator or an active executor. Use the zero address to recover native currency.

The file contains encrypted note/public configuration, never private wallet keys or
arbitrary imported calldata. Keep it private. Already-shielded funds are controlled
by the RAILGUN wallet. Ownership/account upgrades invalidate the original assumptions
and are rejected by verification.

## Optional bridge adapter

`@cloakedxyz/puddle/relay` contains `relayFundingRequest`, `validateRelayFundingQuote`
and `minimumMatchingAssetOutput`. These build and check Relay quotes; they do not
submit transfers, track delivery or process refunds. Bridge recovery uses Relay’s
authorization; account recovery controls funds that have reached the Kernel address.

Original code is MIT; dependencies and built upstream contracts retain their own
licenses. See NOTICE and SECURITY.md. `npm run test:sdk-package` checks an actual
isolated installation, types, example and browser bundle from the repository.
