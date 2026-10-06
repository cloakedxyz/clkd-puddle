import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Contract, ContractFactory, ZeroAddress } from 'ethers';
import type { InterfaceAbi, JsonRpcProvider } from 'ethers';
import { groth16 } from 'snarkjs';
import { compile as compilePuddle, startChain } from './harness.ts';
import { setupPrivacyPoolsV1, v1Upstream, v1Artifacts, v1Root } from './setup-privacy-pools-v1.ts';
import { createPrivacyPoolsV1Adapter } from '../protocols/privacy-pools-v1.ts';
import { v1Native } from '../protocols/privacy-pools-v1-data.ts';
import { mined } from '../protocols/deposit.ts';

// The upstream compiler and dependencies are isolated from Puddle's Solidity 0.8.17 build.
const solc = createRequire(new URL('../test/privacy-pools-v1/package.json', import.meta.url))('solc') as typeof import('solc').default;

export { mined };
const dependencyRoot = `${v1Root}test/privacy-pools-v1/node_modules/`;
type Artifact = { abi: InterfaceAbi; evm: { bytecode: { object: string;
  linkReferences: Record<string, Record<string, { start: number; length: number }[]>> } } };

export function compileV1() {
  setupPrivacyPoolsV1();
  const load = (name: string) => {
    const dependencies: Record<string, string> = { '@oz/': '@openzeppelin/contracts/',
      '@oz-upgradeable/': '@openzeppelin/contracts-upgradeable/', 'lean-imt/': '@zk-kit/lean-imt.sol/',
      'poseidon/': 'poseidon-solidity/', 'poseidon-solidity/': 'poseidon-solidity/' };
    for (const [prefix, directory] of Object.entries(dependencies)) {
      if (name.startsWith(prefix)) return readFileSync(dependencyRoot + directory + name.slice(prefix.length), 'utf8');
    }
    if (name.startsWith('@openzeppelin/')) return readFileSync(dependencyRoot + name, 'utf8');
    return readFileSync(`${v1Upstream}/packages/contracts/src/${name}`, 'utf8');
  };
  const names = ['contracts/Entrypoint.sol', 'contracts/implementations/PrivacyPoolSimple.sol',
    'contracts/implementations/PrivacyPoolComplex.sol', 'contracts/verifiers/CommitmentVerifier.sol',
    'contracts/verifiers/WithdrawalVerifier.sol', '@oz/proxy/ERC1967/ERC1967Proxy.sol'];
  const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity',
    sources: Object.fromEntries(names.map(name => [name, { content: load(name) }])),
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode'] } } },
  }), { import: name => { try { return { contents: load(name) }; } catch { return { error: `Missing import: ${name}` }; } } })) as {
    errors?: { severity: string; formattedMessage: string }[]; contracts: Record<string, Record<string, Artifact>>;
  };
  assert.deepEqual(output.errors?.filter(e => e.severity === 'error') ?? [], []);
  return { v1: output.contracts, puddle: compilePuddle(true) };
}

export async function environment(compiled: ReturnType<typeof compileV1>, existingProvider?: JsonRpcProvider) {
  const chain = existingProvider ? { provider: existingProvider, close: async () => {} } : await startChain();
  try {
    const { provider } = chain;
    const [admin, sender, relayer, owner, attacker, fees] = await Promise.all(Array.from({ length: 6 }, (_, i) => provider.getSigner(i)));
    const libraries = new Map<string, string>();
    async function deploy(file: string, name: string, args: unknown[] = [], puddle = false): Promise<Contract> {
      const artifact = (puddle ? compiled.puddle : compiled.v1)[file][name];
      let bytecode = artifact.evm.bytecode.object;
      for (const [path, names] of Object.entries(artifact.evm.bytecode.linkReferences)) {
        for (const [library, refs] of Object.entries(names)) {
          const key = `${path}:${library}`;
          if (!libraries.has(key)) libraries.set(key, await (await deploy(path, library)).getAddress());
          for (const { start, length } of refs) {
            bytecode = bytecode.slice(0, start * 2) + libraries.get(key)!.slice(2) + bytecode.slice((start + length) * 2);
          }
        }
      }
      const contract = await new ContractFactory(artifact.abi, bytecode, admin).deploy(...args);
      await contract.waitForDeployment();
      return new Contract(await contract.getAddress(), artifact.abi, admin);
    }
    const implementation = await deploy('contracts/Entrypoint.sol', 'Entrypoint');
    const proxy = await deploy('@oz/proxy/ERC1967/ERC1967Proxy.sol', 'ERC1967Proxy', [await implementation.getAddress(),
      implementation.interface.encodeFunctionData('initialize', [await admin.getAddress(), await admin.getAddress()])]);
    const entrypoint = new Contract(await proxy.getAddress(), implementation.interface, admin);
    const commitmentVerifier = await deploy('contracts/verifiers/CommitmentVerifier.sol', 'CommitmentVerifier');
    const withdrawalVerifier = await deploy('contracts/verifiers/WithdrawalVerifier.sol', 'WithdrawalVerifier');
    const token = await deploy('test/contracts/DemoToken.sol', 'DemoToken', [], true);
    const arguments_ = [await entrypoint.getAddress(), await withdrawalVerifier.getAddress(), await commitmentVerifier.getAddress()];
    const nativePool = await deploy('contracts/implementations/PrivacyPoolSimple.sol', 'PrivacyPoolSimple', arguments_);
    const tokenPool = await deploy('contracts/implementations/PrivacyPoolComplex.sol', 'PrivacyPoolComplex', [...arguments_, await token.getAddress()]);
    await mined(entrypoint.getFunction('registerPool')(v1Native, await nativePool.getAddress(), 100n, 100n, 1000n));
    await mined(entrypoint.getFunction('registerPool')(await token.getAddress(), await tokenPool.getAddress(), 100n, 100n, 1000n));
    const factory = await deploy('contracts/protocols/PrivacyPoolsV1Deposit.sol', 'PrivacyPoolsV1DepositFactory',
      [await entrypoint.getAddress(), [ZeroAddress, await token.getAddress()].map(token => ({ token,
        maxGasFee: token === ZeroAddress ? 1_000_000_000_000_000n : 2_000_000n, maxGasFeeBps: 0 }))], true);
    const adapter = createPrivacyPoolsV1Adapter({ chainId: 31337n, factory: await factory.getAddress(), pool: await entrypoint.getAddress() });
    const forwarder = (address: string, signer = owner) => new Contract(address,
      compiled.puddle['contracts/protocols/PrivacyPoolsV1Deposit.sol'].PrivacyPoolsV1Deposit.abi, signer);
    return { ...chain, admin, sender, relayer, owner, attacker, fees, entrypoint, nativePool, tokenPool,
      token, factory, adapter, forwarder, deploy, compiled };
  } catch (error) { await chain.close(); throw error; }
}
export type Environment = Awaited<ReturnType<typeof environment>>;
export async function prove(circuit: 'commitment' | 'withdraw', input: Parameters<typeof groth16.fullProve>[0]) {
  const result = await groth16.fullProve(input, `${v1Artifacts}/${circuit}.wasm`, `${v1Artifacts}/${circuit}.zkey`,
    undefined, undefined, { singleThread: true });
  return JSON.parse('[' + await groth16.exportSolidityCallData(result.proof, result.publicSignals) + ']') as [string[], string[][], string[], string[]];
}
export const recoveryFiles = () => ({ wasm: new Uint8Array(readFileSync(`${v1Artifacts}/commitment.wasm`)),
  zkey: new Uint8Array(readFileSync(`${v1Artifacts}/commitment.zkey`)) });
