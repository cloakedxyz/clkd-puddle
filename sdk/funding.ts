import { Contract, ZeroAddress, getAddress, id, keccak256, zeroPadValue } from 'ethers';
import type { Provider } from 'ethers';
import { createRailgunAdapter } from './receive.ts';
import { createRecoveryFile, inspectRecovery } from './recovery.ts';
import { implementationSlot, requireThat, verifyDeployment } from './kernel.ts';
import type { Deployment, DepositRecord, RecoveryArtifacts, TokenApproval } from './kernel.ts';
import type { RailgunInput } from './receive.ts';

export interface FundingAsset {
  /** Zero address means native ETH; its private asset is the pinned wrapped native token. */
  token: string; balance: bigint; symbol: string; decimals: number | null;
  codeHash: string; implementation: Deployment['poolImplementation'];
}

/** Prepare and back up a token-independent address, without an amount quote. */
export async function prepareFlexibleReceive(provider: Provider, deployment: Deployment,
  input: RailgunInput, artifacts: RecoveryArtifacts) {
  requireThat(deployment.multiAsset === true, 'A multi-asset executor is required.');
  await verifyDeployment(provider, deployment, artifacts);
  const record = await createRailgunAdapter(deployment).prepare(provider, input);
  const recovery = createRecoveryFile(record);
  await inspectRecovery(provider, recovery, artifacts);
  return {record, recovery};
}

/** Metadata and code observations are not an approval of the token's economic behavior. */
export async function readFundingAsset(provider: Provider, address: string, tokenAddress: string): Promise<FundingAsset> {
  const token = getAddress(tokenAddress);
  if (token === ZeroAddress) return {token, balance: await provider.getBalance(address), symbol: 'ETH', decimals: 18,
    codeHash: '0x' + '0'.repeat(64), implementation: null};
  const code = await provider.getCode(token);
  requireThat(code !== '0x', 'Token has no contract code.');
  const contract = new Contract(token, ['function balanceOf(address) view returns(uint256)',
    'function decimals() view returns(uint8)', 'function symbol() view returns(string)'], provider);
  const balance: bigint = await contract.getFunction('balanceOf')(address);
  let decimals: number | null = null;
  try {decimals = Number(await contract.getFunction('decimals')());} catch { /* Optional ERC-20 metadata: use base units. */ }
  let symbol = token.slice(0, 10);
  try { const value: unknown = await contract.getFunction('symbol')();
    if (typeof value === 'string' && /^[A-Za-z0-9 ._-]{1,24}$/.test(value)) symbol = value;
  } catch { /* Metadata is optional; use the contract address as the label. */ }
  const implementation = getAddress('0x' + (await provider.getStorage(token, implementationSlot)).slice(-40));
  return {token, balance, symbol, decimals, codeHash: keccak256(code), implementation: implementation === ZeroAddress ? null
    : {address: implementation, codeHash: keccak256(await provider.getCode(implementation))}};
}

/** Scan Transfer logs in bounded pages. A fabricated log never substitutes for balanceOf. */
export async function discoverFunding(provider: Provider, record: DepositRecord,
  options: {fromBlock?: number; toBlock?: number; tokens?: string[]} = {}) {
  const fromBlock = options.fromBlock ?? record.fundingBlock;
  const toBlock = options.toBlock ?? await provider.getBlockNumber();
  requireThat(Number.isSafeInteger(fromBlock) && fromBlock! >= 0 && Number.isSafeInteger(toBlock)
    && toBlock >= fromBlock! && toBlock - fromBlock! <= 20_000, 'Scan at most 20,000 blocks and persist the next block.');
  const tokens = new Set([ZeroAddress, record.asset, ...(options.tokens ?? []).map(getAddress)]);
  requireThat(tokens.size <= 128, 'Too many token candidates.');
  for (let block = fromBlock!; block <= toBlock; block += 1000) {
    const logs = await provider.getLogs({fromBlock: block, toBlock: Math.min(block + 999, toBlock),
      topics: [id('Transfer(address,address,uint256)'), null, zeroPadValue(record.address, 32)]});
    for (const log of logs) {
      // ERC-721 shares the event signature but has an indexed fourth topic.
      if (log.topics.length !== 3 || !/^0x[\da-fA-F]{64}$/.test(log.data)) continue;
      tokens.add(getAddress(log.address));
      requireThat(tokens.size <= 128, 'Too many token candidates; use explicit token balance checks.');
    }
  }
  const assets: FundingAsset[] = [], unreadable: string[] = [];
  for (const token of tokens) {
    try { const asset = await readFundingAsset(provider, record.address, token); if (asset.balance > 0n) assets.push(asset); }
    catch { unreadable.push(token); }
  }
  return {assets, unreadable, nextBlock: toBlock + 1};
}

/** Approval must come from the wallet/operator's reviewed token policy, not discovery metadata. */
export async function quoteFunding(provider: Provider, record: DepositRecord, funding: FundingAsset,
  approval: TokenApproval, gasFee = 0n) {
  requireThat(record.multiAsset === true && funding.balance > 0n, 'No multi-asset funding.');
  const native = getAddress(funding.token) === ZeroAddress;
  const token = native ? record.asset : getAddress(funding.token);
  requireThat(getAddress(approval.token) === token, 'Approval is for another token.');
  requireThat(!await new Contract(record.pool, ['function tokenBlocklist(address) view returns(bool)'], provider)
    .getFunction('tokenBlocklist')(token), 'RAILGUN excludes this token.');
  const block = await provider.getBlock('latest'); requireThat(block, 'Could not read the chain.');
  return createRailgunAdapter(record).quote(provider, record, {token, native, amount: funding.balance,
    gasFee, deadline: BigInt(block.timestamp + 3600), approval});
}
