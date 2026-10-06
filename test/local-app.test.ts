import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startLocalApp } from '../scripts/local-app.ts';
import { quoteAmount } from '../app/shared.ts';
import type { AppState } from '../app/shared.ts';
import { parseRecoveryFile } from '../recovery/core.ts';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { FetchRequest, JsonRpcProvider, ZeroAddress } from 'ethers';
import { receivingWallet } from './privacy-pools-v1/wallet.ts';
import { createV1ReceiveLink } from '../client/index.ts';
import { decodeV1Recipient } from '../protocols/privacy-pools-v1-data.ts';
import { prepareV1PoolRecovery } from '../client/recovery.ts';
import { recoveryFiles } from './privacy-pools-v1/harness.ts';
import type { RecoveryArtifacts } from '../client/recovery.ts';

let app: Awaited<ReturnType<typeof startLocalApp>>;
before(async () => { app = await startLocalApp(0); });
after(async () => { if (app) await Promise.all([app.close(), app.close()]); });

async function post(path: string, body: Record<string, unknown>, origin = app.url) {
  return fetch(app.url + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify(body),
  });
}

async function current(): Promise<AppState> {
  return (await fetch(app.url + '/api/state')).json() as Promise<AppState>;
}

async function waitForReceipt(phase = 'complete') {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await current();
    assert.notEqual(state.deposit?.phase, 'error', state.deposit?.error);
    if (state.deposit?.phase === phase) return state;
    await delay(200);
  }
  assert.fail('Local deposit did not finish within 20 seconds.');
}

test('serves the local interface without exposing test secrets or allowing cross-site actions', async () => {
  const page = await fetch(app.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Create address/);
  assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.equal((await fetch(app.url + '/main.js')).status, 200);
  assert.equal((await fetch(app.url + '/shared.js')).status, 200);
  assert.equal((await fetch(app.url + '/scripts/local-app.ts')).status, 404);
  const state = await current();
  assert.equal(state.privateBalance, '0');
  assert.equal(state.deposit, null);
  assert.match(state.recipient, /^0zk/);
  assert.doesNotMatch(JSON.stringify(state), /privateKey|mnemonic|viewing/);
  assert.equal((await post('/api/deposits', { amount: '100' }, 'https://unrelated.example')).status, 403);
  assert.equal((await post('/api/deposits', { amount: '100' }, 'null')).status, 403);
  assert.equal((await fetch(app.url + '/api/state', { headers: { Origin: 'https://unrelated.example' } })).status, 403);
  assert.equal((await fetch(app.url + '/api/deposits', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"amount":"100"}',
  })).status, 403);
});

test('rejects malformed amounts and does not create or fund a deposit on invalid requests', async () => {
  assert.equal((await post('/api/deposits', { protocol: 'privacy-pools', amount: '100' })).status, 400);
  for (const amount of ['0', '-1', '1e6', '1.1234567', '1000001', 'NaN', '<script>', 100]) {
    assert.equal((await post('/api/deposits', { amount })).status, 400);
  }
  assert.equal((await post('/api/deposits', { amount: '1'.repeat(5_000) })).status, 413);
  assert.equal((await post('/api/fund', { address: '0x0' })).status, 409);
  assert.equal((await current()).deposit, null);
});

test('creates, funds, relays and decrypts real local deposits; duplicate and stale actions cannot send twice', async () => {
  const created = await post('/api/deposits', { protocol: 'railgun', amount: '100' });
  assert.equal(created.status, 201);
  const first = await created.json() as AppState;
  assert(first.deposit);
  assert.equal(first.deposit.protocol, 'railgun');
  assert.equal(first.deposit.phase, 'ready');
  assert.deepEqual(first.deposit.quote, quoteAmount('100'));
  assert.equal((await post('/api/deposits', { amount: '25' })).status, 409);
  const address = first.deposit.address;
  const backupResponse = await fetch(app.url + `/api/recovery?address=${address}`);
  assert.equal(backupResponse.status, 200);
  const backup = parseRecoveryFile(await backupResponse.text());
  assert.equal(backup.depositAddress, address);
  assert.equal(backup.config.recovery, first.recovery);
  assert.equal(backup.factory, first.factory);
  assert.equal(backup.chainId, '31337');
  const sends = await Promise.all([post('/api/fund', { address }), post('/api/fund', { address })]);
  assert.deepEqual(sends.map(response => response.status).sort(), [202, 409]);
  const funded = await waitForReceipt('funded');
  assert.equal(funded.deposit?.shieldingTx, undefined);
  assert.equal(funded.privateBalance, '0');
  const relays = await Promise.all([post('/api/relay', { address }), post('/api/relay', { address })]);
  assert.deepEqual(relays.map(response => response.status).sort(), [202, 409]);
  const completed = await waitForReceipt();
  assert(completed.deposit);
  assert.equal(completed.deposit.received, '99450750');
  assert.equal(completed.privateBalance, '99450750');
  for (const hash of [completed.deposit.fundingTx, completed.deposit.shieldingTx, completed.deposit.commitment]) {
    assert.match(hash ?? '', /^0x[0-9a-f]{64}$/i);
  }
  assert.equal((await post('/api/fund', { address })).status, 409);
  assert.equal((await post('/api/relay', { address })).status, 409);
  assert.equal((await post('/api/recover', { address })).status, 409);

  const next = await post('/api/deposits', { amount: '25.123456' });
  assert.equal(next.status, 201);
  const second = await next.json() as AppState;
  assert(second.deposit);
  assert.notEqual(second.deposit.address, address);
  assert.equal((await fetch(app.url + `/api/recovery?address=${address}`)).status, 409);
  assert.equal((await post('/api/fund', { address })).status, 409);
  assert.equal((await post('/api/fund', { address: second.deposit.address })).status, 202);
  await waitForReceipt('funded');
  assert.equal((await post('/api/relay', { address: second.deposit.address })).status, 202);
  const final = await waitForReceipt();
  const expected = BigInt(quoteAmount('25.123456').received);
  assert.equal(final.deposit?.received, String(expected));
  assert.equal(final.privateBalance, String(99_450_750n + expected));
});

test('browser accepts only a wallet public code, manually relays and accepts a wallet-generated recovery proof', { timeout: 120_000 }, async () => {
  const connection = new FetchRequest(app.url + '/api/rpc');
  connection.setHeader('Origin', app.url);
  const provider = new JsonRpcProvider(connection, 31337, { batchMaxCount: 1, cacheTimeout: -1 });
  const browser = await chromium.launch(process.platform === 'darwin' ? { channel: 'chrome' } : {});
  try {
    const configuration = await current();
    const block = await provider.getBlock('latest');
    assert(block);
    // Separate wallet fixture. No secrets are generated, imported or displayed in the Puddle browser.
    const wallet = await receivingWallet(provider, { ...configuration.v1, chainId: 31337n }, {
      recovery: configuration.recovery, relayer: configuration.relayer, feeRecipient: configuration.v1.feeRecipient,
      token: ZeroAddress, amount: BigInt(quoteAmount('0.1', 'privacy-pools-v1', 'ETH').amount),
      gasFee: 100_000_000_000_000n, deadline: BigInt(block.timestamp + 3600),
    });
    const recipient = decodeV1Recipient(wallet.deposit.config.recipient);
    const code = { format: 'privacy-pools-v1-receive' as const, version: 1 as const, chainId: '31337',
      entrypoint: configuration.v1.pool, pool: recipient.pool, asset: ZeroAddress, precommitment: String(recipient.precommitment),
      recovery: configuration.recovery };
    const page = await browser.newPage();
    const sent: string[] = [];
    const errors: string[] = [];
    page.on('request', req => { if (req.postData()) sent.push(req.postData()!); });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(createV1ReceiveLink(app.url + '/receive', code) + '&request=ambiguous');
    await page.locator('#create').click();
    await page.locator('#error').waitFor({ state: 'visible' });
    assert.match(await page.locator('#error').textContent() ?? '', /Invalid receive link/);
    await page.goto(createV1ReceiveLink(app.url + '/receive', code));
    await page.waitForFunction(() => !document.querySelector<HTMLTextAreaElement>('#v1-receive-code')!.value.includes('ambiguous'));
    await page.locator('#create').click();
    await page.waitForFunction(() => !document.querySelector<HTMLElement>('#deposit-panel')!.hidden
      || !document.querySelector<HTMLElement>('#error')!.hidden);
    assert.equal(await page.locator('#error').isVisible(), false, await page.locator('#error').textContent() ?? '');
    assert.equal(new URL(page.url()).hash, '');
    assert.equal(await page.locator('#fund').isDisabled(), true);
    const recoveryDownload = page.waitForEvent('download');
    await page.locator('#save-recovery').click();
    const path = await (await recoveryDownload).path();
    assert(path);
    const file = parseRecoveryFile(await readFile(path, 'utf8'));
    await page.locator('#fund').click();
    await page.locator('#relay').waitFor({ state: 'visible' });
    assert.equal((await current()).deposit?.phase, 'funded');
    assert.equal((await current()).deposit?.shieldingTx, undefined);
    await page.screenshot({ path: '.cache/v1-client.png', fullPage: true });
    await page.locator('#relay').click();
    await waitForReceipt();
    await page.reload();
    await page.locator('#received-block').waitFor({ state: 'visible' });
    assert.equal(await page.locator('input[type=file]').count(), 0);
    assert.equal(await page.locator('#mnemonic').count(), 0);
    assert.equal((await current()).deposit?.received, quoteAmount('0.1', 'privacy-pools-v1', 'ETH').received);
    const artifacts = await (await fetch(app.url + '/api/recovery-artifacts')).json() as RecoveryArtifacts;
    const recovery = await prepareV1PoolRecovery(provider, file, artifacts, configuration.recovery, wallet.noteBackup, recoveryFiles());
    assert.equal((await post('/api/pool-recovery', { address: file.depositAddress, data: '0xdeadbeef' })).status, 400);
    assert.equal((await post('/api/pool-recovery', { address: file.depositAddress, data: recovery.data })).status, 202);
    await waitForReceipt('recovered');
    assert.deepEqual(errors, []);
    for (const body of [...sent, await page.content()]) {
      for (const secret of [wallet.mnemonic, wallet.noteBackup.nullifier, wallet.noteBackup.secret]) {
        assert(!body.includes(secret), 'Puddle must not handle the receiving wallet secrets');
      }
    }
    assert.equal((await post('/api/deposits', { protocol: 'privacy-pools-v1', amount: '100', secret: 'rejected' })).status, 400);
    assert.equal((await post('/api/rpc', { jsonrpc: '2.0', id: 1, method: 'eth_sendTransaction', params: [] })).status, 400);
    // Reusing the same public code fails before returning another fundable address.
    await page.locator('#new-deposit').click();
    await page.locator('#protocol').selectOption('privacy-pools-v1');
    await page.locator('#asset').selectOption('ETH');
    await page.locator('#v1-receive-code').fill(JSON.stringify(code));
    await page.locator('#create').click();
    await page.locator('#error').waitFor({ state: 'visible' });
    assert.match(await page.locator('#error').textContent() ?? '', /already used/);
    // The other recovery path needs only the recovery wallet, before manual relay.
    await page.locator('#protocol').selectOption('railgun');
    await page.locator('#create').click();
    await page.locator('#fund').waitFor({ state: 'visible' });
    await page.locator('#save-recovery').click();
    await page.locator('#fund').click();
    await page.locator('#relay').waitFor({ state: 'visible' });
    await page.locator('#recover').click();
    await waitForReceipt('recovered');
    assert.equal((await current()).deposit?.shieldingTx, undefined);
  } finally { provider.destroy(); await browser.close(); }
});
