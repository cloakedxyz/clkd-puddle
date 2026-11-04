import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonRpcProvider, parseUnits } from 'ethers';
import { prepareRailgunReceive } from '@cloakedxyz/puddle';
import contracts from '@cloakedxyz/puddle/contracts' with { type: 'json' };

async function main() {
  const [configurationPath, profilePath, amountText, outputDirectory] = process.argv.slice(2);
  if (configurationPath === '--help') {
    console.log('Usage: node receive.mjs CONFIGURATION_JSON PUBLIC_PROFILE_JSON AMOUNT NEW_OUTPUT_DIRECTORY');
    console.log('Reads public recipient/recovery details, verifies the route, and saves recovery plus a quote. No transactions are signed or sent.');
    return;
  }
  if (!configurationPath || !profilePath || !amountText || !outputDirectory) throw new Error('Use --help for the preparation command.');
  const config = JSON.parse(await readFile(configurationPath, 'utf8'));
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));
  if (typeof config.chainId !== 'string' || !/^[1-9][0-9]*$/.test(config.chainId)
    || !Number.isInteger(config.decimals) || config.decimals < 0 || config.decimals > 18
    || typeof config.maxAmount !== 'string' || !/^[1-9][0-9]*$/.test(config.maxAmount)
    || typeof config.gasFee !== 'string' || !/^(0|[1-9][0-9]*)$/.test(config.gasFee)
    || typeof profile.recipient !== 'string' || typeof profile.recovery !== 'string') throw new Error('Invalid public configuration or profile.');
  const rpc = new URL(config.rpcUrl);
  if (rpc.username || rpc.password || rpc.hash || (rpc.protocol !== 'https:'
    && !(rpc.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(rpc.hostname)))) throw new Error('Use a public HTTPS RPC or a local test node.');
  if (!/^[0-9]+(\.[0-9]+)?$/.test(amountText)) throw new Error('Enter a decimal token amount.');
  const amount = parseUnits(amountText, config.decimals);
  if (amount <= 0n || amount > BigInt(config.maxAmount)) throw new Error('Amount exceeds the configured route limit.');
  const provider = new JsonRpcProvider(config.rpcUrl, undefined, { batchMaxCount: 1, cacheTimeout: -1 });
  try {
    const block = await provider.getBlock('latest'); if (!block) throw new Error('Could not read the chain.');
    const prepared = await prepareRailgunReceive(provider, {
      chainId: BigInt(config.chainId), factory: config.factory, pool: config.pool,
      implementation: config.implementation, validator: config.validator, executor: config.executor,
      asset: config.token, maxGasFee: BigInt(config.maxGasFee), codeHashes: config.codeHashes, poolImplementation: config.poolImplementation,
      assetImplementation: config.assetImplementation ?? null,
    }, { recipient: profile.recipient, recovery: profile.recovery, relayer: config.relayer, feeRecipient: config.feeRecipient },
    { token: config.token, amount, gasFee: BigInt(config.gasFee), deadline: BigInt(block.timestamp + 3600) }, contracts);
    // A fresh directory prevents overwriting an earlier recovery file. Only show
    // the address after both files have been saved successfully.
    await mkdir(outputDirectory, { mode: 0o700 });
    await writeFile(join(outputDirectory, 'recovery.json'), JSON.stringify(prepared.recovery, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await writeFile(join(outputDirectory, 'deposit.json'), JSON.stringify(prepared.deposit,
      (_, value) => typeof value === 'bigint' ? String(value) : value, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ address: prepared.deposit.address, chainId: config.chainId, token: config.token,
      grossAmountUnits: String(amount), recoveryFile: join(outputDirectory, 'recovery.json'), quoteFile: join(outputDirectory, 'deposit.json') }, null, 2));
  } finally { provider.destroy(); }
}

await main().catch(error => { console.error(error.message); process.exitCode = 1; });
