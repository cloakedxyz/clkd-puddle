import { getAddress, ZeroAddress } from 'ethers';
import type { Provider } from 'ethers';
import { createPrivacyPoolsV1Adapter } from '../protocols/privacy-pools-v1.ts';
import { decodeV1Recipient, v1Field } from '../protocols/privacy-pools-v1-data.ts';
import type { Deployment, DepositQuote, DepositTerms } from '../protocols/deposit.ts';
import { createRecoveryFile } from '../recovery/core.ts';

// Proposed integration format, not an existing official Privacy Pools export standard.
export interface V1ReceiveCode {
  format: 'privacy-pools-v1-receive'; version: 1; chainId: string;
  entrypoint: string; pool: string; asset: string; precommitment: string; recovery: string;
}

export function parseV1ReceiveCode(text: string): V1ReceiveCode {
  if (new TextEncoder().encode(text).length > 4096) throw new Error('Receive code is too large.');
  if (text.startsWith('https://') || text.startsWith('http://')) {
    const url = new URL(text);
    const params = new URLSearchParams(url.hash.slice(1));
    if ([...params.keys()].length !== 1 || !params.has('request')) throw new Error('Invalid receive link.');
    text = params.get('request')!;
  }
  let code: V1ReceiveCode;
  try { code = JSON.parse(text) as V1ReceiveCode; }
  catch { throw new Error('Paste a public Privacy Pools v1 receive code or link.'); }
  const keys = ['format', 'version', 'chainId', 'entrypoint', 'pool', 'asset', 'precommitment', 'recovery'];
  const integer = (v: unknown, limit: bigint): v is string => typeof v === 'string'
    && /^[1-9][0-9]{0,77}$/.test(v) && BigInt(v) < limit;
  if (!code || Array.isArray(code) || Object.keys(code).length !== keys.length || keys.some(k => !Object.hasOwn(code, k))
    || code.format !== 'privacy-pools-v1-receive' || code.version !== 1
    || !integer(code.chainId, 1n << 256n) || !integer(code.precommitment, v1Field)
    || ![code.entrypoint, code.pool, code.asset, code.recovery].every(v => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v))) {
    throw new Error('Invalid public Privacy Pools v1 receive code.');
  }
  const result = { ...code, entrypoint: getAddress(code.entrypoint), pool: getAddress(code.pool),
    asset: getAddress(code.asset), recovery: getAddress(code.recovery) };
  if (result.entrypoint === ZeroAddress || result.pool === ZeroAddress || result.recovery === ZeroAddress) {
    throw new Error('Invalid receive pool or recovery wallet.');
  }
  return result;
}

export function createV1ReceiveLink(base: string, code: V1ReceiveCode): string {
  const url = new URL(base);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) {
    throw new Error('Receive links require HTTPS, except on localhost.');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('Use a plain receiving page URL.');
  url.hash = new URLSearchParams({ request: JSON.stringify(parseV1ReceiveCode(JSON.stringify(code))) }).toString();
  return url.href;
}

export async function prepareV1PublicReceive(provider: Provider, deployment: Deployment,
  input: Omit<DepositTerms, 'recovery'> & DepositQuote, code: V1ReceiveCode) {
  code = parseV1ReceiveCode(JSON.stringify(code));
  if (BigInt(code.chainId) !== deployment.chainId || code.entrypoint !== getAddress(deployment.pool)
    || code.asset !== getAddress(input.token)) throw new Error('Receive code does not match the selected chain, pool or asset.');
  const adapter = createPrivacyPoolsV1Adapter(deployment);
  const record = await adapter.prepare(provider, { ...input, recovery: code.recovery, precommitment: BigInt(code.precommitment) });
  if (decodeV1Recipient(record.config.recipient).pool !== code.pool) throw new Error('Receive code points to another asset pool.');
  const deposit = await adapter.quote(provider, record, input);
  return { deposit, recovery: createRecoveryFile(record, input.token) };
}
