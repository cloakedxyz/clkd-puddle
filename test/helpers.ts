import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import solc from 'solc';
import { poseidonContract } from 'circomlibjs';
import { Contract, ContractFactory, JsonRpcProvider, Wallet, ZeroAddress, getBytes, getAddress, keccak256, toBeHex } from 'ethers';
import type { JsonFragment, TransactionReceipt } from 'ethers';
import type { ViewingKeyPair } from '@railgun-community/engine';
import type { RailgunSmartWallet, ShieldEvent } from '../node_modules/@railgun-community/engine/dist/abi/typechain/RailgunSmartWallet.js';
import engine from '@railgun-community/engine';
import { createRailgunAdapter, mined, relayDeposit } from '../sdk/index.ts';
import type { Deployment, DepositExecution } from '../sdk/index.ts';
import { contractArtifact } from '../scripts/artifacts.ts';
import { implementationSlot } from '../sdk/kernel.ts';
import { ensureUpstream, root, upstream } from '../scripts/setup.ts';

const require = createRequire(import.meta.url);
const engineDist = dirname(require.resolve('@railgun-community/engine'));
const { deriveNodes, WalletNode } = require(join(engineDist, 'key-derivation/wallet-node.js')) as
  typeof import('../node_modules/@railgun-community/engine/dist/key-derivation/wallet-node.js');
const { encodeAddress } = require(join(engineDist, 'key-derivation/bech32.js')) as
  typeof import('../node_modules/@railgun-community/engine/dist/key-derivation/bech32.js');
const { getSharedSymmetricKey } = require(join(engineDist, 'utils/keys-utils.js')) as
  typeof import('../node_modules/@railgun-community/engine/dist/utils/keys-utils.js');
const { ShieldNote, ShieldNoteERC20 } = engine;
const railgunSource = 'railgun/contracts/logic/RailgunSmartWallet.sol';
const poseidonSource = 'railgun/contracts/logic/Poseidon.sol';
interface ContractArtifact {
  abi: JsonFragment[];
  evm: { bytecode: {object: string; linkReferences: Record<string, Record<string, {start: number; length: number}[]>>} };
}
interface ForkConfig {
  rpc: string; block: number; chainId: number; pool: string; token: string; maxGasFee: bigint;
  kernel: {factory: string; implementation: string};
}
export interface Recipient { address: string; masterPublicKey: bigint; viewing: ViewingKeyPair }
export function compile() {
  ensureUpstream();
  const input = { language: 'Solidity', sources: {
    [railgunSource]: { content: readFileSync(`${upstream}/contracts/logic/RailgunSmartWallet.sol`, 'utf8') },
    'test/contracts/DemoToken.sol': { content: readFileSync(`${root}test/contracts/DemoToken.sol`, 'utf8') },
    'test/contracts/RecoveryWallet.sol': { content: readFileSync(`${root}test/contracts/RecoveryWallet.sol`, 'utf8') },
  }, settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode'] } } } };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: (name: string) => {
    try { return { contents: readFileSync(name.startsWith('railgun/') ? `${upstream}/${name.slice(8)}` : `${root}node_modules/${name}`, 'utf8') }; }
    catch { return { error: `Missing test dependency: ${name}` }; }
  } })) as {contracts: Record<string, Record<string, ContractArtifact>>; errors?: {severity: string; formattedMessage: string}[]};
  const errors = output.errors?.filter(error => error.severity === 'error') ?? [];
  assert.equal(errors.length, 0, errors.map(error => error.formattedMessage).join('\n'));
  return output.contracts;
}

export async function createEnvironment(contracts = compile(), fork?: ForkConfig, wrappedNative = false) {
  const chain = await startChain(fork);
  try {
    const {provider} = chain;
    const [deployer, sender, relayer, recovery, attacker, treasury, feeCollector] = await Promise.all(
      Array.from({length: 7}, async (_, index) => {
        if (!fork) return provider.getSigner(index);
        const wallet = Wallet.createRandom().connect(provider);
        await provider.send('anvil_setBalance', [wallet.address, '0x56bc75e2d63100000']);
        return wallet;
      }));
    const libraries: Record<string, string> = {};
    for (const inputs of fork ? [] : [2, 3]) {
      const library = await new ContractFactory(poseidonContract.generateABI(inputs), poseidonContract.createCode(inputs), deployer).deploy();
      await library.waitForDeployment(); libraries[`${poseidonSource}:PoseidonT${inputs + 1}`] = await library.getAddress();
    }
    async function deployPool(source: string, name: string, args: unknown[] = []) {
      const artifact = contracts[source][name];
      const deployed = await new ContractFactory(artifact.abi, linkBytecode(artifact, libraries), deployer).deploy(...args);
      await deployed.waitForDeployment(); return new Contract(await deployed.getAddress(), artifact.abi, deployer);
    }
    const pool = (fork ? new Contract(fork.pool, contracts[railgunSource].RailgunSmartWallet.abi, deployer)
      : await deployPool(railgunSource, 'RailgunSmartWallet')) as unknown as RailgunSmartWallet;
    if (!fork) await (await pool.initializeRailgunLogic(await treasury.getAddress(), 25, 25, 0, await deployer.getAddress())).wait();
    const token = fork ? new Contract(fork.token, [...contracts['test/contracts/DemoToken.sol'].DemoToken.abi, 'function deposit() payable'], deployer)
      : await deployPool('test/contracts/DemoToken.sol', wrappedNative ? 'DemoWrappedNative' : 'DemoToken');
    async function deploy(name: string, args: unknown[] = []) {
      const artifact = contractArtifact(name);
      const deployed = await new ContractFactory(artifact.abi, artifact.bytecode.object, deployer).deploy(...args);
      await deployed.waitForDeployment(); return new Contract(await deployed.getAddress(), artifact.abi, deployer);
    }
    // This path invokes executors and owner recovery directly, without UserOperations.
    // A zero EntryPoint cannot call the account. Production uses the chain's reviewed Kernel deployment.
    const implementation = fork ? new Contract(fork.kernel.implementation, contractArtifact('Kernel').abi, deployer)
      : await deploy('Kernel', [ZeroAddress]);
    const factory = fork ? new Contract(fork.kernel.factory, contractArtifact('KernelFactory').abi, deployer)
      : await deploy('KernelFactory', [await implementation.getAddress()]);
    const validator = await deploy('ECDSAValidator');
    const maxGasFee = fork?.maxGasFee ?? (wrappedNative ? 5_000_000_000_000_000n : 2_000_000n);
    const executor = await deploy('RailgunExecutor', [await factory.getAddress(), await pool.getAddress(), await token.getAddress(), maxGasFee]);
    const addresses = {factory: await factory.getAddress(), implementation: await implementation.getAddress(),
      validator: await validator.getAddress(), executor: await executor.getAddress(), pool: await pool.getAddress(), asset: await token.getAddress()};
    const codeHashes = Object.fromEntries(await Promise.all(Object.entries(addresses).map(async ([name, address]) =>
      [name, keccak256(await provider.getCode(address))]))) as Deployment['codeHashes'];
    const poolImplementationAddress = getAddress(`0x${(await provider.getStorage(addresses.pool, implementationSlot)).slice(-40)}`);
    const poolImplementation = poolImplementationAddress === ZeroAddress ? null
      : {address: poolImplementationAddress, codeHash: keccak256(await provider.getCode(poolImplementationAddress))};
    const assetImplementationAddress = getAddress(`0x${(await provider.getStorage(addresses.asset, implementationSlot)).slice(-40)}`);
    const assetImplementation = assetImplementationAddress === ZeroAddress ? null
      : {address: assetImplementationAddress, codeHash: keccak256(await provider.getCode(assetImplementationAddress))};
    const deployment: Deployment = {...addresses, chainId: (await provider.getNetwork()).chainId,
      poolImplementation, assetImplementation, maxGasFee, codeHashes};
    const adapter = createRailgunAdapter(deployment);
    return {...chain, contracts, fork, wrappedNative, pool, token, factory, implementation, validator, executor, deployment, adapter,
      deployer, sender, relayer, recovery, attacker, treasury, feeCollector};
  } catch (error) { await chain.close(); throw error; }
}
export type Environment = Awaited<ReturnType<typeof createEnvironment>>;
export async function prepareDeposit(env: Environment, recipient: string, amount: bigint, gasFee = 0n) {
  const record = await env.adapter.prepare(env.provider, {recipient, recovery: await env.recovery.getAddress(),
    relayer: await env.relayer.getAddress(), feeRecipient: await env.feeCollector.getAddress()});
  const block = await env.provider.getBlock('latest'); assert(block);
  return env.adapter.quote(env.provider, record, {token: env.deployment.asset, amount, gasFee, deadline: BigInt(block.timestamp + 3600)});
}
export async function fund(env: Environment, address: string, amount: bigint) {
  if (env.fork || env.wrappedNative) await mined(env.token.connect(env.sender).getFunction('deposit')({value: amount}));
  else await mined(env.token.getFunction('mint')(await env.sender.getAddress(), amount));
  return mined(env.token.connect(env.sender).getFunction('transfer')(address, amount));
}
export async function settle(env: Environment, deposit: DepositExecution) {
  return mined(relayDeposit(env.adapter, deposit, env.relayer));
}

export async function startChain(fork?: ForkConfig) {
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert(address && typeof address !== 'string');
      server.close(() => resolve(address.port));
    });
  });
  const args = ['--host', '127.0.0.1', '--port', String(port), '--chain-id', String(fork?.chainId ?? 31337), '--silent'];
  if (fork) args.push('--fork-url', fork.rpc, '--fork-block-number', String(fork.block),
    '--no-storage-caching');
  const child = spawn('anvil', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let failure: Error | undefined;
  let stderr = '';
  child.on('error', (error) => { failure = error; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, fork?.chainId ?? 31337,
    { staticNetwork: true, cacheTimeout: -1, pollingInterval: 50 });
  for (let i = 0; i < 600; i++) {
    if (failure || child.exitCode !== null) {
      provider.destroy();
      throw failure ?? new Error(`Anvil failed: ${stderr}`);
    }
    try {
      await provider.send('eth_chainId', []);
      return { provider, close: async () => {
        provider.destroy();
        if (child.exitCode === null) {
          const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
          child.kill('SIGTERM');
          await exited;
        }
      } };
    } catch { await delay(50); }
  }
  provider.destroy();
  child.kill('SIGTERM');
  throw new Error('Local Anvil did not start.');
}

function linkBytecode(artifact: ContractArtifact, libraries: Record<string, string>) {
  let bytecode = artifact.evm.bytecode.object;
  for (const [file, names] of Object.entries(artifact.evm.bytecode.linkReferences)) {
    for (const [name, references] of Object.entries(names)) {
      const address = libraries[`${file}:${name}`];
      assert(address, `Missing library: ${name}`);
      for (const { start, length } of references) {
        assert.equal(length, 20);
        bytecode = bytecode.slice(0, start * 2) + address.slice(2) + bytecode.slice((start + length) * 2);
      }
    }
  }
  return `0x${bytecode}`;
}


export async function createRecipient(): Promise<Recipient> {
  // Fresh ephemeral test identity. No real keys are accepted, persisted, or printed.
  const mnemonic = engine.Mnemonic.generate();
  const nodes = deriveNodes(mnemonic);
  const spending = nodes.spending.getSpendingKeyPair();
  const viewing = await nodes.viewing.getViewingKeyPair();
  const masterPublicKey = WalletNode.getMasterPublicKey(spending.pubkey,
    await nodes.viewing.getNullifyingKey());
  return { address: encodeAddress({ masterPublicKey, viewingPublicKey: viewing.pubkey }),
    masterPublicKey, viewing };
}


export async function decryptDeposit(
  env: Environment, recipient: Recipient, receipt: TransactionReceipt,
) {
  const poolAddress = (await env.pool.getAddress()).toLowerCase();
  const events = receipt.logs.filter((log) => log.address.toLowerCase() === poolAddress)
    .map((log) => { try { return env.pool.interface.parseLog(log); } catch { return null; } });
  const event = events.find((entry) => entry?.name === 'Shield');
  assert(event, 'Real RAILGUN contract must emit Shield');
  const shield = event.args.toObject() as ShieldEvent.OutputObject;
  const preimage = shield.commitments[0];
  const ciphertext = shield.shieldCiphertext[0];
  const key = await getSharedSymmetricKey(recipient.viewing.privateKey, getBytes(ciphertext.shieldKey));
  assert(key, 'Recipient must derive the shared encryption key');
  const random = ShieldNote.decryptRandom([...ciphertext.encryptedBundle], key);
  const reconstructed = new ShieldNoteERC20(recipient.masterPublicKey, random,
    preimage.value, preimage.token.tokenAddress);
  assert.equal(toBeHex(reconstructed.notePublicKey, 32), preimage.npk);
  const commitment = toBeHex(ShieldNote.getShieldNoteHash(reconstructed.notePublicKey,
    reconstructed.tokenHash, preimage.value), 32);
  assert.equal(await env.pool.hashCommitment({ npk: preimage.npk,
    token: { tokenType: preimage.token.tokenType, tokenAddress: preimage.token.tokenAddress,
      tokenSubID: preimage.token.tokenSubID }, value: preimage.value }), commitment);

  const root = await env.pool.merkleRoot();
  assert.equal(await env.pool.rootHistory(shield.treeNumber, root), true);
  return { commitment, amount: preimage.value, fee: shield.fees[0], root };
}
