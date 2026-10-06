---
showAskAi: false
outline: false
---

# Recovery

Only the fixed recovery wallet can withdraw unshielded funds. The relayer's permission is not required.

Save the recovery file before funding a deposit. It contains the configuration,
salt, chain and factory address; no private keys. Keep it private.

The open-source recovery tool works independently of the deposit service. Load
the file locally, connect the recovery wallet on the correct chain, and check
the balance. The file is not uploaded. You can also run the tool yourself with
`npm run recovery:dev` at **http://127.0.0.1:5175**.

1. Deploy the deposit contract if needed (one wallet transaction).
2. Recover the selected asset (a second wallet transaction).
3. The balance returns to the fixed recovery wallet.

The tool checks the deposit address, factory, fixed implementation and any deployed
clone against its own contract build. The current format supports RAILGUN and both
Privacy Pools versions; old pre-release formats and unknown versions are rejected. The demo
uses a local chain and test recovery wallet; the public recovery site is not deployed yet.

Recovery also works for partial deposits, wrong tokens and transfers received after shielding. Use `recoverNative()` for native currency accidentally sent before deployment or forcibly received.

You pay transaction gas; there is no service fee. Recovery is public, and reusing a recovery address links deposits. Successfully deposited funds are controlled through the recipient's protocol wallet.

## Privacy Pools v1 funds already in the pool

The same tool supports v1's public emergency exit. Load the Puddle recovery file
and the separate private note backup, connect the recovery wallet, then check the
pool balance and select **Recover publicly from pool**. Proofs are generated locally
using bundled, verified files; secrets are never uploaded. The receiving contract
calls the original pool and forwards the returned funds to the fixed recovery wallet.

This path requires the current note's secrets in addition to the recovery wallet.
After a partial private withdrawal, use the updated backup. Screening approval and
Puddle's relayer are not needed. A closed pool or removal from its registry does not
prevent the exit. A failed return transfer rolls back the exit so it can be retried.
Paid fees are not refunded, and the exit publicly links back to the deposit.

Excess or late funds at the receive address are recovered separately. See the
[v1 guide](/privacy-pools-v1) for the backup format, helper functions and test coverage.
