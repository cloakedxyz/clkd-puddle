import { Contract, ZeroAddress, getAddress } from 'ethers';
import type { Provider, TransactionRequest } from 'ethers';
import { abi, batchMode, executionsType, factoryABI, initialData, kernelABI, predictAddress,
  requireThat, tokenABI, verifyAccount, verifyDeployment } from './kernel.ts';
import type { Deployment, DepositRecord, RecoveryArtifacts } from './kernel.ts';

type SavedDeployment = Omit<Deployment, 'chainId' | 'maxGasFee'> & {chainId: string; maxGasFee: string};
export interface RecoveryFile extends SavedDeployment {
  format: 'puddle-kernel-railgun-recovery'; version: 1 | 2; fundingBlock?: number; protocol: 'railgun';
  depositAddress: string; salt: string; config: DepositRecord['config'];
}
export function recoveryRecord(file: RecoveryFile): DepositRecord {
  const {format: _format, version: _version, depositAddress, ...saved} = file;
  return { ...saved, chainId: BigInt(file.chainId), maxGasFee: BigInt(file.maxGasFee), address: depositAddress };
}
export function createRecoveryFile(record: DepositRecord): RecoveryFile {
  return parseRecoveryFile(JSON.stringify({
    format: 'puddle-kernel-railgun-recovery', version: record.multiAsset ? 2 : 1, protocol: 'railgun',
    ...(record.multiAsset ? {multiAsset: true, fundingBlock: record.fundingBlock} : {}),
    chainId: String(record.chainId), maxGasFee: String(record.maxGasFee),
    factory: record.factory, implementation: record.implementation, validator: record.validator,
    executor: record.executor, pool: record.pool, asset: record.asset, codeHashes: record.codeHashes,
    poolImplementation: record.poolImplementation,
    assetImplementation: record.assetImplementation ?? null,
    depositAddress: record.address, salt: record.salt, config: record.config,
  }));
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  requireThat(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), 'Invalid recovery fields.');
  return value as Record<string, unknown>;
}
function address(value: unknown) {
  requireThat(typeof value === 'string' && /^0x[\da-fA-F]{40}$/.test(value) && getAddress(value) !== ZeroAddress, 'Invalid recovery address.');
  return getAddress(value);
}
function uint(value: unknown, bits: number) {
  requireThat(typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 1n << BigInt(bits), 'Invalid recovery number.');
  return value;
}
function implementationPin(value: unknown): Deployment['poolImplementation'] {
  if (value === null || value === undefined) return null;
  const pin = object(value, ['address', 'codeHash']);
  requireThat(typeof pin.codeHash === 'string' && /^0x[\da-f]{64}$/.test(pin.codeHash), 'Invalid implementation hash.');
  return {address: address(pin.address), codeHash: pin.codeHash};
}
export function parseRecoveryFile(text: string): RecoveryFile {
  requireThat(new TextEncoder().encode(text).length <= 16384, 'Recovery file is too large.');
  const input: unknown = JSON.parse(text);
  const multi = input && typeof input === 'object' && 'version' in input && input.version === 2;
  const hasAssetPin = input && typeof input === 'object' && Object.hasOwn(input, 'assetImplementation');
  const file = object(input, ['format', 'version', 'protocol', 'chainId', 'factory', 'implementation', 'validator',
    'executor', 'pool', 'poolImplementation', 'asset', 'maxGasFee', 'codeHashes', 'depositAddress', 'salt', 'config',
    ...(hasAssetPin ? ['assetImplementation'] : []), ...(multi ? ['multiAsset', 'fundingBlock'] : [])]);
  requireThat(file.format === 'puddle-kernel-railgun-recovery' && (file.version === 1 || file.version === 2) && file.protocol === 'railgun', 'Unsupported recovery format.');
  if (multi) requireThat(file.multiAsset === true && Number.isSafeInteger(file.fundingBlock) && (file.fundingBlock as number) >= 0, 'Invalid funding scan start.');
  const config = object(file.config, ['recipient', 'recovery', 'relayer', 'feeRecipient']);
  requireThat(typeof config.recipient === 'string' && /^0x[\da-fA-F]{320}$/.test(config.recipient), 'Invalid recipient instructions.');
  requireThat(typeof file.salt === 'string' && /^0x[\da-fA-F]{64}$/.test(file.salt), 'Invalid account salt.');
  const names = ['factory', 'implementation', 'validator', 'executor', 'pool', 'asset'] as const;
  const hashes = object(file.codeHashes, [...names]);
  for (const value of Object.values(hashes)) requireThat(typeof value === 'string' && /^0x[\da-f]{64}$/.test(value), 'Invalid code hash.');
  const result: RecoveryFile = {
    format: 'puddle-kernel-railgun-recovery', version: multi ? 2 : 1, protocol: 'railgun',
    ...(multi ? {multiAsset: true, fundingBlock: file.fundingBlock as number} : {}),
    chainId: uint(file.chainId, 64), maxGasFee: uint(file.maxGasFee, 120),
    ...Object.fromEntries(names.map(name => [name, address(file[name])])) as Pick<RecoveryFile, typeof names[number]>,
    poolImplementation: implementationPin(file.poolImplementation), assetImplementation: implementationPin(file.assetImplementation),
    codeHashes: hashes as Deployment['codeHashes'], depositAddress: address(file.depositAddress), salt: file.salt,
    config: { recipient: config.recipient, recovery: address(config.recovery), relayer: address(config.relayer), feeRecipient: address(config.feeRecipient) },
  };
  requireThat(BigInt(result.chainId) > 0n, 'Invalid recovery chain.');
  const record = recoveryRecord(result);
  requireThat(record.address === predictAddress(record, record.config, record.salt), 'Recovery account does not match its fixed terms.');
  return result;
}
export async function inspectRecovery(provider: Provider, input: RecoveryFile, artifacts: RecoveryArtifacts, asset = input.asset) {
  const file = parseRecoveryFile(JSON.stringify(input));
  const record = recoveryRecord(file);
  await verifyDeployment(provider, record, artifacts, true);
  const deployed = await verifyAccount(provider, record, false);
  const balance: bigint = getAddress(asset) === ZeroAddress ? await provider.getBalance(record.address)
    : await new Contract(asset, tokenABI, provider).getFunction('balanceOf')(record.address);
  return { deployed, balance, address: record.address, recovery: record.config.recovery };
}
export async function recoveryTransaction(provider: Provider, file: RecoveryFile, artifacts: RecoveryArtifacts,
  owner: string, asset = file.asset, action: 'deploy' | 'recover' = 'recover'): Promise<TransactionRequest> {
  const state = await inspectRecovery(provider, file, artifacts, asset);
  const record = recoveryRecord(file);
  requireThat(getAddress(owner) === record.config.recovery, 'Connect the recovery owner wallet.');
  const base = { from: record.config.recovery, chainId: record.chainId, value: 0n };
  if (action === 'deploy') {
    requireThat(!state.deployed, 'Kernel account is already deployed.');
    return { ...base, to: record.factory, data: factoryABI.encodeFunctionData('createAccount', [initialData(record, record.config), record.salt]) };
  }
  requireThat(state.deployed && state.balance > 0n, 'Deploy the account first, then recover its balance.');
  const calls = getAddress(asset) === ZeroAddress
    ? [{ target: record.config.recovery, value: state.balance, callData: '0x' }]
    : [{ target: getAddress(asset), value: 0n, callData: tokenABI.encodeFunctionData('transfer', [record.config.recovery, state.balance]) }];
  return { ...base, to: record.address, data: kernelABI.encodeFunctionData('execute', [batchMode, abi.encode([executionsType], [calls])]) };
}
