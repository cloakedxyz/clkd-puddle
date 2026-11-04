import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { JsonRpcProvider, parseEther } from 'ethers';
import { createEnvironment, createRecipient, decryptDeposit, fund, prepareDeposit, settle } from './helpers.ts';
import { createRecoveryFile, inspectRecovery, recoveryTransaction, mined, verifyDeployment } from '../sdk/index.ts';
import { recoveryArtifacts } from '../scripts/artifacts.ts';

// Opt-in: all transactions stay on an isolated fork. The public RPC is read-only.
test('Arbitrum: deployed ZeroDev factory/account -> RAILGUN WETH, plus owner recovery', {timeout: 180_000}, async () => {
  const rpc = process.env.ARBITRUM_RPC_URL ?? 'https://arb1.arbitrum.io/rpc';
  const remote = new JsonRpcProvider(rpc, undefined, {batchMaxCount: 1});
  const block = await remote.getBlock(process.env.FORK_BLOCK ? Number(process.env.FORK_BLOCK) : 'latest').finally(() => remote.destroy());
  assert(block?.hash);
  const env = await createEnvironment(undefined, {rpc, block: block.number, chainId: 42161,
    pool: '0xFA7093CDD9EE6932B4eb2c9e1cde7CE00B1FA4b9', token: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    maxGasFee: parseEther('0.00005'), kernel: {
      factory: '0x2577507b78c2008Ff367261CB6285d44ba5eF2E9', implementation: '0xd6CEDDe84be40893d153Be9d467CD6aD37875b28',
    }});
  try {
    assert.equal(env.deployment.codeHashes.factory, '0xcc4b1b98f5716bf61042d87bfedd4709a5c9a597c41f3bb0e6fb6fe1a4ebd37a');
    assert.equal(env.deployment.codeHashes.implementation, '0x9c390b4a1d88a48a63dfb485bc4b6117f59e7f48e4138a93b870e1dd35e25fde');
    await verifyDeployment(env.provider, env.deployment, recoveryArtifacts());
    assert(env.deployment.poolImplementation, 'Pin the real pool implementation, not just proxy code.');
    assert(env.deployment.assetImplementation, 'Pin the WETH implementation, not just proxy code.');
    const recipient = await createRecipient();
    const deposit = await prepareDeposit(env, recipient.address, parseEther('0.0001'), parseEther('0.00001'));
    const file = createRecoveryFile(deposit);
    await fund(env, deposit.address, deposit.quote.amount);
    const receipt = await settle(env, deposit);
    const note = await decryptDeposit(env, recipient, receipt);
    assert.equal(note.amount, parseEther('0.00008967525'));
    assert.equal(await env.token.getFunction('allowance')(deposit.address, env.deployment.pool), 0n);
    await fund(env, deposit.address, 1n);
    await mined(env.recovery.sendTransaction(await recoveryTransaction(env.provider, file, recoveryArtifacts(), file.config.recovery)));
    assert.equal((await inspectRecovery(env.provider, file, recoveryArtifacts())).balance, 0n);
    const unspent = await prepareDeposit(env, recipient.address, parseEther('0.0001'));
    const unspentFile = createRecoveryFile(unspent);
    await fund(env, unspent.address, 2n);
    await mined(env.recovery.sendTransaction(await recoveryTransaction(env.provider, unspentFile, recoveryArtifacts(), unspentFile.config.recovery, unspent.asset, 'deploy')));
    await mined(env.recovery.sendTransaction(await recoveryTransaction(env.provider, unspentFile, recoveryArtifacts(), unspentFile.config.recovery)));
    assert.equal((await inspectRecovery(env.provider, unspentFile, recoveryArtifacts())).balance, 0n);
    await mkdir('.cache/migration', {recursive: true});
    await writeFile('.cache/migration/fork-result.json', JSON.stringify({status: 'passed', chainId: 42161, block: block.number,
      blockHash: block.hash, factory: env.deployment.factory, implementation: env.deployment.implementation,
      privateAmount: String(note.amount), relayGasUsed: String(receipt.gasUsed), lateRecovery: true, undeployedRecovery: true,
      productionTransactionsSent: false}, null, 2) + '\n');
    console.log(`Arbitrum fork ${block.number}: actual deployed Kernel path and both recovery checks passed.`);
  } finally { await env.close(); }
});
