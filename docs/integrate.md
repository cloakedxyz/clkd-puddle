# Integrate Puddle

Add a receiving address that turns ETH or a standard ERC-20 transfer into a
RAILGUN deposit. The user supplies their public RAILGUN address and recovery wallet.
Puddle detects the token and amount after funding. ETH is wrapped automatically.

## Available interfaces

| Interface            | Available today                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| SDK                  | Prepare addresses, discover funding, quote and complete deposits, and recover remaining funds.                  |
| Public REST service  | None. The API reference documents JavaScript/TypeScript functions.                                              |
| Public configuration | Read-only `GET /configuration.json` and `GET /contracts.json` on `https://puddle.link`. These are static files. |
| Website              | ETH and standard ERC-20s on Arbitrum One, with manual operator completion.                                      |
| Automatic relaying   | A local WETH worker is included. No hosted service or general token pricing service is running.                 |
| Relay integration    | SDK quote helpers. Public bridge funding is disabled.                                                           |

Choose and arrange the operator before accepting funds. Only the operator bound
when creating an address can complete its private deposit. Each address completes
one deposit of one asset; other or later funds remain recoverable.

## Install and pin

`@cloakedxyz/puddle@0.1.0-rc.1` is a repository build, not an npm publication.
Use Node 24.12+ and Foundry 1.7.1:

```sh
npm ci --ignore-scripts
npm run setup
npm run build:sdk
mkdir -p .cache/release
npm pack ./sdk --pack-destination .cache/release
```

Install that tarball and `ethers@6.17.0` in your wallet project. Pin the reviewed
source revision and exact package digest.

Copy the `configuration` object from the [Arbitrum deployment bundle](../deployments/arbitrum.json)
into `puddle-route.json`. Review and pin it locally. An API response must not supply
its own trusted contract pins. The configuration contains the website's operator
and fee recipient; wallet teams can choose their own before creating addresses.
The recovery wallet belongs to the user.

## Receiving module

Save this as `puddle-integration.ts` beside `puddle-route.json`.
Implement `saveRecovery` using private wallet storage and provide a user export.
It must finish before the function returns a funding address.

```ts
import { Contract, type Provider } from "ethers";
import {
  prepareFlexibleReceive,
  discoverFunding,
  readFundingAsset,
  quoteFunding,
  type Deployment,
  type DepositExecution,
  type RecoveryFile,
} from "@cloakedxyz/puddle";
import artifacts from "@cloakedxyz/puddle/multi-asset-contracts" with { type: "json" };
import configuration from "./puddle-route.json" with { type: "json" };

const c = configuration;
export const puddleDeployment: Deployment = {
  multiAsset: true,
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
) {
  const { record, recovery } = await prepareFlexibleReceive(
    provider,
    puddleDeployment,
    {
      recipient: railgunAddress,
      recovery: recoveryWallet,
      relayer: c.relayer,
      feeRecipient: c.feeRecipient,
    },
    artifacts,
  );
  await saveRecovery(recovery);
  return record;
}

export async function getPuddleEstimate(provider: Provider, deposit: DepositExecution) {
  const pool = new Contract(
    puddleDeployment.pool,
    ["function shieldFee() view returns (uint256)"],
    provider,
  );
  const poolFeeBps: bigint = await pool.getFunction("shieldFee")();
  if (poolFeeBps < 0n || poolFeeBps >= 10000n) throw new Error("Unexpected RAILGUN fee.");
  const serviceFee = deposit.quote.amount / 1000n;
  const gasFee = deposit.quote.gasFee;
  const poolAmount = deposit.quote.amount - serviceFee - gasFee;
  const railgunFee = (poolAmount * poolFeeBps) / 10000n;
  return { serviceFee, gasFee, railgunFee, expectedPrivateAmount: poolAmount - railgunFee };
}

export { discoverFunding, readFundingAsset, quoteFunding };
```

Use the reviewed multi-asset deployment and matching artifact. The SDK verifies
both before returning an address. It rejects setting this mode on an earlier
WETH-only executor.

## Discover and complete

1. Save recovery, then show the receiving address and network. Explain supported
   tokens and the fee schedule before funding; no token or amount input is required.
2. Let the sender transfer ETH or a supported ERC-20 from their normal wallet.
3. Call `discoverFunding`. Retain its token candidates and scan cursor between polls;
   see the [scan bounds](api.md#token-independent-receiving). If several assets arrive,
   ask which one to deposit. Optional metadata failures use token base units.
4. The operator supplies a reviewed `TokenApproval` and calls `quoteFunding` with
   the selected balance and gas reimbursement in token base units. For ETH, use the
   approval for `puddleDeployment.asset`, the pinned wrapped-native token.
5. Show the token, amount, quoted fees and estimated private balance. Submit with
   [`relayDeposit`](api.md#manual-relay) using the configured operator wallet.
6. Show confirmation separately from recipient-wallet discovery and screening.
   The user's RAILGUN wallet establishes when the private balance is usable.

The service fee is 0.1%, plus RAILGUN's pool fee and the operator's quoted gas
reimbursement. Gas reimbursement cannot exceed 5% of the deposit; ETH/WETH also
have the deployment's absolute `maxGasFee` ceiling. The manual interface starts at
zero reimbursement. The operator must accept subsidizing gas or quote a fee.
There is no automatic token-to-gas price feed.

## Token policy and recovery

Support standard ERC-20 behavior. Exclude rebasing, lottery, transfer-tax and other
changing-balance tokens. Metadata, a runtime hash or a simulation does not prove
safe economic behavior. The wallet/operator reviews unfamiliar tokens and supplies
`TokenApproval` from that policy; never automatically approve discovered metadata.
The SDK checks the approved runtime and covered proxy implementation pins again
before execution. Issuer control and other proxy patterns remain external dependencies.

Use [owner recovery](recovery.md) for ETH or tokens still at the receiving address,
including partial, excess and late transfers. Recovery does not require the operator
or an eligible token. Token transfers still depend on the token functioning.
Already-private funds belong to the RAILGUN wallet.

Save complete recovery files privately. They are JSON-safe; active quotes contain
bigints and need explicit serialization. Recovery does not restore an active quote.
Earlier version-1 WETH files remain usable for owner recovery.

Before enabling a wallet integration, check backup failure, wrong-chain and changed-pin
rejection, fee display, manual completion, restored recovery and distinct execution /
discovery / screening status. `npm run dev` exercises a disposable local chain.
Never fund those demo wallets on public networks. See [Security](../SECURITY.md).

## Local HTTP endpoints

`scripts/railgun-app.ts` serves localhost, not a public REST product. `/api/rpc` is
read-only. `/api/relay-register` and `/api/relay-status` exist only with its local
WETH worker; `/api/bridge-quote` requires configured bridge origins and a server-side
Relay key. Endpoints enforce localhost and same-origin access. Do not point a
third-party wallet at them as a hosted Puddle API.

## Agent handoff

```text
Integrate Puddle receiving and recovery into this wallet.
Read https://puddle.link/llms.txt and the Integrate Puddle guide first.
Use the repository-built SDK and reviewed multi-asset deployment pins.
Prepare recipient instructions locally and save recovery before showing an address.
Discover funding after transfer; use a reviewed token policy and manual operator.
Implement the guide's acceptance checks and report what was verified.
```
