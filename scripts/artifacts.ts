import { readFileSync } from 'node:fs';
import type { InterfaceAbi } from 'ethers';
import type { RecoveryArtifacts } from '../sdk/index.ts';

export function contractArtifact(name: string) {
  const directory = ['Kernel', 'KernelFactory', 'ECDSAValidator'].includes(name) ? 'stock-kernel-out' : 'kernel-out';
  return JSON.parse(readFileSync(`.cache/${directory}/${name}.sol/${name}.json`, 'utf8')) as {
    abi: InterfaceAbi; bytecode: { object: string };
    metadata: { sources: Record<string, {keccak256: string}> };
    deployedBytecode: { object: string; immutableReferences?: Record<string, {start: number; length: number}[]> };
  };
}
export function recoveryArtifacts(multiAsset = false): RecoveryArtifacts {
  const names = { factory: 'KernelFactory', implementation: 'Kernel', validator: 'ECDSAValidator', executor: multiAsset ? 'MultiAssetRailgunExecutor' : 'RailgunExecutor' };
  return { format: 'puddle-kernel-artifacts', version: 1,
    contracts: Object.fromEntries(Object.entries(names).map(([key, name]) => {
      const artifact = contractArtifact(name);
      // Solidity's reference IDs depend on the compilation unit (for example whether
      // tests were compiled alongside it). Only offsets matter for runtime matching.
      const offsets = Object.values(artifact.deployedBytecode.immutableReferences ?? {}).flat().sort((a, b) => a.start - b.start);
      return [key, { code: artifact.deployedBytecode.object, references: offsets.length ? {'0': offsets} : {} }];
    })) as RecoveryArtifacts['contracts'] };
}
