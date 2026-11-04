import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JsonRpcProvider } from 'ethers';
import { validateRailgunSiteConfiguration, siteDeployment } from '../app/configuration.ts';
import type { RailgunSiteConfiguration } from '../app/configuration.ts';
import { verifyDeployment } from '../sdk/index.ts';
import { verifySdkBuild } from '../sdk/verify-build.mjs';
import { recoveryArtifacts } from './artifacts.ts';
import { renderApp } from './html.ts';
import { documentation, renderDocumentation } from './docs.ts';

/** Static app and docs. A receiving build requires reviewed, already-deployed contracts. */
export async function buildSite(directory = 'dist', input?: RailgunSiteConfiguration) {
  const output = resolve(directory);
  let configuration: RailgunSiteConfiguration | undefined;
  let artifacts: ReturnType<typeof recoveryArtifacts> | undefined;
  if (input) {
    const checked = validateRailgunSiteConfiguration(input);
    if (checked.bridgeOrigins?.length) throw new Error('Public bridging remains disabled pending funded route/recovery tests.');
    if (checked.mode !== 'pilot') throw new Error('A public receiving build must use pilot mode, without demo wallets.');
    await verifySdkBuild(); artifacts = recoveryArtifacts();
    const provider = new JsonRpcProvider(checked.rpcUrl, undefined, {batchMaxCount: 1, cacheTimeout: -1});
    try { await verifyDeployment(provider, siteDeployment(checked), artifacts); }
    finally { provider.destroy(); }
    // Explicit whitelist: never spread profiles, API keys or unrelated build inputs into the browser.
    configuration = {
      chainId: checked.chainId, chainName: checked.chainName, rpcUrl: checked.rpcUrl, rpcTransport: 'direct',
      factory: checked.factory, implementation: checked.implementation, validator: checked.validator,
      executor: checked.executor, pool: checked.pool, token: checked.token, codeHashes: {...checked.codeHashes},
      poolImplementation: checked.poolImplementation ? {address: checked.poolImplementation.address, codeHash: checked.poolImplementation.codeHash} : null,
      maxGasFee: checked.maxGasFee, relayer: checked.relayer, feeRecipient: checked.feeRecipient,
      symbol: checked.symbol, decimals: checked.decimals, gasFee: checked.gasFee, maxAmount: checked.maxAmount,
      minAmount: checked.minAmount, automaticRelay: false, mode: 'pilot',
    };
  }
  await rm(output, {recursive: true, force: true});
  await mkdir(join(output, 'assets'), {recursive: true});
  await build({entryPoints: ['app/theme.ts', 'app/site.ts', ...(configuration ? ['app/railgun.ts'] : [])],
    outdir: output, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true});
  await writeFile(join(output, 'index.html'), await renderApp(configuration ? 'railgun' : 'public'));
  if (configuration) {
    await writeFile(join(output, 'configuration.json'), JSON.stringify(configuration));
    await writeFile(join(output, 'contracts.json'), JSON.stringify(artifacts));
  }
  for (const page of documentation) {
    const target = join(output, page.path.slice(1));
    await mkdir(target, {recursive: true});
    await writeFile(join(target, 'index.html'), await renderDocumentation(page));
  }
  for (const file of ['style.css', 'docs.css', 'assets/metamask.svg', 'assets/rainbow.svg', 'assets/rabby.svg', 'assets/railgun.svg']) {
    await copyFile(join('app', file), join(output, file));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.env.PUDDLE_SITE_CONFIGURATION;
  const configuration = path ? JSON.parse(await readFile(path, 'utf8')) as RailgunSiteConfiguration : undefined;
  if (configuration && (configuration.chainId !== '42161' || configuration.rpcUrl !== 'https://arb1.arbitrum.io/rpc')) {
    throw new Error('The reviewed public pilot route uses Arbitrum One and its public RPC.');
  }
  await buildSite('dist', configuration);
}
