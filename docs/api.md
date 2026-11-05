# SDK API reference

`@cloakedxyz/puddle@0.1.0-rc.1` provides JavaScript modules for ethers v6, browsers
and Node 24.12+. This reference covers the SDK’s functions and types.

For the complete wallet integration sequence, see [Integrate Puddle](integrate.md).
These are SDK functions; there is no hosted Puddle REST service.

## Installation

Build the package from the repository. It is not published to npm.
Use Node 24.12+ and Foundry 1.7.1:

```sh
npm ci --ignore-scripts
npm run setup
npm run build:sdk
npm pack ./sdk
```

Install the generated tarball and ethers v6 in your application. The SDK runs in
browsers and Node without private recipient keys or the full wallet engine.
See the [runnable example](../sdk/examples/receive.mjs) for a complete integration.

## Token-independent receiving

These functions require `Deployment.multiAsset: true` and the matching
`@cloakedxyz/puddle/multi-asset-contracts` artifact. The public Arbitrum website
uses this multi-asset deployment. `npm run dev` runs the broader local flow.

- `prepareFlexibleReceive(provider, deployment, input, artifacts)` returns a
  `DepositRecord` and version-2 `RecoveryFile`, without a token or amount quote.
  Save recovery before displaying the receiving address.
- `discoverFunding(provider, record, options?)` returns `assets`, `unreadable` token
  addresses and `nextBlock`. It checks native balance and ERC-20 Transfer events
  against current balances. Scan at most 20,000 blocks per call in 1,000-block
  pages, retain token candidates, and persist the cursor. Supply known token
  addresses in `options.tokens` when event history is unavailable. NFT Transfer
  events are excluded. Unavailable balance reads remain available for explicit recovery.
- `readFundingAsset(provider, receivingAddress, tokenAddress)` reads a `FundingAsset`:
  balance, decimals, display symbol, code hash and standard proxy implementation pin.
  The zero address represents ETH. Token metadata is untrusted display information;
  missing decimals use `null` and amounts must be shown in base units.
- `quoteFunding(provider, record, funding, approval, gasFee = 0n)` prepares a quote
  from the observed amount, rejects RAILGUN-blocklisted tokens and rechecks token
  code pins. `TokenApproval` contains `{token, codeHash, implementation, standard: true}`
  from the operator/wallet's reviewed token policy. Discovery is not approval.

Exclude rebasing, lottery, taxed and other changing-balance tokens. A runtime hash,
metadata or a successful simulation does not prove that a token will never rebase.
Review unfamiliar tokens before approving them. Dynamic token proxy patterns outside
standard EIP-1967 require a separate review; the SDK cannot infer every upgrade mechanism.

The operator pays native gas. A token quote expresses reimbursement in that token's
base units, capped at 5% of the received amount. ETH/WETH also have the deployment's
absolute `maxGasFee` ceiling. The manual interface starts at zero reimbursement;
the operator must agree to subsidize gas or enter a fee before completion. There is
no general token-to-gas pricing service. The existing automatic worker rejects this mode.

ETH is wrapped into the pinned wrapped-native token inside the same atomic deposit.
One asset is deposited once per address. Choose explicitly when several assets arrive;
other and late assets remain recoverable. A failure rolls back wrapping, fees,
allowances and the spent flag. `recoveryTransaction` accepts the zero address for
ETH or an ERC-20 contract address, independently of deposit eligibility.

The multi-asset `RecoveryArtifacts` includes a compiled `previousExecutor` template
for owner recovery from earlier version-1 WETH accounts. It is accepted only in
recovery mode; new deposit preparation must match the selected executor exactly.

## Prepare a receive

For earlier WETH-only deployments, use the amount-quoted helper below. New integrations
use `prepareFlexibleReceive` above.

```ts
prepareRailgunReceive(provider, deployment, input, quote, artifacts);
// Promise<{ deposit: DepositExecution; recovery: RecoveryFile }>
```

Prepares encrypted instructions from the public RAILGUN address, derives the Kernel
address and checks the exact deployment, account and recovery configuration. Save
`recovery` privately before displaying `deposit.address` for funding. Signs nothing.

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
// Persist recovery before showing deposit.address.
```

`amount` and `gasFee` are bigint token base units. `deadline` is a bigint Unix
timestamp in seconds. The service fee is `amount / 1000n`, plus gas reimbursement
and the RAILGUN pool fee. The operator may change gas reimbursement up to the module
cap; display that cap before funding.

## Adapter and quotes

```ts
const adapter = createRailgunAdapter(deployment);
await adapter.prepare(provider, input); // DepositRecord
await adapter.quote(provider, record, quote); // DepositExecution
adapter.deployment; // frozen configuration
```

`prepare` derives a fresh account with encrypted recipient instructions.
`quote` refreshes amount, gas charge and expiry without changing account address,
recipient, recovery owner or fee parties. Preparation and quote checks send no transactions.
For the complete exact-build checks before funding, use `prepareFlexibleReceive` or the earlier `prepareRailgunReceive`, with its matching artifact.

## Inspect and verify

```ts
await inspectDeposit(adapter, deposit, provider);
// { deployed: boolean; spent: boolean; balance: bigint; ready: boolean }

await validateDeposit(adapter, record, provider); // void
await verifyDeployment(provider, deployment, artifacts); // void
await verifyAccount(provider, record); // boolean; checkExecutor defaults to true
```

`ready` means unused and sufficiently funded for that quote; it does not establish
an unexpired quote, wallet discovery or screening. `relayDeposit` checks expiry again.
`verifyAccount` returns false for an undeployed account and rejects changed ownership,
implementation or installed terms. Checks reject mismatched chains, pins and configuration.

`verifyDeployment` accepts a fourth `recoveryOnly` argument, default false. Recovery
mode skips pool/token availability checks while preserving the Kernel/module checks.
`inspectRecovery` selects that mode for you. Independently reviewed artifacts and
deployment pins must be trusted application inputs, not supplied by an untrusted API.

## Manual relay

```ts
const transaction = await relayDeposit(adapter, deposit, relayerSigner);
const receipt = await mined(Promise.resolve(transaction));
```

The signer must be connected to the bound relayer address. The function checks
funding, one-time use and quote terms, then submits only the complete restricted
Kernel-to-RAILGUN action. `relayDeposit` returns the submitted transaction immediately;
`mined` waits for a successful receipt. Both use ethers transaction types.

The relayer pays native transaction gas and receives the configured token
reimbursement. A receipt proves execution only. Check recipient-wallet discovery,
screening and private spend readiness separately.

## Recovery files

```ts
createRecoveryFile(record); // RecoveryFile
parseRecoveryFile(jsonText); // RecoveryFile
recoveryRecord(file); // DepositRecord
await inspectRecovery(provider, file, artifacts); // asset defaults to file.asset
// { deployed: boolean; balance: bigint; address: string; recovery: string }

await recoveryTransaction(provider, file, artifacts, owner);
// ethers TransactionRequest; defaults to file.asset and action "recover"
// Signs and sends nothing.

await recoveryTransaction(provider, file, artifacts, owner, file.asset, "deploy");
// Explicit asset and action for an undeployed account.
```

`parseRecoveryFile` strictly validates fields, rejects extra fields and files over
16 KiB, and independently reconstructs the account address. Keep saved files private.
`action` is `"deploy"` or `"recover"`. Deploy an undeployed account first, then recover.
The owner signs both transactions. Use the zero asset address for native currency.
See the complete [recovery example](recovery.md).

## Recipient helpers

```ts
decodeRailgunAddress(publicAddress, optionalChainId); // RailgunRecipient
await prepareRailgunRecipient(publicAddress, destinationChainId); // hex string
```

The decoder checks the address checksum, field limits and viewing-key curve point.
Preparation checks any address chain restriction, creates fresh encrypted note
instructions and returns the 160-byte encoded recipient. These functions accept
public recipient data only. Fresh preparation must not reuse note randomness.

## Public data types

| Type                | Fields                                                                                                                                                                                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RailgunInput`      | Public `recipient` string, `recovery`, `relayer`, `feeRecipient` addresses.                                                                                                                                                                                                            |
| `DepositTerms`      | `recovery`, `relayer`, `feeRecipient`.                                                                                                                                                                                                                                                 |
| `DepositConfig`     | The terms plus encrypted `recipient` instructions.                                                                                                                                                                                                                                     |
| `DepositQuote`      | `token`, bigint `amount`, bigint `gasFee`, bigint `deadline`; multi-asset quotes also contain `native` and a reviewed `approval`.                                                                                                                                                      |
| `Deployment`        | Optional `multiAsset: true`, bigint `chainId`, `factory`, `implementation`, `validator`, `executor`, `pool`, `asset`, bigint `maxGasFee`, six `codeHashes`, `poolImplementation` and `assetImplementation` pins or null. A proxy asset requires its implementation pin before deposit. |
| `DepositRecord`     | Deployment plus `protocol: "railgun"`, `address`, 32-byte `salt`, fixed `config`, and `fundingBlock` in multi-asset mode.                                                                                                                                                              |
| `DepositExecution`  | Deposit record plus `quote`.                                                                                                                                                                                                                                                           |
| `RecoveryArtifacts` | Exact-build runtime templates and immutable offsets; import the reviewed `contracts` JSON export.                                                                                                                                                                                      |
| `RecoveryFile`      | Versioned JSON form with decimal-string numbers, `depositAddress`, route pins, salt and fixed configuration; no keys or arbitrary calls.                                                                                                                                               |
| `RailgunRecipient`  | `masterPublicKey: bigint`, `viewingPublicKey: Uint8Array`, optional `chainId: bigint` restriction.                                                                                                                                                                                     |

The package’s TypeScript declarations define the complete public types.
Version 1 recovery files without `assetImplementation` remain accepted for owner
recovery. Depositing a proxy token requires its current, reviewed implementation pin.
Addresses are EVM hex strings except the public RAILGUN input. Do not guess token
decimals or reuse deployment pins across chains.

## Optional Relay adapter

Import these from `@cloakedxyz/puddle/relay`:

```ts
relayFundingRequest(input); // provider request body
validateRelayFundingQuote(input, response); // RelayFundingQuote
minimumMatchingAssetOutput(amount, gasFee); // bigint policy floor
```

`RelayFundingRequest` specifies origin/destination chain IDs and tokens, destination
account, recovery owner, bigint input amount/minimum output and slippage basis points.

```ts
type RelayFundingRequest = {
  originChainId: number;
  originToken: string;
  destinationChainId: number;
  destinationToken: string;
  destinationAddress: string;
  recoveryOwner: string;
  amount: bigint;
  minimumOutput: bigint;
  slippageBps: number;
};
```

The request uses ERC-20 token addresses and fixes refund
and recovery addresses; the checker validates reported routing, sender and output,
and ignores provider transaction calldata.

`RelayFundingQuote` returns the deposit address/request ID, fixed route and recovery
owner, input amount, expected output and minimum output as decimal strings.
The adapter does not prove recorded source recovery ownership or bridge delivery.
The app's floor allows at most 2% bridge shortfall and enough output for relay fees.
Use that floor only for the same asset with equal decimals on both chains.
The website accepts direct Arbitrum deposits. See [Relay quotes](bridges.md) for integration scope.
