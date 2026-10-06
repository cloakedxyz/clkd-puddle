import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { v1Upstream } from '../../scripts/setup-privacy-pools-v1.ts';

// Exercise the pinned upstream implementation, independently of our client derivation.
export async function officialSDK() {
  const outfile = resolve('.cache/v1-official-sdk.cjs');
  await build({ stdin: { contents: `
    export { AccountService } from ${JSON.stringify(v1Upstream + '/packages/sdk/src/core/account.service.ts')};
    export { DataService } from ${JSON.stringify(v1Upstream + '/packages/sdk/src/core/data.service.ts')};
    export { generateMasterKeys, generateDepositSecrets } from ${JSON.stringify(v1Upstream + '/packages/sdk/src/crypto.ts')};
  `, resolveDir: process.cwd() }, outfile, bundle: true, platform: 'node', format: 'cjs',
  nodePaths: [resolve('test/privacy-pools-v1/node_modules'), resolve('node_modules')] });
  type Pool = { address: string; chainId: number; deploymentBlock: bigint; scope: bigint };
  type Account = { getSpendableCommitments(): Map<bigint, { value: bigint; hash: bigint }[]> };
  return createRequire(import.meta.url)(outfile) as {
    DataService: new (chains: { chainId: number; privacyPoolAddress: string; startBlock: bigint; rpcUrl: string }[]) => object;
    AccountService: { initializeWithEvents(data: object, source: { mnemonic: string }, pools: Pool[],
      options: { includeEmptyNodes: boolean }): Promise<{ account: Account; errors: unknown[] }> };
    generateMasterKeys(mnemonic: string): { masterNullifier: bigint; masterSecret: bigint };
    generateDepositSecrets(keys: object, scope: bigint, index: bigint): { nullifier: bigint; secret: bigint };
  };
}
