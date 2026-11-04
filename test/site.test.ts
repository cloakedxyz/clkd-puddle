import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, lstat, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import test from 'node:test';
import { documentation, renderMarkdown } from '../scripts/docs.ts';
import { createSiteRelease, readSiteRelease, validateSiteRelease } from '../scripts/site-release.ts';
import { createEnvironment, createRecipient, decryptDeposit, fund } from './helpers.ts';
import { parseRecoveryFile } from '../sdk/index.ts';
import type { RailgunSiteConfiguration } from '../app/configuration.ts';
import { chainLogoFiles } from '../app/networks.ts';

test('standalone landing page uses product copy and contains no deposit tooling or private data', async () => {
  const output = new URL('../dist/', import.meta.url);
  const html = await readFile(new URL('index.html', output), 'utf8');
  assert.match(html, /Receive privately\./);
  assert.doesNotMatch(html, /ZeroDev|Kernel|ERC-7579/);
  assert.match(html, /Get started/);
  assert.doesNotMatch(html, /Coming soon|Developer preview/);
  assert.doesNotMatch(html, /\{\{|localhost|127\.0\.0\.1|<form|\/api\/|0zk1|RAILGUN on Ethereum/);
  const files = await readdir(output, { recursive: true });
  assert.deepEqual(files.sort(), ['assets', 'assets/metamask.svg', 'assets/rabby.svg', 'assets/railgun.svg',
    'assets/rainbow.svg', 'assets/chains', ...chainLogoFiles, 'index.html', 'site.js', 'style.css', 'docs.css', 'theme.js', 'docs',
    ...documentation.flatMap(page => page.path === '/docs/' ? ['docs/index.html']
      : [page.path.slice(1, -1), page.path.slice(1) + 'index.html'])].sort());
  for (const file of ['site.js', 'theme.js']) {
    assert.doesNotMatch(await readFile(new URL(file, output), 'utf8'), /\/api\/|fetch\(|XMLHttpRequest|JsonRpcProvider/);
  }
});

test('hosted API reference documents every public SDK export and links to the selected architecture', async () => {
  const html = await readFile(new URL('../dist/docs/api/index.html', import.meta.url), 'utf8');
  const api = await readFile(new URL('../docs/api.md', import.meta.url), 'utf8');
  const exports = await readFile(new URL('../sdk/index.ts', import.meta.url), 'utf8');
  const names = Array.from(exports.matchAll(/export (?:type )?\{([^}]+)\}/g)).flatMap(match => match[1].split(',').map(name => name.trim()));
  for (const name of names) { assert(api.includes(name), `Missing API entry: ${name}`); assert(html.includes(name), `Missing rendered API entry: ${name}`); }
  assert.match(html, /href="\/docs\/recovery\/"/);
  assert.match(html, /aria-current="page">SDK API reference/);
  assert.doesNotMatch(html, /\{\{|<script(?! src=)|PrivacyPoolsDeposit|DepositBase|Coming soon: RAILGUN on Ethereum/);
  for (const page of documentation) {
    const content = await readFile(new URL('../dist' + page.path + 'index.html', import.meta.url), 'utf8');
    assert.doesNotMatch(content, /Unpublished developer preview/);
    if (page.source === 'docs/index.md') assert.doesNotMatch(content, /ZeroDev|Kernel|```/);
    if (page.source === 'docs/architecture.md') assert.match(content, /unmodified Kernel v3.3/);
    assert.doesNotMatch(content, /0zk1|privateKey\s*[:=]|https?:\/\/(?:localhost|127\.0\.0\.1)/);
  }
});

test('documentation renderer escapes raw HTML and rejects executable links', () => {
  const {html} = renderMarkdown('# Test\n\n<script>alert(1)</script>\n\n[bad](javascript:alert)\n\n```ts\n<a href="x">\n```', 'docs/api.md');
  assert(!html.includes('<script>')); assert(!html.includes('href="javascript:'));
  assert(html.includes('&lt;script&gt;')); assert(html.includes('&lt;a href='));
});

test('static receiving build supports manual relay and clean API docs without a Puddle backend', {timeout: 120_000}, async () => {
  const env = await createEnvironment(); const recipient = await createRecipient();
  const output = await mkdtemp(join(tmpdir(), 'puddle-static-site-'));
  const browser = await chromium.launch(process.platform === 'darwin' ? {channel: 'chrome'} : {});
  const files = new Map<string, Buffer>();
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const file = files.get(path.endsWith('/') ? path + 'index.html' : path);
    if (!file) { response.writeHead(404).end(); return; }
    const extension = path.endsWith('/') ? 'html' : path.split('.').at(-1);
    const mime = {html: 'text/html', css: 'text/css', js: 'text/javascript', json: 'application/json', svg: 'image/svg+xml', png: 'image/png'};
    response.writeHead(200, {'Content-Type': mime[extension as keyof typeof mime] ?? 'application/octet-stream',
      'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ${new URL(env.provider._getConnection().url).origin}; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`}).end(file);
  });
  try {
    const configuration: RailgunSiteConfiguration = {
      chainId: '31337', chainName: 'Local test chain', rpcUrl: env.provider._getConnection().url,
      factory: env.deployment.factory, implementation: env.deployment.implementation, validator: env.deployment.validator,
      executor: env.deployment.executor, maxGasFee: String(env.deployment.maxGasFee), codeHashes: env.deployment.codeHashes,
      pool: env.deployment.pool, poolImplementation: env.deployment.poolImplementation,
      assetImplementation: env.deployment.assetImplementation, relayer: await env.relayer.getAddress(),
      feeRecipient: await env.feeCollector.getAddress(), token: env.deployment.asset, symbol: 'test USDC', decimals: 6,
      gasFee: '200000', minAmount: '100000000', maxAmount: '100000000', mode: 'pilot',
    };
    const release = await createSiteRelease(Object.assign(configuration, {privateRecipient: recipient.address, privateMarker: 'not-public'}));
    await validateSiteRelease(release, true);
    assert(!JSON.stringify(release).includes(recipient.address));
    const badSource = structuredClone(release); badSource.sourceHashes['sdk/kernel.ts'] = '0'.repeat(64);
    await assert.rejects(validateSiteRelease(badSource), /source changed/);
    const unsafe = structuredClone(release); unsafe.sourceHashes['../outside'] = '0'.repeat(64);
    await assert.rejects(validateSiteRelease(unsafe), /Unsafe/);
    const privateData = structuredClone(release);
    Object.assign(privateData.configuration, {privateRecipient: recipient.address});
    await assert.rejects(validateSiteRelease(privateData), /nonpublic/);
    const wrongArtifact = structuredClone(release); wrongArtifact.artifacts.contracts.executor.code = '0x00';
    await assert.rejects(validateSiteRelease(wrongArtifact, true), /runtime|reference|compiled/);
    // Reproduce a hosting checkout with npm dependencies but no Foundry cache or sdk/dist.
    // The same static build must work from the reviewed release, then pass the browser flow.
    const checkout = join(output, 'source-checkout'); await mkdir(checkout);
    const paths = execFileSync('git', ['ls-files', '-z'], {encoding: 'utf8'}).split('\0').filter(Boolean);
    paths.push('scripts/site-release.ts');
    for (const path of new Set(paths)) {
      if (!(await lstat(path).catch(() => null))?.isFile()) continue;
      await mkdir(dirname(join(checkout, path)), {recursive: true}); await copyFile(path, join(checkout, path));
    }
    await symlink(resolve('node_modules'), join(checkout, 'node_modules'), 'dir');
    const releasePath = join(checkout, 'reviewed-release.json');
    await writeFile(releasePath, JSON.stringify(release));
    await readSiteRelease(releasePath);
    const built = join(checkout, 'dist');
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
      'import {readSiteRelease} from "./scripts/site-release.ts"; import {buildSite} from "./scripts/build-site.ts"; const r=await readSiteRelease("reviewed-release.json"); await buildSite("dist",r.configuration,r);'],
    {cwd: checkout, timeout: 45_000, maxBuffer: 1_000_000});
    assert.equal(await lstat(join(checkout, '.cache')).catch(() => null), null);
    assert.equal(await lstat(join(checkout, 'sdk/dist')).catch(() => null), null);
    for (const path of await readdir(built, {recursive: true})) {
      if (!(await lstat(join(built, path))).isFile()) continue;
      await mkdir(dirname(join(output, path)), {recursive: true}); await copyFile(join(built, path), join(output, path));
    }
    await rm(checkout, {recursive: true});
    for (const path of await readdir(output, {recursive: true})) {
      if (!(await lstat(join(output, path))).isFile()) continue;
      const bytes = await readFile(join(output, path));
      assert(!bytes.includes(Buffer.from(recipient.address)), 'Private profiles must not be spread into the static build.');
      files.set('/' + path, bytes);
    }
    const published = JSON.parse(files.get('/configuration.json')!.toString());
    assert.equal(published.rpcTransport, 'direct'); assert.equal(published.automaticRelay, false);
    assert(!('privateMarker' in published));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`;
    const page = await browser.newPage({viewport: {width: 1280, height: 900}}); const errors: string[] = []; const backendCalls: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url().startsWith(url + '/api/')) backendCalls.push(request.url()); });
    await page.goto(url + '/docs/api/');
    await page.locator('h1').waitFor();
    assert.equal(await page.locator('h1').innerText(), 'SDK API reference');
    await page.screenshot({path: '.cache/puddle-api-desktop.png'});
    await page.getByRole('button', {name: 'Dark mode'}).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await page.screenshot({path: '.cache/puddle-api-dark.png'});
    const mobile = await browser.newPage({viewport: {width: 390, height: 844}});
    await mobile.goto(url + '/docs/api/');
    await mobile.getByRole('button', {name: 'Dark mode'}).click();
    assert(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.equal(await mobile.locator('.docs-header').count(), 1);
    await mobile.screenshot({path: '.cache/puddle-api-mobile.png'}); await mobile.close();
    await page.exposeFunction('staticWalletRequest', async ({method, params}: {method: string; params?: unknown[]}) => {
      if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return [await env.relayer.getAddress()];
      return env.provider.send(method, params ?? []);
    });
    await page.addInitScript(() => { (window as unknown as {ethereum: unknown}).ethereum = {request: (request: unknown) =>
      (window as unknown as {staticWalletRequest: (input: unknown) => Promise<unknown>}).staticWalletRequest(request)}; });
    await page.goto(url);
    assert.doesNotMatch(await page.locator('.railgun-card').innerText(), /ZeroDev|Kernel|ERC-7579/);
    await page.getByRole('button', {name: 'Fund from Local test chain', exact: true}).waitFor();
    await page.locator('#chain-menu-toggle').click();
    assert.equal(await page.locator('#chain-menu img').count(), 6);
    await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLImageElement>('#chain-menu img')).every(image => image.complete && image.naturalWidth > 0));
    assert.equal(await page.locator('#chain-option-1').isDisabled(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#chain-menu').isVisible(), false);
    assert.equal(await page.locator('#amount-entry').isVisible(), false);
    assert.equal(await page.locator('#manual-deposit-note').isVisible(), false);
    await page.locator('#private-recipient').fill(recipient.address);
    await page.locator('#recovery-owner').fill(await env.recovery.getAddress());
    await page.locator('#prepare').click();
    await page.locator('#receive-details').waitFor({state: 'visible'});
    assert.equal(await page.locator('#chain-menu-toggle').isDisabled(), true);
    await page.locator('#manual-deposit-note').waitFor({state: 'visible'});
    assert.equal(await page.locator('#review-amount').innerText(), '100.0 test USDC');
    const download = page.waitForEvent('download'); await page.locator('#save-backup').click();
    const filePath = await (await download).path(); assert(filePath);
    const file = parseRecoveryFile(await readFile(filePath, 'utf8'));
    await fund(env, file.depositAddress, 100_000_000n);
    await page.reload(); await page.locator('#restore-backup').setInputFiles(filePath);
    await page.waitForFunction(() => document.querySelector('#balance-status')?.textContent?.includes('Recovery restored'));
    assert.equal(await page.locator('#funding-instructions').isVisible(), false);
    await page.locator('#wallet-tools').evaluate(element => { (element as HTMLDetailsElement).open = true; });
    await page.locator('#connect-wallet').click(); await page.locator('#prepare-manual-relay').click();
    await page.locator('#relay-from-wallet').click();
    await page.waitForFunction(() => document.querySelector('#balance-status')?.textContent?.includes('Pool deposit executed'));
    const hash = (await page.locator('#transaction-status').innerText()).match(/0x[\da-f]{64}/i)?.[0]; assert(hash);
    const receipt = await env.provider.getTransactionReceipt(hash); assert(receipt);
    assert.equal((await decryptDeposit(env, recipient, receipt)).amount, 99_450_750n);
    assert.deepEqual(backendCalls, []); assert.deepEqual(errors, []);
  } finally {
    await browser.close(); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await env.close(); await rm(output, {recursive: true});
  }
});
