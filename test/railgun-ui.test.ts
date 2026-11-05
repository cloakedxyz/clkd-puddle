import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { Contract, parseEther, zeroPadValue } from 'ethers';
import { chromium } from 'playwright';
import { startRailgunDemo } from '../scripts/railgun-app.ts';
import { decryptDeposit, fund } from './helpers.ts';
import { parseRecoveryFile } from '../sdk/index.ts';
import { abi, implementationSlot, kernelABI } from '../sdk/kernel.ts';

test('RAILGUN front end prepares in-browser, saves recovery, funds, relays, and recovers late tokens', { timeout: 120_000 }, async () => {
  const app = await startRailgunDemo(0);
  const browser = await chromium.launch(process.platform === 'darwin' ? { channel: 'chrome' } : {});
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const bodies: string[] = [];
    page.on('request', request => { if (request.postData()) bodies.push(request.postData()!); });
    const owner = await app.env.recovery.getAddress();
    let selectedAccount = owner;
    await page.exposeFunction('testWalletRequest', async ({method, params}: {method: string; params?: unknown[]}) => {
      if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return [selectedAccount];
      return app.env.provider.send(method, params ?? []);
    });
    await page.addInitScript(() => {
      (window as unknown as {ethereum: unknown}).ethereum = { request: (request: unknown) =>
        (window as unknown as {testWalletRequest: (value: unknown) => Promise<unknown>}).testWalletRequest(request) };
    });
    const response = await page.goto(app.url);
    assert.match(response?.headers()['content-security-policy'] ?? '', /frame-ancestors 'none'/);
    await page.waitForFunction(() => !!document.querySelector<HTMLInputElement>('#private-recipient')?.value);
    let releaseRead!: () => void;
    let readStarted!: () => void;
    const gate = new Promise<void>(resolve => { releaseRead = resolve; });
    const entered = new Promise<void>(resolve => { readStarted = resolve; });
    let hold = true;
    await page.route('**/api/rpc', async route => {
      if (hold && route.request().postDataJSON().method === 'eth_getBlockByNumber') {
        hold = false; readStarted(); await gate;
      }
      await route.continue();
    });
    await page.locator('#prepare').click();
    await entered;
    assert.equal(await page.locator('#private-recipient').isDisabled(), true);
    assert.equal(await page.locator('#recovery-owner').isDisabled(), true);
    assert.equal(await page.locator('#source-chain').isDisabled(), true);
    assert.equal(await page.locator('#chain-menu-toggle').isDisabled(), true);
    // Even a programmatic edit during the pending read cannot relabel the prepared recipient.
    await page.locator('#private-recipient').evaluate(element => { (element as HTMLInputElement).value = 'changed while preparing'; });
    releaseRead();
    await page.locator('#receive-details').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#recipient-summary').textContent(), `Recipient: ${app.recipient.address}`);
    assert.equal(await page.locator('#error').isVisible(), false, await page.locator('#error').textContent() ?? '');
    assert.equal(await page.locator('#funding-instructions').isVisible(), false);
    assert.equal(await page.locator('#demo-fund').isDisabled(), true);
    const download = page.waitForEvent('download');
    await page.locator('#save-backup').click();
    const path = await (await download).path(); assert(path);
    const file = parseRecoveryFile(await readFile(path, 'utf8'));
    assert.equal(file.config.recovery, owner);
    assert.equal(await page.locator('#receiving-address').innerText(), file.depositAddress);
    assert.equal(await page.locator('#funding-instructions').isVisible(), true);
    await page.locator('#demo-fund').click();
    await page.waitForFunction(() => document.querySelector('#balance-status')?.textContent?.includes('Ready to deposit'));
    await page.screenshot({ path: '.cache/railgun-ui-funded.png', fullPage: true });
    // Refresh an expired, fully funded quote without changing the amount. Use the
    // actual browser-wallet relay path: the demo endpoint would create its own quote.
    await app.env.provider.send('evm_increaseTime', [7200]); await app.env.provider.send('evm_mine', []);
    await page.locator('#refresh-deposit').click();
    await page.waitForFunction(() => document.querySelector('#balance-status')?.textContent?.includes('Ready to deposit'));
    selectedAccount = await app.env.relayer.getAddress();
    await page.locator('#wallet-tools').evaluate(element => { (element as HTMLDetailsElement).open = true; });
    await page.locator('#connect-wallet').click();
    await page.waitForFunction(() => !!document.querySelector('#connected-wallet')?.textContent);
    await page.locator('#relay-from-wallet').click();
    await page.waitForFunction(() => document.querySelector('#balance-status')?.textContent?.includes('Pool deposit executed'));
    const txText = await page.locator('#transaction-status').innerText();
    const hash = txText.match(/0x[0-9a-f]{64}/i)?.[0]; assert(hash);
    const receipt = await app.env.provider.getTransactionReceipt(hash); assert(receipt);
    const note = await decryptDeposit(app.env, app.recipient, receipt);
    assert.equal(note.amount, 99_450_750n);
    assert.equal(await app.env.token.allowance(file.depositAddress, app.configuration.pool), 0n);
    assert.equal(await page.locator('#demo-relay').isDisabled(), true);
    // A saved file still recovers a late transfer after a page reload, without server state.
    await fund(app.env, file.depositAddress, 123_456n);
    selectedAccount = owner;
    await page.reload();
    await page.waitForFunction(() => !!document.querySelector<HTMLInputElement>('#private-recipient')?.value);
    await page.locator('#restore-backup').setInputFiles(path);
    await page.locator('#receive-details').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#funding-instructions').isVisible(), false, 'Restored recovery is not new funding instructions.');
    await page.locator('#wallet-tools').evaluate(element => { (element as HTMLDetailsElement).open = true; });
    await page.locator('#connect-wallet').click();
    await page.waitForFunction(() => !!document.querySelector('#connected-wallet')?.textContent);
    const before = await app.env.token.balanceOf(owner);
    await page.locator('#recover-from-wallet').click();
    await page.waitForFunction(() => document.querySelector('#balance-status')?.textContent?.includes('0.0 test USDC remains'));
    assert.equal(await app.env.token.balanceOf(owner) - before, 123_456n);
    assert.deepEqual(errors, []);
    assert(!bodies.some(body => body.includes(app.recipient.address)), 'Private address stays in the browser; the service sees encrypted instructions.');
    const crossOrigin = await fetch(app.url + '/api/rpc', { method: 'POST', headers: { Origin: 'https://other.example', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(crossOrigin.status, 403);
    const writeRPC = await fetch(app.url + '/api/rpc', { method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendTransaction', params: [] }) });
    assert.equal(writeRPC.status, 400);
    // A provider response is simulated here: this verifies the UI's source/destination
    // distinction and backup gate, not a real bridge fill or refund.
    await page.route('**/configuration.json', route => route.fulfill({ json: {
      ...app.configuration, providerRecoveryAccepted: true, bridgeOrigins: [{ chainId: 8453,
        chainName: 'Base', token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'test USDC', decimals: 6 }],
    } }));
    const bridgeAddress = '0x3333333333333333333333333333333333333333';
    let destinationAddress = '';
    await page.route('**/api/bridge-quote', async route => {
      const request = route.request().postDataJSON();
      destinationAddress = request.recovery.depositAddress;
      assert.equal(request.originChainId, 8453); assert.equal(request.amount, '100000000');
      await route.fulfill({ json: { providerResponse: {
        details: { sender: owner, recipient: destinationAddress,
          currencyIn: { currency: { chainId: 8453, address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }, amount: '100000000' },
          currencyOut: { currency: { chainId: 31337, address: app.configuration.token }, amount: '99700000', minimumAmount: '99400000' } },
        steps: [{ id: 'deposit', requestId: '0x' + 'ab'.repeat(32), depositAddress: bridgeAddress }],
      } } });
    });
    await page.reload();
    await page.waitForFunction(() => !!document.querySelector<HTMLInputElement>('#private-recipient')?.value);
    await page.locator('#chain-menu-toggle').click();
    await page.locator('#chain-option-8453').click();
    assert.match(await page.locator('#selected-chain-logo').getAttribute('src') ?? '', /base\.png$/);
    await page.locator('#prepare').click();
    await page.locator('#receive-details').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#error').isVisible(), false, await page.locator('#error').textContent() ?? '');
    await page.locator('#save-backup').click();
    assert.equal(await page.locator('#funding-instructions').isVisible(), false);
    const bridgeDownload = page.waitForEvent('download');
    await page.locator('#save-bridge').click();
    const bridgePath = await (await bridgeDownload).path(); assert(bridgePath);
    const funding = JSON.parse(await readFile(bridgePath, 'utf8'));
    assert.equal(funding.funding.recoveryOwner, owner);
    assert.equal(funding.destinationRecovery.depositAddress, destinationAddress);
    assert.equal(await page.locator('#receiving-address').innerText(), bridgeAddress);
    assert.match(await page.locator('#send-instructions').innerText(), /Base/);
    assert.equal(await page.locator('#funding-instructions').isVisible(), true);
    await fund(app.env, destinationAddress, 99_700_000n);
    await page.locator('#refresh-deposit').click();
    await page.waitForFunction(() => document.querySelector('#balance-status')?.textContent?.includes('99.7 test USDC received'));
    assert.equal(await page.locator('#net-amount').innerText(), '99.1518 test USDC');
    assert.deepEqual(errors, []);
    // Same-chain funding uses the actual received amount, including an ordinary
    // transfer smaller than the initial estimate. The recipient remains fixed.
    await page.reload();
    await page.waitForFunction(() => !!document.querySelector<HTMLInputElement>('#private-recipient')?.value);
    await page.locator('#prepare').click();
    await page.locator('#receive-details').waitFor({ state: 'visible' });
    const partialDownload = page.waitForEvent('download');
    await page.locator('#save-backup').click();
    const partialPath = await (await partialDownload).path(); assert(partialPath);
    const partial = parseRecoveryFile(await readFile(partialPath, 'utf8'));
    await fund(app.env, partial.depositAddress, 90_000_000n);
    await page.locator('#refresh-deposit').click();
    await page.waitForFunction(() => document.querySelector('#balance-status')?.textContent?.includes('90.0 test USDC received. Ready'));
    assert.equal(await page.locator('#net-amount').innerText(), '89.485725 test USDC');
    await page.locator('#demo-relay').click();
    await page.waitForFunction(() => document.querySelector('#balance-status')?.textContent?.includes('Pool deposit executed'));
    const partialHash = (await page.locator('#transaction-status').innerText()).match(/0x[0-9a-f]{64}/i)?.[0]; assert(partialHash);
    const partialReceipt = await app.env.provider.getTransactionReceipt(partialHash); assert(partialReceipt);
    assert.equal((await decryptDeposit(app.env, app.recipient, partialReceipt)).amount, 89_485_725n);
    assert.equal(await page.locator('#funding-instructions').isVisible(), false, 'A used account must not invite another payment.');
    // Revoking settlement does not revoke ownership or hide owner recovery.
    await fund(app.env, partial.depositAddress, 11n);
    await (await new Contract(partial.depositAddress, kernelABI, app.env.recovery).getFunction('uninstallModule')(
      2, partial.executor, abi.encode(['bytes','bytes'], ['0x','0x']))).wait();
    await page.locator('#refresh-deposit').click();
    await page.waitForFunction(() => document.querySelector('#balance-status')?.textContent?.includes('Depositing is unavailable'));
    assert.equal(await page.locator('#funding-instructions').isVisible(), false);
    await page.locator('#wallet-tools').evaluate(element => { (element as HTMLDetailsElement).open = true; });
    await page.locator('#connect-wallet').click();
    await page.waitForFunction(() => !!document.querySelector('#connected-wallet')?.textContent);
    const beforeRemovedModule = await app.env.token.balanceOf(owner);
    await page.locator('#recover-from-wallet').click();
    await page.waitForFunction(() => document.querySelector('#balance-status')?.textContent?.includes('0.0 test USDC remains recoverable'));
    assert.equal(await app.env.token.balanceOf(owner) - beforeRemovedModule, 11n);
    // A pool change blocks settlement, but a saved file still deploys the original
    // Kernel account and recovers funds without querying the changed pool.
    await page.reload();
    await page.waitForFunction(() => !!document.querySelector<HTMLInputElement>('#private-recipient')?.value);
    await page.locator('#prepare').click();
    await page.locator('#receive-details').waitFor({ state: 'visible' });
    const independentDownload = page.waitForEvent('download');
    await page.locator('#save-backup').click();
    const independentPath = await (await independentDownload).path(); assert(independentPath);
    const independent = parseRecoveryFile(await readFile(independentPath, 'utf8'));
    await fund(app.env, independent.depositAddress, 23n);
    await app.env.provider.send('anvil_setStorageAt', [app.configuration.pool, implementationSlot,
      zeroPadValue(await app.env.attacker.getAddress(), 32)]);
    await page.locator('#refresh-deposit').click();
    await page.waitForFunction(() => document.querySelector('#balance-status')?.textContent?.includes('Depositing is unavailable'));
    assert.equal(await page.locator('#demo-relay').isDisabled(), true);
    assert.equal(await page.locator('#funding-instructions').isVisible(), false);
    await page.reload();
    await page.waitForFunction(() => !!document.querySelector<HTMLInputElement>('#private-recipient')?.value);
    await page.locator('#restore-backup').setInputFiles(independentPath);
    await page.waitForFunction(() => document.querySelector('#balance-status')?.textContent?.includes('Recovery restored'));
    assert.equal(await page.locator('#error').isVisible(), false, await page.locator('#error').textContent() ?? '');
    assert.equal(await page.locator('#funding-instructions').isVisible(), false);
    await page.locator('#wallet-tools').evaluate(element => { (element as HTMLDetailsElement).open = true; });
    await page.locator('#connect-wallet').click();
    await page.waitForFunction(() => !!document.querySelector('#connected-wallet')?.textContent);
    const beforePoolChange = await app.env.token.balanceOf(owner);
    await page.locator('#recover-from-wallet').click();
    await page.waitForFunction(() => document.querySelector('#balance-status')?.textContent?.includes('0.0 test USDC remains recoverable'));
    assert.equal(await app.env.token.balanceOf(owner) - beforePoolChange, 23n);
    assert.notEqual(await app.env.provider.getCode(independent.depositAddress), '0x');
    assert.equal(await page.locator('#error').isVisible(), false, await page.locator('#error').textContent() ?? '');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await app.close(); }
});

test('automatic receiving registers only after backup and shields without a recipient wallet connection', {timeout: 120_000}, async () => {
  const app = await startRailgunDemo(0, true); const {env, recipient} = app;
  const browser = await chromium.launch(process.platform === 'darwin' ? {channel: 'chrome'} : {});
  const status = async (address: string) => {
    const response = await fetch(app.url + '/api/relay-status', {method: 'POST', headers: {Origin: app.url, 'Content-Type': 'application/json'}, body: JSON.stringify({address})});
    assert.equal(response.status, 200);
    return (await response.json()).job as {status: string; hash?: string; gasFee?: string};
  };
  try {
    const page = await browser.newPage(); const posts: string[] = []; const errors: string[] = [];
    page.on('request', request => { if (request.postData()) posts.push(request.postData()!); });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(app.url);
    await page.waitForFunction(() => !!document.querySelector<HTMLInputElement>('#private-recipient')?.value);
    await page.locator('#prepare').click();
    await page.locator('#receive-details').waitFor({state: 'visible'});
    assert.equal(await page.locator('#funding-instructions').isVisible(), false);
    assert(!posts.some(body => body.includes('puddle-kernel-railgun-recovery')), 'Registration must wait for the saved backup.');
    const download = page.waitForEvent('download'); await page.locator('#save-backup').click();
    const path = await (await download).path(); assert(path);
    const file = parseRecoveryFile(await readFile(path, 'utf8'));
    await page.locator('#funding-instructions').waitFor({state: 'visible'});
    assert.equal((await status(file.depositAddress)).status, 'waiting');
    assert.equal(await page.locator('#relay-from-wallet').isVisible(), false);
    assert.equal(await page.locator('#demo-relay').isVisible(), false);
    await page.locator('#demo-fund').click();
    await page.waitForFunction(() => document.querySelector('#automatic-status')?.textContent?.includes('Automatic deposit confirmed'), undefined, {timeout: 35_000});
    const job = await status(file.depositAddress); assert.equal(job.status, 'confirmed'); assert(job.hash);
    const receipt = await env.provider.getTransactionReceipt(job.hash); assert(receipt);
    const poolAmount = parseEther('0.01') - parseEther('0.01') / 1000n - BigInt(job.gasFee!);
    assert.equal((await decryptDeposit(env, recipient, receipt)).amount, poolAmount - poolAmount * 25n / 10000n);
    assert.equal(await page.locator('#connected-wallet').textContent(), '');
    assert.equal(await page.locator('#funding-instructions').isVisible(), false);
    assert(!posts.some(body => body.includes(recipient.address)), 'The recipient address stays in the browser.');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await app.close(); }
});
