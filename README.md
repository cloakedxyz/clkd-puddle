<!-- brand:start -->

# puddle

<!-- brand:end -->

Ordinary token transfers into a RAILGUN private balance, using **ZeroDev Kernel**
accounts. No recipient setup signature or private wallet keys are needed.

**Unaudited developer preview. Local test funds only. Nothing is published to npm.**

## Run

Requires Node.js 24.12+, npm, Git and Foundry 1.7.1.

```sh
npm ci --ignore-scripts
npm run setup
npm run dev
```

Open **http://127.0.0.1:5177**. The demo runs a fresh local chain with real Kernel
and RAILGUN contracts and disposable wallets. Save recovery, fund the account,
then relay the deposit. The same interface restores saved recovery files.
Restarting clears the local chain.

For automatic settlement with a disposable wrapped-native token, run
`node scripts/railgun-app.ts --demo-auto`. Save recovery and send test funds;
the local worker performs the RAILGUN deposit without a manual relay click.

## Design

```text
Sender transfers tokens
        ↓
ZeroDev Kernel account ← recovery owner controls this account
        ↓ restricted deposit module
RAILGUN private balance
```

Kernel supplies the account, factory, ownership and recovery. Puddle supplies one
small module that enforces the recipient, one-time deposit and bounded fees.
The SDK prepares encrypted recipient instructions locally and independently checks
the account address, code, owner and module before funding.

The service fee is 0.1%, plus a capped gas reimbursement and RAILGUN's pool fee.
Amounts can be requoted without changing the account or recipient. Excess, partial
and late transfers remain recoverable by the owner through Kernel.

The old custom account/factory and unrelated protocol experiments have been removed.
The earlier live RAILGUN test used those old contracts and **does not validate this
ZeroDev implementation**. Current evidence is in [RELEASE.md](RELEASE.md).

## SDK and verification

The unpublished candidate is `@cloakedxyz/puddle@0.1.0-rc.1`.
See the [SDK guide](sdk/README.md) and runnable [example](sdk/examples/receive.mjs).
The website docs include the [complete API reference](docs/api.md), receiving guide
and [recovery guide](docs/recovery.md).

```sh
npm run check
npm run test:sdk-package
```

These check types, contract behavior, recipient encoding against the official
RAILGUN engine, real Kernel-to-RAILGUN deposits, owner recovery, the browser and
an actual package installation outside the checkout.

| Path         | Purpose                                                             |
| ------------ | ------------------------------------------------------------------- |
| `contracts/` | Restricted RAILGUN module and upstream imports                      |
| `sdk/`       | Public receiving and recovery package; optional Relay quote adapter |
| `app/`       | One receiving/recovery front end                                    |
| `scripts/`   | Setup, builds, localhost server and release checks                  |
| `test/`      | Local contracts, protocol, package and browser tests                |

[Architecture](docs/architecture.md) · [Security](SECURITY.md) ·
[Contributing](CONTRIBUTING.md) · [Release checklist](docs/releasing.md)

## Limits

Standard ERC-20 tokens only. Initial transfers and reused recovery addresses are
publicly linkable. RAILGUN governance and screening are external dependencies.
The pilot CLI requires an explicit relay action. An optional WETH worker has local
restart, budget and browser coverage; production operations and independent review
remain outstanding. Relay is the bridge candidate under accepted provider-assisted recovery;
no funded bridge route is enabled. See [bridge notes](docs/bridges.md).

`npm run build:site` builds the landing page and current docs. To build the manual
receiving interface, set `PUDDLE_SITE_CONFIGURATION` to a private, reviewed Arbitrum
configuration file after building the SDK. The build checks deployed contracts and
copies only public route fields and trusted artifacts. It uses the public RPC directly;
no hosted signer or Puddle backend is required for the manual pilot.

[MIT](LICENSE) for original code. Upstream contracts and dependencies retain their
own licenses; see [notices](sdk/NOTICE). The full wallet/proving engine is a test
dependency and is excluded from the receiving package.
