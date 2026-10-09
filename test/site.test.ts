import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

test('public build makes the launch status clear and excludes local deposit tooling', async () => {
  const output = new URL('../dist/', import.meta.url);
  const html = await readFile(new URL('index.html', output), 'utf8');
  assert.match(html, /RAILGUN on Ethereum/);
  assert.match(html, /Privacy Pools v1 &amp; v2/);
  assert.match(html, /Coming soon/);
  assert.match(html, /Deposits aren’t open yet/);
  assert.match(html, /href="\/docs"/);
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
