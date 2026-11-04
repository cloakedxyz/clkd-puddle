# Architecture

One path: **ERC-20 transfer → ZeroDev Kernel account → RAILGUN**.

Kernel v3.3 is pinned at `cd697c7e21715d015e0643af22310a99aa17433b`.
Its account, factory and ECDSA validator are unmodified. Puddle supplies only
`contracts/RailgunExecutor.sol`, a restricted execution module. There is no
Puddle account, factory, account upgrade authority or generic relayer batch API.

The stock contracts are built with Solidity 0.8.28 and Kernel's deployment settings
to match its verified deployed code. Puddle's module uses Solidity 0.8.32. Both
profiles are explicit in `foundry.toml`; SDK artifacts contain those exact builds.

## Preparation

The SDK decodes the public RAILGUN address and prepares an encrypted shield note
locally. No private recipient data or signature is needed. It builds Kernel's initial
configuration with the recovery owner and installed module. The module's terms bind
the relayer, fee recipient and encrypted recipient hash. The ordinary Kernel factory
creates the account at an address independently derived by the SDK.

The trusted deployment fixes the factory, implementation, validator, module, token,
pool and gas ceiling. Runtime code hashes, built contract artifacts and module getters
are checked before funding. A configuration returned by an untrusted API cannot
serve as its own trusted source. Save recovery before showing the account address.

## Settlement

A quote contains gross amount, gas reimbursement and deadline. It can change without
changing the account address or recipient. Only the bound relayer can submit it.
The module creates this complete batch itself:

1. Reset token allowance and approve the exact pool amount.
2. Shield exactly one fixed-recipient ERC-20 note into the configured RAILGUN pool.
3. Clear allowance and pay the 0.1% service fee plus capped gas reimbursement.
4. Check actual account debit, fee receipt and zero allowance.

Kernel uses revert-on-failure execution. Any failure rolls back deployment, transfers,
fees and the use flag. Success makes the account single-use for this module, including
after uninstall/reinstall. Excess and later transfers remain owner-recoverable.

The relayer pays ordinary transaction gas. This direct module path needs no bundler,
paymaster, per-account EntryPoint deposit or recipient account-operation signature.
The local fixture uses a zero EntryPoint because it only exercises direct module and
owner calls; production must use the reviewed deployed Kernel for the target chain.

## Automatic operator

`scripts/relay-worker.ts` supplies an optional durable queue for Arbitrum WETH.
The operator provides a connected signer, reviewed deployment/artifacts and an
explicit policy: fee recipient, minimum/maximum amount, per-transaction native fee
cap, total native spending budget, confirmation count and maximum job count.
The worker does not load keys. Default pilot startup never creates a signer.

The site can receive the worker as the fourth argument to `startRailgunSite`.
It checks that the site and worker routes match, starts polling and stops the worker
on shutdown. The browser saves recovery before registering encrypted instructions
and revealing funding. It polls deposit status without a recipient wallet connection.

Before signing, the worker verifies the route, owner terms, actual funding, nonce and
gas estimate. WETH reimbursement uses native wei directly; it includes a gas-limit
buffer and must fit the module cap. The RPC estimate includes Arbitrum's data fee.
Other assets need a separately reviewed pricing policy and are not automated.

The private queue saves signed bytes, transaction hash and worst-case native fee
reservation to disk before broadcast. A restart checks that same hash and reuses
the same signed transaction if necessary. It never silently signs a replacement.
Confirmed receipts are checked again; a changed or missing block returns the original
hash to reconciliation rather than allocating a new nonce.
Reservations remain charged against the total budget even after confirmation;
restarting cannot reset the budget. A failed transaction, expired signed quote or
conflicting nonce needs operator review. Funds still in the account remain recoverable.

Use a dedicated operator wallet, private directory (0700) and queue file (0600).
Only one process can open a queue. A leftover `operator.lock/owner.json` identifies
the previous process; verify it has stopped and reconcile recorded hashes before
removing its lock. Never delete a queue to bypass its budget or pending transaction.
Call `close()` on shutdown. The local automatic demo uses disposable funds and
removes its queue when its temporary chain is stopped.

## Recovery

Saved recovery data contains public configuration and encrypted recipient instructions,
not keys or arbitrary executable calls. The SDK reconstructs initialization and checks
the account address/code and owner. If necessary, the owner deploys through Kernel's
factory, then calls Kernel to transfer the selected balance to itself. No Puddle API,
relayer, executor permission or unexpired quote is required. Pool upgrades or outages
block new deposits without blocking this owner-recovery path.

Recovery works before shielding and for excess/late assets. Already-private funds
are controlled by the RAILGUN wallet. Owner-authorized account upgrades and ownership
changes are possible; the SDK detects changed assumptions instead of silently trusting
them. Verify wallet discovery, screening and private spending separately.

## Scope

Standard ERC-20 tokens only. The pool and token are reviewed route dependencies.
The account owner can revoke the module or recover at any time. This is deliberate
self-custody. A reused owner publicly links accounts. Bridging is a separate provider
trust boundary, described in [bridges.md](bridges.md).
