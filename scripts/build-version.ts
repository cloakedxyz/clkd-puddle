import { readFile, writeFile } from 'node:fs/promises';
import { renderBrand, revisionBadge } from './html.ts';
import { build } from 'esbuild';

await build({ entryPoints: ['app/main.ts', 'app/shared.ts', 'app/theme.ts'], outdir: '.cache/ui',
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true });

const root = new URL('../', import.meta.url);
const template = await readFile(new URL('app/index.html', root), 'utf8');
await writeFile(new URL('.cache/ui/index.html', root),
  renderBrand(template).replace('<!-- build-version -->', revisionBadge('build-version')));
