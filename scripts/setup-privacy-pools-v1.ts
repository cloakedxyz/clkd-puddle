import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ensureCheckout } from './checkout.ts';

export const v1Commit = 'd494b63e79f33bb2b0c8ece6cdacdca465c3b884';
export const v1Root = fileURLToPath(new URL('../', import.meta.url));
export const v1Upstream = `${v1Root}.cache/privacy-pools-v1`;
export const v1Artifacts = `${v1Root}.cache/privacy-pools-v1-artifacts`;
const manifest = {
  'commitment.wasm': ['build/commitment/commitment_js/commitment.wasm', '254d2130607182fd6fd1aee67971526b13cfe178c88e360da96dce92663828d8'],
  'commitment.zkey': ['trusted-setup/final-keys/commitment.zkey', '494ae92d64098fda2a5649690ddc5821fcd7449ca5fe8ef99ee7447544d7e1f3'],
  'withdraw.wasm': ['build/withdraw/withdraw_js/withdraw.wasm', '36cda22791def3d520a55c0fc808369cd5849532a75fab65686e666ed3d55c10'],
  'withdraw.zkey': ['trusted-setup/final-keys/withdraw.zkey', '2a893b42174c813566e5c40c715a8b90cd49fc4ecf384e3a6024158c3d6de677'],
};
export function setupPrivacyPoolsV1() {
  ensureCheckout(v1Upstream, 'https://github.com/0xbow-io/privacy-pools-core.git', v1Commit);
  mkdirSync(v1Artifacts, { recursive: true });
  for (const [name, [path, hash]] of Object.entries(manifest)) {
    const data = readFileSync(`${v1Upstream}/packages/circuits/${path}`);
    if (createHash('sha256').update(data).digest('hex') !== hash) throw new Error(`V1 artifact mismatch: ${name}`);
    writeFileSync(`${v1Artifacts}/${name}`, data);
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  setupPrivacyPoolsV1();
  console.log(`Privacy Pools v1 contracts and proof files verified at ${v1Commit}.`);
}
