# Puddle documentation

Puddle turns an ordinary token transfer into a RAILGUN private balance through an
unmodified ZeroDev Kernel account. You keep control of funds that have not been
shielded through your recovery wallet.

**Unaudited preview. A bounded live ZeroDev pilot passed deposit and recovery checks;
the recipient wallet discovered the deposit and screening is still pending.
The SDK candidate is not published on npm. The website offers a small manual pilot;
arrange with the operator before funding.**

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
The website currently accepts 0.0001 WETH per receiving address on Arbitrum One.
Only the configured operator can complete shielding; arrange this before sending.

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

The tested live route is WETH on Arbitrum. The new ZeroDev pilot is separate from
the earlier custom-contract RAILGUN test. Discovery, screening and private spending
are separate checks; only discovery has been confirmed in the recipient wallet.

Public bridge routes remain disabled. Relay quotes and funding instructions are
integrated, but funded delivery, refunds and source recovery still need verification.
End users do not need a Relay account; the app operator supplies the server API key.

The automatic local demo is available with `node scripts/railgun-app.ts --demo-auto`.
It uses a temporary chain and disposable funds. Production operation and independent
security review remain outstanding.
