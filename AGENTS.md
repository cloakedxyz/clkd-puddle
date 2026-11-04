# Working on Puddle

Puddle's selected architecture is **ZeroDev Kernel + RAILGUN**.
Do not reintroduce a custom receiving account or factory.

Read `README.md`, `docs/architecture.md`, then `SECURITY.md`.

## Source map

- `contracts/RailgunExecutor.sol`: the only Puddle settlement contract.
- `contracts/KernelImports.sol`: imports unmodified upstream Kernel, factory and validator.
- `sdk/`: browser/Node preparation, account checks, quotes and owner recovery.
- `app/`: the single receiving/recovery interface.
- `deployments/arbitrum.json`: reviewed public route pins and runtime templates for the manual website preview; no personal accounts or recipient data.
- `scripts/railgun-app.ts`: localhost demo/pilot server; no production keys.
- `scripts/plan-live.ts`: read-only public preflight and isolated-fork pilot planning; never sends live transactions.
- `scripts/relay-worker.ts`: private, bounded operator queue; signed transactions reach disk before broadcast.
- `test/helpers.ts`: disposable accounts and real RAILGUN fixtures, never production code.

## Commands

```sh
npm ci --ignore-scripts
npm run setup
npm run check
npm run test:sdk-package
```

Use Node 24 and Foundry 1.7.1. `npm run dev` starts the local demo.
All default checks are local and send no live transactions.

## Invariants

- Recipient instructions are prepared from public details in the trusted client.
- Account ownership and recovery stay in Kernel; the relayer gets one restricted deposit action.
- Recipient, recovery owner and fee parties stay fixed when the amount quote changes.
- Failed deposits transfer no fee and preserve retry/recovery; successful deposits run once.
- Save recovery before showing funding instructions. Never log private wallet data.
- Treat execution, recipient discovery, screening and private spending as separate evidence.
- Test changes to contract behavior against the actual Kernel and RAILGUN contracts.
- Keep generated output, secrets and pilot records under ignored `.cache/`.
  The reviewed public website deployment bundle is the sole generated-file exception.

Use plain English. Keep changes focused and avoid extra abstractions or duplicate guides.
Record current evidence in `RELEASE.md`. Live spending and publication need their own explicit scope.
