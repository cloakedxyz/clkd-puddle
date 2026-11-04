# Architecture

**ERC-20 transfer → ZeroDev Kernel account → RAILGUN.**

Puddle uses unmodified Kernel v3.3 accounts, factory and ECDSA owner validator, pinned
at `cd697c7e21715d015e0643af22310a99aa17433b`. Its only settlement contract is
`contracts/RailgunExecutor.sol`, a restricted execution module. Puddle has no custom
receiving account, factory, account upgrade authority or generic relayer batch API.

## Receiving account

The SDK decodes the public RAILGUN address and encrypts recipient instructions locally.
It derives the receiving address from Kernel's factory, initialization and a fresh salt.
Initialization fixes the recovery owner and installs the module with a fixed relayer,
fee recipient and encrypted recipient hash. No recipient signature or private key is needed.

Before funding, the SDK checks the chain, deployed code, proxy implementations, module
configuration and account ownership against trusted deployment pins and build artifacts.
An untrusted API response cannot serve as its own trust source. Recovery is saved before
the funding address is shown.

## Settlement

Only the configured relayer can submit a deposit quote. The quote supplies amount,
gas reimbursement and expiry; changing it preserves the receiving address, owner,
fee parties and encrypted recipient.

The module performs one complete batch:

1. Reset allowance and approve the exact pool amount.
2. Shield one fixed-recipient ERC-20 note into the configured RAILGUN pool.
3. Clear allowance and pay the 0.1% service fee plus bounded gas reimbursement.
4. Check the account debit, fee receipt and zero allowance.

Failure rolls back deployment, transfers, fees and the use flag. Success permanently
uses the account's deposit action, including after module removal and reinstallation.
Excess and later transfers remain recoverable by the owner.

The operator pays native transaction gas. The direct module path uses no bundler,
paymaster, per-account EntryPoint deposit or recipient account-operation signature.
The website currently requires manual operator execution.

## Recovery and trust

The recovery wallet owns the Kernel account. It can deploy an undeployed account through
the standard factory and transfer unshielded assets to itself without the Puddle
operator, executor permission, API or an unexpired quote. Pool/token deposit checks
are skipped for recovery; a token still needs to function for its transfer to succeed.
Already-shielded funds are controlled by the RAILGUN wallet.

Saved files contain public configuration and encrypted recipient instructions, not
keys or arbitrary imported calls. The SDK reconstructs the account and rejects changed
ownership or account implementation. Reused recovery owners publicly link accounts.

RAILGUN governance, screening and token governance are external dependencies. A deposit
receipt does not prove discovery or spend readiness; those are checked in the recipient
wallet. [Bridge recovery](bridges.md) has a separate provider dependency.

## Builds and local automation

Stock Kernel contracts use Solidity 0.8.28 to match deployed code; Puddle's module uses
Solidity 0.8.32. Both profiles are pinned in `foundry.toml`. The SDK ships matching
runtime templates, and the website's public deployment bundle is checked against an
independent build in CI and against deployed code before publication.
The live route's addresses, code hashes and runtime templates are in
[the Arbitrum deployment bundle](../deployments/arbitrum.json).

The repository also includes an optional local operator worker and automatic demo.
The worker persists signed transactions before broadcast, resumes the same hash,
checks confirmations and preserves per-transaction and total spending budgets across
restarts. Failed, expired or conflicting jobs need operator review. It runs locally with disposable funds. See [scripts/relay-worker.ts](../scripts/relay-worker.ts) and the
[local demo instructions](../README.md#run).
