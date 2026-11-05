# Integrate Puddle

Add a receiving flow that turns an ordinary token transfer into a RAILGUN deposit.
Use the JavaScript/TypeScript SDK in your wallet. Receiving instructions are prepared
locally from the user's public RAILGUN address and recovery wallet.

## Available interfaces

| Interface             | Available today                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| SDK                   | Prepare addresses, check funding, complete a deposit with its operator wallet, and prepare owner recovery.              |
| Public REST service   | None. The website's API reference documents SDK functions.                                                              |
| Public configuration  | Read-only `GET /configuration.json` and `GET /contracts.json` on `https://puddle.link`. These are static website files. |
| Automatic relaying    | A local worker is included in the repository. No hosted operator service is running.                                    |
| Website funding route | Arbitrum One, WETH, 0.0001 WETH per address. Other chain logos are not enabled routes.                                  |
| Relay integration     | Quote helpers in the SDK. Public bridge funding is disabled.                                                            |

A wallet can integrate receiving and recovery with manual operator completion.
Choose and arrange the operator before accepting funds. Only the operator bound
when creating an address can complete its private deposit.

## Install and pin

The package is `@cloakedxyz/puddle@0.1.0-rc.1`, built from this repository; it is not
published to npm. From the Puddle checkout, with Node 24.12+ and Foundry 1.7.1:

```sh
npm ci --ignore-scripts
npm run setup
npm run build:sdk
mkdir -p .cache/release
npm pack ./sdk --pack-destination .cache/release
```

Install that tarball and `ethers@6.17.0` in your wallet project. Pin the reviewed
source revision and exact package digest in your integration.

Copy the `configuration` object from the [Arbitrum deployment bundle](../deployments/arbitrum.json)
into `puddle-route.json` beside your integration module. Review and pin this local
copy. Use the contract artifact exported by the installed SDK. Runtime API responses
must not supply their own trusted contract pins.

The configuration includes the website's operator and fee recipient. Wallet teams
can choose their own `relayer` and `feeRecipient` in this reviewed configuration
before creating any addresses. The recovery wallet belongs to the user.

## Receiving module

Save this as `puddle-integration.ts` beside `puddle-route.json`. It takes the wallet's
Arbitrum provider and public addresses. Implement
`saveRecovery` using private wallet storage and provide a user export. It must finish
successfully before the function returns a funding address.

```ts
import { Contract, type Provider } from "ethers";
import {
  prepareRailgunReceive,
  createRailgunAdapter,
  inspectDeposit,
  type Deployment,
  type DepositExecution,
  type RecoveryFile,
} from "@cloakedxyz/puddle";
import contracts from "@cloakedxyz/puddle/contracts" with { type: "json" };
import configuration from "./puddle-route.json" with { type: "json" };

const c = configuration;
export const puddleDeployment: Deployment = {
  chainId: BigInt(c.chainId),
  factory: c.factory,
  implementation: c.implementation,
  validator: c.validator,
  executor: c.executor,
  pool: c.pool,
  asset: c.token,
  maxGasFee: BigInt(c.maxGasFee),
  codeHashes: c.codeHashes,
  poolImplementation: c.poolImplementation,
  assetImplementation: c.assetImplementation,
};

export async function createPuddleReceive(
  provider: Provider,
  railgunAddress: string,
  recoveryWallet: string,
  saveRecovery: (file: RecoveryFile) => Promise<void>,
): Promise<DepositExecution> {
  const block = await provider.getBlock("latest");
  if (!block) throw new Error("Could not read Arbitrum.");
  const amount = BigInt(c.minAmount);
  const { deposit, recovery } = await prepareRailgunReceive(
    provider,
    puddleDeployment,
    {
      recipient: railgunAddress,
      recovery: recoveryWallet,
      relayer: c.relayer,
      feeRecipient: c.feeRecipient,
    },
    {
      token: c.token,
      amount,
      gasFee: BigInt(c.gasFee),
      deadline: BigInt(block.timestamp + 3600),
    },
    contracts,
  );
  await saveRecovery(recovery);
  return deposit;
}

export function getPuddleFundingStatus(provider: Provider, deposit: DepositExecution) {
  return inspectDeposit(createRailgunAdapter(puddleDeployment), deposit, provider);
}

export async function getPuddleEstimate(provider: Provider, deposit: DepositExecution) {
  const pool = new Contract(
    puddleDeployment.pool,
    ["function shieldFee() view returns (uint256)"],
    provider,
  );
  const poolFeeBps: bigint = await pool.getFunction("shieldFee")();
  if (poolFeeBps < 0n || poolFeeBps >= 10000n) {
    throw new Error("Unexpected RAILGUN fee.");
  }
  const serviceFee = deposit.quote.amount / 1000n;
  const gasFee = deposit.quote.gasFee;
  const poolAmount = deposit.quote.amount - serviceFee - gasFee;
  const railgunFee = (poolAmount * poolFeeBps) / 10000n;
  return {
    serviceFee,
    gasFee,
    maxGasFee: deposit.maxGasFee,
    railgunFee,
    expectedPrivateAmount: poolAmount - railgunFee,
  };
}
```

The example uses the configured minimum amount. Show the token, network, amount,
fees, maximum gas reimbursement and estimated private balance before funding.
`getPuddleEstimate` reads the pool fee and returns token base units; it is an estimate.
Format bigint amounts using the configured token decimals. The operator can refresh
amount, gas reimbursement and expiry within the fixed account rules.

For a command-line integration, the package also contains a
[runnable preparation example](../sdk/examples/receive.mjs). It saves recovery and
quote files before printing the receiving address and sends no transactions.

## Complete the flow

1. Ask for the public RAILGUN address and user-controlled recovery wallet.
2. Call `createPuddleReceive` and save the complete recovery file privately.
3. Display the verified receiving address, token, network, amount and fees.
4. Let the sender transfer WETH using their normal wallet. Check funding with
   `getPuddleFundingStatus`.
5. The configured operator completes the deposit with the SDK's
   [manual relay functions](api.md#manual-relay). This can be performed manually;
   it does not require a hosted relayer API.
6. Show transaction confirmation separately from recipient-wallet discovery and
   screening. The recipient's RAILGUN wallet establishes when the balance is usable.

Keep deposit quotes in wallet state if needed; their bigint fields need explicit
serialization. Recovery files already use JSON-safe fields. Restoring a recovery
file does not restore an active quote. The operator can prepare a fresh quote from
its verified account record.

## Recovery and acceptance checks

Use [owner recovery](recovery.md) for funds still at the receiving address, including
partial, excess and late transfers. Already-private funds belong to the RAILGUN wallet.
Each receiving address completes one private deposit.

Before enabling the integration, check that:

- A failed recovery save prevents displaying funding instructions.
- Wrong chains, changed contract pins and changed recovery ownership are rejected.
- The user sees the correct token, chain, amount and gas cap before funding.
- The assigned operator can complete a funded deposit manually.
- The user can restore recovery and recover remaining funds without that operator.
- Your wallet distinguishes funding, execution, discovery and screening.

Run `npm run dev` in this repository for a disposable local chain and the full
receiving/recovery interface. Default tests use local chains and send no live funds.
Do not fund the demo's disposable wallets on public networks. See
[Security](../SECURITY.md) for review status, privacy and trust boundaries.

## Local HTTP endpoints

`scripts/railgun-app.ts` serves a localhost application, not a public REST product.
Its `/api/rpc` endpoint is a restricted read-only proxy. `/api/relay-register` and
`/api/relay-status` exist only with its local automatic worker;
`/api/bridge-quote` exists only with configured bridge origins and a server-side
Relay API key. These endpoints enforce localhost and same-origin access.
Do not point a third-party wallet at them as a hosted Puddle API.

## Agent handoff

Give your implementation agent this task:

```text
Integrate Puddle receiving and recovery into this wallet.
Read https://puddle.link/llms.txt and the Integrate Puddle guide first.
Use the repository-built @cloakedxyz/puddle SDK and reviewed deployment pins.
Prepare recipient instructions locally and save recovery before showing an address.
Use a configured manual operator for deposit completion.
Implement the guide's acceptance checks and report what was verified.
```

## Receive without choosing a token first

The repository also implements token-independent receiving with
`MultiAssetRailgunExecutor`. This module needs a new deployment before the public
website can enable it; the existing public route remains WETH-only. The local demo
uses this flow. Use its matching contract artifact and a reviewed deployment with
`multiAsset: true`; setting that flag on the existing executor does not enable it.

The user supplies their two addresses and network. Save recovery, show the receiving
address, then discover the transferred token and amount. ETH is wrapped automatically.
Only standard ERC-20 behavior is supported; exclude rebasing, lottery and taxed tokens.

```ts
import type { Provider } from "ethers";
import {
  prepareFlexibleReceive,
  discoverFunding,
  quoteFunding,
  type Deployment,
  type RailgunInput,
  type RecoveryFile,
} from "@cloakedxyz/puddle";
import artifacts from "@cloakedxyz/puddle/multi-asset-contracts" with { type: "json" };

export async function createFlexiblePuddleAddress(
  provider: Provider,
  deployment: Deployment,
  input: RailgunInput,
  saveRecovery: (file: RecoveryFile) => Promise<void>,
) {
  const prepared = await prepareFlexibleReceive(provider, deployment, input, artifacts);
  await saveRecovery(prepared.recovery);
  return prepared.record;
}

export { discoverFunding, quoteFunding };
```

After funding, `discoverFunding` supplies candidates. Keep its token list and scan
cursor between polls; see the [API reference](api.md#token-independent-receiving)
for bounds and unreadable tokens. If several assets arrive, ask which one to deposit.
Each receiving address still completes one private deposit.

The configured operator reviews an unfamiliar token and supplies a `TokenApproval`
from its token policy to `quoteFunding`, together with reimbursement in the received
token. Do not turn discovered metadata into automatic approval. The manual UI starts
with zero gas reimbursement; the operator must accept paying gas or quote a fee.
Show the quote before execution. The contract caps token reimbursement at 5%, with
an additional absolute ceiling for ETH/WETH. Owner recovery remains available for
assets that cannot be deposited. The automatic worker and public bridge routes do
not support this mode.
