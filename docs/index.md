# Puddle documentation

Puddle turns an ordinary token transfer into a RAILGUN private balance through an
unmodified ZeroDev Kernel account. You keep control of funds that have not been
shielded through your recovery wallet.

**Unaudited developer preview. The new live ZeroDev pilot is awaiting approval.
The SDK candidate is not published on npm.**

## Receive

1. Enter your public RAILGUN address and a recovery wallet you control.
2. Review the chain, token, fees and maximum operator gas charge.
3. Save the recovery file before funding. Keep it private.
4. Send the selected token on the selected chain to the receiving address.
5. For this pilot, the configured operator restores the saved file, connects its wallet,
   selects **Prepare manual deposit**, reviews fees, then selects **Relay deposit**.
6. Check your RAILGUN wallet for receipt, screening and spend readiness.

A sender needs only an ordinary token transfer. Preparing a receiving address does
not require a recipient signature, spending key or private viewing key. The manual
relay step is an operator action, not a requirement to connect your RAILGUN wallet.

Each receiving account shields once. Excess or later transfers remain recoverable.
Initial transfers and reused recovery addresses are publicly linkable.

## Build with the SDK

The proposed package is `@cloakedxyz/puddle@0.1.0-rc.1`. Build and install its reviewed
tarball from the repository; do not assume an npm package with that name is this release.
Use ethers v6 and Node 24.12+ for Node integrations.

```sh
npm ci --ignore-scripts
npm run setup
npm run build:sdk
npm pack ./sdk
```

The SDK prepares encrypted recipient instructions locally, checks deployed code and
ownership, creates recovery files, refreshes quotes and constructs recovery transactions.
It excludes the full wallet/proving engine and never needs recipient private keys.

Read the [API reference](api.md), [recovery guide](recovery.md),
[architecture](architecture.md) and [bridge scope](bridges.md).

## Current limits

The intended first live route is WETH on Arbitrum. The earlier custom-contract
RAILGUN pilot does not prove the new ZeroDev route. A mined transaction also does
not prove recipient discovery, screening or private spending.

Public bridge routes remain disabled. Relay quotes and funding instructions are
integrated, but funded delivery, refunds and source recovery still need verification.
End users do not need a Relay account; the app operator supplies the server API key.

The automatic local demo is available with `node scripts/railgun-app.ts --demo-auto`.
It uses a temporary chain and disposable funds. Production operation and independent
security review remain outstanding.
