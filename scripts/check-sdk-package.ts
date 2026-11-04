import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { build } from 'esbuild';

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
execFileSync(resolve('node_modules/.bin/tsc'), ['--strict', '--module', 'NodeNext', '--target', 'ES2024',
  '--resolveJsonModule', '--skipLibCheck', '--noEmit', 'consumer.ts'], { cwd: destination, stdio: 'pipe' });
const output = execFileSync(process.execPath, ['consumer.mjs'], { cwd: destination, encoding: 'utf8' });
const help = execFileSync(process.execPath, ['node_modules/@cloakedxyz/puddle/examples/receive.mjs', '--help'], { cwd: destination, encoding: 'utf8' });
assert(help.includes('No transactions are signed or sent.'));
const bundled = await build({ absWorkingDir: destination, entryPoints: ['consumer.mjs'], bundle: true,
  platform: 'browser', format: 'esm', write: false, metafile: true });
assert(Object.keys(bundled.metafile!.inputs).every(path => path === 'consumer.mjs' || path.startsWith('node_modules/')),
  'Consumer resolved a dependency from outside its installed package tree.');
const lock = JSON.parse(await readFile(join(destination, 'package-lock.json'), 'utf8'));
assert(!Object.keys(lock.packages).some(path => /@railgun-community\/engine|snarkjs|circomlibjs/.test(path)));
console.log(output.trim());
console.log('Installed TypeScript declarations pass a separate consumer check.');
console.log(JSON.stringify({ tarball, consumerDirectory: destination, unpackedBytes: packed.unpackedSize,
  browserBundleBytes: bundled.outputFiles[0].contents.length }));
