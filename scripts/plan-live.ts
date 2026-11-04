import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contract, ContractFactory, Interface, JsonRpcProvider, ZeroAddress, getAddress,
  getCreateAddress, keccak256, parseEther, toUtf8Bytes } from 'ethers';
import type { TransactionRequest } from 'ethers';
import { prepareRailgunReceive, inspectRecovery, recoveryTransaction, verifyAccount } from '../sdk/index.ts';
import type { Deployment } from '../sdk/index.ts';
import { abi, executorABI, implementationSlot, initialData } from '../sdk/kernel.ts';
import { railgunRecipientTypes } from '../sdk/recipient.ts';
import { verifySdkBuild, buildHash } from '../sdk/verify-build.mjs';
import { contractArtifact, recoveryArtifacts } from './artifacts.ts';
import { compile, startChain } from '../test/helpers.ts';

// This tool NEVER signs or sends on the public RPC. All execution uses an isolated Anvil fork.
const route = {
  chainId: 42161, factory: '0x2577507b78c2008Ff367261CB6285d44ba5eF2E9',
  implementation: '0xd6CEDDe84be40893d153Be9d467CD6aD37875b28',
  pool: '0xFA7093CDD9EE6932B4eb2c9e1cde7CE00B1FA4b9', asset: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  maxGasFee: parseEther('0.00005'),
};
const nodeInterface = new Interface([
  'function gasEstimateL1Component(address,bool,bytes) returns(uint64 gasEstimateForL1,uint256 baseFee,uint256 l1BaseFeeEstimate)',
]);
export interface PilotTransaction {
  label: string; nonce: number; to: string | null; data: string; value: string;
  gasLimit: string; maxFeePerGas: string; maxPriorityFeePerGas: string;
  simulatedGasUsed: string; l1GasEstimate: string; estimatedNetworkFee: string;
}

export async function planLive(profilePath: string, output: string, maximumNativeDebit: bigint) {
  const plannerSourceHash = buildHash(await readFile(fileURLToPath(import.meta.url)));
  assert(maximumNativeDebit > 0n);
  await verifySdkBuild();
  const profile = JSON.parse(await readFile(profilePath, 'utf8')) as {recipient: string; recovery: string; relayer: string};
  const owner = getAddress(profile.relayer);
  assert.equal(getAddress(profile.recovery), owner, 'This private pilot uses the approved relayer as recovery owner.');
  const rpc = process.env.ARBITRUM_RPC_URL ?? 'https://arb1.arbitrum.io/rpc';
  const remote = new JsonRpcProvider(rpc, undefined, {batchMaxCount: 1, cacheTimeout: -1});
  let fork: Awaited<ReturnType<typeof startChain>> | undefined;
  try {
    const block = await remote.getBlock('latest'); assert(block?.hash);
    assert.equal((await remote.getNetwork()).chainId, BigInt(route.chainId));
    const nonce = await remote.getTransactionCount(owner, block.number);
    assert.equal(await remote.getTransactionCount(owner, 'pending'), nonce, 'Resolve pending wallet transactions first.');
    assert.equal(await remote.getCode(owner, block.number), '0x', 'This pilot expects the previously selected ordinary execution wallet.');
    const nativeBefore = await remote.getBalance(owner, block.number);
    const fees = await remote.getFeeData(); assert(fees.gasPrice && fees.gasPrice > 0n);
    const maxFeePerGas = fees.gasPrice * 2n;
    fork = await startChain({rpc, block: block.number, ...route, token: route.asset, kernel: route});
    const local = fork.provider;
    assert.match(await local.send('web3_clientVersion', []), /anvil/i);
    assert.equal((await local.getBlock(block.number))?.hash, block.hash);
    await local.send('anvil_impersonateAccount', [owner]);
    const signer = await local.getSigner(owner);
    assert.equal(await local.getTransactionCount(owner), nonce);
    const poolABI = compile()['railgun/contracts/logic/RailgunSmartWallet.sol'].RailgunSmartWallet.abi;
    const pool = new Contract(route.pool, poolABI, local);
    const token = new Contract(route.asset, ['function deposit() payable', 'function transfer(address,uint256) returns(bool)',
      'function balanceOf(address) view returns(uint256)', 'function allowance(address,address) view returns(uint256)'], local);
    const wethBefore: bigint = await token.getFunction('balanceOf')(owner);
    const poolFeeBps: bigint = await pool.getFunction('shieldFee')();
    assert(poolFeeBps >= 0n && poolFeeBps < 10000n);
    const transactions: PilotTransaction[] = [];
    let maximumDebit = 0n;
    async function simulate(label: string, input: TransactionRequest) {
      const currentNonce = nonce + transactions.length;
      const request = {from: owner, chainId: route.chainId, nonce: currentNonce, ...input};
      assert.equal(await local.getTransactionCount(owner), currentNonce);
      const executionGas = await local.estimateGas(request);
      // Arbitrum's RPC-only interface estimates the data fee even for future contracts.
      const l1Result = await remote.call({from: owner, to: '0x00000000000000000000000000000000000000C8',
        data: nodeInterface.encodeFunctionData('gasEstimateL1Component', [input.to ?? ZeroAddress, !input.to, input.data ?? '0x'])});
      const [l1Gas, baseFee] = nodeInterface.decodeFunctionResult('gasEstimateL1Component', l1Result) as unknown as [bigint, bigint];
      const gasLimit = (executionGas + l1Gas) * 125n / 100n + 20000n;
      const value = BigInt(String(input.value ?? 0n));
      maximumDebit += value + gasLimit * maxFeePerGas;
      assert(maximumDebit <= maximumNativeDebit,
        `${label}: reserved debit ${maximumDebit} wei exceeds the ${maximumNativeDebit} wei cap.`);
      assert(maximumDebit <= nativeBefore, 'The execution wallet cannot cover this transaction set.');
      const receipt = await (await signer.sendTransaction({...request, gasLimit, maxFeePerGas, maxPriorityFeePerGas: 0n})).wait();
      assert(receipt?.status === 1);
      transactions.push({label, nonce: currentNonce, to: input.to ? getAddress(String(input.to)) : null,
        data: String(input.data ?? '0x'), value: String(value), gasLimit: String(gasLimit),
        maxFeePerGas: String(maxFeePerGas), maxPriorityFeePerGas: '0', simulatedGasUsed: String(receipt.gasUsed),
        l1GasEstimate: String(l1Gas), estimatedNetworkFee: String((receipt.gasUsed + l1Gas) * baseFee)});
      return receipt;
    }
    const validator = getCreateAddress({from: owner, nonce});
    const executor = getCreateAddress({from: owner, nonce: nonce + 1});
    const validatorArtifact = contractArtifact('ECDSAValidator');
    await simulate('Deploy unmodified ZeroDev ECDSA validator', await new ContractFactory(validatorArtifact.abi, validatorArtifact.bytecode.object).getDeployTransaction());
    const moduleArtifact = contractArtifact('RailgunExecutor');
    await simulate('Deploy restricted RAILGUN module for the existing Kernel factory',
      await new ContractFactory(moduleArtifact.abi, moduleArtifact.bytecode.object).getDeployTransaction(route.factory, route.pool, route.asset, route.maxGasFee));
    const addresses = {factory: route.factory, implementation: route.implementation, validator, executor, pool: route.pool, asset: route.asset};
    const codeHashes = Object.fromEntries(await Promise.all(Object.entries(addresses).map(async ([name, address]) =>
      [name, keccak256(await local.getCode(address))]))) as Deployment['codeHashes'];
    assert.equal(codeHashes.factory, '0xcc4b1b98f5716bf61042d87bfedd4709a5c9a597c41f3bb0e6fb6fe1a4ebd37a');
    assert.equal(codeHashes.implementation, '0x9c390b4a1d88a48a63dfb485bc4b6117f59e7f48e4138a93b870e1dd35e25fde');
    const poolImplementation = getAddress(`0x${(await local.getStorage(route.pool, implementationSlot)).slice(-40)}`);
    const assetImplementation = getAddress(`0x${(await local.getStorage(route.asset, implementationSlot)).slice(-40)}`);
    assert.notEqual(poolImplementation, ZeroAddress);
    const deployment: Deployment = {...addresses, chainId: BigInt(route.chainId), maxGasFee: route.maxGasFee, codeHashes,
      poolImplementation: {address: poolImplementation, codeHash: keccak256(await local.getCode(poolImplementation))},
      assetImplementation: assetImplementation === ZeroAddress ? null
        : {address: assetImplementation, codeHash: keccak256(await local.getCode(assetImplementation))}};
    const latest = await local.getBlock('latest'); assert(latest);
    const quote = {token: route.asset, amount: parseEther('0.0001'), gasFee: parseEther('0.000025'), deadline: BigInt(latest.timestamp + 86400)};
    const {deposit, recovery} = await prepareRailgunReceive(local, deployment, {
      recipient: profile.recipient, recovery: owner, relayer: owner, feeRecipient: owner,
    }, quote, recoveryArtifacts());
    await mkdir(output, {mode: 0o700});
    const save = (name: string, value: unknown) => writeFile(join(output, name), JSON.stringify(value,
      (_, item) => typeof item === 'bigint' ? String(item) : item, 2) + '\n', {flag: 'wx', mode: 0o600});
    await save('recovery.json', recovery); // Saved before even the simulated funding transfer.
    const wrapped = quote.amount + 2n;
    await simulate('Wrap the test funding and two recovery-test base units', {to: route.asset, value: wrapped, data: token.interface.encodeFunctionData('deposit')});
    await simulate('Send one WETH base unit to the undeployed Kernel address', {to: route.asset, data: token.interface.encodeFunctionData('transfer', [deposit.address, 1n])});
    await simulate('Deploy through the existing ZeroDev Kernel factory for owner recovery', await recoveryTransaction(local, recovery, recoveryArtifacts(), owner, route.asset, 'deploy'));
    await simulate('Recover the pre-deposit WETH base unit through Kernel ownership', await recoveryTransaction(local, recovery, recoveryArtifacts(), owner));
    assert.equal((await inspectRecovery(local, recovery, recoveryArtifacts())).balance, 0n);
    await simulate('Fund the verified Kernel account with 0.0001 WETH', {to: route.asset, data: token.interface.encodeFunctionData('transfer', [deposit.address, quote.amount])});
    await verifyAccount(local, deposit);
    const receipt = await simulate('Shield through the RAILGUN module and existing Kernel account', {to: executor,
      data: executorABI.encodeFunctionData('deployAndExecute', [initialData(deposit, deposit.config), deposit.salt, deposit.config.recipient, quote])});
    const event = receipt.logs.filter(log => getAddress(log.address) === route.pool)
      .map(log => { try { return pool.interface.parseLog(log); } catch { return null; } }).find(log => log?.name === 'Shield');
    assert(event);
    const [npk, ciphertext] = abi.decode(railgunRecipientTypes, deposit.config.recipient);
    assert.equal(event.args.commitments[0].npk, npk);
    assert.equal(getAddress(event.args.commitments[0].token.tokenAddress), route.asset);
    assert.equal(event.args.commitments[0].token.tokenType, 0n);
    assert.equal(event.args.commitments[0].token.tokenSubID, 0n);
    assert.deepEqual(Array.from(event.args.shieldCiphertext[0].encryptedBundle), Array.from(ciphertext.encryptedBundle));
    assert.equal(event.args.shieldCiphertext[0].shieldKey, ciphertext.shieldKey);
    const serviceFee = quote.amount / 1000n, poolAmount = quote.amount - serviceFee - quote.gasFee;
    const privateAmount = poolAmount - poolAmount * poolFeeBps / 10000n;
    assert.equal(event.args.commitments[0].value, privateAmount);
    assert.equal(event.args.fees[0], poolAmount - privateAmount);
    assert.equal(await new Contract(executor, executorABI, local).getFunction('spent')(deposit.address), true);
    const shieldFee = BigInt(transactions.at(-1)!.estimatedNetworkFee);
    assert(shieldFee <= quote.gasFee, 'The pilot gas reimbursement is below the current estimated relay network fee.');
    assert.equal(await token.getFunction('allowance')(deposit.address, route.pool), 0n);
    await simulate('Send one late WETH base unit after shielding', {to: route.asset, data: token.interface.encodeFunctionData('transfer', [deposit.address, 1n])});
    await simulate('Recover the late WETH base unit through Kernel ownership', await recoveryTransaction(local, recovery, recoveryArtifacts(), owner));
    assert.equal((await inspectRecovery(local, recovery, recoveryArtifacts())).balance, 0n);
    assert.equal(await token.getFunction('balanceOf')(owner), wethBefore + 2n + serviceFee + quote.gasFee);
    assert.equal(transactions.length, 10);
    assert.equal(await local.getTransactionCount(owner), nonce + 10);
    const estimatedFees = transactions.reduce((sum, transaction) => sum + BigInt(transaction.estimatedNetworkFee), 0n);
    const site = {chainId: String(route.chainId), chainName: 'Arbitrum One', rpcUrl: 'https://arb1.arbitrum.io/rpc',
      ...addresses, poolImplementation: deployment.poolImplementation, assetImplementation: deployment.assetImplementation,
      token: route.asset, symbol: 'WETH', decimals: 18,
      relayer: owner, feeRecipient: owner, gasFee: String(quote.gasFee), maxGasFee: String(route.maxGasFee),
      maxAmount: String(quote.amount), codeHashes, mode: 'pilot'};
    const plan = {format: 'puddle-kernel-live-plan', version: 1, status: 'simulated-not-approved', createdAt: new Date().toISOString(),
      chainId: route.chainId, block: block.number, blockHash: block.hash, owner, startNonce: nonce,
      recipientDigest: keccak256(toUtf8Bytes(profile.recipient)), nativeBalanceBefore: String(nativeBefore), wethBalanceBefore: String(wethBefore),
      maximumNativeDebit: String(maximumNativeDebit), reservedMaximumDebit: String(maximumDebit),
      estimatedNativeDebit: String(wrapped + estimatedFees), estimatedNetworkFees: String(estimatedFees),
      expectedPrivateWETH: String(privateAmount), poolFeeBps: String(poolFeeBps), deposit, recovery, site, transactions,
      sdkBuildHash: buildHash(await readFile('sdk/dist/build.json')),
      plannerSourceHash, productionTransactionsSent: false};
    assert.equal(buildHash(await readFile(fileURLToPath(import.meta.url))), plannerSourceHash, 'Planner source changed during simulation.');
    await save('site.json', site); await save('plan.json', plan);
    const planHash = buildHash(await readFile(join(output, 'plan.json')));
    await save('plan.sha256.json', {sha256: planHash});
    return {output: resolve(output), planHash, owner, account: deposit.address, transactions: transactions.length,
      estimatedNativeDebit: plan.estimatedNativeDebit, reservedMaximumDebit: plan.reservedMaximumDebit,
      maximumNativeDebit: plan.maximumNativeDebit, expectedPrivateWETH: plan.expectedPrivateWETH};
  } finally { await fork?.close(); remote.destroy(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [profile, output, cap] = process.argv.slice(2);
  if (!profile || !output || !cap) throw new Error('Usage: node scripts/plan-live.ts PUBLIC_PROFILE_JSON NEW_PRIVATE_OUTPUT_DIRECTORY MAX_NATIVE_ETH');
  console.log(JSON.stringify(await planLive(profile, output, parseEther(cap)), null, 2));
}
