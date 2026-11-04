# Bridge scope

Use an existing provider rather than build a bridge. Relay is the initial candidate
for a narrow matching-asset route, such as Base WETH → Arbitrum WETH, after the
same-chain ZeroDev + RAILGUN flow is validated.

| Provider | Fit for this release                                                                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relay    | The existing adapter uses strict, single-payment deposit addresses with explicit refund and recovery settings.                                                                                          |
| Across   | Now offers persistent deposit addresses without a sender signature, but requires an API key with deposit-address permission and route-specific limits. No Across integration or funded test is present. |

Keep one provider in the initial release. Relay is the implementation candidate;
Across is an alternative if its access, routes or recovery model prove a better fit.
Every shield needs a fresh Kernel account. A persistent bridge address pointing at
an already-used account would deliver funds that need owner recovery instead of
another shield. The funded bridge test must use a new account, separate from the
same-chain pilot.

Enabled Relay routes require a server-side `RELAY_API_KEY` from a Dashboard App.
The key is never sent to the browser or saved in recovery files. Relay documents
authenticated `/quote/v2` requests as required; successful anonymous test quotes
are not a production guarantee. End users do not need Relay accounts.

Provider-assisted recovery while funds are inside the bridge is an accepted trust
dependency. Destination account recovery must remain independent of Puddle. The
optional `@cloakedxyz/puddle/relay` adapter validates reported chains, tokens, recipient,
sender and minimum output, and fixes the requested refund/recovery owner. It ignores provider-returned transaction
calldata. It does not independently prove the source address or recorded recovery
ownership, or provide an exit if Relay's authorization system disappears.

Read-only Relay quotes on 4 November 2026 used the planned ZeroDev Kernel address:

| Base WETH input | Minimum Arbitrum WETH output | Passes 2% shortfall policy |
| --------------- | ---------------------------- | -------------------------- |
| 0.0001          | 0.000085030143263058         | No                         |
| 0.001           | 0.000980438467161227         | Yes                        |
| 0.01            | 0.009934594345763058         | Yes                        |

These are expiring samples, not funding instructions or future price guarantees.
They establish neither funded delivery nor recorded recovery ownership. Earlier
quotes used the removed custom contracts and are not compatibility evidence.
No production bridge origins are configured. Relay documents that a configured
`recoveryAddress` becomes the protocol depositor; verify that field on the actual
funded request before calling source recovery proven.

Before enabling one route, test funded destination delivery, source refunds and
recovery, quote expiry, shortfalls, unsupported wallets and destination shielding
failure. Keep the bridge funding record and destination recovery file separately.
RAILGUN wallet discovery and screening are additional checks after delivery.

References assessed on 4 November 2026:
[Relay deposit addresses](https://docs.relay.link/features/deposit-addresses),
[API keys](https://docs.relay.link/references/api/api-keys),
[recovery](https://docs.relay.link/references/protocol/guides/withdrawals),
[depository](https://docs.relay.link/references/protocol/components/depository),
[Across persistent deposit addresses](https://docs.across.to/introduction/persistent-deposit-addresses).
