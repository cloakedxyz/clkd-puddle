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
export function recoveryArtifacts(): RecoveryArtifacts {
  const names = { factory: 'KernelFactory', implementation: 'Kernel', validator: 'ECDSAValidator', executor: 'RailgunExecutor' };
  return { format: 'puddle-kernel-artifacts', version: 1,
    contracts: Object.fromEntries(Object.entries(names).map(([key, name]) => {
      const artifact = contractArtifact(name);
      return [key, { code: artifact.deployedBytecode.object, references: artifact.deployedBytecode.immutableReferences ?? {} }];
    })) as RecoveryArtifacts['contracts'] };
}
