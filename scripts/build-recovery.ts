import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { brand } from './brand.ts';
import { escapeHTML, renderBrand, revisionBadge } from './html.ts';
import { compile } from './harness.ts';
import { recoveryArtifacts } from './recovery-file.ts';
import { build } from 'esbuild';
import { setupPrivacyPoolsV1, v1Artifacts } from './setup-privacy-pools-v1.ts';

const root = new URL('../', import.meta.url);
const out = new URL('.cache/recovery/', root);
await mkdir(new URL('vendor/', out), { recursive: true });
setupPrivacyPoolsV1();
await mkdir(new URL('v1/', out), { recursive: true });
for (const name of ['commitment.wasm', 'commitment.zkey']) {
  await copyFile(`${v1Artifacts}/${name}`, new URL(`v1/${name}`, out));
}
await build({ entryPoints: { main: 'recovery/main.ts', core: 'recovery/core.ts', theme: 'app/theme.ts' }, outdir: '.cache/recovery',
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['ethers'], minify: true });
await writeFile(new URL('contracts.json', out), JSON.stringify(recoveryArtifacts(compile())));
for (const [source, target] of [
  ['recovery/style.css', 'style.css'],
  ['node_modules/ethers/dist/ethers.min.js', 'vendor/ethers.js'],
  ['node_modules/ethers/LICENSE.md', 'vendor/ethers-LICENSE.md'], ['LICENSE', 'LICENSE'],
  ['node_modules/snarkjs/COPYING', 'vendor/snarkjs-COPYING'],
  ['recovery/poseidon-lite-NOTICE', 'vendor/poseidon-lite-NOTICE'],
]) await copyFile(new URL(source, root), new URL(target, out));

let html = renderBrand(await readFile(new URL('recovery/index.html', root), 'utf8'));
const importMap = html.match(/<script type="importmap">(.*?)<\/script>/)?.[1];
if (!importMap) throw new Error('Recovery import map is missing.');
const hash = createHash('sha256').update(importMap).digest('base64');
const policy = `default-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'sha256-${hash}'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; object-src 'none'`;
html = html.replace('<!-- content-security-policy -->',
  `<meta http-equiv="Content-Security-Policy" content="${escapeHTML(policy)}">`);
await writeFile(new URL('index.html', out), html.replace('<!-- build-version -->', revisionBadge()));
// Static hosts such as Cloudflare Pages and Netlify honor this file. Set equivalent
// headers manually on other hosts. The HTML CSP also protects local copies.
await writeFile(new URL('_headers', out), `/*\n  Content-Security-Policy: ${policy}; frame-ancestors 'none'\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  X-Frame-Options: DENY\n  Cache-Control: no-cache\n`);
await writeFile(new URL('CNAME', out), `recovery.${brand.name}.link\n`);
console.log(`Recovery site built in .cache/recovery (intended host: recovery.${brand.name}.link).`);
