import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { JsonRpcProvider } from 'ethers';
import { validateRailgunSiteConfiguration, siteDeployment } from '../app/configuration.ts';
import type { RailgunSiteConfiguration } from '../app/configuration.ts';
import { verifyDeployment } from '../sdk/index.ts';
import type { RecoveryArtifacts } from '../sdk/index.ts';
import { buildHash, verifySdkBuild } from '../sdk/verify-build.mjs';
import { recoveryArtifacts } from './artifacts.ts';

export interface SiteRelease {
  format: 'puddle-site-release'; version: 1;
  configuration: RailgunSiteConfiguration;
  artifacts: RecoveryArtifacts;
  sourceHashes: Record<string, string>;
  sdkBuildHash: string;
}
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const critical = ['contracts/RailgunExecutor.sol', 'contracts/KernelImports.sol', 'sdk/index.ts', 'sdk/kernel.ts',
  'sdk/receive.ts', 'sdk/recovery.ts', 'sdk/recipient.ts', 'scripts/build-sdk.ts', 'scripts/artifacts.ts',
  'scripts/setup.ts', 'foundry.toml', 'package.json', 'package-lock.json', 'sdk/package.json'];

/** Public manual-pilot fields only. Never copy profiles or server credentials. */
export function publicSiteConfiguration(input: RailgunSiteConfiguration): RailgunSiteConfiguration {
  const value = validateRailgunSiteConfiguration(input);
  check(!value.bridgeOrigins?.length, 'Public bridging remains disabled pending funded route/recovery tests.');
  check(value.mode === 'pilot', 'A public receiving build must use pilot mode, without demo wallets.');
  const gasFee = BigInt(value.gasFee), feeFloor = gasFee + gasFee / 999n + 1n;
  const minimum = BigInt(value.minAmount ?? '1') > feeFloor ? BigInt(value.minAmount!) : feeFloor;
  check(gasFee <= BigInt(value.maxGasFee) && minimum <= BigInt(value.maxAmount), 'Public pilot amount/fee limits cannot produce a valid deposit.');
  return JSON.parse(JSON.stringify({
    chainId: value.chainId, chainName: value.chainName, rpcUrl: value.rpcUrl, rpcTransport: 'direct',
    factory: value.factory, implementation: value.implementation, validator: value.validator,
    executor: value.executor, pool: value.pool, token: value.token, codeHashes: {...value.codeHashes},
    poolImplementation: value.poolImplementation ? {address: value.poolImplementation.address, codeHash: value.poolImplementation.codeHash} : null,
    assetImplementation: value.assetImplementation ? {address: value.assetImplementation.address, codeHash: value.assetImplementation.codeHash} : null,
    maxGasFee: value.maxGasFee, relayer: value.relayer, feeRecipient: value.feeRecipient,
    symbol: value.symbol, decimals: value.decimals, gasFee: value.gasFee, maxAmount: value.maxAmount,
    minAmount: String(minimum), automaticRelay: false, mode: 'pilot',
  })) as RailgunSiteConfiguration;
}

function publicInputs(manifest: {inputs: Record<string, string>}) {
  return Object.fromEntries(Object.entries(manifest.inputs).filter(([path]) => !path.startsWith('.cache/')));
}
function exactKeys(value: unknown, keys: string[]) {
  check(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value!, key)), 'Unexpected site-release fields.');
}

/** Validate a reviewed release without requiring a compiler or the SDK build cache. */
export async function validateSiteRelease(input: SiteRelease, compareCompiled = false) {
  exactKeys(input, ['format', 'version', 'configuration', 'artifacts', 'sourceHashes', 'sdkBuildHash']);
  check(input.format === 'puddle-site-release' && input.version === 1, 'Unsupported site release.');
  check(isDeepStrictEqual(input.configuration, publicSiteConfiguration(input.configuration)), 'Site release contains nonpublic or noncanonical configuration.');
  const artifacts = input.artifacts;
  exactKeys(artifacts, ['format', 'version', 'contracts']);
  check(artifacts.format === 'puddle-kernel-artifacts' && artifacts.version === 1, 'Unsupported release artifacts.');
  exactKeys(artifacts.contracts, ['factory', 'implementation', 'validator', 'executor']);
  for (const contract of Object.values(artifacts.contracts)) {
    exactKeys(contract, ['code', 'references']);
    check(typeof contract.code === 'string' && /^0x(?:[\da-fA-F]{2})+$/.test(contract.code)
      && contract.code.length <= 100_000, 'Invalid released contract runtime.');
    check(contract.references && typeof contract.references === 'object' && !Array.isArray(contract.references), 'Invalid immutable references.');
    for (const [id, offsets] of Object.entries(contract.references)) {
      check(/^\d+$/.test(id) && Array.isArray(offsets), 'Invalid immutable reference entry.');
      for (const offset of offsets) {
        exactKeys(offset, ['start', 'length']);
        check(Number.isSafeInteger(offset.start) && offset.start >= 0 && offset.length === 32
          && 2 + (offset.start + offset.length) * 2 <= contract.code.length, 'Invalid immutable reference offset.');
      }
    }
  }
  check(input.sourceHashes && typeof input.sourceHashes === 'object' && !Array.isArray(input.sourceHashes)
    && critical.every(path => Object.hasOwn(input.sourceHashes, path)), 'Missing site-release source bindings.');
  check(typeof input.sdkBuildHash === 'string' && /^[\da-f]{64}$/.test(input.sdkBuildHash), 'Invalid SDK build digest.');
  for (const [path, hash] of Object.entries(input.sourceHashes)) {
    check(/^[A-Za-z0-9_./-]+$/.test(path) && !path.startsWith('.') && !path.startsWith('/')
      && !path.split('/').includes('..') && typeof hash === 'string' && /^[\da-f]{64}$/.test(hash), 'Unsafe site-release input binding.');
    check(buildHash(await readFile(path)) === hash, `Site-release source changed: ${path}`);
  }
  if (compareCompiled) {
    await verifySdkBuild(); const bytes = await readFile('sdk/dist/build.json');
    check(buildHash(bytes) === input.sdkBuildHash && isDeepStrictEqual(publicInputs(JSON.parse(bytes.toString())), input.sourceHashes)
      && isDeepStrictEqual(recoveryArtifacts(), artifacts), 'Site release does not match the independently compiled SDK artifacts.');
  }
  return input;
}

/** Read-only chain preflight; write no personal profile, account salt or recipient. */
export async function createSiteRelease(input: RailgunSiteConfiguration): Promise<SiteRelease> {
  await verifySdkBuild();
  const configuration = publicSiteConfiguration(input), artifacts = recoveryArtifacts();
  const provider = new JsonRpcProvider(configuration.rpcUrl, undefined, {batchMaxCount: 1, cacheTimeout: -1});
  try { await verifyDeployment(provider, siteDeployment(configuration), artifacts); } finally { provider.destroy(); }
  const bytes = await readFile('sdk/dist/build.json');
  return validateSiteRelease({format: 'puddle-site-release', version: 1, configuration, artifacts,
    sdkBuildHash: buildHash(bytes), sourceHashes: publicInputs(JSON.parse(bytes.toString()))}, true);
}
export async function readSiteRelease(path: string) {
  const bytes = await readFile(path); check(bytes.length <= 512_000, 'Site release is too large.');
  return validateSiteRelease(JSON.parse(bytes.toString()) as SiteRelease);
}
export function requirePublicArbitrum(configuration: RailgunSiteConfiguration) {
  check(configuration.chainId === '42161' && configuration.rpcUrl === 'https://arb1.arbitrum.io/rpc',
    'The reviewed public pilot route uses Arbitrum One and its public RPC.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, output] = process.argv.slice(2);
  check(source && output, 'Usage: node scripts/site-release.ts REVIEWED_PUBLIC_CONFIGURATION NEW_RELEASE_JSON');
  const configuration = JSON.parse(await readFile(source, 'utf8')) as RailgunSiteConfiguration;
  requirePublicArbitrum(configuration);
  const release = await createSiteRelease(configuration);
  await writeFile(output, json(release), {flag: 'wx', mode: 0o600});
  console.log('Public route release saved. It contains no recipient or recovery profile.');
}
