# Security

Puddle uses ZeroDev Kernel for account ownership and a restricted module for RAILGUN
deposits. Recovery belongs to the account owner; the operator can perform only the
configured deposit action.

## Review status

Puddle's module, SDK and service have not undergone an independent security audit.
Kernel's audit coverage does not extend to these components. Current verification
evidence is recorded in [RELEASE.md](RELEASE.md).

## Trust boundaries

- Kernel, its standard factory and ECDSA validator provide account control. Puddle's
  module exposes only a complete RAILGUN deposit, not arbitrary account calls.
- The trusted client prepares the encrypted note and binds its hash, relayer and fee
  recipient into account initialization. The recovery owner is Kernel's owner.
- The configured deployment and artifacts must come from an independently reviewed
  source. Do not trust pins supplied alongside an untrusted API response.
- The relayer chooses a fresh amount/expiry within the immutable gas cap. A successful
  deposit is single-use; failures roll back the fee, use flag and fresh deployment.
- The owner can use Kernel directly to recover funds or remove the module. Account
  owner changes/upgrades invalidate the SDK's original assumptions and are rejected.
- RAILGUN's pool, governance and screening remain external dependencies. A transaction
  receipt does not establish wallet discovery, screening or spendability.
- Token issuer/governance control is also external. Pool and token proxy implementations
  are pinned before new deposits; that detects changes but cannot freeze an issuer's
  token logic. Owner recovery skips those deposit pins and still depends on a functioning token.
- The optional Relay adapter checks reported terms; it does not prove source recovery
  ownership or an exit without Relay's authorization. No funded bridge route is enabled.

Never request spending keys, private viewing keys, seed phrases or note backups.
Public recipient/address mappings and recovery files are privacy-sensitive. Keep
recovery files private and save them before funding. Reused owners link accounts.
Successfully shielded funds belong to the RAILGUN wallet, outside account recovery.

## Dependencies and release checks

Install lockfiles with `--ignore-scripts`. Use normal `npm pack` so its build guard
runs; `--ignore-scripts` during packing bypasses it. The guard catches stale output,
not compromised compilers or dependencies.

```sh
npm audit --prefix sdk --omit=dev
npm audit
```

The full RAILGUN engine and proof tools are development/test dependencies and are
excluded from the receiving package. That development tree still has upstream
advisories; resolve or explicitly assess relevant findings before operating a public
service. Do not use `npm audit fix --force` to replace the protocol engine.

Local demos hold disposable test keys. Keep them on localhost and never fund those
keys on public networks. The pilot server has no signing key. Source checks redact
credential matches but do not replace final artifact and Git-history review.

The optional automatic worker receives its operator signer from the embedding app;
it never imports recipient keys. Use a dedicated wallet and private durable storage.
Its queue contains signed transaction authorizations and privacy-sensitive recovery
data. Preserve its spending ledger and recorded hashes across restarts. Gas and
queue limits bound operator exposure; they do not replace service authentication,
monitoring, reviewed hosting or independent security review. Relay API keys stay
server-side and outside source control.

## Reporting

Use GitHub's **Security → Report a vulnerability** option if available. Otherwise
request a private reporting channel in an issue without exploit details. Do not
post keys, wallet exports, recipient profiles or recovery files. Use disposable
local data for reproductions. No bounty or response-time guarantee is offered.
