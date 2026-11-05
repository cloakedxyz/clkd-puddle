import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {Contract, ContractFactory, parseEther, keccak256} from 'ethers';
import {chromium} from 'playwright';
import {createRequire} from 'node:module';
const jsQR: typeof import('jsqr').default = createRequire(import.meta.url)('jsqr');
import {startRailgunDemo} from '../scripts/railgun-app.ts';
import {decryptDeposit, fund} from './helpers.ts';
import {parseRecoveryFile, createRailgunAdapter, createRecoveryFile, inspectRecovery} from '../sdk/index.ts';
import {contractArtifact, recoveryArtifacts} from '../scripts/artifacts.ts';

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
    await page.waitForFunction(() => !!document.querySelector<HTMLInputElement>('#private-recipient')?.value);
    assert.equal(await page.locator('#amount-entry').isVisible(), false);
    await page.locator('#protocol-menu-toggle').click();
    assert.equal(await page.locator('#protocol-option-railgun').isEnabled(), true);
    for (const id of ['privacy-pools-v1', 'privacy-pools-v2']) {
      assert.equal(await page.locator('#protocol-option-' + id).isDisabled(), true);
      assert((await page.locator('#protocol-option-' + id).innerText()).includes('Coming soon'));
    }
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#protocol-menu').isVisible(), false);
    await page.locator('#protocol-menu-toggle').click(); await page.locator('#chain-menu-toggle').click();
    assert.equal(await page.locator('#protocol-menu').isVisible(), false);
    await page.keyboard.press('Escape');
    await page.locator('h2').click();
    await page.screenshot({path: '.cache/puddle-receive-mobile-light.png', fullPage: true, animations: 'disabled'});
    await page.locator('#menu-toggle').click(); await page.locator('#site-menu [data-theme-choice="dark"]').click();
    await page.locator('#menu-toggle').click();
    await page.screenshot({path: '.cache/puddle-receive-mobile-dark.png', fullPage: true, animations: 'disabled'});
    await page.locator('#protocol-menu-toggle').click();
    await page.screenshot({path: '.cache/puddle-protocol-menu-dark.png', fullPage: true, animations: 'disabled'});
    await page.keyboard.press('Escape');
    assert((await page.locator('#route-description').innerText()).includes('ETH and tokens'));
    for (const native of [true, false]) {
      if (!native) await page.locator('#new-receive').click();
      await page.locator('#prepare').click();
      await page.locator('#receive-details').waitFor({state: 'visible'});
      assert.equal(await page.locator('#protocol-menu-toggle').isDisabled(), true);
      assert.equal(await page.locator('#funding-instructions').isVisible(), false);
      assert.equal(await page.locator('#receive-info').isVisible(), false);
      await page.screenshot({path: '.cache/puddle-save-recovery-dark.png', fullPage: true, animations: 'disabled'});
      const download = page.waitForEvent('download'); await page.locator('#save-backup').click();
      const path = await (await download).path(); assert(path);
      const recovery = parseRecoveryFile(await readFile(path, 'utf8'));
      await page.locator('#funding-instructions').waitFor({state: 'visible'});
      assert.equal(await page.locator('.receive-heading').isVisible(), false);
      assert.equal(await page.locator('#receive-info').getAttribute('open'), null);
      assert.equal(await page.locator('#receiving-address').innerText(), recovery.depositAddress);
      const pixels = await page.locator('#receiving-qr svg').evaluate(async svg => {
        const image = new Image(); const url = 'data:image/svg+xml;base64,' + btoa(new XMLSerializer().serializeToString(svg));
        try {
          image.src = url; await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 240;
          const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0, 240, 240);
          return Array.from(context.getImageData(0, 0, 240, 240).data);
        } finally {image.remove();}
      });
      assert.equal(jsQR(new Uint8ClampedArray(pixels), 240, 240)?.data, recovery.depositAddress);
      await page.screenshot({path: '.cache/puddle-receive-address-dark.png', fullPage: true, animations: 'disabled'});

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
      await page.screenshot({path: `.cache/multi-asset-${native ? 'eth' : 'erc20'}-review.png`, fullPage: true, animations: 'disabled'});
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
      assert.equal(await page.locator('#protocol-menu-toggle').isDisabled(), true);
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
    // Previously issued WETH recovery files remain usable after the website switches modules.
    const legacyArtifact = contractArtifact('RailgunExecutor');
    const oldModule = await new ContractFactory(legacyArtifact.abi, legacyArtifact.bytecode.object, app.env.deployer)
      .deploy(app.env.deployment.factory, app.env.deployment.pool, app.env.deployment.asset, app.env.deployment.maxGasFee);
    await oldModule.waitForDeployment();
    const legacyDeployment = {...app.env.deployment, multiAsset: false, executor: await oldModule.getAddress(),
      codeHashes: {...app.env.deployment.codeHashes, executor: keccak256(await app.env.provider.getCode(await oldModule.getAddress()))}};
    const legacyRecord = await createRailgunAdapter(legacyDeployment).prepare(app.env.provider, {
      recipient: app.recipient.address, recovery: await app.env.recovery.getAddress(),
      relayer: await app.env.relayer.getAddress(), feeRecipient: await app.env.feeCollector.getAddress()});
    const legacyFile = createRecoveryFile(legacyRecord); assert.equal(legacyFile.version, 1);
    const wrongArtifacts = recoveryArtifacts(true); wrongArtifacts.previousExecutor!.code = '0x00';
    await assert.rejects(inspectRecovery(app.env.provider, legacyFile, wrongArtifacts), /Unrecognized executor/);
    await fund(app.env, legacyRecord.address, parseEther('0.001'));
    await (await app.env.sender.sendTransaction({to: legacyRecord.address, value: 123n})).wait();
    await page.locator('#restore-backup').setInputFiles({name: 'earlier-recovery.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(legacyFile))});
    await page.waitForFunction(() => document.querySelector('#balance-status')?.textContent?.includes('Recovery restored'));
    assert.equal(await page.locator('#funding-instructions').isVisible(), false);
    await page.locator('#wallet-tools').evaluate(element => {(element as HTMLDetailsElement).open = true;});
    await page.locator('#connect-wallet').click(); await page.locator('#recovery-asset').fill('ETH');
    await page.locator('#recover-from-wallet').click();
    await page.waitForFunction(() => !(document.querySelector('#refresh-deposit') as HTMLButtonElement)?.disabled);
    assert.equal(await app.env.provider.getBalance(legacyRecord.address), 0n);
    await page.locator('#recovery-asset').fill(app.env.deployment.asset); await page.locator('#recover-from-wallet').click();
    await page.waitForFunction(() => !(document.querySelector('#refresh-deposit') as HTMLButtonElement)?.disabled);
    assert.equal(await app.env.token.balanceOf(legacyRecord.address), 0n);
    assert.deepEqual(errors, []);
  } finally {await browser.close(); await app.close();}
});
