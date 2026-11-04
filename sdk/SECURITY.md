# SDK security

Unaudited ZeroDev Kernel + RAILGUN candidate. Use local test funds.

Prepare notes locally from public recipient details. Never request spending keys,
private viewing keys, seeds or note backups. Save recovery before funding and keep
recipient/address mappings private. Initial transfers and reused owners are public links.

Deployment pins and shipped artifacts are trusted application inputs. They must not
come solely from the same untrusted API whose response is being checked. The SDK
checks account derivation, runtime code, owner and module terms. It does not audit
Kernel, the custom module, cryptography, pool governance, RPCs or screening.

Recovery uses Kernel ownership and works without the relayer or active module.
Already-shielded funds belong to the recipient's RAILGUN wallet. Wallet discovery,
screening and private spending are separate from successful contract execution.

The optional Relay adapter trusts provider-reported route/recovery terms and its
authorization service. No funded route is validated. Keep both recovery records.

The full wallet/proving engine is excluded from the receiving package. Audit the
runtime lockfile with `npm audit --prefix sdk --omit=dev`. A clean report is not an
independent security review. Normal packing checks stale/changed output;
`--ignore-scripts` bypasses this safeguard during packing.

Report privately through the repository's Security tab if available:
https://github.com/cloakedxyz/clkd-puddle/security. Otherwise request a private channel
without exploit details. Never disclose keys, profiles or recovery files publicly.
