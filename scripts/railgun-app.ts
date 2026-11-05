import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { build } from 'esbuild';
import { JsonRpcProvider, Wallet, parseEther } from 'ethers';
import { validateRailgunSiteConfiguration, siteDeployment } from '../app/configuration.ts';
import type { RailgunSiteConfiguration } from '../app/configuration.ts';
import { inspectRecovery, parseRecoveryFile, recoveryRecord } from '../sdk/index.ts';
import { minimumMatchingAssetOutput, relayFundingRequest, validateRelayFundingQuote } from '../sdk/relay.ts';
import type { RecoveryFile } from '../sdk/index.ts';
import { recoveryArtifacts } from './artifacts.ts';
import { renderApp } from './html.ts';
import { brand } from './brand.ts';
import { openRelayWorker } from './relay-worker.ts';
import type { RelayWorker } from './relay-worker.ts';
import { chainLogoFiles } from '../app/networks.ts';
import { documentation, renderDocumentation, machineDocumentation } from './docs.ts';

export async function startRailgunSite(input: RailgunSiteConfiguration, port = 5177,
  demo?: { recipient: string; recovery: string; amount?: string; action: (kind: string, file: RecoveryFile, amount: bigint) => Promise<string> },
  worker?: RelayWorker) {
  const configuration = validateRailgunSiteConfiguration(input);
  if (configuration.bridgeOrigins?.length && !process.env.RELAY_API_KEY) {
    throw new Error('Enabled Relay routes require a server-side RELAY_API_KEY.');
  }
  if (worker) {
    const route = siteDeployment(configuration), actual = worker.configuration;
    if (!isDeepStrictEqual(route, actual.deployment)
      || configuration.relayer !== actual.owner || configuration.feeRecipient !== actual.policy.feeRecipient
      || configuration.decimals !== 18 || BigInt(configuration.maxAmount) > actual.policy.maxAmount) {
      throw new Error('Site configuration does not match the automatic relay policy.');
    }
  }
  const provider = new JsonRpcProvider(configuration.rpcUrl, undefined, { batchMaxCount: 1, cacheTimeout: -1 });
  if ((await provider.getNetwork()).chainId !== BigInt(configuration.chainId)) {
    provider.destroy(); throw new Error('RPC chain does not match the site configuration.');
  }
  const bundle = await build({ entryPoints: ['app/railgun.ts', 'app/theme.ts', 'app/site.ts'],
    outdir: '.cache/railgun-ui', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false, minify: true });
  const trustedArtifacts = recoveryArtifacts();
  const files = new Map<string, [string | Uint8Array, string]>([
    ['/', [await renderApp('railgun'), 'text/html']],
    ['/configuration.json', [JSON.stringify({...configuration, automaticRelay: !!worker,
      minAmount: worker ? String(worker.configuration.policy.minAmount) : configuration.minAmount}), 'application/json']],
    ['/contracts.json', [JSON.stringify(trustedArtifacts), 'application/json']],
    ['/style.css', [await readFile('app/style.css'), 'text/css']],
    ['/docs.css', [await readFile('app/docs.css'), 'text/css']],
  ]);
  for (const page of documentation) {
    const rendered: [string, string] = [await renderDocumentation(page), 'text/html'];
    files.set(page.path, rendered); files.set(page.path.slice(0, -1), rendered);
  }
  for (const [path, file] of await machineDocumentation()) files.set(path, file);
  for (const output of bundle.outputFiles) files.set('/' + output.path.split('/').at(-1), [output.contents, 'text/javascript']);
  for (const asset of ['metamask', 'rainbow', 'rabby', 'railgun']) {
    files.set(`/assets/${asset}.svg`, [await readFile(`app/assets/${asset}.svg`), 'image/svg+xml']);
  }
  for (const asset of chainLogoFiles) files.set('/' + asset, [await readFile('app/' + asset), 'image/png']);
  if (demo) {
    if (configuration.mode !== 'local' || configuration.chainId !== '31337') throw new Error('Demo actions are local only.');
    files.set('/demo.json', [JSON.stringify({ recipient: demo.recipient, recovery: demo.recovery, amount: demo.amount ?? '100' }), 'application/json']);
  }
  const methods = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getCode', 'eth_call', 'eth_getBalance',
    'eth_getBlockByNumber', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getLogs', 'eth_getStorageAt']);
  let actualPort = port;
  let busy = false;
  const stopWorker = new AbortController();
  let workerStopped = false;
  let running: Promise<void> | undefined;
  const server = createServer((request, response) => {
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    void (async () => {
      const host = request.headers.host;
      if (![`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(host ?? '')
        || request.headers['sec-fetch-site'] === 'cross-site'
        || (request.headers.origin && request.headers.origin !== `http://${host}`)) {
        response.writeHead(403).end('Use the local application address.'); return;
      }
      const path = new URL(request.url ?? '/', `http://${host}`).pathname;
      if (request.method === 'GET') {
        const file = files.get(path);
        if (!file) { response.writeHead(404).end('Not found'); return; }
        response.writeHead(200, { 'Content-Type': file[1] }).end(file[0]); return;
      }
      if (request.method !== 'POST' || request.headers.origin !== `http://${host}`
        || request.headers['content-type'] !== 'application/json') { response.writeHead(403).end(); return; }
      let body = '';
      for await (const chunk of request) { body += String(chunk); if (body.length > 20_000) { response.writeHead(413).end(); return; } }
      const data = JSON.parse(body);
      let result: unknown;
      if (path === '/api/rpc') {
        if (data.jsonrpc !== '2.0' || !methods.has(data.method) || !Array.isArray(data.params)
          || !['string', 'number'].includes(typeof data.id)) { response.writeHead(400).end(); return; }
        try { result = { jsonrpc: '2.0', id: data.id, result: await provider.send(data.method, data.params) }; }
        catch { result = { jsonrpc: '2.0', id: data.id, error: { code: -32000, message: 'Chain request failed.' } }; }
      } else if (worker && path === '/api/relay-register') {
        if (workerStopped) { response.writeHead(503).end(); return; }
        result = {address: await worker.register(parseRecoveryFile(JSON.stringify(data.recovery)))};
      } else if (worker && path === '/api/relay-status') {
        if (typeof data.address !== 'string' || !/^0x[\da-fA-F]{40}$/.test(data.address)) { response.writeHead(400).end(); return; }
        result = {job: await worker.status(data.address), stopped: workerStopped};
      } else if (path === '/api/bridge-quote' && configuration.bridgeOrigins?.length) {
        const file = parseRecoveryFile(JSON.stringify(data.recovery));
        const origin = configuration.bridgeOrigins.find(origin => origin.chainId === data.originChainId);
        if (!origin || file.protocol !== 'railgun' || file.chainId !== configuration.chainId || file.pool !== configuration.pool
          || file.factory !== configuration.factory || file.asset !== configuration.token
          || file.config.relayer !== configuration.relayer || file.config.feeRecipient !== configuration.feeRecipient
          || typeof data.amount !== 'string' || !/^[1-9][0-9]{0,35}$/.test(data.amount)
          || BigInt(data.amount) > BigInt(configuration.maxAmount)) { response.writeHead(400).end(); return; }
        const bridgeMinimum = minimumMatchingAssetOutput(BigInt(data.amount), BigInt(configuration.gasFee));
        const minimumOutput = worker && worker.configuration.policy.minAmount > bridgeMinimum ? worker.configuration.policy.minAmount : bridgeMinimum;
        const input = { originChainId: origin.chainId, originToken: origin.token,
          destinationChainId: Number(configuration.chainId), destinationToken: configuration.token,
          destinationAddress: file.depositAddress, recoveryOwner: file.config.recovery, amount: BigInt(data.amount),
          minimumOutput, slippageBps: 50 };
        await inspectRecovery(provider, file, trustedArtifacts);
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (process.env.RELAY_API_KEY) headers['x-api-key'] = process.env.RELAY_API_KEY;
        const quoted = await fetch('https://api.relay.link/quote/v2', { method: 'POST', headers,
          body: JSON.stringify(relayFundingRequest(input)), signal: AbortSignal.timeout(15000) });
        if (!quoted.ok) { response.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Bridge quote unavailable. No funds have moved.' })); return; }
        const providerResponse: unknown = await quoted.json();
        validateRelayFundingQuote(input, providerResponse);
        result = { providerResponse };
      } else if (demo && (path === '/api/demo-fund' || !worker && path === '/api/demo-relay')) {
        if (busy) { response.writeHead(409).end(); return; }
        const file = parseRecoveryFile(JSON.stringify(data.recovery));
        if (file.config.recovery !== demo.recovery || file.factory !== configuration.factory || file.pool !== configuration.pool
          || file.chainId !== '31337' || file.protocol !== 'railgun' || file.asset !== configuration.token
          || file.config.relayer !== configuration.relayer || file.config.feeRecipient !== configuration.feeRecipient
          || typeof data.amount !== 'string' || !/^[1-9][0-9]{0,35}$/.test(data.amount)
          || BigInt(data.amount) > BigInt(configuration.maxAmount)) { response.writeHead(400).end(); return; }
        busy = true;
        try { result = { transactionHash: await demo.action(path, file, BigInt(data.amount)) }; }
        finally { busy = false; }
      } else { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
    })().catch(() => { if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Could not complete this request. Check the route and try again.' })); else response.end(); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Could not start the site.');
  actualPort = address.port;
  if (worker) running = worker.run(stopWorker.signal).catch(() => { workerStopped = true; });
  return { url: `http://127.0.0.1:${actualPort}`, close: () => new Promise<void>((resolve, reject) => {
    stopWorker.abort();
    server.close(error => {
      provider.destroy();
      void (async () => { await running; await worker?.close(); if (error) throw error; })().then(resolve, reject);
    }); server.closeAllConnections();
  }) };
}

export async function startRailgunDemo(port = 5177, automatic = false) {
  const { createEnvironment, createRecipient, fund, settle } = await import('../test/helpers.ts');
  const env = await createEnvironment(undefined, undefined, automatic);
  let worker: RelayWorker | undefined; let directory: string | undefined;
  try {
    const recipient = await createRecipient();
    const operator = automatic ? Wallet.createRandom().connect(env.provider) : env.relayer;
    if (automatic) await (await env.deployer.sendTransaction({to: await operator.getAddress(), value: parseEther('0.1')})).wait();
    const configuration: RailgunSiteConfiguration = {
      chainId: '31337', chainName: 'Local test chain', rpcUrl: env.provider._getConnection().url,
      factory: env.deployment.factory, implementation: env.deployment.implementation, validator: env.deployment.validator,
      executor: env.deployment.executor, maxGasFee: String(env.deployment.maxGasFee), codeHashes: env.deployment.codeHashes,
      pool: await env.pool.getAddress(), poolImplementation: env.deployment.poolImplementation,
      assetImplementation: env.deployment.assetImplementation, relayer: await operator.getAddress(),
      feeRecipient: await env.feeCollector.getAddress(), token: await env.token.getAddress(),
      symbol: automatic ? 'test WETH' : 'test USDC', decimals: automatic ? 18 : 6,
      gasFee: automatic ? String(parseEther('0.0005')) : '200000',
      maxAmount: automatic ? String(parseEther('0.1')) : '1000000000000', mode: 'local',
    };
    if (automatic) {
      directory = await mkdtemp('.cache/relay-demo-');
      worker = await openRelayWorker(env.deployment, recoveryArtifacts(), operator, {
        feeRecipient: configuration.feeRecipient, minAmount: parseEther('0.002'), maxAmount: parseEther('0.1'),
        maxNativeFee: parseEther('0.01'), maxTotalNativeSpend: parseEther('0.02'), confirmations: 1, maxJobs: 10,
      }, join(directory, 'queue'));
    }
    const site = await startRailgunSite(configuration, port, {
      recipient: recipient.address, recovery: await env.recovery.getAddress(), amount: automatic ? '0.01' : '100',
      action: async (kind, file, amount) => {
        const record = recoveryRecord(file);
        if (kind === '/api/demo-fund') return (await fund(env, file.depositAddress, amount)).hash;
        const block = await env.provider.getBlock('latest'); if (!block) throw new Error('No block');
        const deposit = await env.adapter.quote(env.provider, record, { token: file.asset, amount,
          gasFee: BigInt(configuration.gasFee), deadline: BigInt(block.timestamp + 3600) });
        return (await settle(env, deposit)).hash;
      },
    }, worker);
    return { ...site, env, recipient, configuration, close: async () => {
      await site.close(); await env.close(); if (directory) await rm(directory, {recursive: true});
    } };
  } catch (error) { await worker?.close(); await env.close(); if (directory) await rm(directory, {recursive: true}); throw error; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  const site = !path || ['--demo', '--demo-auto'].includes(path) ? await startRailgunDemo(5177, path === '--demo-auto')
    : await startRailgunSite(JSON.parse(await readFile(path, 'utf8')));
  console.log(`${brand.displayName} RAILGUN: ${site.url}`);
  const stop = () => { void site.close().then(() => process.exit(0)); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
