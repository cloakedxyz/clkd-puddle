import { createHash } from 'node:crypto';
import { readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const buildHash = value => createHash('sha256').update(value).digest('hex');
const safePath = name => typeof name === 'string' && /^[A-Za-z0-9_./-]+$/.test(name)
  && !name.startsWith('/') && !name.split('/').includes('..');

/** Catch missing, altered, and stale generated output before npm pack/publish. */
export async function verifySdkBuild(root = fileURLToPath(new URL('.', import.meta.url))) {
  const fail = reason => { throw new Error(`${reason} Run npm run build:sdk from the repository root before packing.`); };
  let manifest;
  try { manifest = JSON.parse(await readFile(resolve(root, 'dist/build.json'), 'utf8')); }
  catch { fail('The SDK build manifest is missing.'); }
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  if (manifest.format !== 'puddle-sdk-build' || manifest.version !== 1 || manifest.packageVersion !== pkg.version) fail('The SDK build version does not match.');
  for (const group of ['inputs', 'outputs']) {
    if (!manifest[group] || typeof manifest[group] !== 'object' || Array.isArray(manifest[group])
      || !Object.keys(manifest[group]).length) fail('The SDK build manifest is invalid.');
    for (const [name, hash] of Object.entries(manifest[group])) {
      if (!safePath(name) || typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) fail('The SDK build manifest is invalid.');
    }
  }
  for (const [name, hash] of Object.entries(manifest.outputs)) {
    if (!name.startsWith('dist/') && !['LICENSE', 'poseidon-lite-NOTICE'].includes(name)) fail('Unexpected SDK build output.');
    let value;
    try { value = await readFile(resolve(root, name)); } catch { fail(`Missing SDK output: ${name}.`); }
    if (buildHash(value) !== hash) fail(`Changed SDK output: ${name}.`);
  }
  function exportedFiles(value) {
    if (typeof value === 'string') return [value];
    return value && typeof value === 'object' ? Object.values(value).flatMap(exportedFiles) : [];
  }
  for (const path of exportedFiles(pkg.exports)) {
    if (!path.startsWith('./dist/') || !Object.hasOwn(manifest.outputs, path.slice(2))) fail('An SDK export is missing from the build.');
  }
  // Installed tarballs have no source checkout. In the repository, verify inputs
  // too, so edited source cannot accidentally be published as an older binary.
  const sourceRoot = resolve(root, '..');
  const inCheckout = await access(resolve(sourceRoot, 'scripts/build-sdk.ts')).then(() => true, () => false);
  if (inCheckout) {
    for (const [name, hash] of Object.entries(manifest.inputs)) {
      let value;
      try { value = await readFile(resolve(sourceRoot, name)); } catch { fail(`Missing SDK build input: ${name}.`); }
      if (buildHash(value) !== hash) fail(`Stale SDK build input: ${name}.`);
    }
  }
  return { outputs: Object.keys(manifest.outputs).length, sourceChecked: inCheckout };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await verifySdkBuild(); process.stderr.write('SDK package build verified.\n'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
