# SDK API reference

Candidate `@cloakedxyz/puddle@0.1.0-rc.1`. JavaScript modules, ethers v6, browser and Node 24.12+.
The candidate is unpublished and unaudited. This page describes SDK functions;
it does not promise a public hosted REST service.

## Prepare a receive

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
For the complete exact-build checks before funding, use `prepareRailgunReceive`.

## Inspect and verify

```ts
await inspectDeposit(adapter, deposit, provider);
// { deployed: boolean; spent: boolean; balance: bigint; ready: boolean }

await validateDeposit(adapter, record, provider); // void
await verifyDeployment(provider, deployment, artifacts); // void
await verifyAccount(provider, record, (checkExecutor = true)); // boolean
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
await inspectRecovery(provider, file, artifacts, (asset = file.asset));
// { deployed: boolean; balance: bigint; address: string; recovery: string }

await recoveryTransaction(
  provider,
  file,
  artifacts,
  owner,
  (asset = file.asset),
  (action = "recover"),
); // ethers TransactionRequest; signs and sends nothing
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

| Type                | Fields                                                                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RailgunInput`      | Public `recipient` string, `recovery`, `relayer`, `feeRecipient` addresses.                                                                                      |
| `DepositTerms`      | `recovery`, `relayer`, `feeRecipient`.                                                                                                                           |
| `DepositConfig`     | The terms plus encrypted `recipient` instructions.                                                                                                               |
| `DepositQuote`      | `token`, bigint `amount`, bigint `gasFee`, bigint `deadline`.                                                                                                    |
| `Deployment`        | bigint `chainId`, `factory`, `implementation`, `validator`, `executor`, `pool`, `asset`, bigint `maxGasFee`, six `codeHashes`, `poolImplementation` pin or null. |
| `DepositRecord`     | Deployment plus `protocol: "railgun"`, `address`, 32-byte `salt`, fixed `config`.                                                                                |
| `DepositExecution`  | Deposit record plus `quote`.                                                                                                                                     |
| `RecoveryArtifacts` | Exact-build runtime templates and immutable offsets; import the reviewed `contracts` JSON export.                                                                |
| `RecoveryFile`      | Versioned JSON form with decimal-string numbers, `depositAddress`, route pins, salt and fixed configuration; no keys or arbitrary calls.                         |
| `RailgunRecipient`  | `masterPublicKey: bigint`, `viewingPublicKey: Uint8Array`, optional `chainId: bigint` restriction.                                                               |

The generated TypeScript declarations in the packed candidate are authoritative.
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
Only matching-asset ERC-20 funding is wired into the app. The request fixes refund
and recovery addresses; the checker validates reported routing, sender and output,
and ignores provider transaction calldata.

`RelayFundingQuote` returns the deposit address/request ID, fixed route and recovery
owner, input amount, expected output and minimum output as decimal strings.
The adapter does not prove recorded source recovery ownership or bridge delivery.
The app's floor allows at most 2% bridge shortfall and enough output for relay fees.
No production bridge route is enabled. See [bridge scope](bridges.md).
