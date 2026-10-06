// Receiving-wallet fixture. Only tests generate or hold secrets; the Puddle UI receives the public code.
import { Contract, Mnemonic, randomBytes } from 'ethers';
import type { Provider } from 'ethers';
import { prepareV1PublicReceive } from '../../client/index.ts';
import type { Deployment, DepositQuote, DepositTerms, V1ReceiveCode } from '../../client/index.ts';
import { v1Field, v1PoolABI, v1EntrypointABI, v1PoolAsset } from '../../protocols/privacy-pools-v1-data.ts';
import { createV1NoteBackup, v1Precommitment } from '../../recovery/v1-note.ts';
import type { V1Secrets } from '../../recovery/v1-note.ts';
import { officialSDK } from './official-sdk.ts';

export async function receivingWallet(provider: Provider, deployment: Deployment, input: DepositTerms & DepositQuote,
  sdk = undefined as Awaited<ReturnType<typeof officialSDK>> | undefined) {
  sdk ??= await officialSDK();
  const mnemonic = Mnemonic.fromEntropy(randomBytes(32)).phrase;
  const config = await new Contract(deployment.pool, v1EntrypointABI, provider).getFunction('assetConfig')(v1PoolAsset(input.token));
  const scope: bigint = await new Contract(config.pool, v1PoolABI, provider).getFunction('SCOPE')();
  const secrets = sdk.generateDepositSecrets(sdk.generateMasterKeys(mnemonic), scope, 0n);
  const code: V1ReceiveCode = { format: 'privacy-pools-v1-receive', version: 1, chainId: String(deployment.chainId),
    entrypoint: deployment.pool, pool: config.pool, asset: input.token, precommitment: String(v1Precommitment(secrets)),
    recovery: input.recovery };
  return { ...await prepareV1PublicReceive(provider, deployment, input, code), code, mnemonic, scope,
    noteBackup: createV1NoteBackup(deployment.chainId, config.pool, secrets) };
}

// Random notes for contract tests. Real receiving wallets derive their own secrets.
export function createV1Secrets(): V1Secrets & { precommitment: bigint } {
  const random = () => {
    let value: bigint;
    do { value = BigInt('0x' + Array.from(randomBytes(32), b => b.toString(16).padStart(2, '0')).join('')); }
    while (value === 0n || value >= v1Field);
    return value;
  };
  const secrets = { nullifier: random(), secret: random() };
  return { ...secrets, precommitment: v1Precommitment(secrets) };
}
