# Relay quotes

The SDK provides helpers for Relay quotes. The website’s receiving flow accepts
WETH directly on Arbitrum One; it does not initiate cross-chain transfers.

## SDK quote helpers

The SDK's optional `@cloakedxyz/puddle/relay` module builds and validates Relay
quote requests. It does not execute bridge transfers, track delivery or process refunds.
These helpers do not establish a verified bridge route.

`relayFundingRequest` requests a strict, single-use deposit address with fixed
source/destination assets, destination account and refund/recovery owner.
`validateRelayFundingQuote` checks the reported route, sender, recipient and minimum
output. It ignores provider transaction calldata. `minimumMatchingAssetOutput`
sets a floor of 98% of the input amount and raises it if needed to cover Puddle’s fee and gas reimbursement.
The 2% limit applies to the bridge leg; Puddle and RAILGUN fees are separate.

Relay API requests use an operator's server-side API key. Never include that key
in a browser bundle or recovery file. See the [API reference](api.md).

## Recovery boundary

Funds held inside Relay depend on Relay's refund and withdrawal authorization.
The quote checker does not independently derive the source deposit address or
prove its recorded recovery owner. Once funds arrive at a Puddle receiving account,
its owner can recover unshielded funds through the [normal recovery path](recovery.md).

For Relay's own behavior, see its [deposit-address documentation](https://docs.relay.link/features/deposit-addresses)
and [withdrawal documentation](https://docs.relay.link/references/protocol/guides/withdrawals).
