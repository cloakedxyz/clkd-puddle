# Recover funds

Your recovery wallet controls the Puddle receiving account. It can recover
funds that have not entered RAILGUN, including partial, excess and late transfers.
It cannot withdraw funds that have already been shielded into the private wallet.

## Use the receiving interface

1. Restore the recovery JSON file you saved before funding.
2. Connect the wallet whose address is recorded as the recovery owner.
3. Switch to the chain shown in the file and keep enough native currency for gas.
4. Select **Recover remaining tokens**.
5. If the account is undeployed, approve its creation through the standard Kernel factory.
6. Approve the recovery transaction and check your wallet balance.

Both transactions are authorized by the recovery owner. The Puddle relayer does not
sign or approve recovery. A pool upgrade, expired quote or removed deposit module
does not prevent this ownership path. If the site is unavailable, use the SDK below.

## Use the SDK

```ts
import { parseRecoveryFile, inspectRecovery, recoveryTransaction, mined } from "@cloakedxyz/puddle";
import artifacts from "@cloakedxyz/puddle/contracts" with { type: "json" };

const file = parseRecoveryFile(savedJSON);
const owner = await recoverySigner.getAddress();
const state = await inspectRecovery(provider, file, artifacts);

if (!state.deployed) {
  await mined(
    recoverySigner.sendTransaction(
      await recoveryTransaction(provider, file, artifacts, owner, file.asset, "deploy"),
    ),
  );
}
await mined(
  recoverySigner.sendTransaction(
    await recoveryTransaction(provider, file, artifacts, owner, file.asset, "recover"),
  ),
);
```

Use the zero address as the asset to recover native currency, or another token
address to recover a mistaken ERC-20 transfer. The website currently exposes recovery
for the route token; the SDK exposes these additional choices.

## Keep the file private

Recovery files contain public account configuration and encrypted recipient
instructions, not wallet keys. They can still link your private receiving activity
to public accounts. Store the file privately and retain it for future late transfers.
Never upload a seed phrase, spending key or private viewing key.

Only the recorded owner can authorize recovery. If that owner is a contract wallet,
it must be able to call Kernel directly. Changing account ownership or upgrading
Kernel invalidates the original saved assumptions and is rejected by verification.

Bridge funds still held by Relay have a separate provider-assisted recovery process.
See [Relay quotes](bridges.md) and the [SDK API reference](api.md).
