---
showAskAi: false
outline: false
---

# How it works

Fund your private RAILGUN balance with an ordinary token transfer.

**Coming soon:** RAILGUN on Ethereum, using WETH (the token form of ETH).
Public deposits aren't open yet.
[Privacy Pools v1](/privacy-pools-v1) and [v2](/privacy-pools) are planned for later.

1. Enter your RAILGUN address and choose a recovery wallet you control.
2. Review your deposit address and fees, then save the recovery file.
3. Send WETH on Ethereum. Puddle's relayer submits the deposit into RAILGUN for you.

Your initial transfer remains public. Each address deposits once; excess funds
remain recoverable. See [fees](/fees), [recovery](/recovery) and
[contracts & security](/contracts) for the details. The contracts are unaudited.

## Try it locally

Run `npm run dev` from the repository and open the [app](http://127.0.0.1:5173).
The RAILGUN demo supplies test USDC and uses a **Relay deposit manually** step.
It runs on a local chain; nothing is sent to a public network. Save the recovery
file before funding so you can also try recovering a deposit before it enters the pool.

The Privacy Pools guides cover their separate development tests.
