import { AbiCoder, Contract, Interface, ZeroAddress, concat, getAddress, getCreate2Address,
  hexlify, keccak256, randomBytes } from 'ethers';
import type { Provider, Signer, TransactionResponse } from 'ethers';

export interface Deployment {
  multiAsset?: boolean;
  chainId: bigint;
  factory: string;
  implementation: string;
  validator: string;
  executor: string;
  pool: string;
  poolImplementation: {address: string; codeHash: string} | null;
  assetImplementation?: {address: string; codeHash: string} | null;
  asset: string;
  maxGasFee: bigint;
  codeHashes: Record<'factory' | 'implementation' | 'validator' | 'executor' | 'pool' | 'asset', string>;
}
export interface DepositTerms { recovery: string; relayer: string; feeRecipient: string }
export interface DepositConfig extends DepositTerms { recipient: string }
export interface TokenApproval { token: string; codeHash: string; implementation: Deployment['poolImplementation']; standard: true }
export interface DepositQuote { token: string; amount: bigint; gasFee: bigint; deadline: bigint; native?: boolean; approval?: TokenApproval }
export interface DepositRecord extends Deployment {
  protocol: 'railgun'; address: string; salt: string; config: DepositConfig; fundingBlock?: number;
}
export interface DepositExecution extends DepositRecord {
  quote: DepositQuote;
}
export interface RuntimeArtifact { code: string; references: Record<string, {start: number; length: number}[]> }
export interface RecoveryArtifacts {
  // JSON imports infer string/number; the exact format/version are checked at runtime.
  format: string; version: number;
  contracts: Record<'factory' | 'implementation' | 'validator' | 'executor', RuntimeArtifact>;
}

export const abi = AbiCoder.defaultAbiCoder();
export const termsType = 'tuple(address relayer,address feeRecipient,bytes32 recipientHash)';
export const assetQuoteType = 'tuple(address token,bool native,uint120 amount,uint120 gasFee,uint48 deadline)';
export const quoteType = 'tuple(uint120 amount,uint120 gasFee,uint48 deadline)';
export const batchMode = `0x01${'00'.repeat(31)}`;
export const executionsType = 'tuple(address target,uint256 value,bytes callData)[]';
export const implementationSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export const kernelABI = new Interface([
  'function initialize(bytes21,address,bytes,bytes,bytes[])',
  'function installModule(uint256,address,bytes)', 'function uninstallModule(uint256,address,bytes)',
  'function execute(bytes32,bytes)', 'function rootValidator() view returns(bytes21)',
  'function executorConfig(address) view returns(address)',
]);
export const factoryABI = new Interface([
  'function createAccount(bytes,bytes32) payable returns(address)',
  'function getAddress(bytes,bytes32) view returns(address)', 'function implementation() view returns(address)',
]);
export const executorABI = new Interface([
  `function deployAndExecuteAsset(bytes,bytes32,bytes,${assetQuoteType}) returns(address)`,
  `function executeAsset(address,bytes,${assetQuoteType})`,
  'function multiAsset() pure returns(bool)', 'function maxTokenGasFeeBps() view returns(uint256)',
  `function deployAndExecute(bytes,bytes32,bytes,${quoteType}) returns(address)`,
  `function execute(address,bytes,${quoteType})`,
  'function terms(address) view returns(address relayer,address feeRecipient,bytes32 recipientHash)',
  'function installed(address) view returns(bool)', 'function spent(address) view returns(bool)',
  'function factory() view returns(address)', 'function pool() view returns(address)',
  'function asset() view returns(address)', 'function maxGasFee() view returns(uint120)',
]);
export const tokenABI = new Interface([
  'function balanceOf(address) view returns(uint256)', 'function transfer(address,uint256) returns(bool)',
]);
const same = (a: string, b: string) => getAddress(a) === getAddress(b);
export function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// Solady's exact ERC1967 proxy creation code, from the pinned Kernel dependency.
export function proxyInitCode(implementation: string) {
  return concat(['0x603d3d8160223d3973', getAddress(implementation),
    '0x60095155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3']);
}
export function initialData(deployment: Deployment, config: DepositConfig) {
  for (const value of [config.recovery, config.relayer, config.feeRecipient]) {
    requireThat(!same(value, ZeroAddress), 'Zero owner, relayer or fee recipient.');
  }
  requireThat(!same(config.feeRecipient, deployment.pool), 'The fee recipient cannot be the pool.');
  requireThat(/^0x[\da-fA-F]{320}$/.test(config.recipient), 'Invalid encrypted recipient instructions.');
  const terms = { relayer: config.relayer, feeRecipient: config.feeRecipient, recipientHash: keccak256(config.recipient) };
  const install = kernelABI.encodeFunctionData('installModule', [2, deployment.executor,
    concat([ZeroAddress, abi.encode(['bytes', 'bytes'], [abi.encode([termsType], [terms]), '0x'])])]);
  return kernelABI.encodeFunctionData('initialize', [concat(['0x01', deployment.validator]),
    ZeroAddress, config.recovery, '0x', [install]]);
}
export function predictAddress(deployment: Deployment, config: DepositConfig, salt: string) {
  requireThat(/^0x[\da-fA-F]{64}$/.test(salt), 'Invalid account salt.');
  return getCreate2Address(deployment.factory, keccak256(concat([initialData(deployment, config), salt])),
    keccak256(proxyInitCode(deployment.implementation)));
}

function normalizedRuntime(code: string, artifact: RuntimeArtifact) {
  requireThat(/^0x[\da-fA-F]+$/.test(code) && code.length === artifact.code.length, 'Wrong contract runtime length.');
  let result = code.toLowerCase();
  for (const references of Object.values(artifact.references)) for (const {start, length} of references) {
    requireThat(Number.isSafeInteger(start) && length === 32 && start >= 0 && 2 + (start + length) * 2 <= result.length,
      'Invalid trusted artifact offsets.');
    result = result.slice(0, 2 + start * 2) + '0'.repeat(length * 2) + result.slice(2 + (start + length) * 2);
  }
  return result;
}
export async function verifyDeployment(provider: Provider, deployment: Deployment, artifacts?: RecoveryArtifacts, recoveryOnly = false) {
  requireThat((await provider.getNetwork()).chainId === deployment.chainId, 'Wrong chain.');
  requireThat(deployment.maxGasFee >= 0n && deployment.maxGasFee < 1n << 120n, 'Invalid gas policy.');
  // Owner recovery must continue when the pool is paused, upgraded or unavailable.
  if (!recoveryOnly) {
    for (const role of ['pool', 'asset'] as const) {
      const implementation = getAddress(`0x${(await provider.getStorage(deployment[role], implementationSlot)).slice(-40)}`);
      const pin = role === 'pool' ? deployment.poolImplementation : deployment.assetImplementation;
      if (pin) requireThat(same(implementation, pin.address)
        && keccak256(await provider.getCode(implementation)) === pin.codeHash, `${role} implementation changed.`);
      else requireThat(implementation === ZeroAddress, `A proxy ${role} requires an implementation pin.`);
    }
  }
  if (artifacts) requireThat(artifacts.format === 'puddle-kernel-artifacts' && artifacts.version === 1, 'Wrong trusted artifacts.');
  const names = recoveryOnly ? ['factory', 'implementation', 'validator', 'executor'] as const
    : ['factory', 'implementation', 'validator', 'executor', 'pool', 'asset'] as const;
  for (const name of names) {
    const code = await provider.getCode(deployment[name]);
    requireThat(code !== '0x' && keccak256(code) === deployment.codeHashes[name], `Wrong ${name} code.`);
    if (artifacts && name in artifacts.contracts) {
      const artifact = artifacts.contracts[name as keyof typeof artifacts.contracts];
      requireThat(normalizedRuntime(code, artifact) === normalizedRuntime(artifact.code, artifact), `Unrecognized ${name} build.`);
    }
  }
  const factory = new Contract(deployment.factory, factoryABI, provider);
  requireThat(same(await factory.getFunction('implementation')(), deployment.implementation), 'Wrong factory implementation.');
  const module = new Contract(deployment.executor, executorABI, provider);
  for (const name of ['factory', 'pool', 'asset'] as const) {
    requireThat(same(await module.getFunction(name)(), deployment[name]), `Wrong executor ${name}.`);
  }
  requireThat(await module.getFunction('maxGasFee')() === deployment.maxGasFee, 'Wrong executor gas cap.');
  if (deployment.multiAsset) requireThat(await module.getFunction('multiAsset')() === true
    && await module.getFunction('maxTokenGasFeeBps')() === 500n, 'Wrong multi-asset policy.');
}
export async function verifyAccount(provider: Provider, record: DepositRecord, checkExecutor = true) {
  requireThat(record.address === predictAddress(record, record.config, record.salt), 'Account configuration/address mismatch.');
  const code = await provider.getCode(record.address);
  if (code === '0x') return false;
  requireThat(code.toLowerCase() === `0x${proxyInitCode(record.implementation).slice(2 + 34 * 2)}`.toLowerCase(), 'Wrong Kernel proxy code.');
  requireThat(same(`0x${(await provider.getStorage(record.address, implementationSlot)).slice(-40)}`, record.implementation), 'Kernel implementation changed.');
  const account = new Contract(record.address, kernelABI, provider);
  requireThat((await account.getFunction('rootValidator')()).toLowerCase() === concat(['0x01', record.validator]).toLowerCase(), 'Kernel owner validator changed.');
  const owner = await new Contract(record.validator, ['function ecdsaValidatorStorage(address) view returns(address)'], provider)
    .getFunction('ecdsaValidatorStorage')(record.address);
  requireThat(same(owner, record.config.recovery), 'Kernel recovery owner changed.');
  if (checkExecutor) {
    requireThat(same(await account.getFunction('executorConfig')(record.executor), '0x0000000000000000000000000000000000000001'), 'Deposit executor removed or changed.');
    const module = new Contract(record.executor, executorABI, provider);
    requireThat(await module.getFunction('installed')(record.address), 'Deposit executor not initialized.');
    const terms = await module.getFunction('terms')(record.address);
    requireThat(same(terms.relayer, record.config.relayer) && same(terms.feeRecipient, record.config.feeRecipient)
      && terms.recipientHash === keccak256(record.config.recipient), 'Executor terms changed.');
  }
  return true;
}
export function createRecord(deployment: Deployment, config: DepositConfig, salt = hexlify(randomBytes(32))): DepositRecord {
  const address = predictAddress(deployment, config, salt);
  requireThat(!same(address, config.relayer) && !same(address, config.feeRecipient), 'Invalid settlement parties.');
  return { ...deployment, codeHashes: { ...deployment.codeHashes }, protocol: 'railgun', config: { ...config }, salt, address };
}
export async function validateDeposit(adapter: {deployment: Readonly<Deployment>}, record: DepositRecord, provider: Provider) {
  const expected = adapter.deployment;
  requireThat(!!record.multiAsset === !!expected.multiAsset, 'Wrong asset mode.');
  requireThat(record.protocol === 'railgun' && record.chainId === expected.chainId && record.maxGasFee === expected.maxGasFee,
    'Wrong deposit route.');
  requireThat(expected.poolImplementation ? record.poolImplementation
    && same(record.poolImplementation.address, expected.poolImplementation.address)
    && record.poolImplementation.codeHash === expected.poolImplementation.codeHash : record.poolImplementation === null,
  'Wrong pool implementation pin.');
  requireThat(expected.assetImplementation ? record.assetImplementation
    && same(record.assetImplementation.address, expected.assetImplementation.address)
    && record.assetImplementation.codeHash === expected.assetImplementation.codeHash : !record.assetImplementation,
  'Wrong asset implementation pin.');
  for (const name of ['factory', 'implementation', 'validator', 'executor', 'pool', 'asset'] as const) {
    requireThat(same(record[name], expected[name]) && record.codeHashes[name] === expected.codeHashes[name], 'Wrong deposit deployment.');
  }
  await verifyDeployment(provider, expected);
  await verifyAccount(provider, record);
}
export async function inspectDeposit(adapter: {deployment: Readonly<Deployment>}, deposit: DepositExecution, provider: Provider) {
  await validateDeposit(adapter, deposit, provider);
  const balance: bigint = deposit.quote.native ? await provider.getBalance(deposit.address)
    : await new Contract(deposit.quote.token, tokenABI, provider).getFunction('balanceOf')(deposit.address);
  const spent: boolean = await new Contract(deposit.executor, executorABI, provider).getFunction('spent')(deposit.address);
  return { deployed: await provider.getCode(deposit.address) !== '0x', spent, balance,
    ready: !spent && balance >= deposit.quote.amount };
}
export async function validateQuote(provider: Provider, deployment: Deployment, quote: DepositQuote) {
  requireThat((deployment.multiAsset || same(quote.token, deployment.asset)) && quote.amount > 0n && quote.amount < 1n << 120n
    && quote.gasFee >= 0n && (deployment.multiAsset && !same(quote.token, deployment.asset) ? quote.gasFee <= quote.amount / 20n : quote.gasFee <= deployment.maxGasFee) && quote.gasFee + quote.amount / 1000n < quote.amount
    && quote.deadline > 0n && quote.deadline < 1n << 48n, 'Invalid amount, asset, fee or expiry.');
  if (deployment.multiAsset) {
    requireThat(!quote.native || same(quote.token, deployment.asset), 'Native deposits require the pinned wrapped native token.');
    requireThat(quote.gasFee <= quote.amount / 20n, 'Token gas reimbursement exceeds 5%.');
    const approval = quote.approval;
    requireThat(approval?.standard === true && same(approval.token, quote.token), 'A reviewed standard-token approval is required.');
    requireThat(/^0x[\da-f]{64}$/.test(approval.codeHash) && await provider.getCode(quote.token) !== '0x'
      && keccak256(await provider.getCode(quote.token)) === approval.codeHash, 'Token code changed.');
    const implementation = getAddress(`0x${(await provider.getStorage(quote.token, implementationSlot)).slice(-40)}`);
    requireThat(approval.implementation ? same(implementation, approval.implementation.address)
      && keccak256(await provider.getCode(implementation)) === approval.implementation.codeHash : implementation === ZeroAddress, 'Token implementation changed.');
  } else requireThat(!quote.native && !quote.approval, 'This executor accepts its configured ERC-20 only.');
  const block = await provider.getBlock('latest');
  requireThat(block && BigInt(block.timestamp) <= quote.deadline, 'Deposit quote expired.');
}
export async function relayDeposit(adapter: {deployment: Readonly<Deployment>}, deposit: DepositExecution, signer: Signer) {
  requireThat(signer.provider && same(await signer.getAddress(), deposit.config.relayer), 'Connect the designated relayer wallet.');
  const state = await inspectDeposit(adapter, deposit, signer.provider);
  requireThat(!state.spent && state.ready, 'Account already used or insufficiently funded.');
  await validateQuote(signer.provider, deposit, deposit.quote);
  return signer.sendTransaction({ to: deposit.executor, chainId: deposit.chainId, value: 0n,
    data: executorABI.encodeFunctionData(deposit.multiAsset ? 'deployAndExecuteAsset' : 'deployAndExecute', [initialData(deposit, deposit.config), deposit.salt,
      deposit.config.recipient, deposit.multiAsset ? {...deposit.quote, native: !!deposit.quote.native} : deposit.quote]) });
}
export async function mined(transaction: Promise<TransactionResponse>) {
  const receipt = await (await transaction).wait();
  requireThat(receipt?.status === 1, 'Transaction did not succeed.');
  return receipt;
}
