import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Contract, ContractFactory, JsonRpcProvider, Wallet, ZeroAddress, getAddress, keccak256, parseEther, zeroPadValue } from 'ethers';
import { createEnvironment, createRecipient, decryptDeposit, fund, prepareDeposit, settle } from './helpers.ts';
import { prepareRailgunReceive, createRecoveryFile, parseRecoveryFile, inspectRecovery, recoveryTransaction,
  verifyAccount, verifyDeployment, relayDeposit, mined, createRailgunAdapter } from '../sdk/index.ts';
import { abi, createRecord, executorABI, factoryABI, implementationSlot, initialData, kernelABI } from '../sdk/kernel.ts';
import { contractArtifact, recoveryArtifacts } from '../scripts/artifacts.ts';
import { openRelayWorker } from '../scripts/relay-worker.ts';

let env: Awaited<ReturnType<typeof createEnvironment>>;
let snapshot: string;
before(async () => { env = await createEnvironment(); });
beforeEach(async () => { snapshot = await env.provider.send('evm_snapshot', []); });
afterEach(async () => { await env.provider.send('evm_revert', [snapshot]); });
after(async () => { await env?.close(); });

test('ordinary transfer -> unmodified Kernel factory/account -> real RAILGUN note discovery', async () => {
  const recipient = await createRecipient();
  const block = await env.provider.getBlock('latest'); assert(block);
  const {deposit, recovery} = await prepareRailgunReceive(env.provider, env.deployment, {
    recipient: recipient.address, recovery: await env.recovery.getAddress(), relayer: await env.relayer.getAddress(),
    feeRecipient: await env.feeCollector.getAddress(),
  }, {token: env.deployment.asset, amount: 100_000_000n, gasFee: 200_000n, deadline: BigInt(block.timestamp + 3600)}, recoveryArtifacts());
  assert.equal(recovery.format, 'puddle-kernel-railgun-recovery');
  assert.equal(await env.provider.getCode(deposit.address), '0x');
  const predicted = await env.factory.getFunction('getAddress')(initialData(deposit, deposit.config), deposit.salt);
  assert.equal(predicted, deposit.address);
  await fund(env, deposit.address, deposit.quote.amount);
  const beforeFee = await env.token.getFunction('balanceOf')(deposit.config.feeRecipient);
  const tx = await relayDeposit(env.adapter, deposit, env.relayer);
  assert.equal(getAddress(tx.to!), env.deployment.executor);
  const receipt = await mined(Promise.resolve(tx));
  const note = await decryptDeposit(env, recipient, receipt);
  assert.equal(note.amount, 99_450_750n);
  assert.equal(await env.token.getFunction('balanceOf')(deposit.address), 0n);
  assert.equal(await env.token.getFunction('allowance')(deposit.address, env.deployment.pool), 0n);
  assert.equal(await env.token.getFunction('balanceOf')(deposit.config.feeRecipient) - beforeFee, 300_000n);
  await verifyAccount(env.provider, deposit);
  assert(await env.executor.getFunction('spent')(deposit.address));
  await assert.rejects(relayDeposit(env.adapter, deposit, env.relayer), /already used/);
});

test('partial funding and refreshed quotes preserve the Kernel address, owner and encrypted recipient', async () => {
  const recipient = await createRecipient();
  const original = await prepareDeposit(env, recipient.address, 100_000_000n, 200_000n);
  await fund(env, original.address, 90_000_000n);
  await assert.rejects(relayDeposit(env.adapter, original, env.relayer), /insufficiently funded/);
  const quote = await env.adapter.quote(env.provider, original, {...original.quote, amount: 90_000_000n});
  assert.equal(quote.address, original.address);
  assert.deepEqual(quote.config, original.config);
  assert.equal((await decryptDeposit(env, recipient, await settle(env, quote))).amount, 89_485_725n);
});

test('wrong caller, recipient, fee, expiry and funding revert deployment and charge no service fee', async () => {
  const recipient = await createRecipient();
  const deposit = await prepareDeposit(env, recipient.address, 10_000_000n);
  await fund(env, deposit.address, deposit.quote.amount);
  const data = initialData(deposit, deposit.config);
  const call = env.executor.connect(env.relayer).getFunction('deployAndExecute');
  const beforeFee = await env.token.getFunction('balanceOf')(deposit.config.feeRecipient);
  await assert.rejects(env.executor.connect(env.attacker).getFunction('deployAndExecute')(data, deposit.salt, deposit.config.recipient, deposit.quote));
  for (const quote of [
    {...deposit.quote, gasFee: env.deployment.maxGasFee + 1n}, {...deposit.quote, amount: 0n},
    {...deposit.quote, deadline: 1n}, {...deposit.quote, amount: deposit.quote.amount + 1n},
  ]) await assert.rejects(call(data, deposit.salt, deposit.config.recipient, quote));
  const changedRecipient = deposit.config.recipient.slice(0, -2) + (deposit.config.recipient.endsWith('00') ? '01' : '00');
  await assert.rejects(call(data, deposit.salt, changedRecipient, deposit.quote));
  assert.equal(await env.provider.getCode(deposit.address), '0x');
  assert.equal(await env.token.getFunction('balanceOf')(deposit.address), deposit.quote.amount);
  assert.equal(await env.token.getFunction('balanceOf')(deposit.config.feeRecipient), beforeFee);
  assert.equal(await env.executor.getFunction('spent')(deposit.address), false);
  await settle(env, deposit);
});

test('a stranger deploying the account first cannot change its ownership or prevent the deposit', async () => {
  const recipient = await createRecipient();
  const deposit = await prepareDeposit(env, recipient.address, 5_000_000n);
  await mined(new Contract(deposit.factory, factoryABI, env.attacker).getFunction('createAccount')(initialData(deposit, deposit.config), deposit.salt));
  await verifyAccount(env.provider, deposit);
  await fund(env, deposit.address, deposit.quote.amount);
  await settle(env, deposit);
});

test('saved data recovers an undeployed, expired, partially funded account without the relayer', async () => {
  const recipient = await createRecipient();
  const deposit = await prepareDeposit(env, recipient.address, 10_000_000n);
  const file = parseRecoveryFile(JSON.stringify(createRecoveryFile(deposit)));
  await fund(env, deposit.address, 123_456n);
  await env.provider.send('evm_increaseTime', [7200]); await env.provider.send('evm_mine', []);
  const reader = new JsonRpcProvider(env.provider._getConnection().url, undefined, {cacheTimeout: -1});
  try {
    const before = await env.token.getFunction('balanceOf')(file.config.recovery);
    await assert.rejects(recoveryTransaction(reader, file, recoveryArtifacts(), await env.attacker.getAddress(), file.asset, 'deploy'), /recovery owner/);
    await mined(env.recovery.sendTransaction(await recoveryTransaction(reader, file, recoveryArtifacts(), file.config.recovery, file.asset, 'deploy')));
    await mined(env.recovery.sendTransaction(await recoveryTransaction(reader, file, recoveryArtifacts(), file.config.recovery)));
    assert.equal(await env.token.getFunction('balanceOf')(file.config.recovery) - before, 123_456n);
    assert.equal((await inspectRecovery(reader, file, recoveryArtifacts())).balance, 0n);
    assert.equal(await env.executor.getFunction('spent')(deposit.address), false);
  } finally { reader.destroy(); }
});

test('owner recovery works after module removal; excess, wrong tokens and native currency use Kernel ownership', async () => {
  const recipient = await createRecipient();
  const deposit = await prepareDeposit(env, recipient.address, 10_000_000n);
  const file = createRecoveryFile(deposit);
  await fund(env, deposit.address, deposit.quote.amount + 99n);
  await settle(env, deposit);
  const account = new Contract(deposit.address, kernelABI, env.recovery);
  await mined(account.getFunction('uninstallModule')(2, deposit.executor, abi.encode(['bytes','bytes'], ['0x','0x'])));
  assert.equal(await env.executor.getFunction('installed')(deposit.address), false);
  await mined(env.recovery.sendTransaction(await recoveryTransaction(env.provider, file, recoveryArtifacts(), file.config.recovery)));
  assert.equal(await env.token.getFunction('balanceOf')(deposit.address), 0n);
  const artifact = env.contracts['test/contracts/DemoToken.sol'].DemoToken;
  const wrongToken = await new ContractFactory(artifact.abi, `0x${artifact.evm.bytecode.object}`, env.deployer).deploy();
  await wrongToken.waitForDeployment();
  await mined(wrongToken.getFunction('mint')(deposit.address, 37n));
  await mined(env.recovery.sendTransaction(await recoveryTransaction(env.provider, file, recoveryArtifacts(), file.config.recovery, await wrongToken.getAddress())));
  assert.equal(await wrongToken.getFunction('balanceOf')(deposit.address), 0n);
  assert.equal(await wrongToken.getFunction('balanceOf')(file.config.recovery), 37n);
  await mined(env.sender.sendTransaction({to: deposit.address, value: 17n}));
  const balance = await inspectRecovery(env.provider, file, recoveryArtifacts(), ZeroAddress);
  assert.equal(balance.balance, 17n);
  await mined(env.recovery.sendTransaction(await recoveryTransaction(env.provider, file, recoveryArtifacts(), file.config.recovery, ZeroAddress)));
  assert.equal(await env.provider.getBalance(deposit.address), 0n);
  assert.equal(await env.executor.getFunction('spent')(deposit.address), true);
  await mined(account.getFunction('installModule')(2, deposit.executor,
    '0x' + '00'.repeat(20) + abi.encode(['bytes','bytes'], [abi.encode(['tuple(address,address,bytes32)'],
      [[deposit.config.relayer, deposit.config.feeRecipient, keccak256(deposit.config.recipient)]]), '0x']).slice(2)));
  await fund(env, deposit.address, deposit.quote.amount);
  await assert.rejects(env.executor.connect(env.relayer).getFunction('execute')(deposit.address, deposit.config.recipient, deposit.quote));
});

test('deployment pins, recovery file integrity and trusted module artifacts reject substitutions', async () => {
  const recipient = await createRecipient();
  const deposit = await prepareDeposit(env, recipient.address, 10_000_000n);
  const file = createRecoveryFile(deposit);
  for (const key of ['factory', 'implementation', 'validator', 'executor', 'pool', 'asset'] as const) {
    const bad = {...env.deployment, codeHashes: {...env.deployment.codeHashes, [key]: '0x' + '00'.repeat(32)}};
    await assert.rejects(verifyDeployment(env.provider, bad, recoveryArtifacts()), /code/);
  }
  await assert.rejects(inspectRecovery(env.provider, file, undefined!), /trusted artifacts/i);
  const incomplete = recoveryArtifacts();
  delete (incomplete.contracts as Partial<typeof incomplete.contracts>).factory;
  await assert.rejects(inspectRecovery(env.provider, file, incomplete), /trusted artifacts/i);
  const artifacts = recoveryArtifacts(); artifacts.contracts.executor.code = '0x00';
  await assert.rejects(inspectRecovery(env.provider, file, artifacts), /runtime|build/);
  assert.throws(() => parseRecoveryFile(JSON.stringify({...file, config: {...file.config, recovery: '0x1111111111111111111111111111111111111111'}})));
  assert.throws(() => parseRecoveryFile(JSON.stringify({...file, seed: 'forbidden'})));
  await assert.rejects(inspectRecovery(env.provider, {...file, chainId: '1'}, recoveryArtifacts()), /chain/);
  const decoded = executorABI.decodeFunctionData('deployAndExecute', executorABI.encodeFunctionData('deployAndExecute',
    [initialData(deposit, deposit.config), deposit.salt, deposit.config.recipient, deposit.quote]));
  assert.equal(decoded[2], deposit.config.recipient);
});

test('recovery and relay use the same input snapshot throughout asynchronous checks', async () => {
  const recipient = await createRecipient();
  const deposit = await prepareDeposit(env, recipient.address, 10_000_000n);
  const file = createRecoveryFile(deposit), owner = file.config.recovery;
  await fund(env, deposit.address, 123n);
  await mined(env.recovery.sendTransaction(await recoveryTransaction(env.provider, file, recoveryArtifacts(), owner, file.asset, 'deploy')));
  const other = await env.attacker.getAddress();
  const getNetwork = env.provider.getNetwork.bind(env.provider);
  env.provider.getNetwork = async () => {file.depositAddress = other; return getNetwork();};
  try {
    const transaction = await recoveryTransaction(env.provider, file, recoveryArtifacts(), owner);
    assert.equal(transaction.to, deposit.address);
    await mined(env.recovery.sendTransaction(transaction));
  } finally {env.provider.getNetwork = getNetwork;}
  assert.equal(await env.token.getFunction('balanceOf')(deposit.address), 0n);
  assert.equal(await env.token.getFunction('balanceOf')(owner), 123n);

  const next = await prepareDeposit(env, recipient.address, 10_000_000n);
  await fund(env, next.address, next.quote.amount);
  const expectedExecutor = next.executor;
  const getBlock = env.provider.getBlock.bind(env.provider);
  env.provider.getBlock = async (...args) => {
    const block = await getBlock(...args); next.executor = other; return block;
  };
  try {
    const transaction = await relayDeposit(env.adapter, next, env.relayer);
    assert.equal(getAddress(transaction.to!), expectedExecutor);
    const note = await decryptDeposit(env, recipient, await mined(Promise.resolve(transaction)));
    assert(note.amount > 0n);
  } finally {env.provider.getBlock = getBlock;}
});

test('a contract recovery wallet controls Kernel through direct calls', async () => {
  const fixture = env.contracts['test/contracts/RecoveryWallet.sol'].RecoveryWallet;
  const wallet = await new ContractFactory(fixture.abi, `0x${fixture.evm.bytecode.object}`, env.recovery)
    .deploy(await env.recovery.getAddress());
  await wallet.waitForDeployment();
  const owner = await wallet.getAddress();
  const recipient = await createRecipient();
  const record = await env.adapter.prepare(env.provider, {recipient: recipient.address, recovery: owner,
    relayer: await env.relayer.getAddress(), feeRecipient: await env.feeCollector.getAddress()});
  const file = createRecoveryFile(record);
  await fund(env, record.address, 123n);
  for (const action of ['deploy', 'recover'] as const) {
    const transaction = await recoveryTransaction(env.provider, file, recoveryArtifacts(), owner, file.asset, action);
    await mined(wallet.getFunction('perform')(transaction.to, transaction.data));
  }
  assert.equal(await env.token.getFunction('balanceOf')(record.address), 0n);
  assert.equal(await env.token.getFunction('balanceOf')(owner), 123n);
});

test('a pool implementation change blocks deposits while independent owner recovery stays usable', async () => {
  const recipient = await createRecipient();
  const deposit = await prepareDeposit(env, recipient.address, 10_000_000n);
  const file = createRecoveryFile(deposit);
  await fund(env, deposit.address, 12n);
  await env.provider.send('anvil_setStorageAt', [deposit.pool, implementationSlot, zeroPadValue(await env.attacker.getAddress(), 32)]);
  await assert.rejects(verifyDeployment(env.provider, deposit, recoveryArtifacts()), /implementation pin/);
  for (const action of ['deploy', 'recover'] as const) {
    await mined(env.recovery.sendTransaction(await recoveryTransaction(env.provider, file, recoveryArtifacts(), file.config.recovery, file.asset, action)));
  }
  assert.equal((await inspectRecovery(env.provider, file, recoveryArtifacts())).balance, 0n);
});

test('asset implementation checks block deposits without disabling saved owner recovery', async () => {
  const recipient = await createRecipient(); const deposit = await prepareDeposit(env, recipient.address, 10_000_000n);
  const file = createRecoveryFile(deposit); await fund(env, deposit.address, 123n);
  await env.provider.send('anvil_setStorageAt', [deposit.asset, implementationSlot, zeroPadValue(await env.attacker.getAddress(), 32)]);
  await assert.rejects(verifyDeployment(env.provider, deposit, recoveryArtifacts()), /proxy asset requires an implementation pin/);
  const wrongPin = {...deposit, assetImplementation: {address: env.deployment.factory, codeHash: env.deployment.codeHashes.factory}};
  await assert.rejects(verifyDeployment(env.provider, wrongPin, recoveryArtifacts()), /asset implementation changed/);
  // Earlier v1 files omit the token pin; recovery still uses ownership rather than deposit assumptions.
  const earlier = {...file}; delete earlier.assetImplementation;
  const restored = parseRecoveryFile(JSON.stringify(earlier));
  for (const action of ['deploy', 'recover'] as const) await mined(env.recovery.sendTransaction(
    await recoveryTransaction(env.provider, restored, recoveryArtifacts(), restored.config.recovery, restored.asset, action)));
  assert.equal((await inspectRecovery(env.provider, restored, recoveryArtifacts())).balance, 0n);
});

async function workerFixture() {
  const tokenArtifact = env.contracts['test/contracts/DemoToken.sol'].DemoWrappedNative;
  const wrapped = await new ContractFactory(tokenArtifact.abi, `0x${tokenArtifact.evm.bytecode.object}`, env.deployer).deploy();
  await wrapped.waitForDeployment();
  const token = new Contract(await wrapped.getAddress(), tokenArtifact.abi, env.sender);
  const artifact = contractArtifact('RailgunExecutor'); const maxGasFee = parseEther('0.005');
  const module = await new ContractFactory(artifact.abi, artifact.bytecode.object, env.deployer)
    .deploy(env.deployment.factory, env.deployment.pool, await wrapped.getAddress(), maxGasFee);
  await module.waitForDeployment();
  const asset = await wrapped.getAddress(), executor = await module.getAddress();
  const deployment = {...env.deployment, asset, executor, maxGasFee,
    codeHashes: {...env.deployment.codeHashes, asset: keccak256(await env.provider.getCode(asset)),
      executor: keccak256(await env.provider.getCode(executor))}};
  const operator = Wallet.createRandom().connect(env.provider);
  await mined(env.deployer.sendTransaction({to: operator.address, value: parseEther('0.1')}));
  const adapter = createRailgunAdapter(deployment); const recipient = await createRecipient();
  const record = await adapter.prepare(env.provider, {recipient: recipient.address,
    recovery: await env.recovery.getAddress(), relayer: operator.address, feeRecipient: await env.feeCollector.getAddress()});
  const file = createRecoveryFile(record);
  const policy = {feeRecipient: record.config.feeRecipient, minAmount: parseEther('0.002'), maxAmount: parseEther('0.1'),
    maxNativeFee: parseEther('0.01'), maxTotalNativeSpend: parseEther('0.02'), confirmations: 2, maxJobs: 10};
  return {deployment, operator, recipient, record, file, policy, token,
    fund: async () => { await mined(token.getFunction('deposit')({value: parseEther('0.01')}));
      await mined(token.getFunction('transfer')(record.address, parseEther('0.01'))); }};
}

test('automatic worker persists signed deposits before broadcast and resumes without duplicate spending', async () => {
  const fixture = await workerFixture(); const parent = await mkdtemp(join(tmpdir(), 'puddle-worker-'));
  const directory = join(parent, 'queue'); const artifacts = recoveryArtifacts();
  let worker = await openRelayWorker(fixture.deployment, artifacts, fixture.operator, fixture.policy, directory);
  const broadcast = env.provider.broadcastTransaction.bind(env.provider); let broadcasts = 0;
  try {
    await assert.rejects(openRelayWorker(fixture.deployment, artifacts, fixture.operator, fixture.policy, directory), /EEXIST/);
    await worker.register(fixture.file); await worker.tick();
    assert.equal((await worker.status(fixture.record.address))?.status, 'waiting');
    assert.equal(await env.provider.getTransactionCount(fixture.operator.address), 0);
    const bad = createRecord(fixture.deployment, {...fixture.record.config, feeRecipient: await env.attacker.getAddress()});
    await assert.rejects(worker.register(createRecoveryFile(bad)), /Wrong operator or fee recipient/);
    await fixture.fund();
    const beforeBroadcast = await env.provider.send('evm_snapshot', []);
    env.provider.broadcastTransaction = async raw => {
      const result = await broadcast(raw); broadcasts++;
      assert.equal(broadcasts, 1);
      const saved = JSON.parse(await readFile(join(directory, 'queue.json'), 'utf8'));
      assert.equal(saved.jobs[fixture.record.address].transaction.hash, result.hash, 'Hash was durable before broadcast.');
      throw new Error('Simulated lost broadcast response');
    };
    await assert.rejects(worker.tick(), /Simulated lost broadcast response/);
    const pending = await worker.status(fixture.record.address); assert.equal(pending?.status, 'submitted'); assert(pending.hash);
    assert(BigInt(pending.gasFee!) > 0n && BigInt(pending.gasFee!) <= fixture.deployment.maxGasFee);
    await env.provider.send('evm_mine', []);
    await worker.close();
    env.provider.broadcastTransaction = async raw => { broadcasts++; return broadcast(raw); };
    worker = await openRelayWorker(fixture.deployment, artifacts, fixture.operator, fixture.policy, directory);
    await worker.tick();
    assert.equal((await worker.status(fixture.record.address))?.status, 'confirmed');
    assert.equal(await env.provider.getTransactionCount(fixture.operator.address), 1);
    assert.equal(broadcasts, 1);
    const receipt = await env.provider.getTransactionReceipt(pending.hash); assert(receipt);
    const note = await decryptDeposit(env, fixture.recipient, receipt);
    const poolAmount = parseEther('0.01') - parseEther('0.01') / 1000n - BigInt(pending.gasFee!);
    assert.equal(note.amount, poolAmount - poolAmount * 25n / 10000n);
    await worker.register(fixture.file); await worker.tick();
    assert.equal(await env.provider.getTransactionCount(fixture.operator.address), 1);
    assert.equal(await fixture.token.getFunction('balanceOf')(fixture.record.address), 0n);
    // A confirmed block can disappear. Reuse the original signed transaction;
    // do not allocate a second nonce or a second spending reservation.
    await env.provider.send('evm_revert', [beforeBroadcast]);
    await worker.tick(); assert.equal((await worker.status(fixture.record.address))?.status, 'submitted');
    await worker.tick(); await env.provider.send('evm_mine', []); await worker.tick();
    assert.equal((await worker.status(fixture.record.address))?.status, 'confirmed');
    assert.equal((await worker.status(fixture.record.address))?.hash, pending.hash);
    assert.equal(await env.provider.getTransactionCount(fixture.operator.address), 1);
    assert.equal(broadcasts, 2);
  } finally { env.provider.broadcastTransaction = broadcast; await worker.close(); await rm(parent, {recursive: true}); }
});

test('automatic worker parks expensive deposits and rejects changed budgets without signing', async () => {
  const fixture = await workerFixture(); const parent = await mkdtemp(join(tmpdir(), 'puddle-worker-limits-'));
  const directory = join(parent, 'queue'); const policy = {...fixture.policy, maxNativeFee: 1n, maxTotalNativeSpend: 1n};
  let worker = await openRelayWorker(fixture.deployment, recoveryArtifacts(), fixture.operator, policy, directory);
  try {
    await worker.register(fixture.file); await fixture.fund(); await worker.tick();
    assert.equal((await worker.status(fixture.record.address))?.status, 'blocked');
    assert.equal(await env.provider.getTransactionCount(fixture.operator.address), 0);
    await worker.close();
    await assert.rejects(openRelayWorker(fixture.deployment, recoveryArtifacts(), fixture.operator,
      {...policy, maxTotalNativeSpend: 2n}, directory), /policy changed/);
    worker = await openRelayWorker(fixture.deployment, recoveryArtifacts(), fixture.operator, policy, directory);
    const state = await inspectRecovery(env.provider, fixture.file, recoveryArtifacts());
    assert.equal(state.balance, parseEther('0.01'));
    for (const action of ['deploy', 'recover'] as const) await mined(env.recovery.sendTransaction(
      await recoveryTransaction(env.provider, fixture.file, recoveryArtifacts(), fixture.file.config.recovery, fixture.file.asset, action)));
    assert.equal((await inspectRecovery(env.provider, fixture.file, recoveryArtifacts())).balance, 0n);
  } finally { await worker.close(); await rm(parent, {recursive: true}); }
});

test('automatic worker stops at its cumulative native budget across multiple funded accounts', async () => {
  const fixture = await workerFixture(); const parent = await mkdtemp(join(tmpdir(), 'puddle-worker-budget-'));
  const cap = parseEther('0.01'); const policy = {...fixture.policy, maxNativeFee: cap, maxTotalNativeSpend: cap};
  const worker = await openRelayWorker(fixture.deployment, recoveryArtifacts(), fixture.operator, policy, join(parent, 'queue'));
  // Mutating the caller's object must not change the policy already accepted by the worker.
  policy.maxTotalNativeSpend = parseEther('1');
  let confirmed = 0; let stopped = false;
  try {
    const adapter = createRailgunAdapter(fixture.deployment);
    for (let i = 0; i < 10; i++) {
      const record = await adapter.prepare(env.provider, {recipient: fixture.recipient.address,
        recovery: fixture.record.config.recovery, relayer: fixture.operator.address, feeRecipient: fixture.policy.feeRecipient});
      await worker.register(createRecoveryFile(record));
      await mined(fixture.token.getFunction('deposit')({value: parseEther('0.01')}));
      await mined(fixture.token.getFunction('transfer')(record.address, parseEther('0.01')));
      const before = await env.provider.getTransactionCount(fixture.operator.address);
      await worker.tick();
      if ((await worker.status(record.address))?.status === 'blocked') {
        assert.equal(await env.provider.getTransactionCount(fixture.operator.address), before);
        stopped = true; break;
      }
      await env.provider.send('evm_mine', []); await worker.tick();
      assert.equal((await worker.status(record.address))?.status, 'confirmed'); confirmed++;
    }
    assert(confirmed > 0 && stopped, 'Some deposits complete, then the cumulative budget stops further signing.');
    const saved = JSON.parse(await readFile(join(parent, 'queue/queue.json'), 'utf8'));
    const jobs = Object.values(saved.jobs) as {transaction?: {reservation: string}; networkFee?: string}[];
    const reserved = jobs.reduce((sum, job) => sum + BigInt(job.transaction?.reservation ?? 0), 0n);
    const actual = jobs.reduce((sum, job) => sum + BigInt(job.networkFee ?? 0), 0n);
    assert(actual <= reserved && reserved <= cap);
    assert.equal(await env.provider.getTransactionCount(fixture.operator.address), confirmed);
  } finally { await worker.close(); await rm(parent, {recursive: true}); }
});
