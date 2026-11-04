import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHash, verifySdkBuild } from '../sdk/verify-build.mjs';

test('package guard rejects stale source, changed or missing output, and unsafe manifest paths', async () => {
  const source = await mkdtemp(join(tmpdir(), 'puddle-sdk-build-'));
  const root = join(source, 'sdk');
  await mkdir(join(root, 'dist'), { recursive: true });
  await mkdir(join(source, 'scripts'));
  await writeFile(join(source, 'scripts/build-sdk.ts'), '// fixture');
  await writeFile(join(source, 'source.ts'), 'export const amount = 1;');
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.0.0', exports: { '.': './dist/index.js' } }));
  await writeFile(join(root, 'dist/index.js'), 'export const amount = 1;');
  const manifest = { format: 'puddle-sdk-build', version: 1, packageVersion: '1.0.0',
    inputs: { 'source.ts': buildHash('export const amount = 1;') }, outputs: { 'dist/index.js': buildHash('export const amount = 1;') } };
  const save = () => writeFile(join(root, 'dist/build.json'), JSON.stringify(manifest));
  await save();
  assert.deepEqual(await verifySdkBuild(root), { outputs: 1, sourceChecked: true });
  await writeFile(join(source, 'source.ts'), 'export const amount = 2;');
  await assert.rejects(verifySdkBuild(root), /Stale SDK build input/);
  await writeFile(join(source, 'source.ts'), 'export const amount = 1;');
  await writeFile(join(root, 'dist/index.js'), 'export const amount = 2;');
  await assert.rejects(verifySdkBuild(root), /Changed SDK output/);
  await rm(join(root, 'dist/index.js'));
  await assert.rejects(verifySdkBuild(root), /Missing SDK output/);
  await writeFile(join(root, 'dist/index.js'), 'export const amount = 1;');
  manifest.packageVersion = '2.0.0'; await save();
  await assert.rejects(verifySdkBuild(root), /version does not match/);
  manifest.packageVersion = '1.0.0';
  Object.assign(manifest.inputs, { '../outside': buildHash('outside') }); await save();
  await assert.rejects(verifySdkBuild(root), /manifest is invalid/);
});
