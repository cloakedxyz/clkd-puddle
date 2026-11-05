import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { createEnvironment, createRecipient, decryptDeposit, fund } from '../test/helpers.ts';

// A real consumer outside the repo catches missing files and accidental reliance
// on development dependencies that a source-tree import test would miss.
execFileSync(process.execPath, ['scripts/build-sdk.ts'], { stdio: 'pipe' });
await mkdir('.cache/release', { recursive: true });
const [packed] = JSON.parse(execFileSync('npm', ['pack', './sdk', '--pack-destination', '.cache/release', '--json'], { encoding: 'utf8' }));
const tarball = resolve('.cache/release', packed.filename);
const destination = await mkdtemp(join(tmpdir(), 'puddle-sdk-consumer-'));
await writeFile(join(destination, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: {
  '@cloakedxyz/puddle': `file:${tarball}`, ethers: '6.17.0',
} }));
execFileSync('npm', ['install', '--ignore-scripts', '--prefix', destination], { stdio: 'pipe', timeout: 120_000 });
const source = `import { prepareRailgunReceive, decodeRailgunAddress } from '@cloakedxyz/puddle';
import contracts from '@cloakedxyz/puddle/contracts' with { type: 'json' };
import { relayFundingRequest } from '@cloakedxyz/puddle/relay';
if (typeof prepareRailgunReceive !== 'function' || typeof decodeRailgunAddress !== 'function'
 || typeof relayFundingRequest !== 'function' || !contracts.contracts.factory.code) throw new Error('Missing package exports');
console.log('Installed SDK exports and contract artifact work.');\n`;
await writeFile(join(destination, 'consumer.mjs'), source);
await writeFile(join(destination, 'consumer.ts'), `import type { Provider } from 'ethers';
import { prepareRailgunReceive, type RecoveryArtifacts, type Deployment } from '@cloakedxyz/puddle';
import contracts from '@cloakedxyz/puddle/contracts' with { type: 'json' };
const artifacts: RecoveryArtifacts = contracts;
export function prepare(provider: Provider, deployment: Deployment, recipient: string, recovery: string) {
  return prepareRailgunReceive(provider, deployment, { recipient, recovery, relayer: recovery, feeRecipient: recovery },
    { token: recovery, amount: 100n, gasFee: 0n, deadline: 4000000000n }, artifacts);
}\n`);
const guide = await readFile('docs/integrate.md', 'utf8');
const integration = guide.match(/```ts\n([\s\S]*?)\n```/)?.[1];
assert(integration, 'The integration guide must contain its copyable TypeScript module.');
await writeFile(join(destination, 'integration.ts'), integration);
const flexible = [...guide.matchAll(/```ts\n([\s\S]*?)\n```/g)][1]?.[1];
assert(flexible, 'The guide must include the token-independent module.');
await writeFile(join(destination, 'flexible.ts'), flexible);
const published = JSON.parse(await readFile('deployments/arbitrum.json', 'utf8'));
await writeFile(join(destination, 'puddle-route.json'), JSON.stringify(published.configuration));
execFileSync(resolve('node_modules/.bin/tsc'), ['--strict', '--module', 'NodeNext', '--target', 'ES2024',
  '--resolveJsonModule', '--skipLibCheck', '--noEmit', 'consumer.ts', 'integration.ts', 'flexible.ts'], { cwd: destination, stdio: 'pipe' });
const output = execFileSync(process.execPath, ['consumer.mjs'], { cwd: destination, encoding: 'utf8' });
const help = execFileSync(process.execPath, ['node_modules/@cloakedxyz/puddle/examples/receive.mjs', '--help'], { cwd: destination, encoding: 'utf8' });
assert(help.includes('No transactions are signed or sent.'));
const bundled = await build({ absWorkingDir: destination, entryPoints: ['consumer.mjs'], bundle: true,
  platform: 'browser', format: 'esm', write: false, metafile: true });
assert(Object.keys(bundled.metafile!.inputs).every(path => path === 'consumer.mjs' || path.startsWith('node_modules/')),
  'Consumer resolved a dependency from outside its installed package tree.');
const integrationBundle = await build({absWorkingDir: destination, entryPoints: ['integration.ts'], bundle: true,
  platform: 'browser', format: 'esm', write: false, metafile: true});
assert(Object.keys(integrationBundle.metafile!.inputs).every(path => ['integration.ts', 'puddle-route.json'].includes(path) || path.startsWith('node_modules/')),
  'The integration guide must bundle using only the product configuration and installed package tree.');
const flexibleBundle = await build({absWorkingDir: destination, entryPoints: ['flexible.ts'], bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true});
assert(Object.keys(flexibleBundle.metafile!.inputs).every(path => path === 'flexible.ts' || path.startsWith('node_modules/')));
const lock = JSON.parse(await readFile(join(destination, 'package-lock.json'), 'utf8'));
assert(!Object.keys(lock.packages).some(path => /@railgun-community\/engine|snarkjs|circomlibjs/.test(path)));
// Execute the exact documentation module against local real-protocol contracts.
// The installed consumer still has only the packed SDK and its runtime dependencies.
const env = await createEnvironment();
try {
  const configuration = {...published.configuration, ...env.deployment, chainId: '31337',
    token: env.deployment.asset, maxGasFee: String(env.deployment.maxGasFee),
    assetImplementation: env.deployment.assetImplementation ?? null,
    relayer: await env.relayer.getAddress(), feeRecipient: await env.feeCollector.getAddress(),
    minAmount: '100000000', maxAmount: '100000000', gasFee: '200000', decimals: 6};
  await writeFile(join(destination, 'puddle-route.json'), JSON.stringify(configuration));
  const module = await import(pathToFileURL(join(destination, 'integration.ts')).href);
  const sdk = await import(pathToFileURL(join(destination, 'node_modules/@cloakedxyz/puddle/dist/sdk/index.js')).href);
  const recipient = await createRecipient(), owner = await env.recovery.getAddress();
  await assert.rejects(module.createPuddleReceive(env.provider, recipient.address, owner,
    async () => { throw new Error('Recovery save failed'); }), /Recovery save failed/);
  const savedPath = join(destination, 'saved-recovery.json');
  const deposit = await module.createPuddleReceive(env.provider, recipient.address, owner,
    async (file: unknown) => { await writeFile(savedPath, JSON.stringify(file)); });
  assert.equal(sdk.parseRecoveryFile(await readFile(savedPath, 'utf8')).depositAddress, deposit.address);
  assert.equal((await module.getPuddleFundingStatus(env.provider, deposit)).ready, false);
  const estimate = await module.getPuddleEstimate(env.provider, deposit);
  assert.equal(estimate.expectedPrivateAmount, 99_450_750n);
  assert.equal(estimate.maxGasFee, env.deployment.maxGasFee);
  await fund(env, deposit.address, deposit.quote.amount);
  assert.equal((await module.getPuddleFundingStatus(env.provider, deposit)).ready, true);
  const receipt = await sdk.mined(sdk.relayDeposit(sdk.createRailgunAdapter(module.puddleDeployment), deposit, env.relayer));
  assert.equal((await decryptDeposit(env, recipient, receipt)).amount, estimate.expectedPrivateAmount);
  assert.equal((await module.getPuddleFundingStatus(env.provider, deposit)).spent, true);
  console.log('Copied integration guide module passes backup failure, preparation, funding and manual RAILGUN completion.');
} finally { await env.close(); }
const flexibleEnv = await createEnvironment(undefined, undefined, true, true);
try {
  const module = await import(pathToFileURL(join(destination, 'flexible.ts')).href);
  const sdk = await import(pathToFileURL(join(destination, 'node_modules/@cloakedxyz/puddle/dist/sdk/index.js')).href);
  const recipient = await createRecipient();
  const input = {recipient: recipient.address, recovery: await flexibleEnv.recovery.getAddress(),
    relayer: await flexibleEnv.relayer.getAddress(), feeRecipient: await flexibleEnv.feeCollector.getAddress()};
  await assert.rejects(module.createFlexiblePuddleAddress(flexibleEnv.provider, flexibleEnv.deployment, input,
    async () => {throw new Error('Recovery save failed');}), /Recovery save failed/);
  let saved: unknown;
  const record = await module.createFlexiblePuddleAddress(flexibleEnv.provider, flexibleEnv.deployment, input,
    async (file: unknown) => {saved = file;});
  assert.equal(sdk.parseRecoveryFile(JSON.stringify(saved)).depositAddress, record.address);
  await sdk.mined(flexibleEnv.sender.sendTransaction({to: record.address, value: 10n ** 16n}));
  const discovered = await module.discoverFunding(flexibleEnv.provider, record);
  assert.equal(discovered.assets.length, 1);
  const observed = await sdk.readFundingAsset(flexibleEnv.provider, record.address, record.asset);
  const deposit = await module.quoteFunding(flexibleEnv.provider, record, discovered.assets[0],
    {token: record.asset, codeHash: observed.codeHash, implementation: observed.implementation, standard: true});
  const receipt = await sdk.mined(sdk.relayDeposit(sdk.createRailgunAdapter(record), deposit, flexibleEnv.relayer));
  assert.equal((await decryptDeposit(flexibleEnv, recipient, receipt)).amount, 9_965_025_000_000_000n);
  console.log('Copied flexible guide module passes backup failure, ETH discovery, wrapping and RAILGUN completion.');
} finally {await flexibleEnv.close();}
console.log(output.trim());
console.log('Installed TypeScript declarations pass a separate consumer check.');
console.log(JSON.stringify({ tarball, consumerDirectory: destination, unpackedBytes: packed.unpackedSize,
  browserBundleBytes: bundled.outputFiles[0].contents.length, integrationBundleBytes: integrationBundle.outputFiles[0].contents.length }));
