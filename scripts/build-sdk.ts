import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { keccak256 } from 'ethers';
import { contractArtifact, recoveryArtifacts } from './artifacts.ts';
import { buildContracts } from './setup.ts';
import { buildHash } from '../sdk/verify-build.mjs';

const sources = ['package.json', 'package-lock.json', 'tsconfig.json', 'LICENSE',
  'sdk/package.json', 'sdk/package-lock.json', 'sdk/index.ts', 'sdk/kernel.ts', 'sdk/receive.ts',
  'sdk/funding.ts', 'sdk/recovery.ts', 'sdk/recipient.ts', 'sdk/relay.ts', 'sdk/poseidon-provenance.txt',
  'sdk/tsconfig.json', 'sdk/verify-build.mjs', 'sdk/examples/receive.mjs', 'sdk/README.md',
  'sdk/SECURITY.md', 'sdk/NOTICE', 'scripts/build-sdk.ts', 'scripts/artifacts.ts',
  'scripts/setup.ts', 'foundry.toml', 'contracts/KernelImports.sol', 'contracts/RailgunExecutor.sol', 'contracts/MultiAssetRailgunExecutor.sol'];
const hashes = async (files: string[], prefix = '') => Object.fromEntries(await Promise.all(files.map(async path =>
  [path, buildHash(await readFile(prefix + path))])));
const before = await hashes(sources);
buildContracts();

// Bind the artifact to every actual compiler input, including pinned upstream code.
const compilerInputs = new Map<string, string>();
for (const name of ['Kernel', 'KernelFactory', 'ECDSAValidator', 'RailgunExecutor', 'MultiAssetRailgunExecutor']) {
  for (const [path, source] of Object.entries(contractArtifact(name).metadata.sources)) {
    assert.equal(keccak256(await readFile(path)), source.keccak256, `Compiler/source mismatch: ${path}`);
    compilerInputs.set(path, source.keccak256);
  }
}
// Delete only generated output so removed exports cannot survive a release.
await rm('sdk/dist', { recursive: true, force: true });
await mkdir('sdk/dist', { recursive: true });
execFileSync('node_modules/.bin/tsc', ['-p', 'sdk/tsconfig.json'], { stdio: 'inherit' });
await copyFile('LICENSE', 'sdk/LICENSE');
await copyFile('sdk/poseidon-provenance.txt', 'sdk/poseidon-lite-NOTICE');
await writeFile('sdk/dist/contracts.json', JSON.stringify(recoveryArtifacts()) + '\n');
await writeFile('sdk/dist/multi-asset-contracts.json', JSON.stringify(recoveryArtifacts(true)) + '\n');
const inputs = await hashes([...new Set([...sources, ...compilerInputs.keys()])]);
for (const [path, hash] of Object.entries(before)) assert.equal(inputs[path], hash, `Source changed during build: ${path}`);
const outputs = ['LICENSE', 'poseidon-lite-NOTICE', ...(await readdir('sdk/dist', { recursive: true, withFileTypes: true }))
  .filter(entry => entry.isFile()).map(entry => relative('sdk', join(entry.parentPath, entry.name)).replaceAll('\\', '/'))];
const pkg = JSON.parse(await readFile('sdk/package.json', 'utf8'));
await writeFile('sdk/dist/build.json', JSON.stringify({ format: 'puddle-sdk-build', version: 1,
  packageVersion: pkg.version, inputs, outputs: await hashes(outputs, 'sdk/') }, null, 2) + '\n');
console.log('SDK built in sdk/dist. Run npm pack ./sdk to inspect the release artifact.');
