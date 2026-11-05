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
function runtime(name: string): RecoveryArtifacts['contracts']['executor'] {
  const artifact = contractArtifact(name);
  // Source IDs vary with the compilation unit; only byte offsets matter.
  const offsets = Object.values(artifact.deployedBytecode.immutableReferences ?? {}).flat().sort((a, b) => a.start - b.start);
  return {code: artifact.deployedBytecode.object, references: offsets.length ? {'0': offsets} : {}};
}
export function recoveryArtifacts(multiAsset = false): RecoveryArtifacts {
  const names = { factory: 'KernelFactory', implementation: 'Kernel', validator: 'ECDSAValidator', executor: multiAsset ? 'MultiAssetRailgunExecutor' : 'RailgunExecutor' };
  return { format: 'puddle-kernel-artifacts', version: 1,
    contracts: Object.fromEntries(Object.entries(names).map(([key, name]) => [key, runtime(name)])) as RecoveryArtifacts['contracts'],
    ...(multiAsset ? {previousExecutor: runtime('RailgunExecutor')} : {}) };
}
