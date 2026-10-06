import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { brand } from './brand.ts';
import { createEnvironment, createRecipient, prepareDeposit, fund, settle, decryptDeposit } from './harness.ts';
import type { PreparedDeposit } from './types.ts';
import { ZeroAddress, toBeHex } from 'ethers';
import type { TransactionReceipt } from 'ethers';
import { quoteAmount } from '../app/shared.ts';
import type { AppState } from '../app/shared.ts';
import { createRecoveryFile, recoveryArtifacts } from './recovery-file.ts';
import { parseRecoveryFile } from '../recovery/core.ts';
import { mined, recoveryTransaction, relayDeposit, inspectDeposit } from '../protocols/deposit.ts';
import { compileV1, environment as createV1Environment } from './privacy-pools-v1-local.ts';
import type { PrivacyPoolsV1Deposit } from '../protocols/privacy-pools-v1.ts';
import { decodeV1Recipient, v1PoolABI, v1ForwarderABI } from '../protocols/privacy-pools-v1-data.ts';

class RequestError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = '';
  let tooLarge = false;
  for await (const chunk of request) {
    if (!tooLarge) body += String(chunk);
    if (body.length > 4_096) { tooLarge = true; body = ''; }
  }
  if (tooLarge) throw new RequestError('Request is too large.', 413);
  try {
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new RequestError('Expected a JSON object.'); }
}

export async function startLocalApp(port = 5173) {
  // A fresh isolated chain and test identity on every start. No live RPC or signing keys.
  const env = await createEnvironment();
  try {
    assert.equal(await env.pool.shieldFee(), 25n, 'Local quote must match the pool fee');
    const recipient = await createRecipient();
    const v1 = await createV1Environment(compileV1(), env.provider);
    const state: AppState = {
      recipient: recipient.address, recovery: await env.recovery.getAddress(),
      relayer: await env.relayer.getAddress(), feeRecipient: await env.feeCollector.getAddress(),
      token: await env.token.getAddress(), pool: await env.pool.getAddress(),
      factory: await env.factory.getAddress(), privateBalance: '0', deposit: null,
      v1: { chainId: '31337', factory: await v1.factory.getAddress(), pool: await v1.entrypoint.getAddress(),
        token: await v1.token.getAddress(), feeRecipient: await v1.fees.getAddress() },
    };
    let prepared: PreparedDeposit | PrivacyPoolsV1Deposit | undefined;
    let shieldReceipt: TransactionReceipt | undefined;
    let busy = false;
    let task: Promise<void> | undefined;

    function runTask(work: () => Promise<void>) {
      busy = true;
      task = work().catch(error => {
        console.error('Local deposit failed:', error instanceof Error ? error.message : 'Unknown error');
        assert(state.deposit);
        state.deposit.phase = 'error';
        state.deposit.error = shieldReceipt
          ? 'Shielding confirmed, but receipt verification failed. Retry verification.'
          : 'The deposit could not finish. Retry shielding or recover your test tokens.';
      }).finally(() => { busy = false; });
    }

    async function relay() {
      assert(prepared && state.deposit);
      const gasFee = BigInt(state.deposit.quote.gasFee);
      if (!shieldReceipt) {
        state.deposit.phase = 'shielding';
        shieldReceipt = prepared.protocol === 'railgun' ? await settle(env, prepared, gasFee)
          : await mined(relayDeposit(v1.adapter, prepared, v1.relayer));
        state.deposit.shieldingTx = shieldReceipt.hash;
      }
      state.deposit.phase = 'verifying';
      if (prepared.protocol === 'privacy-pools-v1') {
        const pool = decodeV1Recipient(prepared.config.recipient).pool;
        const logs = shieldReceipt.logs.filter(log => log.address.toLowerCase() === pool.toLowerCase())
          .map(log => v1PoolABI.parseLog(log));
        const deposited = logs.find(log => log?.name === 'Deposited');
        assert(deposited && deposited.args.depositor === prepared.address);
        assert.equal(String(deposited.args.value), state.deposit.quote.received);
        state.deposit.received = String(deposited.args.value);
        state.deposit.commitment = toBeHex(deposited.args.commitment, 32);
        state.deposit.phase = 'complete';
        delete state.deposit.error;
        return;
      }
      const note = await decryptDeposit(env, recipient, shieldReceipt);
      const quote = state.deposit.quote;
      assert.equal(note.amount + note.fee + BigInt(quote.serviceFee) + gasFee, BigInt(quote.amount));
      assert.equal(note.amount.toString(), quote.received);
      assert.equal(await env.token.balanceOf(prepared.address), 0n);
      assert.equal(await env.token.allowance(prepared.address, state.pool), 0n);
      state.deposit.received = String(note.amount);
      state.deposit.commitment = note.commitment;
      state.privateBalance = String(BigInt(state.privateBalance) + note.amount);
      state.deposit.phase = 'complete';
      delete state.deposit.error;
    }

    const files = new Map([
      ['/', ['.cache/ui/index.html', 'text/html']],
      ['/receive', ['.cache/ui/index.html', 'text/html']],
      ['/style.css', ['app/style.css', 'text/css']],
      ['/main.js', ['.cache/ui/main.js', 'text/javascript']],
      ['/theme.js', ['.cache/ui/theme.js', 'text/javascript']],
      ['/shared.js', ['.cache/ui/shared.js', 'text/javascript']],
      ['/assets/metamask.svg', ['app/assets/metamask.svg', 'image/svg+xml']],
      ['/assets/rainbow.svg', ['app/assets/rainbow.svg', 'image/svg+xml']],
      ['/assets/rabby.svg', ['app/assets/rabby.svg', 'image/svg+xml']],
      ['/assets/railgun.svg', ['app/assets/railgun.svg', 'image/svg+xml']],
      ['/assets/privacy-pools.svg', ['app/assets/privacy-pools.svg', 'image/svg+xml']],
      ['/assets/chains/eth.png', ['app/assets/chains/eth.png', 'image/png']],
      ['/assets/chains/base.png', ['app/assets/chains/base.png', 'image/png']],
      ['/assets/chains/arbitrum.png', ['app/assets/chains/arbitrum.png', 'image/png']],
      ['/assets/chains/bnb.png', ['app/assets/chains/bnb.png', 'image/png']],
      ['/assets/chains/optimism.png', ['app/assets/chains/optimism.png', 'image/png']],
      ['/assets/chains/robinhood.png', ['app/assets/chains/robinhood.png', 'image/png']],
    ]);
    let actualPort = port;
    const server = createServer((request, response) => {
      void handle(request, response).catch(error => {
        const known = error instanceof RequestError;
        if (!known) console.error('Local request failed:', error instanceof Error ? error.message : 'Unknown error');
        response.writeHead(known ? error.status : 500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: known ? error.message : 'Could not complete this local request.' }));
      });
    });

    async function handle(request: IncomingMessage, response: ServerResponse) {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      const host = request.headers.host;
      if (host !== `127.0.0.1:${actualPort}` && host !== `localhost:${actualPort}`) {
        throw new RequestError('Use the local application address.', 403);
      }
      if (request.headers['sec-fetch-site'] === 'cross-site'
        || (request.headers.origin && request.headers.origin !== `http://${host}`)) {
        throw new RequestError('Cross-origin requests are not allowed.', 403);
      }
      const path = new URL(request.url ?? '/', `http://${host}`).pathname;
      const sendState = (status = 200) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(state));
      };
      if (request.method === 'GET') {
        if (path === '/api/state') return sendState();
        if (path === '/api/recovery-artifacts') {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify(recoveryArtifacts(env.contracts)));
          return;
        }
        if (path === '/api/recovery') {
          const requested = new URL(request.url!, `http://${host}`).searchParams.get('address');
          if (!prepared || requested !== prepared.address) throw new RequestError('This deposit is no longer active.', 409);
          const file = createRecoveryFile(prepared, prepared.quote.token);
          response.writeHead(200, { 'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename="${brand.name}-recovery-${prepared.address}.json"` });
          response.end(`${JSON.stringify(file, null, 2)}\n`);
          return;
        }
        const file = files.get(path);
        if (!file) throw new RequestError('Not found.', 404);
        const content = await readFile(new URL(`../${file[0]}`, import.meta.url));
        response.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8` });
        response.end(content);
        return;
      }
      if (request.method !== 'POST') throw new RequestError('Method not allowed.', 405);
      if (request.headers.origin !== `http://${host}`
        || request.headers['content-type'] !== 'application/json') {
        throw new RequestError('Use the local application to submit actions.', 403);
      }
      const body = await readBody(request);
      if (path === '/api/rpc') {
        const methods = ['eth_chainId', 'eth_blockNumber', 'eth_getCode', 'eth_call', 'eth_getLogs',
          'eth_getBalance', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getBlockByNumber'];
        if (body.jsonrpc !== '2.0' || typeof body.method !== 'string' || !methods.includes(body.method)
          || !Array.isArray(body.params) || !['number', 'string'].includes(typeof body.id)) {
          throw new RequestError('Only read-only local chain requests are supported.');
        }
        let result;
        try { result = { result: await env.provider.send(body.method, body.params) }; }
        catch { result = { error: { code: -32000, message: 'Local chain request failed.' } }; }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...result }));
        return;
      }
      if (busy) throw new RequestError('A deposit action is already running.', 409);
      if (path === '/api/deposits') {
        if (body.protocol !== undefined && body.protocol !== 'railgun' && body.protocol !== 'privacy-pools-v1') {
          throw new RequestError('Choose RAILGUN or Privacy Pools v1.');
        }
        if (Object.keys(body).some(key => !['protocol', 'amount', 'asset', 'recoveryFile'].includes(key))) {
          throw new RequestError('Unexpected deposit fields. Keep private note backups on your device.');
        }
        const protocol = body.protocol ?? 'railgun';
        const asset = body.asset ?? 'USDC';
        if (asset !== 'ETH' && asset !== 'USDC') throw new RequestError('Choose ETH or USDC.');
        if (state.deposit && !['complete', 'recovered'].includes(state.deposit.phase)) {
          throw new RequestError('Finish the current deposit first.', 409);
        }
        if (typeof body.amount !== 'string') throw new RequestError('Enter a deposit amount.');
        let quote;
        try { quote = quoteAmount(body.amount, protocol, asset); }
        catch (error) { throw new RequestError(error instanceof Error ? error.message : 'Invalid amount.'); }
        busy = true;
        try {
          if (protocol === 'railgun') {
            prepared = await prepareDeposit(env, recipient.address,
              { amount: BigInt(quote.amount), gasFee: BigInt(quote.gasFee) });
          } else {
            try {
              const file = parseRecoveryFile(JSON.stringify(body.recoveryFile));
              assert.equal(file.protocol, 'privacy-pools-v1');
              assert.equal(file.config.recovery, state.recovery);
              assert.equal(file.config.relayer, state.relayer);
              assert.equal(file.config.feeRecipient, state.v1.feeRecipient);
              const token = asset === 'ETH' ? ZeroAddress : state.v1.token;
              assert.equal(file.asset, token);
              const block = await env.provider.getBlock('latest');
              assert(block);
              prepared = await v1.adapter.quote(env.provider, { protocol: 'privacy-pools-v1',
                chainId: BigInt(file.chainId), factory: file.factory, pool: file.pool,
                address: file.depositAddress, salt: file.salt, config: file.config },
              { token, amount: BigInt(quote.amount), gasFee: BigInt(quote.gasFee), deadline: BigInt(block.timestamp + 3600) });
            } catch { throw new RequestError('Invalid public v1 receive instructions.'); }
          }
          shieldReceipt = undefined;
          state.deposit = { protocol: prepared.protocol, asset, address: prepared.address, quote, phase: 'ready' };
        } finally { busy = false; }
        return sendState(201);
      }
      const deposit = state.deposit;
      if (!deposit || !prepared || body.address !== deposit.address) {
        throw new RequestError('This deposit is no longer active. Refresh the page.', 409);
      }
      if (path === '/api/fund' && deposit.phase === 'ready') {
        deposit.phase = 'funding';
        runTask(async () => {
          assert.equal(await env.provider.getCode(deposit.address), '0x');
          const amount = BigInt(deposit.quote.amount);
          let receipt;
          if (deposit.protocol === 'railgun') receipt = await fund(env, deposit.address, amount);
          else if (deposit.asset === 'ETH') receipt = await mined(v1.sender.sendTransaction({ to: deposit.address, value: amount }));
          else {
            await mined(v1.token.getFunction('mint')(await v1.sender.getAddress(), amount));
            receipt = await mined(v1.token.connect(v1.sender).getFunction('transfer')(deposit.address, amount));
          }
          deposit.fundingTx = receipt.hash;
          assert.equal(await env.provider.getCode(deposit.address), '0x');
          deposit.phase = 'funded';
        });
        return sendState(202);
      }
      if (path === '/api/relay' && ['funded', 'error'].includes(deposit.phase) && deposit.fundingTx) {
        delete deposit.error;
        runTask(relay);
        return sendState(202);
      }
      if (path === '/api/recover' && ['funded', 'error'].includes(deposit.phase) && !shieldReceipt) {
        deposit.phase = 'recovering';
        runTask(async () => {
          assert(prepared);
          const owner = await env.recovery.getAddress();
          const adapter = prepared.protocol === 'railgun' ? env.adapter : v1.adapter;
          // A fresh address needs deployment first; an existing one can recover immediately.
          const deployed = await env.provider.getCode(prepared.address) !== '0x';
          let receipt = await mined(env.recovery.sendTransaction(await recoveryTransaction(
            adapter, prepared, env.provider, owner, prepared.quote.token)));
          if (!deployed) receipt = await mined(env.recovery.sendTransaction(await recoveryTransaction(
            adapter, prepared, env.provider, owner, prepared.quote.token)));
          assert(receipt);
          assert.equal((await inspectDeposit(adapter, prepared, env.provider)).balance, 0n);
          deposit.recoveryTx = receipt.hash;
          deposit.phase = 'recovered';
          delete deposit.error;
        });
        return sendState(202);
      }
      if (path === '/api/pool-recovery' && prepared.protocol === 'privacy-pools-v1'
        && deposit.phase === 'complete') {
        if (Object.keys(body).some(key => !['address', 'data'].includes(key)) || typeof body.data !== 'string') {
          throw new RequestError('Provide only the public recovery proof.');
        }
        busy = true;
        try {
          const decoded = v1ForwarderABI.decodeFunctionData('ragequit', body.data);
          assert.equal(v1ForwarderABI.encodeFunctionData('ragequit', decoded).toLowerCase(), body.data.toLowerCase());
          await env.provider.call({ from: state.recovery, to: deposit.address, data: body.data });
        } catch { busy = false; throw new RequestError('Invalid pool recovery proof.'); }
        const data = body.data;
        deposit.phase = 'recovering';
        runTask(async () => {
          try {
            const receipt = await mined(v1.owner.sendTransaction({ to: deposit.address, data }));
            deposit.recoveryTx = receipt.hash;
            deposit.phase = 'recovered';
          } catch (error) {
            deposit.phase = 'complete';
            deposit.error = 'Pool recovery failed. Your note can be retried.';
            console.error(error instanceof Error ? error.message : 'Pool recovery failed');
          }
        });
        return sendState(202);
      }
      throw new RequestError('This action is not available for the current deposit.', 409);
    }

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert(address && typeof address !== 'string');
    actualPort = address.port;
    let closing: Promise<void> | undefined;
    return {
      url: `http://127.0.0.1:${actualPort}`,
      close() {
        return closing ??= (async () => {
          await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
          await task;
          await env.close();
        })();
      },
    };
  } catch (error) { await env.close(); throw error; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`Starting ${brand.name} on a fresh local test chain…`);
  const app = await startLocalApp(Number(process.env.PORT ?? 5173));
  console.log(`${brand.name} is ready at ${app.url} — local test funds only.`);
  const stop = () => { void app.close().then(() => process.exit(0)); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
