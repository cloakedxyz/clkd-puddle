import { getAddress, ZeroAddress } from 'ethers';

export interface RelayFundingRequest {
  originChainId: number;
  originToken: string;
  destinationChainId: number;
  destinationToken: string;
  destinationAddress: string;
  recoveryOwner: string;
  amount: bigint;
  minimumOutput: bigint;
  slippageBps: number;
}
export interface RelayFundingQuote {
  provider: 'relay';
  depositAddress: string;
  requestId: string;
  originChainId: number;
  originToken: string;
  amount: string;
  destinationChainId: number;
  destinationToken: string;
  destinationAddress: string;
  recoveryOwner: string;
  expectedOutput: string;
  minimumOutput: string;
}
const address = (value: string) => {
  const result = getAddress(value);
  if (result === ZeroAddress) throw new Error('Use a nonzero token or wallet address.');
  return result;
};

/** Matching-asset app policy: at most 2% bridge shortfall, and enough for relay fees. */
export function minimumMatchingAssetOutput(amount: bigint, gasFee: bigint): bigint {
  if (amount <= 0n || gasFee < 0n) throw new Error('Invalid matching-asset funding amount.');
  const feeFloor = (gasFee + 1n) * 1000n / 999n + 1n;
  const valueFloor = (amount * 9800n + 9999n) / 10000n;
  return feeFloor > valueFloor ? feeFloor : valueFloor;
}

/** Narrow ERC-20 bridge request. No swaps, destination calls, approvals, or app fees. */
export function relayFundingRequest(input: RelayFundingRequest) {
  if (!Number.isSafeInteger(input.originChainId) || input.originChainId <= 0
    || !Number.isSafeInteger(input.destinationChainId) || input.destinationChainId <= 0
    || input.originChainId === input.destinationChainId || input.amount <= 0n || input.amount >= 1n << 120n
    || input.minimumOutput <= 0n || input.minimumOutput >= 1n << 120n
    || !Number.isInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps > 100) {
    throw new Error('Invalid bridge funding terms.');
  }
  return {
    user: address(input.recoveryOwner), recipient: address(input.destinationAddress),
    originChainId: input.originChainId, originCurrency: address(input.originToken),
    destinationChainId: input.destinationChainId, destinationCurrency: address(input.destinationToken),
    amount: String(input.amount), tradeType: 'EXACT_INPUT', useDepositAddress: true, strict: true,
    refundTo: address(input.recoveryOwner), recoveryAddress: address(input.recoveryOwner),
    slippageTolerance: String(input.slippageBps),
  };
}

/**
 * Check provider-reported terms against the caller's expected route. This is not
 * independent address derivation: Relay's deposit-address service is a trust dependency.
 * Never execute arbitrary transaction data or check URLs returned by the provider.
 */
export function validateRelayFundingQuote(input: RelayFundingRequest, response: unknown): RelayFundingQuote {
  const expected = relayFundingRequest(input);
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed bridge quote.');
    return value as Record<string, unknown>;
  };
  const uint = (value: unknown) => {
    if (typeof value !== 'string' || !/^[1-9][0-9]{0,35}$/.test(value) || BigInt(value) >= 1n << 120n) throw new Error('Invalid bridge amount.');
    return BigInt(value);
  };
  const same = (value: unknown, wanted: string) => typeof value === 'string' && getAddress(value) === wanted;
  const data = object(response);
  const details = object(data.details);
  const incoming = object(details.currencyIn); const outgoing = object(details.currencyOut);
  const origin = object(incoming.currency); const destination = object(outgoing.currency);
  if (!same(details.recipient, expected.recipient) || !same(details.sender, expected.user)
    || origin.chainId !== expected.originChainId || destination.chainId !== expected.destinationChainId
    || !same(origin.address, expected.originCurrency) || !same(destination.address, expected.destinationCurrency)
    || uint(incoming.amount) !== input.amount || uint(outgoing.minimumAmount) < input.minimumOutput
    || uint(outgoing.amount) < uint(outgoing.minimumAmount)) throw new Error('Bridge quote does not match the expected funding route.');
  if (!Array.isArray(data.steps) || data.steps.length !== 1) throw new Error('Unexpected bridge execution steps.');
  const step = object(data.steps[0]);
  if (step.id !== 'deposit' || typeof step.requestId !== 'string' || !/^0x[0-9a-f]{64}$/i.test(step.requestId)
    || typeof step.depositAddress !== 'string') throw new Error('Missing bridge deposit instructions.');
  const depositAddress = address(step.depositAddress);
  if (depositAddress === expected.recipient || depositAddress === expected.refundTo) throw new Error('Invalid bridge deposit address.');
  return { provider: 'relay', depositAddress, requestId: step.requestId,
    originChainId: input.originChainId, originToken: expected.originCurrency, amount: String(input.amount),
    destinationChainId: input.destinationChainId, destinationToken: expected.destinationCurrency,
    destinationAddress: expected.recipient, recoveryOwner: expected.recoveryAddress,
    expectedOutput: String(uint(outgoing.amount)), minimumOutput: String(uint(outgoing.minimumAmount)) };
}
