import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { getAddress } from 'ethers';
import type { SepoliaConfiguration } from '../client/sepolia.ts';
import { sepoliaChainId, sepoliaEntrypoint } from '../client/sepolia.ts';
import { compile } from './harness.ts';
import { recoveryArtifacts } from './recovery-file.ts';
import type { RecoveryArtifacts } from '../recovery/core.ts';

export async function startSepoliaSite(configuration: SepoliaConfiguration, port = 5176,
  artifacts: RecoveryArtifacts = recoveryArtifacts(compile())) {
  const rpc = new URL(configuration.rpcUrl);
  if (rpc.username || rpc.password || (rpc.protocol !== 'https:'
    && !(rpc.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(rpc.hostname)))) {
    throw new Error('Use a public HTTPS RPC or a local test node.');
  }
  // Each server keeps its own snapshot; tests must not overwrite a running Sepolia page.
  const [bundle, html, css, baseCSS] = await Promise.all([
    build({ entryPoints: ['app/sepolia.ts'], outfile: 'sepolia.js', write: false,
      bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true }),
    readFile(new URL('../app/sepolia.html', import.meta.url)),
    readFile(new URL('../app/sepolia.css', import.meta.url)),
    readFile(new URL('../app/style.css', import.meta.url)),
  ]);
  const files = new Map<string, [Uint8Array | string, string]>([
    ['/', [html, 'text/html']], ['/receive', [html, 'text/html']],
    ['/sepolia.js', [bundle.outputFiles[0].contents, 'text/javascript']], ['/style.css', [baseCSS, 'text/css']],
    ['/sepolia.css', [css, 'text/css']], ['/configuration.json', [JSON.stringify(configuration), 'application/json']],
    ['/contracts.json', [JSON.stringify(artifacts), 'application/json']],
  ]);
  const server = createServer((request, response) => {
    response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ${rpc.origin}; img-src data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    const file = files.get(new URL(request.url ?? '/', 'http://localhost').pathname);
    if (request.method !== 'GET' || !file) { response.writeHead(404); response.end('Not found'); return; }
    response.writeHead(200, { 'Content-Type': file[1] }); response.end(file[0]);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not start the test page.');
  return { url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const configuration: SepoliaConfiguration = JSON.parse(await readFile('deployments/sepolia.json', 'utf8'));
  if (BigInt(configuration.chainId) !== sepoliaChainId || getAddress(configuration.pool) !== getAddress(sepoliaEntrypoint)) {
    throw new Error('Use the Privacy Pools v1 Sepolia deployment.');
  }
  const site = await startSepoliaSite(configuration, Number(process.env.SEPOLIA_PORT ?? 5176));
  console.log(`Sepolia test page: ${site.url}`);
  const stop = () => { void site.close().then(() => process.exit(0)); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
