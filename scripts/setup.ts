import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureCheckout } from './checkout.ts';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const kernel = `${root}.cache/kernel`;
export const kernelCommit = 'cd697c7e21715d015e0643af22310a99aa17433b'; // Kernel v3.3
export const upstream = `${root}.cache/railgun-contract`;
export const upstreamCommit = '36bcf5ed7cf94bfafb6e1a303e1832c769c16780';

export function ensureUpstream() {
  ensureCheckout(upstream, 'https://github.com/Railgun-Privacy/contract.git', upstreamCommit);
}
export function buildContracts() {
  // Refuse locally modified upstream sources as well as a different version.
  ensureCheckout(kernel, 'https://github.com/zerodevapp/kernel.git', kernelCommit);
  execFileSync('forge', ['build', '--skip', 'test'], { stdio: 'inherit', env: { ...process.env, FOUNDRY_PROFILE: 'kernel' } });
  execFileSync('forge', ['build', '--skip', 'test'], { stdio: 'inherit' });
}
export function setup() {
  ensureCheckout(kernel, 'https://github.com/zerodevapp/kernel.git', kernelCommit);
  execFileSync('git', ['-C', kernel, 'submodule', 'update', '--init', '--depth', '1',
    'lib/solady', 'lib/ExcessivelySafeCall'], { stdio: 'inherit' });
  ensureCheckout(kernel, 'https://github.com/zerodevapp/kernel.git', kernelCommit);
  ensureUpstream();
  ensureCheckout(`${root}.cache/forge-std`, 'https://github.com/foundry-rs/forge-std.git', '77041d2ce690e692d6e03cc812b57d1ddaa4d505');
  buildContracts();
}
if (process.argv[1] === fileURLToPath(import.meta.url)) setup();
