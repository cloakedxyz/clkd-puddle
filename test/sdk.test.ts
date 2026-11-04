import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { AbiCoder, ZeroAddress, getBytes, toBeHex } from 'ethers';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import engine from '@railgun-community/engine';
import { createEnvironment, createRecipient, decryptDeposit, fund, settle } from './helpers.ts';
import { recoveryArtifacts } from '../scripts/artifacts.ts';
import { decodeRailgunAddress, prepareRailgunReceive, prepareRailgunRecipient } from '../sdk/index.ts';
import { railgunRecipientTypes } from '../sdk/recipient.ts';

const require = createRequire(import.meta.url);
const engineDist = dirname(require.resolve('@railgun-community/engine'));
const { getSharedSymmetricKey } = require(join(engineDist, 'utils/keys-utils.js')) as
  typeof import('../node_modules/@railgun-community/engine/dist/utils/keys-utils.js');
const { encodeAddress } = require(join(engineDist, 'key-derivation/bech32.js')) as
  typeof import('../node_modules/@railgun-community/engine/dist/key-derivation/bech32.js');
const { AES } = require(join(engineDist, 'utils/encryption/aes.js')) as
  typeof import('../node_modules/@railgun-community/engine/dist/utils/encryption/aes.js');
let env: Awaited<ReturnType<typeof createEnvironment>>;
before(async () => { env = await createEnvironment(); });
after(async () => { await env?.close(); });

test('browser note encoding interoperates with the official engine for independent recipients', async () => {
  for (let i = 0; i < 8; i++) {
    const recipient = await createRecipient();
    const data = await prepareRailgunRecipient(recipient.address, 31337n);
    const [npk, ciphertext] = AbiCoder.defaultAbiCoder().decode(railgunRecipientTypes, data);
    const key = await getSharedSymmetricKey(recipient.viewing.privateKey, getBytes(ciphertext.shieldKey));
    assert(key);
    const bundle: [string, string, string] = [ciphertext.encryptedBundle[0], ciphertext.encryptedBundle[1], ciphertext.encryptedBundle[2]];
    const random = engine.ShieldNote.decryptRandom(bundle, key);
    assert.equal(toBeHex(engine.ShieldNote.getNotePublicKey(recipient.masterPublicKey, random), 32), npk);
    const other = await createRecipient();
    const wrong = await getSharedSymmetricKey(other.viewing.privateKey, getBytes(ciphertext.shieldKey));
    assert(wrong);
    assert.throws(() => engine.ShieldNote.decryptRandom(bundle, wrong));
  }
});

test('recipient parsing rejects checksum, field, curve, and destination-chain mismatches', async () => {
  const r = await createRecipient();
  assert.equal(decodeRailgunAddress(r.address, 1n).masterPublicKey, r.masterPublicKey);
  const specific = encodeAddress({ ...decodeRailgunAddress(r.address), chain: { type: 0, id: 42161 } });
  assert.equal(decodeRailgunAddress(specific, 42161n).chainId, 42161n);
  assert.throws(() => decodeRailgunAddress(specific, 1n));
  for (const address of ['', r.address + 'x', r.address.slice(0, -1) + (r.address.endsWith('q') ? 'p' : 'q'),
    encodeAddress({ masterPublicKey: 0n, viewingPublicKey: r.viewing.pubkey }),
    encodeAddress({ masterPublicKey: r.masterPublicKey, viewingPublicKey: new Uint8Array(32) })]) {
    assert.throws(() => decodeRailgunAddress(address));
  }
});

test('official engine decrypts both browser ciphertext components with known test-only randomness', async () => {
  const recipient = await createRecipient();
  const entropy = [new Uint8Array(16).fill(11), new Uint8Array(32).fill(23), new Uint8Array(16).fill(37), new Uint8Array(16).fill(41)];
  let call = 0;
  const replacement = mock.method(crypto, 'getRandomValues', (array: Uint8Array) => {
    const bytes = entropy[call++]; assert.equal(array.length, bytes.length); array.set(bytes); return array;
  });
  let encoded: string;
  try { encoded = await prepareRailgunRecipient(recipient.address, 31337n); }
  finally { replacement.mock.restore(); }
  assert.equal(call, 4);
  const [, ciphertext] = AbiCoder.defaultAbiCoder().decode(railgunRecipientTypes, encoded);
  const receiver = AES.decryptCTR({ iv: ciphertext.encryptedBundle[1].slice(-32),
    data: [ciphertext.encryptedBundle[2].slice(2)] }, entropy[1]);
  assert.equal(receiver[0], Buffer.from(recipient.viewing.pubkey).toString('hex'));
  const key = await getSharedSymmetricKey(entropy[1], recipient.viewing.pubkey); assert(key);
  const random = engine.ShieldNote.decryptRandom([ciphertext.encryptedBundle[0], ciphertext.encryptedBundle[1], ciphertext.encryptedBundle[2]], key);
  assert.equal(random, Buffer.from(entropy[0]).toString('hex'));
});

test('SDK prepares locally, checks contract code, and deposits a note readable by the recipient', async () => {
  const recipient = await createRecipient();
  const deployment = env.deployment;
  const terms = { recipient: recipient.address, recovery: await env.recovery.getAddress(),
    relayer: await env.relayer.getAddress(), feeRecipient: await env.feeCollector.getAddress() };
  const quote = { token: await env.token.getAddress(), amount: 100_000_000n, gasFee: 200_000n, deadline: 4_000_000_000n };
  const artifacts = recoveryArtifacts();
  const { deposit, recovery } = await prepareRailgunReceive(env.provider, deployment, terms, quote, artifacts);
  assert.equal(recovery.config.recovery, terms.recovery);
  assert.equal(recovery.config.recipient, deposit.config.recipient);
  await fund(env, deposit.address, quote.amount);
  const receipt = await settle(env, deposit);
  const note = await decryptDeposit(env, recipient, receipt);
  assert.equal(note.amount + note.fee, quote.amount - quote.amount / 1000n - quote.gasFee);
  const changed = structuredClone(artifacts);
  changed.contracts.factory.code = '0x00';
  await assert.rejects(prepareRailgunReceive(env.provider, deployment, terms, quote, changed), /runtime|factory/);
  await assert.rejects(prepareRailgunReceive(env.provider, deployment, { ...terms, recovery: ZeroAddress }, quote, artifacts));
});

test('shipped Node example prepares usable recovery and quote files without signing', async () => {
  const recipient = await createRecipient();
  const root = await mkdtemp(join(tmpdir(), 'puddle-sdk-example-'));
  const configuration = { rpcUrl: env.provider._getConnection().url,
    ...env.deployment, chainId: '31337', maxGasFee: String(env.deployment.maxGasFee), token: await env.token.getAddress(),
    decimals: 6, gasFee: '200000', maxAmount: '1000000000', relayer: await env.relayer.getAddress(), feeRecipient: await env.feeCollector.getAddress() };
  await writeFile(join(root, 'configuration.json'), JSON.stringify(configuration));
  await writeFile(join(root, 'profile.json'), JSON.stringify({ recipient: recipient.address, recovery: await env.recovery.getAddress() }));
  const beforeNonce = await env.provider.getTransactionCount(await env.relayer.getAddress());
  const result = JSON.parse(execFileSync(process.execPath, ['sdk/examples/receive.mjs', join(root, 'configuration.json'),
    join(root, 'profile.json'), '25', join(root, 'prepared')], { encoding: 'utf8' }));
  assert(!JSON.stringify(result).includes(recipient.address));
  const recovery = JSON.parse(await readFile(result.recoveryFile, 'utf8'));
  const deposit = JSON.parse(await readFile(result.quoteFile, 'utf8'));
  assert.equal(recovery.depositAddress, result.address);
  assert.equal(deposit.address, result.address);
  assert.equal(deposit.quote.amount, '25000000');
  assert.equal(await env.provider.getTransactionCount(await env.relayer.getAddress()), beforeNonce);
  assert.equal(await env.provider.getCode(result.address), '0x');
});

test('release package excludes experiments and the browser SDK needs no Node polyfills', async () => {
  const [pack] = JSON.parse(execFileSync('npm', ['pack', './sdk', '--dry-run', '--ignore-scripts', '--json'], { encoding: 'utf8' }));
  assert(pack.files.some((f: {path: string}) => f.path === 'dist/sdk/index.d.ts'));
  assert(pack.files.some((f: {path: string}) => f.path === 'dist/contracts.json'));
  for (const file of pack.files) assert(!/experiments|\.cache|node_modules|test\/|scripts\/|\.env/.test(file.path), file.path);
  const result = await build({ entryPoints: ['sdk/dist/sdk/index.js'], bundle: true, platform: 'browser',
    format: 'esm', write: false, metafile: true });
  assert(!Object.keys(result.metafile!.inputs).some(path => /@railgun-community\/engine|snarkjs|circomlibjs/.test(path)));
  const manifest = JSON.parse(await readFile('sdk/package.json', 'utf8'));
  assert.equal(manifest.private, undefined);
  const buildManifest = JSON.parse(await readFile('sdk/dist/build.json', 'utf8'));
  for (const path of ['tsconfig.json', 'package.json', '.cache/kernel/src/Kernel.sol',
    '.cache/kernel/lib/solady/src/utils/LibClone.sol']) assert(Object.hasOwn(buildManifest.inputs, path), path);
  const compiled = await import(new URL('../sdk/dist/sdk/index.js', import.meta.url).href);
  assert.equal(typeof compiled.prepareRailgunReceive, 'function');
});
