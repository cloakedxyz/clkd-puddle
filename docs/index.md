# Puddle documentation

Puddle receives an ordinary token transfer and deposits it into your RAILGUN private
wallet. You control funds still at the receiving address through your recovery wallet.

Receive **0.0001 WETH on Arbitrum One** at a Puddle address. WETH is ETH represented
as a token. An operator completes your private deposit; coordinate before sending.

## Receive

1. Enter your public RAILGUN address and a recovery wallet you control.
2. Review the token, fees and maximum operator gas charge.
3. Save your recovery file, then send WETH to the displayed receiving address.
4. The operator completes the private deposit manually.
5. Check your RAILGUN wallet for receipt, screening and spend readiness.

Preparing an address needs no wallet connection, recipient signature, spending key
or private viewing key. Each receiving address supports one private deposit. Excess
and later transfers remain recoverable. Initial transfers and reused recovery wallets
are publicly linkable.

For the operator: restore the saved receiving file, connect the configured operator
wallet, select **Prepare manual deposit**, review fees, then select **Relay deposit**.

## Fees and recovery

The service fee is 0.1%, plus gas reimbursement and RAILGUN's pool fee. The website
shows the estimated private balance and maximum gas charge before funding. The
operator can change gas reimbursement up to that displayed maximum.

Your recovery wallet can recover funds that have not entered RAILGUN, including
partial, excess and late transfers. It cannot recover an already-shielded balance.
See [Recovery](recovery.md).

## Use the SDK

`@cloakedxyz/puddle@0.1.0-rc.1` is available as a repository build. It is not published
to npm. Build and install the tarball with ethers v6; Node integrations require
Node 24.12+.

```sh
npm ci --ignore-scripts
npm run setup
npm run build:sdk
npm pack ./sdk
```

The SDK prepares encrypted recipient instructions, verifies accounts and deployed
code, creates recovery files, refreshes quotes and constructs recovery transactions.
It runs in browsers and Node without the full wallet/proving engine or recipient keys.

See the [API reference](api.md) for functions and types, [Architecture](architecture.md)
for contract behavior and trust boundaries, and [Relay quotes](bridges.md) for Relay quote helpers.
