import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Contract, ContractFactory, ZeroAddress, parseEther} from 'ethers';
import {createEnvironment, createRecipient, decryptDeposit, compile} from './helpers.ts';
import {recoveryArtifacts} from '../scripts/artifacts.ts';
import {prepareFlexibleReceive, readFundingAsset, discoverFunding, quoteFunding, relayDeposit,
  createRailgunAdapter, mined, parseRecoveryFile, recoveryTransaction} from '../sdk/index.ts';
import type {TokenApproval} from '../sdk/index.ts';

test('one address detects ETH or tokens after preparation, shields actual protocol notes and recovers other assets', {timeout: 120_000}, async () => {
  const contracts = compile(), env = await createEnvironment(contracts, undefined, true, true);
  try {
    const recipient = await createRecipient(), artifacts = recoveryArtifacts(true);
    const input = {recipient: recipient.address, recovery: await env.recovery.getAddress(),
      relayer: await env.relayer.getAddress(), feeRecipient: await env.feeCollector.getAddress()};
    for (const name of ['ETH', 'DemoToken', 'Demo18Token', 'DemoNoReturnToken', 'DemoBareToken', 'DemoHighDecimals']) {
      const {record, recovery} = await prepareFlexibleReceive(env.provider, env.deployment, input, artifacts);
      assert.equal(recovery.version, 2);
      assert.deepEqual(parseRecoveryFile(JSON.stringify(recovery)), recovery);
      let token = env.token;
      const amount = name === 'ETH' ? parseEther('0.01') : 100_000_000n;
      if (name === 'ETH') await mined(env.sender.sendTransaction({to: record.address, value: amount}));
      else {
        const artifact = contracts['test/contracts/DemoToken.sol'][name];
        const deployed = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, env.deployer).deploy();
        await deployed.waitForDeployment(); token = new Contract(await deployed.getAddress(), artifact.abi, env.deployer);
        await mined(token.getFunction('mint')(record.address, amount));
      }
      const found = await discoverFunding(env.provider, record);
      assert.equal(found.assets.length, 1);
      const funding = found.assets[0];
      assert.equal(funding.balance, amount);
      assert.equal(funding.decimals, name === 'DemoBareToken' ? null : name === 'DemoHighDecimals' ? 200 : name === 'DemoToken' || name === 'DemoNoReturnToken' ? 6 : 18);
      const pin = await readFundingAsset(env.provider, record.address, name === 'ETH' ? env.deployment.asset : funding.token);
      const approval: TokenApproval = {token: pin.token, codeHash: pin.codeHash, implementation: pin.implementation, standard: true};
      const quote = await quoteFunding(env.provider, record, funding, approval);
      assert.equal(quote.address, record.address);
      await assert.rejects(quoteFunding(env.provider, record, funding, {...approval, codeHash: '0x'+'0'.repeat(64)}), /Token code changed/);
      await assert.rejects(relayDeposit(createRailgunAdapter(env.deployment), quote, env.attacker), /designated relayer/);
      const receipt = await mined(relayDeposit(createRailgunAdapter(env.deployment), quote, env.relayer));
      const note = await decryptDeposit(env, recipient, receipt);
      const base = amount - amount / 1000n;
      assert.equal(note.amount, base - base * 25n / 10000n);
      assert.equal(await token.getFunction('balanceOf')(record.address), 0n);
      assert.equal(await env.provider.getBalance(record.address), 0n);
      await assert.rejects(relayDeposit(createRailgunAdapter(env.deployment), quote, env.relayer), /already used/);
      // An unrelated ERC-20 and native ETH remain recoverable after success.
      const extra = contracts['test/contracts/DemoToken.sol'].DemoToken;
      const deployed = await new ContractFactory(extra.abi, extra.evm.bytecode.object, env.deployer).deploy(); await deployed.waitForDeployment();
      const other = new Contract(await deployed.getAddress(), extra.abi, env.deployer);
      await mined(other.getFunction('mint')(record.address, 123n));
      await mined(env.sender.sendTransaction({to: record.address, value: 456n}));
      for (const asset of [await other.getAddress(), ZeroAddress]) await mined(env.recovery.sendTransaction(
        await recoveryTransaction(env.provider, recovery, artifacts, input.recovery, asset)));
      assert.equal(await other.getFunction('balanceOf')(record.address), 0n);
      assert.equal(await env.provider.getBalance(record.address), 0n);
    }
  } finally {await env.close();}
});

test('taxed, blocklisted and unapproved assets cannot settle or collect fees; owner recovery stays available', {timeout: 90_000}, async () => {
  const contracts = compile(), env = await createEnvironment(contracts, undefined, true, true);
  try {
    const recipient = await createRecipient(), artifacts = recoveryArtifacts(true);
    const input = {recipient: recipient.address, recovery: await env.recovery.getAddress(), relayer: await env.relayer.getAddress(), feeRecipient: await env.feeCollector.getAddress()};
    const {record, recovery} = await prepareFlexibleReceive(env.provider, env.deployment, input, artifacts);
    const artifact = contracts['test/contracts/DemoToken.sol'].DemoTaxToken;
    const deployed = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, env.deployer).deploy(); await deployed.waitForDeployment();
    const token = new Contract(await deployed.getAddress(), artifact.abi, env.deployer);
    await mined(token.getFunction('mint')(record.address, 100_000_000n));
    const funding = await readFundingAsset(env.provider, record.address, await token.getAddress());
    const approval: TokenApproval = {token: funding.token, codeHash: funding.codeHash, implementation: funding.implementation, standard: true};
    const deposit = await quoteFunding(env.provider, record, funding, approval);
    await assert.rejects(mined(relayDeposit(env.adapter, deposit, env.relayer)));
    assert.equal(await env.provider.getCode(record.address), '0x');
    assert.equal(await token.getFunction('balanceOf')(record.address), 100_000_000n);
    assert.equal(await token.getFunction('balanceOf')(input.feeRecipient), 0n);
    assert.equal(await env.executor.spent(record.address), false);
    await assert.rejects(env.adapter.quote(env.provider, record, {...deposit.quote, approval: undefined}), /approval is required/);
    await assert.rejects(quoteFunding(env.provider, record, funding, approval, 5_000_001n), /Invalid amount|5%/);
    await (await env.pool.addToBlocklist([funding.token])).wait();
    await assert.rejects(quoteFunding(env.provider, record, funding, approval), /RAILGUN excludes/);
    await mined(env.recovery.sendTransaction(await recoveryTransaction(env.provider, recovery, artifacts, input.recovery, funding.token, 'deploy')));
    await mined(env.recovery.sendTransaction(await recoveryTransaction(env.provider, recovery, artifacts, input.recovery, funding.token)));
    assert.equal(await token.getFunction('balanceOf')(record.address), 0n);
    assert.equal(await token.getFunction('balanceOf')(input.recovery), 99_999_999n);
  } finally {await env.close();}
});

test('a discovered proxy upgrade invalidates its quote while saved owner recovery survives', {timeout: 90_000}, async () => {
  const contracts = compile(), env = await createEnvironment(contracts, undefined, true, true);
  try {
    const recipient = await createRecipient(), artifacts = recoveryArtifacts(true);
    const input = {recipient: recipient.address, recovery: await env.recovery.getAddress(), relayer: await env.relayer.getAddress(), feeRecipient: await env.feeCollector.getAddress()};
    const {record, recovery} = await prepareFlexibleReceive(env.provider, env.deployment, input, artifacts);
    const deploy = async (name: string, args: unknown[] = []) => {
      const artifact = contracts['test/contracts/DemoToken.sol'][name];
      const deployed = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, env.deployer).deploy(...args);
      await deployed.waitForDeployment(); return deployed;
    };
    const original = await deploy('DemoToken'), replacement = await deploy('Demo18Token');
    const proxy = await deploy('DemoTokenProxy', [await original.getAddress()]);
    const token = new Contract(await proxy.getAddress(), contracts['test/contracts/DemoToken.sol'].DemoToken.abi, env.deployer);
    await mined(token.getFunction('mint')(record.address, 100_000_000n));
    const funding = await readFundingAsset(env.provider, record.address, await proxy.getAddress());
    assert.equal(funding.implementation?.address, await original.getAddress());
    const quote = await quoteFunding(env.provider, record, funding, {token: funding.token, codeHash: funding.codeHash, implementation: funding.implementation, standard: true});
    await mined(proxy.getFunction('setImplementation')(await replacement.getAddress()));
    await assert.rejects(relayDeposit(env.adapter, quote, env.relayer), /Token implementation changed/);
    assert.equal(await env.executor.spent(record.address), false);
    await mined(env.recovery.sendTransaction(await recoveryTransaction(env.provider, recovery, artifacts, input.recovery, funding.token, 'deploy')));
    await mined(env.recovery.sendTransaction(await recoveryTransaction(env.provider, recovery, artifacts, input.recovery, funding.token)));
    assert.equal(await token.getFunction('balanceOf')(input.recovery), 100_000_000n);
    assert.throws(() => parseRecoveryFile(JSON.stringify({...recovery, multiAsset: false})), /funding scan/);
    await assert.rejects(discoverFunding(env.provider, record, {fromBlock: 0, toBlock: 20_001}), /at most 20,000/);
  } finally {await env.close();}
});
