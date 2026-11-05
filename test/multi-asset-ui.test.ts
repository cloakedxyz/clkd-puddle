import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {Contract, ContractFactory, parseEther} from 'ethers';
import {chromium} from 'playwright';
import {startRailgunDemo} from '../scripts/railgun-app.ts';
import {decryptDeposit} from './helpers.ts';
import {parseRecoveryFile} from '../sdk/index.ts';

test('flexible browser flow requires only two addresses, detects ETH and ERC-20s, quotes manually and recovers other funds', {timeout: 150_000}, async () => {
  const app = await startRailgunDemo(0, false, true);
  const browser = await chromium.launch(process.platform === 'darwin' ? {channel: 'chrome'} : {});
  try {
    const page = await browser.newPage({viewport: {width: 390, height: 844}});
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    let account = await app.env.relayer.getAddress();
    await page.exposeFunction('testWalletRequest', async ({method, params}: {method: string; params?: unknown[]}) => {
      if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return [account];
      return app.env.provider.send(method, params ?? []);
    });
    await page.addInitScript(() => {(window as unknown as {ethereum: unknown}).ethereum = {request: (request: unknown) =>
      (window as unknown as {testWalletRequest: (request: unknown) => Promise<unknown>}).testWalletRequest(request)};});
    await page.goto(app.url);
    await page.waitForFunction(() => !!document.querySelector<HTMLTextAreaElement>('#private-recipient')?.value);
    assert.equal(await page.locator('#amount-entry').isVisible(), false);
    assert((await page.locator('#route-description').innerText()).includes('ETH and tokens'));
    for (const native of [true, false]) {
      if (!native) await page.locator('#new-receive').click();
      await page.locator('#prepare').click();
      await page.locator('#receive-details').waitFor({state: 'visible'});
      assert.equal(await page.locator('#funding-instructions').isVisible(), false);
      const download = page.waitForEvent('download'); await page.locator('#save-backup').click();
      const path = await (await download).path(); assert(path);
      const recovery = parseRecoveryFile(await readFile(path, 'utf8'));
      await page.locator('#funding-instructions').waitFor({state: 'visible'});
      let amount: bigint, token: Contract | undefined, proxy: Contract | undefined;
      if (native) {
        amount = parseEther('0.01'); await (await app.env.sender.sendTransaction({to: recovery.depositAddress, value: amount})).wait();
      } else {
        amount = 100_000_000n;
        const artifact = app.env.contracts['test/contracts/DemoToken.sol'].DemoToken;
        const deployed = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, app.env.deployer).deploy(); await deployed.waitForDeployment();
        const proxyArtifact = app.env.contracts['test/contracts/DemoToken.sol'].DemoTokenProxy;
        const deployedProxy = await new ContractFactory(proxyArtifact.abi, proxyArtifact.evm.bytecode.object, app.env.deployer).deploy(await deployed.getAddress()); await deployedProxy.waitForDeployment();
        proxy = new Contract(await deployedProxy.getAddress(), proxyArtifact.abi, app.env.deployer);
        token = new Contract(await proxy.getAddress(), artifact.abi, app.env.deployer);
        await (await token.getFunction('mint')(recovery.depositAddress, amount)).wait();
        await (await app.env.sender.sendTransaction({to: recovery.depositAddress, value: 123n})).wait();
      }
      await page.locator('#refresh-deposit').click();
      await page.locator('#detected-funds').waitFor({state: 'visible'});
      assert.equal(await page.locator('#error').isVisible(), false, await page.locator('#error').innerText().catch(() => ''));
      if (token) await page.locator('#funded-asset').selectOption(await token.getAddress());
      await page.locator('#wallet-tools').evaluate(element => {(element as HTMLDetailsElement).open = true;});
      await page.locator('#connect-wallet').click();
      await page.locator('#prepare-manual-relay').click();
      if (!native) {
        await page.waitForFunction(() => document.querySelector('#error')?.textContent?.includes('review token behavior'));
        await page.locator('#review-standard-token').check();
        await page.locator('#prepare-manual-relay').click();
      }
      await page.locator('#deposit-review').waitFor({state: 'visible'});
      await page.screenshot({path: `.cache/multi-asset-${native ? 'eth' : 'erc20'}-review.png`, fullPage: true});
      if (proxy) {
        const replacementArtifact = app.env.contracts['test/contracts/DemoToken.sol'].Demo18Token;
        const replacement = await new ContractFactory(replacementArtifact.abi, replacementArtifact.evm.bytecode.object, app.env.deployer).deploy(); await replacement.waitForDeployment();
        await (await proxy.getFunction('setImplementation')(await replacement.getAddress())).wait();
        await page.locator('#refresh-deposit').click();
        await page.waitForFunction(() => !(document.querySelector('#refresh-deposit') as HTMLButtonElement)?.disabled);
        assert.equal(await page.locator('#relay-from-wallet').isDisabled(), true);
        assert.equal(await page.locator('#review-standard-token').isChecked(), false);
        assert.equal(await app.env.executor.spent(recovery.depositAddress), false);
        await page.locator('#review-standard-token').check(); await page.locator('#prepare-manual-relay').click();
      }
      await page.locator('#relay-from-wallet').click();
      await page.waitForFunction(() => document.querySelector('#balance-status')?.textContent?.includes('Pool deposit executed'));
      const hash = (await page.locator('#transaction-status').innerText()).match(/0x[\da-f]{64}/i)?.[0]; assert(hash);
      const receipt = await app.env.provider.getTransactionReceipt(hash); assert(receipt);
      const note = await decryptDeposit(app.env, app.recipient, receipt);
      const poolAmount = amount - amount / 1000n;
      assert.equal(note.amount, poolAmount - poolAmount * 25n / 10000n);
      if (!native) {
        // Reload and recover unrelated native funds using only the saved file.
        account = await app.env.recovery.getAddress(); await page.reload();
        await page.locator('#restore-backup').setInputFiles(path);
        await page.locator('#receive-details').waitFor({state: 'visible'});
        await page.locator('#wallet-tools').evaluate(element => {(element as HTMLDetailsElement).open = true;});
        await page.locator('#connect-wallet').click(); await page.locator('#recovery-asset').fill('ETH');
        await page.locator('#recover-from-wallet').click();
        await page.waitForFunction(() => document.querySelector('#transaction-status')?.textContent?.includes('Recovery submitted'));
        await page.waitForFunction(() => !(document.querySelector('#refresh-deposit') as HTMLButtonElement)?.disabled);
        assert.equal(await app.env.provider.getBalance(recovery.depositAddress), 0n);
      }
    }
    // The default local demo also completes without importing any disposable operator key.
    await page.locator('#new-receive').click(); await page.locator('#prepare').click();
    await page.locator('#receive-details').waitFor({state: 'visible'});
    const demoDownload = page.waitForEvent('download'); await page.locator('#save-backup').click(); await demoDownload;
    await page.locator('#demo-fund').click(); await page.locator('#demo-relay').waitFor({state: 'visible'});
    await page.locator('#demo-relay').click();
    await page.waitForFunction(() => document.querySelector('#balance-status')?.textContent?.includes('Pool deposit executed'));
    assert.deepEqual(errors, []);
  } finally {await browser.close(); await app.close();}
});
