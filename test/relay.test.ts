import assert from 'node:assert/strict';
import { test } from 'node:test';
import { minimumMatchingAssetOutput, relayFundingRequest, validateRelayFundingQuote } from '../sdk/relay.ts';

const input = { originChainId: 8453, destinationChainId: 42161,
  originToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  destinationToken: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  destinationAddress: '0x1111111111111111111111111111111111111111',
  recoveryOwner: '0x2222222222222222222222222222222222222222',
  amount: 100_000_000n, minimumOutput: 99_000_000n, slippageBps: 50 };
function quote() {
  return { details: { sender: input.recoveryOwner, recipient: input.destinationAddress,
    currencyIn: { currency: { chainId: input.originChainId, address: input.originToken }, amount: String(input.amount) },
    currencyOut: { currency: { chainId: input.destinationChainId, address: input.destinationToken }, amount: '99900000', minimumAmount: '99400000' } },
  steps: [{ id: 'deposit', requestId: '0x' + 'ab'.repeat(32), depositAddress: '0x3333333333333333333333333333333333333333' }] };
}
test('bridge request fixes user-owned source recovery and the Puddle destination', () => {
  const request = relayFundingRequest(input);
  assert.equal(request.refundTo, input.recoveryOwner);
  assert.equal(request.recoveryAddress, input.recoveryOwner);
  assert.equal(request.recipient, input.destinationAddress);
  assert.equal(request.strict, true);
  assert.equal(request.useDepositAddress, true);
  assert.equal(minimumMatchingAssetOutput(100_000_000n, 200_000n), 98_000_000n);
  assert.equal(minimumMatchingAssetOutput(1001n, 0n), 981n, 'The 98% floor rounds up to preserve the shortfall limit.');
  assert(minimumMatchingAssetOutput(1000n, 999n) > 1000n);
  const checked = validateRelayFundingQuote(input, quote());
  assert.equal(checked.minimumOutput, '99400000');
  for (const patch of [{ amount: 0n }, { minimumOutput: 0n }, { originChainId: 42161 }, { slippageBps: 101 }]) {
    assert.throws(() => relayFundingRequest({ ...input, ...patch }));
  }
});
test('bridge quote rejects redirected, wrong-chain, undersized, and compound execution results', () => {
  const badRecipient = quote(); badRecipient.details.recipient = input.recoveryOwner;
  const badChain = quote(); badChain.details.currencyOut.currency.chainId = 1;
  const badToken = quote(); badToken.details.currencyOut.currency.address = input.originToken;
  const badMinimum = quote(); badMinimum.details.currencyOut.minimumAmount = '1';
  const badInput = quote(); badInput.details.currencyIn.amount = '1';
  const extraSteps = quote(); extraSteps.steps.push(extraSteps.steps[0]);
  for (const bad of [badRecipient, badChain, badToken, badMinimum, badInput, extraSteps, {}, null]) {
    assert.throws(() => validateRelayFundingQuote(input, bad));
  }
});
