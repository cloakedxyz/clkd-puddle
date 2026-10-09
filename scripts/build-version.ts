import { writeFile } from 'node:fs/promises';
import { renderApp } from './html.ts';
import { build } from 'esbuild';

await build({ entryPoints: ['app/main.ts', 'app/shared.ts', 'app/theme.ts', 'app/site.ts'], outdir: '.cache/ui',
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true });

await writeFile(new URL('../.cache/ui/index.html', import.meta.url), await renderApp('local'));
