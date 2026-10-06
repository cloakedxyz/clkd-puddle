import assert from 'node:assert/strict';
import { before, after, beforeEach, afterEach, test } from 'node:test';
import { AbiCoder, Contract, JsonRpcProvider, ZeroAddress, keccak256 } from 'ethers';
import { LeanIMT } from '@zk-kit/lean-imt';
import { poseidon2 } from 'poseidon-lite';
import { compileV1, environment, mined, prove, recoveryFiles } from './harness.ts';
import type { Environment } from './harness.ts';
import { relayDeposit, inspectDeposit } from '../../protocols/deposit.ts';
import { decodeV1Recipient, v1Field, v1Native, v1ForwarderABI, v1PoolABI } from '../../protocols/privacy-pools-v1-data.ts';
import { createV1NoteBackup, parseV1NoteBackup, v1NullifierHash, v1Commitment } from '../../recovery/v1-note.ts';
import { createRecoveryFile, recoveryArtifacts } from '../../scripts/recovery-file.ts';
import { parseRecoveryFile, recoveryTransaction } from '../../recovery/core.ts';
import { inspectV1Note, prepareV1PoolRecovery, verifyV1Artifact } from '../../recovery/v1.ts';
import { chromium } from 'playwright';
import { startRecoverySite } from '../../scripts/serve-recovery.ts';
import { createV1Secrets, receivingWallet } from './wallet.ts';
import { officialSDK } from './official-sdk.ts';
import { minimumV1Funding, prepareV1PublicReceive, readV1Pool } from '../../client/index.ts';
import { startSepoliaSite } from '../../scripts/sepolia-app.ts';

let env: Environment;
let snapshot: string;
before(async () => { env = await environment(compileV1()); });
after(async () => { if (env) await env.close(); });
beforeEach(async () => { snapshot = await env.provider.send('evm_snapshot', []); });
afterEach(async () => { await env.provider.send('evm_revert', [snapshot]); });

async function prepare(native: boolean, recovery?: string) {
  const secrets = createV1Secrets();
  const token = native ? ZeroAddress : await env.token.getAddress();
  const record = await env.adapter.prepare(env.provider, { token, precommitment: secrets.precommitment,
    recovery: recovery ?? await env.owner.getAddress(), relayer: await env.relayer.getAddress(), feeRecipient: await env.fees.getAddress() });
  const block = await env.provider.getBlock('latest');
  assert(block);
  const execution = await env.adapter.quote(env.provider, record,
    { token, amount: 1_000_000n, gasFee: 1000n, deadline: BigInt(block.timestamp + 3600) });
  const file = parseRecoveryFile(JSON.stringify(createRecoveryFile(record, token)));
  const backup = parseV1NoteBackup(JSON.stringify(createV1NoteBackup(31337n, decodeV1Recipient(record.config.recipient).pool, secrets)));
  return { secrets, record, execution, file, backup, artifacts: recoveryArtifacts(env.compiled.puddle) };
}
async function fund(prepared: Awaited<ReturnType<typeof prepare>>, amount = prepared.execution.quote.amount) {
  if (prepared.execution.quote.token === ZeroAddress) await mined(env.sender.sendTransaction({ to: prepared.record.address, value: amount }));
  else await mined(env.token.getFunction('mint')(prepared.record.address, amount));
}
const fee = (receipt: { fee: bigint }) => receipt.fee;

test('public receive code fixes recovery ownership; live minimum changes block relay without charging fees', async () => {
  const poolMinimum = 1_000_000_000_000_000n;
  await mined(env.entrypoint.getFunction('updatePoolConfiguration')(v1Native, poolMinimum, 100n, 1000n));
  const rules = await readV1Pool(env.provider, env.adapter.deployment, ZeroAddress);
  assert.equal(rules.minimumDepositAmount, poolMinimum);
  const block = await env.provider.getBlock('latest');
  assert(block);
  const terms = { recovery: await env.owner.getAddress(), relayer: await env.relayer.getAddress(),
    feeRecipient: await env.fees.getAddress(), token: ZeroAddress, gasFee: 1000n,
    amount: minimumV1Funding(poolMinimum, 1000n), deadline: BigInt(block.timestamp + 3600) };
  const receive = await receivingWallet(env.provider, env.adapter.deployment, terms);
  // Even an untyped caller supplying its own recovery field cannot replace the wallet in the public code.
  const changedInput = { ...terms, recovery: await env.attacker.getAddress() };
  const protectedReceive = await prepareV1PublicReceive(env.provider, env.adapter.deployment, changedInput, receive.code);
  assert.equal(protectedReceive.deposit.config.recovery, terms.recovery);
  await assert.rejects(prepareV1PublicReceive(env.provider, env.adapter.deployment,
    { ...terms, amount: terms.amount - 1n }, receive.code), /too small/);
  await mined(env.sender.sendTransaction({ to: receive.deposit.address, value: terms.amount }));
  await mined(env.entrypoint.getFunction('updatePoolConfiguration')(v1Native, poolMinimum + 1n, 100n, 1000n));
  const feesBefore = await env.provider.getBalance(terms.feeRecipient);
  await assert.rejects(relayDeposit(env.adapter, receive.deposit, env.relayer), /too small/);
  assert.equal(await env.provider.getBalance(receive.deposit.address), terms.amount);
  assert.equal(await env.provider.getBalance(terms.feeRecipient), feesBefore);
  const artifacts = recoveryArtifacts(env.compiled.puddle);
  for (const action of ['deploy', 'recover'] as const) {
    await mined(env.owner.sendTransaction(await recoveryTransaction(env.provider, receive.recovery,
      artifacts, terms.recovery, ZeroAddress, action)));
  }
  assert.equal(await env.provider.getBalance(receive.deposit.address), 0n);
});

test('Sepolia servers keep independent deployment configurations', async t => {
  const configuration = { chainId: '31337', pool: await env.entrypoint.getAddress(), factory: await env.factory.getAddress(),
    relayer: await env.relayer.getAddress(), feeRecipient: await env.fees.getAddress(), gasFee: '1000', rpcUrl: env.provider._getConnection().url };
  const artifacts = recoveryArtifacts(env.compiled.puddle);
  const first = await startSepoliaSite(configuration, 0, artifacts);
  t.after(() => first.close());
  const secondConfig = { ...configuration, gasFee: '2000' };
  const second = await startSepoliaSite(secondConfig, 0, artifacts);
  t.after(() => second.close());
  assert.deepEqual(await (await fetch(first.url + '/configuration.json')).json(), configuration);
  assert.deepEqual(await (await fetch(second.url + '/configuration.json')).json(), secondConfig);
});

test('Sepolia browser flow uses public codes, manual relay, top-ups and owner-only wrong-token recovery', async () => {
  const configuration = { chainId: '31337', pool: await env.entrypoint.getAddress(), factory: await env.factory.getAddress(),
    relayer: await env.relayer.getAddress(), feeRecipient: await env.fees.getAddress(), gasFee: '1000', rpcUrl: env.provider._getConnection().url };
  const artifacts = recoveryArtifacts(env.compiled.puddle);
  const site = await startSepoliaSite(configuration, 0, artifacts);
  const browser = await chromium.launch({ channel: process.platform === 'darwin' ? 'chrome' : undefined, headless: true });
  try {
    const page = await browser.newPage();
    let account = configuration.relayer;
    let transactions = 0;
    let connections = 0;
    await page.exposeFunction('walletRPC', async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === 'eth_requestAccounts') connections++;
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
      if (method === 'eth_sendTransaction') transactions++;
      return env.provider.send(method, params ?? []);
    });
    await page.addInitScript(() => {
      (window as any).ethereum = { request: (payload: unknown) => (window as any).walletRPC(payload) };
      window.addEventListener('eip6963:requestProvider', () => {
        for (const [uuid, name, provider] of [
          ['00000000-0000-4000-8000-000000000001', 'Other wallet', {request: () => {throw new Error('Wrong wallet selected');}}],
          ['00000000-0000-4000-8000-000000000002', 'Cloaked test wallet', (window as any).ethereum],
        ]) window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {detail:{info:{uuid,name},provider}}));
      });
    });
    const block = await env.provider.getBlock('latest'); assert(block);
    const receive = await receivingWallet(env.provider, env.adapter.deployment, { recovery: await env.owner.getAddress(),
      relayer: configuration.relayer, feeRecipient: configuration.feeRecipient, token: ZeroAddress,
      gasFee: 1000n, amount: 2_000_000n, deadline: BigInt(block.timestamp + 3600) });
    await page.goto(site.url);
    await page.locator('#create-form').waitFor({ state: 'visible' });
    await page.locator('#receive-code').fill(JSON.stringify(receive.code));
    await page.locator('#amount').fill('0.000000000002');
    await page.locator('#create').click();
    await page.locator('#deposit').waitFor({ state: 'visible' });
    const address = (await page.locator('#address').textContent())!;
    assert.match((await page.locator('#recovery-wallet').textContent())!, new RegExp(await env.owner.getAddress()));
    assert.equal(transactions, 0, 'Creating an address never sends a transaction');
    assert.equal(connections, 0, 'Creating a receiving address never requests a wallet connection');
    await page.locator('#wallet-tools summary').click();
    await page.locator('#wallet').selectOption({label:'Cloaked test wallet'});
    await page.locator('#connect').click();
    await page.waitForFunction(() => document.querySelector('#status')?.textContent?.startsWith('Connected:'));
    await mined(env.sender.sendTransaction({ to: address, value: 1_000_000n }));
    await page.locator('#refresh').click();
    await page.waitForFunction(() => document.querySelector('#funding')?.textContent?.includes('Send another'));
    assert(await page.locator('#relay').isDisabled());
    await page.locator('#deposit summary').click();
    await page.locator('#recover').click();
    await page.waitForFunction(() => document.querySelector('#error')?.textContent?.includes('recovery wallet'));
    assert.equal(transactions, 0, 'The wrong wallet must not submit a recovery transaction');
    await mined(env.sender.sendTransaction({ to: address, value: 1_000_000n }));
    await page.locator('#refresh').click();
    await page.waitForFunction(() => document.querySelector('#funding')?.textContent?.includes('Ready for manual relay'));
    assert(await page.locator('#relay').isDisabled(), 'Saving the recovery configuration is required');
    await page.waitForFunction(() => !(document.querySelector('#save') as HTMLButtonElement).disabled);
    let resume!: () => void;
    const rpcURL = new URL(configuration.rpcUrl).href;
    const requestReceived = page.waitForRequest(rpcURL);
    const release = new Promise<void>(resolve => { resume = resolve; });
    await page.route(rpcURL, async route => { await release; await route.continue(); });
    const download = page.waitForEvent('download');
    try {
      await page.locator('#save').click(); await download; await requestReceived;
      assert(await page.locator('#save').isDisabled(), 'Actions stay locked while balances are being verified');
      assert(await page.locator('#wallet').isDisabled(), 'The wallet cannot change during verification');
    } finally { resume(); }
    await page.waitForFunction(() => !(document.querySelector('#relay') as HTMLButtonElement).disabled);
    await page.unroute(rpcURL);
    await page.screenshot({ path: '.cache/sepolia-client.png', fullPage: true });
    assert.equal(transactions, 0, 'Funding and checking the address must never auto-relay');
    await page.locator('#relay').click();
    await page.waitForFunction(() => document.querySelector('#status')?.textContent?.startsWith('Pool deposit confirmed:'), { timeout: 30_000 });
    assert.equal(transactions, 1);
    await mined(env.token.getFunction('mint')(address, 123n));
    account = await env.owner.getAddress();
    await page.locator('#connect').click();
    await page.waitForFunction((owner) => document.querySelector('#status')?.textContent?.includes(owner), account);
    const before = await env.token.getFunction('balanceOf')(account);
    await page.locator('#recover-asset').fill(await env.token.getAddress());
    await page.locator('#recover').click();
    await page.waitForFunction(() => document.querySelector('#status')?.textContent?.startsWith('Recovered to '), { timeout: 30_000 });
    assert.equal(await env.token.getFunction('balanceOf')(account), before + 123n);
    assert.equal(await env.token.getFunction('balanceOf')(address), 0n);
  } finally { await browser.close(); await site.close(); }
});

test('a wallet public code deposits through Puddle and is restored by the official PP SDK from its phrase alone', async () => {
  const sdk = await officialSDK();
  const block = await env.provider.getBlock('latest');
  assert(block);
  const receive = await receivingWallet(env.provider, env.adapter.deployment, {
    recovery: await env.owner.getAddress(), relayer: await env.relayer.getAddress(), feeRecipient: await env.fees.getAddress(),
    token: ZeroAddress, amount: 1_000_000n, gasFee: 1000n, deadline: BigInt(block.timestamp + 3600),
  }, sdk);
  const { scope, mnemonic } = receive;
  const backup = receive.noteBackup;
  await mined(env.sender.sendTransaction({ to: receive.deposit.address, value: receive.deposit.quote.amount }));
  await mined(relayDeposit(env.adapter, receive.deposit, env.relayer));
  const pool = { address: backup.pool, chainId: 31337, scope, deploymentBlock: 0n };
  // A fresh data client also avoids viem's cached head hiding the just-mined exit.
  const restore = () => sdk.AccountService.initializeWithEvents(new sdk.DataService([
    { chainId: 31337, privacyPoolAddress: pool.address, startBlock: 0n, rpcUrl: env.provider._getConnection().url },
  ]), { mnemonic }, [pool], { includeEmptyNodes: false });
  const restored = await restore();
  assert.deepEqual(restored.errors, []);
  const notes = restored.account.getSpendableCommitments().get(scope);
  assert.equal(notes?.length, 1);
  assert.equal(notes[0].value, 988020n);
  assert.equal(notes[0].hash, v1Commitment((await inspectV1Note(env.provider, receive.recovery,
    recoveryArtifacts(env.compiled.puddle), backup)).note));
  await mined(env.owner.sendTransaction(await prepareV1PoolRecovery(env.provider, receive.recovery,
    recoveryArtifacts(env.compiled.puddle), await env.owner.getAddress(), backup, recoveryFiles())));
  const exited = await restore();
  assert.deepEqual(exited.errors, []);
  assert.equal(exited.account.getSpendableCommitments().get(scope)?.length ?? 0, 0);
});

for (const native of [true, false]) {
  const asset = native ? 'ETH' : 'ERC20';
  test(`${asset}: undeployed receive-address recovery needs no secrets or relayer`, async () => {
    const p = await prepare(native);
    await fund(p, 123n);
    const owner = await env.owner.getAddress();
    const balance = () => native ? env.provider.getBalance(owner) : env.token.getFunction('balanceOf')(owner) as Promise<bigint>;
    const before = await balance();
    let gas = 0n;
    for (const action of ['deploy', 'recover'] as const) {
      gas += fee(await mined(env.owner.sendTransaction(await recoveryTransaction(env.provider, p.file, p.artifacts, owner,
        p.execution.quote.token, action))));
    }
    assert.equal(await balance() - before + (native ? gas : 0n), 123n);
    assert.equal((await inspectDeposit(env.adapter, p.execution, env.provider)).balance, 0n);
  });

  test(`${asset}: real deposit, fresh-session backup recovery and late funds`, async () => {
    const p = await prepare(native);
    await fund(p, p.execution.quote.amount + 17n);
    const receipt = await mined(relayDeposit(env.adapter, p.execution, env.relayer));
    const owner = await env.owner.getAddress();
    const pool = native ? env.nativePool : env.tokenPool;
    const balance = () => native ? env.provider.getBalance(owner) : env.token.getFunction('balanceOf')(owner) as Promise<bigint>;
    assert.equal((await inspectDeposit(env.adapter, p.execution, env.provider)).balance, 17n);
    // Fresh chain connection + serialized backups; no application/session or screening service exists here.
    const restored = new JsonRpcProvider(env.provider._getConnection().url, 31337, { cacheTimeout: -1 });
    try {
      const backup = parseV1NoteBackup(JSON.stringify(p.backup));
      const file = parseRecoveryFile(JSON.stringify(p.file));
      const checked = await inspectV1Note(restored, file, p.artifacts, backup, receipt.blockNumber);
      assert.equal(checked.note.value, 988_020n);
      assert.equal(await pool.getFunction('depositors')(checked.note.label), p.record.address);
      const request = await prepareV1PoolRecovery(restored, file, p.artifacts, owner, backup, recoveryFiles(), receipt.blockNumber);
      await assert.rejects(env.attacker.sendTransaction({ ...request, from: await env.attacker.getAddress() }));
      // A wallet cannot call the v1 pool directly, even with the correct proof.
      const proof = v1ForwarderABI.decodeFunctionData('ragequit', request.data!)[0];
      await assert.rejects(pool.connect(env.owner).getFunction('ragequit').staticCall(proof));
      const before = await balance();
      const exit = await mined(env.owner.sendTransaction(request));
      assert.equal(await balance() - before + (native ? exit.fee : 0n), checked.note.value);
      await assert.rejects(env.owner.sendTransaction(request));
      assert.equal((await inspectV1Note(restored, file, p.artifacts, backup)).spent, true);
      await fund(p, 23n);
      assert.equal((await inspectDeposit(env.adapter, p.execution, env.provider)).balance, 40n);
      await assert.rejects(relayDeposit(env.adapter, p.execution, env.relayer), /already been relayed/);
      await mined(env.owner.sendTransaction(await recoveryTransaction(restored, file, p.artifacts, owner, p.execution.quote.token, 'recover')));
      assert.equal((await inspectDeposit(env.adapter, p.execution, env.provider)).balance, 0n);
    } finally { restored.destroy(); }
  });
}

test('emergency recovery still works when the pool is closed and removed from the entrypoint', async () => {
  const p = await prepare(true);
  await fund(p); await mined(relayDeposit(env.adapter, p.execution, env.relayer));
  await mined(env.entrypoint.getFunction('windDownPool')(await env.nativePool.getAddress()));
  await mined(env.entrypoint.getFunction('removePool')(v1Native));
  const request = await prepareV1PoolRecovery(env.provider, p.file, p.artifacts, await env.owner.getAddress(), p.backup, recoveryFiles());
  await mined(env.owner.sendTransaction(request));
});

test('real private partial withdrawal followed by emergency recovery of the current note', async () => {
  const p = await prepare(false);
  await fund(p); await mined(relayDeposit(env.adapter, p.execution, env.relayer));
  const { note } = await inspectV1Note(env.provider, p.file, p.artifacts, p.backup);
  const state = new LeanIMT<bigint>((a, b) => poseidon2([a, b]));
  const logs = await new Contract(await env.tokenPool.getAddress(), v1PoolABI, env.provider).queryFilter('LeafInserted');
  state.insertMany(logs.map(log => { assert('args' in log); return BigInt(log.args.leaf); }));
  const asp = new LeanIMT<bigint>((a, b) => poseidon2([a, b]), [note.label]);
  await mined(env.entrypoint.getFunction('updateRoot')(asp.root, 'Qm' + 'x'.repeat(44)));
  const withdrawal = { processooor: await env.owner.getAddress(), data: '0x' };
  const context = BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(['tuple(address processooor,bytes data)', 'uint256'],
    [withdrawal, await env.tokenPool.getFunction('SCOPE')()]))) % v1Field;
  const next = createV1Secrets();
  const withdrawn = 100_000n;
  const stateProof = state.generateProof(state.indexOf(v1Commitment(note)));
  const pad = (values: bigint[]) => [...values, ...Array<bigint>(32 - values.length).fill(0n)];
  const proof = await prove('withdraw', { withdrawnValue: withdrawn, stateRoot: state.root,
    stateTreeDepth: BigInt(state.depth), ASPRoot: asp.root, ASPTreeDepth: BigInt(asp.depth), context,
    label: note.label, existingValue: note.value, existingNullifier: note.nullifier, existingSecret: note.secret,
    newNullifier: next.nullifier, newSecret: next.secret, stateSiblings: pad(stateProof.siblings),
    stateIndex: stateProof.index, ASPSiblings: pad([]), ASPIndex: 0 });
  const before: bigint = await env.token.getFunction('balanceOf')(withdrawal.processooor);
  await mined(env.tokenPool.connect(env.owner).getFunction('withdraw')(withdrawal, proof));
  assert.equal(await env.token.getFunction('balanceOf')(withdrawal.processooor), before + withdrawn);
  await assert.rejects(prepareV1PoolRecovery(env.provider, p.file, p.artifacts, withdrawal.processooor, p.backup, recoveryFiles()), /note was spent/);
  const current = createV1NoteBackup(31337n, p.backup.pool, { ...next, value: note.value - withdrawn, label: note.label });
  await mined(env.owner.sendTransaction(await prepareV1PoolRecovery(env.provider, p.file, p.artifacts, withdrawal.processooor, current, recoveryFiles())));
  assert.equal(await env.token.getFunction('balanceOf')(withdrawal.processooor), before + note.value);
});

test('rejected ETH forwarding rolls back the real pool exit and allows a retry; callbacks cannot reenter', async () => {
  const receiver = await env.deploy('test/contracts/RecoveryReceiver.sol', 'RecoveryReceiver', [], true);
  const p = await prepare(true, await receiver.getAddress());
  await fund(p); await mined(relayDeposit(env.adapter, p.execution, env.relayer));
  const { note } = await inspectV1Note(env.provider, p.file, p.artifacts, p.backup);
  const proof = await prove('commitment', { ...note });
  const data = v1ForwarderABI.encodeFunctionData('ragequit', [proof]);
  await mined(receiver.getFunction('configure')(p.record.address, true));
  await assert.rejects(receiver.getFunction('forward')(data));
  assert.equal(await env.nativePool.getFunction('nullifierHashes')(v1NullifierHash(note)), false);
  await mined(receiver.getFunction('configure')(p.record.address, false));
  await mined(receiver.getFunction('forward')(data));
  assert.equal(await env.provider.getBalance(await receiver.getAddress()), note.value);
  assert.equal(await receiver.getFunction('reentryBlocked')(), true);
});

test('wrong backup, wrong wallet, altered proof and artifact substitution are rejected', async () => {
  const p = await prepare(false);
  await fund(p); await mined(relayDeposit(env.adapter, p.execution, env.relayer));
  const owner = await env.owner.getAddress();
  await assert.rejects(prepareV1PoolRecovery(env.provider, p.file, p.artifacts, await env.attacker.getAddress(), p.backup, recoveryFiles()), /recovery wallet/);
  await assert.rejects(inspectV1Note(env.provider, p.file, p.artifacts, { ...p.backup, secret: '42' }), /secrets do not match/);
  await assert.rejects(inspectV1Note(env.provider, p.file, p.artifacts, { ...p.backup, chainId: '1' }), /another chain/);
  assert.throws(() => parseV1NoteBackup(JSON.stringify({ ...p.backup, secret: '0' })));
  assert.throws(() => parseV1NoteBackup(JSON.stringify({ ...p.backup, transactions: [] })));
  const bad = recoveryFiles().wasm; bad[100] ^= 1;
  await assert.rejects(verifyV1Artifact(bad, 'wasm'), /Incorrect/);
  const request = await prepareV1PoolRecovery(env.provider, p.file, p.artifacts, owner, p.backup, recoveryFiles());
  const proof = v1ForwarderABI.decodeFunctionData('ragequit', request.data!)[0].toArray(true) as bigint[][];
  proof[3][2] += 1n;
  await assert.rejects(env.forwarder(p.record.address).getFunction('ragequit')(proof));
  const balance: bigint = await env.token.getFunction('balanceOf')(p.backup.pool);
  assert.equal(balance, 988_020n);
});

test('deposit failure preserves all funds and fees and leaves independent recovery available', async () => {
  const p = await prepare(true);
  await fund(p);
  await mined(env.entrypoint.getFunction('windDownPool')(await env.nativePool.getAddress()));
  const feesBefore = await env.provider.getBalance(await env.fees.getAddress());
  await assert.rejects(env.factory.connect(env.relayer).getFunction('deployAndExecute')(p.record.salt, p.record.config, p.execution.quote, '0x'));
  assert.equal(await env.provider.getCode(p.record.address), '0x');
  assert.equal(await env.provider.getBalance(p.record.address), p.execution.quote.amount);
  assert.equal(await env.provider.getBalance(await env.fees.getAddress()), feesBefore);
  for (const action of ['deploy', 'recover'] as const) {
    await mined(env.owner.sendTransaction(await recoveryTransaction(env.provider, p.file, p.artifacts, await env.owner.getAddress(), ZeroAddress, action)));
  }
  await assert.rejects(relayDeposit(env.adapter, p.execution, env.relayer), /not fully funded/);
});

test('recovery submitted first leaves a pending deposit unable to spend or collect fees', async () => {
  const p = await prepare(false);
  await fund(p);
  for (const action of ['deploy', 'recover'] as const) {
    await mined(env.owner.sendTransaction(await recoveryTransaction(env.provider, p.file, p.artifacts,
      await env.owner.getAddress(), p.execution.quote.token, action)));
  }
  await assert.rejects(env.factory.connect(env.relayer).getFunction('deployAndExecute')(p.record.salt, p.record.config, p.execution.quote, '0x'));
  assert.equal(await env.token.getFunction('balanceOf')(await env.fees.getAddress()), 0n);
  assert.equal(await env.token.getFunction('balanceOf')(p.backup.pool), 0n);
});

test('browser restores private backup and recovers both pool funds and excess using only static files and its wallet', async () => {
  const p = await prepare(true);
  await fund(p, p.execution.quote.amount + 17n);
  await mined(relayDeposit(env.adapter, p.execution, env.relayer));
  const site = await startRecoverySite(0);
  const browser = await chromium.launch(process.platform === 'darwin' ? { channel: 'chrome' } : {});
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const requests: string[] = [];
    await page.route('**/*', async route => {
      const request = route.request();
      requests.push(request.url());
      assert.equal(request.method(), 'GET', 'The recovery page must never upload private data');
      assert(request.url().startsWith(site.url + '/'), 'No remote services or CDN');
      await route.continue();
    });
    const owner = await env.owner.getAddress();
    const walletCalls: unknown[] = [];
    await page.exposeFunction('testWalletRequest', async ({ method, params = [] }: { method: string; params?: unknown[] }) => {
      walletCalls.push({ method, params });
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [owner];
      return env.provider.send(method, params);
    });
    await page.addInitScript(() => {
      (window as unknown as { ethereum: unknown }).ethereum = {
        request: (request: unknown) => (window as unknown as { testWalletRequest: (r: unknown) => Promise<unknown> }).testWalletRequest(request),
      };
    });
    await page.goto(site.url);
    await page.waitForFunction(() => !(document.querySelector('#controls') as HTMLFieldSetElement).disabled);
    const select = async (id: string, value: unknown) => page.locator(id).setInputFiles({
      name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)),
    });
    await select('#file', p.file);
    await page.locator('#check').click();
    await page.locator('#submit').waitFor({ state: 'visible' });
    await select('#note-file', p.backup);
    await page.locator('#pool-check').click();
    await page.waitForFunction(() => !(document.querySelector('#pool-submit') as HTMLButtonElement).hidden
      || document.querySelector('#status')?.classList.contains('error'));
    assert(await page.locator('#pool-submit').isVisible(), (await page.locator('#status').textContent()) ?? errors.join('\n'));
    await page.screenshot({ path: '.cache/v1-recovery.png', fullPage: true });
    const before = await env.provider.getBalance(owner);
    await page.locator('#pool-submit').click();
    await page.waitForFunction(() => document.querySelector('#status')?.textContent?.startsWith('Pool recovery confirmed')
      || document.querySelector('#status')?.classList.contains('error'), undefined, { timeout: 60_000 });
    assert.match((await page.locator('#status').textContent())!, /^Pool recovery confirmed/);
    const txHash = await page.locator('#transaction').textContent();
    const receipt = await env.provider.getTransactionReceipt(txHash!);
    assert(receipt);
    assert.equal(await env.provider.getBalance(owner) - before + receipt.fee, 988_020n);
    await page.locator('#check').click();
    await page.locator('#submit').click();
    await page.waitForFunction(() => document.querySelector('#status')?.textContent?.startsWith('Recovery confirmed'));
    assert.equal(await env.provider.getBalance(p.record.address), 0n);
    assert.deepEqual(errors, []);
    assert(requests.some(url => url.endsWith('/v1/commitment.zkey')));
    const calls = JSON.stringify(walletCalls);
    assert(!calls.includes(p.backup.secret) && !calls.includes(p.backup.nullifier), 'Secrets never enter wallet requests');
  } finally { await browser.close(); await site.close(); }
});
