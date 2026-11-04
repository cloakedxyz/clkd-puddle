import type { Deployment } from '../sdk/index.ts';
import { getAddress, ZeroAddress } from 'ethers';

export interface RailgunSiteConfiguration {
  chainId: string;
  chainName: string;
  rpcUrl: string;
  factory: string;
  pool: string;
  poolImplementation: Deployment['poolImplementation'];
  assetImplementation?: Deployment['assetImplementation'];
  implementation: string;
  validator: string;
  executor: string;
  maxGasFee: string;
  codeHashes: Deployment['codeHashes'];
  relayer: string;
  feeRecipient: string;
  token: string;
  symbol: string;
  decimals: number;
  gasFee: string;
  maxAmount: string;
  minAmount?: string;
  mode: 'local' | 'pilot';
  bridgeOrigins?: { chainId: number; chainName: string; token: string; symbol: string; decimals: number }[];
  providerRecoveryAccepted?: boolean;
  automaticRelay?: boolean;
  rpcTransport?: 'proxy' | 'direct';
}

export function validateRailgunSiteConfiguration(value: RailgunSiteConfiguration): RailgunSiteConfiguration {
  if (value?.automaticRelay !== undefined && typeof value.automaticRelay !== 'boolean') throw new Error('Invalid automatic relay setting.');
  if (value?.rpcTransport !== undefined && !['proxy', 'direct'].includes(value.rpcTransport)) throw new Error('Invalid RPC transport.');
  if (!value || !/^[1-9][0-9]{0,15}$/.test(value.chainId)
    || !['local', 'pilot'].includes(value.mode)
    || typeof value.chainName !== 'string' || value.chainName.length > 60
    || typeof value.symbol !== 'string' || !/^[A-Za-z0-9. -]{1,16}$/.test(value.symbol)
    || !Number.isInteger(value.decimals) || value.decimals < 0 || value.decimals > 18
    || !/^(0|[1-9][0-9]{0,35})$/.test(value.gasFee)
    || !/^[1-9][0-9]{0,35}$/.test(value.maxAmount) || BigInt(value.maxAmount) >= 1n << 120n) {
    throw new Error('Invalid RAILGUN site configuration.');
  }
  if (value.minAmount !== undefined && (!/^[1-9][0-9]{0,35}$/.test(value.minAmount)
    || BigInt(value.minAmount) > BigInt(value.maxAmount))) throw new Error('Invalid minimum deposit amount.');
  if (value.automaticRelay && value.minAmount === undefined) throw new Error('Automatic deposits need a minimum amount.');
  if (!/^(0|[1-9][0-9]{0,35})$/.test(value.maxGasFee) || BigInt(value.maxGasFee) >= 1n << 120n
    || !value.codeHashes || Object.values(value.codeHashes).length !== 6
    || !['factory', 'implementation', 'validator', 'executor', 'pool', 'asset'].every(name =>
      /^0x[\da-f]{64}$/.test(value.codeHashes[name as keyof Deployment['codeHashes']]))) {
    throw new Error('Missing Kernel deployment pins.');
  }
  const rpc = new URL(value.rpcUrl);
  if (rpc.username || rpc.password || rpc.hash || (rpc.protocol !== 'https:'
    && !(rpc.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(rpc.hostname)))) {
    throw new Error('Use a public HTTPS RPC or a local test node.');
  }
  const result = { ...value };
  for (const key of ['factory', 'implementation', 'validator', 'executor', 'pool', 'relayer', 'feeRecipient', 'token'] as const) {
    result[key] = getAddress(value[key]);
    if (result[key] === ZeroAddress) throw new Error('A RAILGUN deployment requires nonzero contract and wallet addresses.');
  }
  if (value.mode === 'local' && value.chainId !== '31337') throw new Error('Local mode requires the isolated test chain.');
  if (value.bridgeOrigins !== undefined) {
    if (!Array.isArray(value.bridgeOrigins) || value.bridgeOrigins.length > 5
      || (value.bridgeOrigins.length > 0 && value.providerRecoveryAccepted !== true)) throw new Error('Bridge routes require an explicit provider recovery decision.');
    const chains = new Set<number>();
    result.bridgeOrigins = value.bridgeOrigins.map(origin => {
      if (!Number.isSafeInteger(origin.chainId) || origin.chainId <= 0 || String(origin.chainId) === value.chainId || chains.has(origin.chainId)
        || typeof origin.chainName !== 'string' || origin.chainName.length > 60 || origin.decimals !== value.decimals
        || origin.symbol !== value.symbol) throw new Error('Bridge routes must use the reviewed matching asset.');
      chains.add(origin.chainId);
      const token = getAddress(origin.token); if (token === ZeroAddress) throw new Error('Bridge funding currently supports ERC-20 tokens only.');
      return { ...origin, token };
    });
  }
  return result;
}

export function siteDeployment(value: RailgunSiteConfiguration): Deployment {
  return { chainId: BigInt(value.chainId), factory: value.factory, implementation: value.implementation,
    validator: value.validator, executor: value.executor, pool: value.pool, poolImplementation: value.poolImplementation,
    assetImplementation: value.assetImplementation ?? null, asset: value.token,
    maxGasFee: BigInt(value.maxGasFee), codeHashes: { ...value.codeHashes } };
}
