import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';

test('public build makes the launch status clear and excludes local deposit tooling', async () => {
  const output = new URL('../dist/', import.meta.url);
  const html = await readFile(new URL('index.html', output), 'utf8');
  assert.match(html, /RAILGUN on Ethereum/);
  assert.match(html, /Privacy Pools v1 &amp; v2/);
  assert.match(html, /Coming soon/);
  assert.match(html, /Deposits aren’t open yet/);
  assert.match(html, /href="\/docs\/"/);
  assert.doesNotMatch(html, /\{\{|localhost|127\.0\.0\.1|<form|\/main\.js|\/api\/|0zk1/);
  // A stale local build must never become a public deposit page or leak test data.
  const files = (await readdir(output, { recursive: true })).filter(file => file !== 'docs' && !file.startsWith('docs/'));
  assert.deepEqual(files.sort(), ['assets', 'assets/metamask.svg', 'assets/privacy-pools.svg',
    'assets/rabby.svg', 'assets/railgun.svg', 'assets/rainbow.svg', 'index.html', 'site.js',
    'style.css', 'theme.js'].sort());
  for (const file of ['site.js', 'theme.js']) {
    assert.doesNotMatch(await readFile(new URL(file, output), 'utf8'), /\/api\/|fetch\(|XMLHttpRequest|JsonRpcProvider/);
  }
});

test('docs are published under the same site with their own asset paths', async () => {
  const fees = await readFile(new URL('../dist/docs/fees/index.html', import.meta.url), 'utf8');
  assert.match(fees, /Fees/);
  assert.match(fees, /\/docs\/assets\//);
  assert.match(fees, /href="https:\/\/puddle\.link\/"/);
  assert.doesNotMatch(fees, /(?:src|href)="\/(?:assets|rsc)\//);
});

test('docs entry and navigation stay usable after JavaScript loads', { timeout: 30_000 }, async t => {
  const output = fileURLToPath(new URL('../dist/', import.meta.url));
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  const files = new Map<string, Buffer>();
  for (const entry of await readdir(output, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    files.set('/' + relative(output, file), await readFile(file));
  }
  const contentTypes: Record<string, string> = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  };
  // Match Vercel's configured static-directory redirects, including direct /docs visits.
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    const path = url.pathname;
    if (config.trailingSlash && !extname(path) && !path.endsWith('/')) {
      res.writeHead(308, { Location: path + '/' + url.search }).end();
      return;
    }
    const file = extname(path) ? path : path.replace(/\/$/, '') + '/index.html';
    const body = files.get(file);
    res.writeHead(body ? 200 : 404, { 'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch(process.platform === 'darwin' ? { channel: 'chrome' } : {});
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/docs');
  await page.getByRole('button', { name: /Search/ }).click();
  await page.getByRole('dialog').waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('heading', { name: 'How it works', exact: true }).isVisible(), true);
  assert.equal(new URL(page.url()).pathname, '/docs/');
  await page.getByRole('link', { name: 'Fees', exact: true }).click();
  await page.getByRole('heading', { name: 'Fees', exact: true }).waitFor({ state: 'visible' });
  await page.reload();
  await page.getByRole('heading', { name: 'Fees', exact: true }).waitFor({ state: 'visible' });
  assert.deepEqual(errors, []);
});
