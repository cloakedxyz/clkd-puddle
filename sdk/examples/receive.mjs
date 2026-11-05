import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonRpcProvider, parseUnits } from 'ethers';
import { prepareRailgunReceive, prepareFlexibleReceive } from '@cloakedxyz/puddle';
import multiContracts from '@cloakedxyz/puddle/multi-asset-contracts' with { type: 'json' };
import contracts from '@cloakedxyz/puddle/contracts' with { type: 'json' };

async function main() {
  const [configurationPath, profilePath, third, fourth] = process.argv.slice(2);
  if (configurationPath === '--help') {
    console.log('Usage: node receive.mjs CONFIGURATION_JSON PUBLIC_PROFILE_JSON NEW_OUTPUT_DIRECTORY');
    console.log('Legacy quoted route: add AMOUNT before NEW_OUTPUT_DIRECTORY.');
    console.log('Reads public recipient/recovery details, verifies the route, and saves recovery plus a receiving record. No transactions are signed or sent.');
    return;
  }
  if (!configurationPath || !profilePath || !third) throw new Error('Use --help for the preparation command.');
  const config = JSON.parse(await readFile(configurationPath, 'utf8'));
  const amountText = config.multiAsset ? undefined : third;
  const outputDirectory = config.multiAsset ? third : fourth;
  if (!outputDirectory || config.multiAsset && fourth) throw new Error('Use --help for the preparation command.');
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));
  if (typeof config.chainId !== 'string' || !/^[1-9][0-9]*$/.test(config.chainId)
    || !Number.isInteger(config.decimals) || config.decimals < 0 || config.decimals > 18
    || typeof config.maxAmount !== 'string' || !/^[1-9][0-9]*$/.test(config.maxAmount)
    || typeof config.gasFee !== 'string' || !/^(0|[1-9][0-9]*)$/.test(config.gasFee)
    || typeof profile.recipient !== 'string' || typeof profile.recovery !== 'string') throw new Error('Invalid public configuration or profile.');
  const rpc = new URL(config.rpcUrl);
  if (rpc.username || rpc.password || rpc.hash || (rpc.protocol !== 'https:'
    && !(rpc.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(rpc.hostname)))) throw new Error('Use a public HTTPS RPC or a local test node.');
  const amount = config.multiAsset ? undefined : parseUnits(amountText, config.decimals);
  if (amount !== undefined && (amount <= 0n || amount > BigInt(config.maxAmount))) throw new Error('Amount exceeds the configured route limit.');
  const provider = new JsonRpcProvider(config.rpcUrl, undefined, { batchMaxCount: 1, cacheTimeout: -1 });
  try {
    const deployment = {
      ...(config.multiAsset ? {multiAsset: true} : {}), chainId: BigInt(config.chainId), factory: config.factory, pool: config.pool,
      implementation: config.implementation, validator: config.validator, executor: config.executor,
      asset: config.token, maxGasFee: BigInt(config.maxGasFee), codeHashes: config.codeHashes, poolImplementation: config.poolImplementation,
      assetImplementation: config.assetImplementation ?? null,
    };
    const input = {recipient: profile.recipient, recovery: profile.recovery, relayer: config.relayer, feeRecipient: config.feeRecipient};
    const block = await provider.getBlock('latest'); if (!block) throw new Error('Could not read the chain.');
    const prepared = config.multiAsset ? await prepareFlexibleReceive(provider, deployment, input, multiContracts)
      : await prepareRailgunReceive(provider, deployment, input,
        {token: config.token, amount, gasFee: BigInt(config.gasFee), deadline: BigInt(block.timestamp + 3600)}, contracts);
    const record = prepared.record ?? prepared.deposit;
    const recordName = config.multiAsset ? 'receiving.json' : 'deposit.json';
    // A fresh directory prevents overwriting an earlier recovery file. Only show
    // the address after both files have been saved successfully.
    await mkdir(outputDirectory, { mode: 0o700 });
    await writeFile(join(outputDirectory, 'recovery.json'), JSON.stringify(prepared.recovery, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await writeFile(join(outputDirectory, recordName), JSON.stringify(record,
      (_, value) => typeof value === 'bigint' ? String(value) : value, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ address: record.address, chainId: config.chainId, recoveryFile: join(outputDirectory, 'recovery.json'),
      ...(config.multiAsset ? {receivingFile: join(outputDirectory, recordName), accepts: 'ETH and standard ERC-20'}
        : {token: config.token, grossAmountUnits: String(amount), quoteFile: join(outputDirectory, recordName)}) }, null, 2));
  } finally { provider.destroy(); }
}

await main().catch(error => { console.error(error.message); process.exitCode = 1; });
