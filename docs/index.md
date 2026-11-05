# Receive privately

Puddle turns a normal transfer into a private balance.
Create a receiving address, send from your usual wallet and receive privately.

Send **ETH or a standard ERC-20 on Arbitrum One**. Puddle detects the token and
amount after funding. ETH is wrapped automatically before the private deposit.

## Create your address

1. Choose where you send from and where you receive privately.
   RAILGUN is available on Arbitrum One.
2. Enter your RAILGUN address and a recovery wallet you control.
3. Choose **Save & show address**. Keep the downloaded recovery file private.
4. Copy the address or scan its QR code, then send on the displayed network.

You only enter the two addresses. Choose the network, then send the token and amount
you want to receive privately.
Creating an address needs no wallet connection.

An operator completes the private deposit. Arrange this before sending funds.
Check your RAILGUN wallet for the deposit; it becomes available after screening.
Use a new Puddle address for each deposit. If several assets arrive, choose one to
deposit and recover the others. Rebasing, lottery and taxed tokens are unsupported.

## Fees

Puddle charges 0.1%, plus gas reimbursement and RAILGUN's pool fee.
The gas charge is quoted in the received token, up to 5% of the deposit. ETH/WETH
also have an absolute ceiling shown before funding. Review the final fees and
estimated private balance with the operator before completion.

## Recovery

Your recovery wallet controls funds that have not entered RAILGUN, including
partial, excess and late transfers. Save the recovery file and keep it private.
Once deposited, funds are controlled by your RAILGUN wallet.
See [Recover funds](recovery.md) for the steps.

The transfer to your Puddle address is public. Reusing a recovery wallet can link
receiving addresses. Read [Security](../SECURITY.md) for privacy and review details.

## Build with Puddle

Use the SDK to create addresses, check deposits and prepare recovery transactions
in your app. Start with [Integrate Puddle](integrate.md) for a copyable module and
the [API reference](api.md) for functions and types. [Architecture](architecture.md) covers the contracts and
[Relay quotes](bridges.md) covers the optional bridge quote helpers.
