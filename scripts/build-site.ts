import { copyFile, cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { renderApp } from './html.ts';

// Only publish the landing page and its assets. Test wallets and deposit APIs stay local.
const output = new URL('../dist/', import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(new URL('assets/', output), { recursive: true });
await build({ entryPoints: ['app/theme.ts', 'app/site.ts'], outdir: output.pathname,
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true });
await writeFile(new URL('index.html', output), await renderApp('public'));
for (const file of ['style.css', 'assets/metamask.svg', 'assets/rainbow.svg', 'assets/rabby.svg',
  'assets/railgun.svg', 'assets/privacy-pools.svg']) {
  await copyFile(new URL(`../app/${file}`, import.meta.url), new URL(file, output));
}
execFileSync('npm', ['--prefix', 'docs', 'run', 'build'], {
  stdio: 'inherit', env: { ...process.env, PUDDLE_SITE: '1' },
});
await cp(new URL('../docs/dist/public/', import.meta.url), new URL('docs/', output), { recursive: true });
