# Receive privately

Puddle turns a normal token transfer into a deposit in your RAILGUN private wallet.
Create a receiving address, send from your usual wallet and receive privately.

The website accepts **0.0001 WETH on Arbitrum One** per receiving address.
WETH is ETH represented as a token.

## Create your address

1. Enter your RAILGUN address and a recovery wallet you control.
2. Review the amount, network and fees.
3. Save your recovery file, then send to your Puddle address.

You only enter the two addresses. The website supplies the token, network and amount.
Creating an address needs no wallet connection.

An operator completes the private deposit. Arrange this before sending funds.
Check your RAILGUN wallet for the deposit; it becomes available after screening.
Use a new Puddle address for each deposit.

## Fees

Puddle charges 0.1%, plus gas reimbursement and RAILGUN's pool fee.
Review the estimated private balance and maximum gas charge before sending.
The operator's gas reimbursement can change within that maximum.

## Recovery

Your recovery wallet controls funds that have not entered RAILGUN, including
partial, excess and late transfers. Save the recovery file and keep it private.
Once deposited, funds are controlled by your RAILGUN wallet.
See [Recover funds](recovery.md) for the steps.

The transfer to your Puddle address is public. Reusing a recovery wallet can link
receiving addresses. Read [Security](../SECURITY.md) for privacy and review details.

## Build with Puddle

Use the SDK to create addresses, check deposits and prepare recovery transactions
in your app. Start with [SDK installation](api.md#installation) and the
[API reference](api.md). [Architecture](architecture.md) covers the contracts and
[Relay quotes](bridges.md) covers the optional bridge quote helpers.
