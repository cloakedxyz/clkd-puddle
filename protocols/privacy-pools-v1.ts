import { AbiCoder, Contract, ZeroAddress, getAddress } from 'ethers';
import type { Provider } from 'ethers';
import { createDepositAdapter, prepareRecord, quoteDeposit } from './deposit.ts';
import type { Deployment, DepositExecution, DepositQuote, DepositRecord, DepositTerms } from './deposit.ts';
import { decodeV1Recipient, v1EntrypointABI, v1Field, v1PoolABI, v1PoolAsset, v1RecipientTypes } from './privacy-pools-v1-data.ts';

export type PrivacyPoolsV1Address = DepositRecord<'privacy-pools-v1'>;
export type PrivacyPoolsV1Deposit = DepositExecution<'privacy-pools-v1'>;
export interface PrivacyPoolsV1Input extends DepositTerms { token: string; precommitment: bigint }

/** Current pool rules. Read again before relay: registration, fees and minimums can change. */
export async function readV1Pool(provider: Provider, deployment: Deployment, asset: string) {
  if ((await provider.getNetwork()).chainId !== deployment.chainId) throw new Error('Wrong deposit chain.');
  const entrypoint = getAddress(deployment.pool);
  const token = getAddress(asset);
  const config = await new Contract(entrypoint, v1EntrypointABI, provider)
    .getFunction('assetConfig')(v1PoolAsset(token));
  const address = getAddress(config.pool);
  if (address === ZeroAddress) throw new Error('Unsupported v1 asset.');
  const pool = new Contract(address, v1PoolABI, provider);
  const [poolAsset, poolEntrypoint, dead] = await Promise.all([
    pool.getFunction('ASSET')(), pool.getFunction('ENTRYPOINT')(), pool.getFunction('dead')(),
  ]);
  if (getAddress(poolAsset) !== v1PoolAsset(token) || getAddress(poolEntrypoint) !== entrypoint || dead) {
    throw new Error('Invalid or closed v1 pool.');
  }
  const minimumDepositAmount = BigInt(config.minimumDepositAmount);
  const vettingFeeBPS = BigInt(config.vettingFeeBPS);
  if (minimumDepositAmount < 0n || vettingFeeBPS < 0n || vettingFeeBPS >= 10_000n) {
    throw new Error('Invalid v1 pool fees or minimum.');
  }
  return { address, minimumDepositAmount, vettingFeeBPS };
}

/** Smallest funding amount whose pool transfer meets the minimum, with exact integer fees. */
export function minimumV1Funding(poolMinimum: bigint, gasFee: bigint): bigint {
  if (poolMinimum < 0n || gasFee < 0n) throw new Error('Invalid minimum or gas charge.');
  // A deposit must leave a positive pool balance even when the configured minimum is zero.
  const required = (poolMinimum > 0n ? poolMinimum : 1n) + gasFee;
  const amount = required + (required - 1n) / 999n;
  if (amount >= 1n << 120n) throw new Error('Minimum exceeds the supported deposit amount.');
  return amount;
}

export function createPrivacyPoolsV1Adapter(configuration: Deployment) {
  const common = createDepositAdapter('privacy-pools-v1', configuration);
  const { deployment } = common;
  const adapter = {
    ...common,
    async validateExecution(deposit: PrivacyPoolsV1Deposit, provider: Provider) {
      await common.validateExecution(deposit, provider);
      const recipient = decodeV1Recipient(deposit.config.recipient);
      if (getAddress(deposit.quote.token) !== recipient.token || deposit.data !== '0x') {
        throw new Error('Quote does not match the v1 deposit instructions.');
      }
      const entrypoint = new Contract(deployment.pool, v1EntrypointABI, provider);
      const [pool, used] = await Promise.all([
        readV1Pool(provider, deployment, recipient.token),
        entrypoint.getFunction('usedPrecommitments')(recipient.precommitment),
      ]);
      const amount = deposit.quote.amount - deposit.quote.amount / 1000n - deposit.quote.gasFee;
      if (pool.address !== recipient.pool || amount < pool.minimumDepositAmount
        || amount - amount * pool.vettingFeeBPS / 10_000n <= 0n || used) {
        throw new Error('V1 pool unavailable, deposit too small, or deposit hash already used.');
      }
    },
    async prepare(provider: Provider, input: PrivacyPoolsV1Input): Promise<PrivacyPoolsV1Address> {
      if (input.precommitment <= 0n || input.precommitment >= v1Field) throw new Error('Invalid v1 deposit hash.');
      const token = getAddress(input.token);
      const pool = await readV1Pool(provider, deployment, token);
      return prepareRecord(adapter, provider, { recipient: AbiCoder.defaultAbiCoder().encode(v1RecipientTypes,
        [token, pool.address, input.precommitment]), recovery: input.recovery,
        relayer: input.relayer, feeRecipient: input.feeRecipient });
    },
    quote(provider: Provider, address: PrivacyPoolsV1Address, quote: DepositQuote) {
      return quoteDeposit(adapter, provider, address, quote);
    },
  };
  return adapter;
}
