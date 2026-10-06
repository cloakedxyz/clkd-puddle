# Recovery

Standalone recovery for unshielded RAILGUN, Privacy Pools v2 and v1 deposits, plus v1's public pool exit.
Receive-address recovery uses a saved recovery file and the owner's wallet; no deposit API, relayer or token approvals.
Files stay on your device. The wallet needs a blockchain connection and gas.

```sh
npm ci --ignore-scripts
npm run setup
npm run privacy-pools-v1:setup
npm run recovery:dev
```

Open **http://127.0.0.1:5175**. Load the file, connect its recovery wallet on the
specified chain, then check the balance. Deploy the deposit contract if needed;
recover the selected token or native currency in a separate transaction.

## Verification

The tool validates the file, computes the deposit address and compares the
factory and fixed implementation's onchain code with its own build. Deployed
addresses must contain the exact expected ERC-1167 clone. It checks the network and recovery
owner before each transaction. Imported transaction data is never trusted.

Keep the file private and compare its addresses with your records. Validation
checks consistency, not the file's origin. Only the current `private-deposit-recovery`
format is supported; old pre-release files and unknown versions are rejected.
The tool is unaudited.

The public recovery file stores the protocol, chain, factory, pool, deposit address, salt, recipient
instructions and fixed recovery/relayer/fee addresses. Recipient instructions are
an encrypted RAILGUN note, a Privacy Pools v2 call hash, or v1's asset, pool and deposit hash; receive-address recovery needs no proof or
Privacy Pools SDK. The `asset` field only selects the
initial token to check; it does not affect the deposit address. Amount, fee and expiry
are execution settings and are unnecessary for recovery.

The demo uses a temporary local chain and test wallet. Already shielded funds
remain in the recipient's protocol wallet; a pending recovery can be overtaken by depositing.
Partial deposits, wrong assets and late transfers remain recoverable publicly.

## Privacy Pools v1 public exit

Load the Puddle recovery file, connect its recovery wallet, and load the separate
private v1 note backup. Check the pool balance and choose **Recover publicly from pool**.
The proof is generated on this device with bundled, hash-checked proof files. The
receive contract calls the original pool and returns funds only to the fixed recovery
wallet. A failed return transfer reverses the complete exit and can be retried.
The pool can be closed or removed from the registry; screening approval is not required.

The private backup contains spending secrets; never upload it. After a partial
withdrawal, use the updated note backup. The original backup cannot recover a note
that was already spent. Missing private secrets cannot be replaced by the recovery wallet.
This is Puddle's note JSON format, not an official-wallet seed phrase. See the
[v1 guide](../docs/src/pages/privacy-pools-v1.md) for backup helpers and limitations.

Pool exit is public, and previous fees are not refunded. Excess and late transfers
at the receive address are recovered separately. V1 uses native ETH or registered
standard ERC-20 tokens; no wrapping or swapping is performed.

## Hosting

`npm run recovery:build` produces a standalone site in `.cache/recovery`.
The intended domain is `recovery.<brand>.link`; nothing is deployed yet.
Host it independently of the app, or keep a local copy. Apply the generated
`_headers`, including its content security policy, or equivalent host settings.
Libraries and contract artifacts are included; no CDN is required.

Run `npm run test:recovery` to verify recovery and invalid-input handling on Anvil.
