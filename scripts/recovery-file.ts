import assert from 'node:assert/strict';
import type { RecoveryArtifacts, RecoveryBuild } from '../recovery/core.ts';
import type { CompiledContracts } from './types.ts';

export { createRecoveryFile } from '../recovery/core.ts';

export function recoveryArtifacts(contracts: CompiledContracts): RecoveryArtifacts {
  function build(protocol: 'Railgun' | 'PrivacyPools' | 'PrivacyPoolsV1'): RecoveryBuild {
    const source = contracts[`contracts/protocols/${protocol}Deposit.sol`];
    const factory = source[`${protocol}DepositFactory`];
    const forwarder = source[`${protocol}Deposit`];
    assert.deepEqual(factory.evm.bytecode.linkReferences, {});
    assert.deepEqual(forwarder.evm.bytecode.linkReferences, {});
    function runtime(artifact: typeof factory, names: string[]) {
      const references = artifact.evm.deployedBytecode.immutableReferences;
      assert.deepEqual(Object.keys(references).sort(), names.sort(), 'Review recovery validation after changing immutables');
      assert(Object.values(references).every(refs => refs.length > 0 && refs.every(ref => ref.length === 32)));
      return { code: `0x${artifact.evm.deployedBytecode.object}`, references };
    }
    return { implementationCreationCode: `0x${forwarder.evm.bytecode.object}`,
      factory: runtime(factory, ['pool', 'implementation']),
      implementation: runtime(forwarder, ['factory', 'pool']) };
  }
  return { railgun: build('Railgun'), 'privacy-pools': build('PrivacyPools'), 'privacy-pools-v1': build('PrivacyPoolsV1') };
}
