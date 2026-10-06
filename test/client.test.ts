import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ZeroAddress } from 'ethers';
import { createV1ReceiveLink, parseV1ReceiveCode, minimumV1Funding } from '../client/index.ts';

const code = { format: 'privacy-pools-v1-receive' as const, version: 1 as const, chainId: '1',
  entrypoint: '0x1111111111111111111111111111111111111111', pool: '0x2222222222222222222222222222222222222222',
  asset: ZeroAddress, precommitment: '123456', recovery: '0x3333333333333333333333333333333333333333' };

test('receive links round trip only public fields and keep them in the fragment', () => {
  const link = createV1ReceiveLink('https://puddle.example/receive', code);
  const url = new URL(link);
  assert.equal(url.search, '');
  assert(url.hash.startsWith('#request='));
  assert.deepEqual(parseV1ReceiveCode(link), code);
  assert.deepEqual(parseV1ReceiveCode(JSON.stringify(code)), code);
});

test('minimum funding meets the pool minimum after fees, and one unit less cannot', () => {
  // Exercise both sides of service-fee rounding boundaries, as well as ETH-sized values.
  for (const minimum of [0n, 1n, 998n, 999n, 1000n, 1998n, 1999n, 10n ** 15n]) {
    for (const gas of [0n, 1n, 999n, 1000n, 10n ** 14n]) {
      const amount = minimumV1Funding(minimum, gas);
      const required = minimum > 0n ? minimum : 1n;
      assert(amount - amount / 1000n - gas >= required);
      assert(amount - 1n - (amount - 1n) / 1000n - gas < required);
    }
  }
  assert.throws(() => minimumV1Funding(-1n, 0n));
  assert.throws(() => minimumV1Funding(1n, -1n));
  assert.throws(() => minimumV1Funding(1n << 120n, 0n));
});

test('receive parser rejects malformed codes, ambiguous links and secret-bearing payloads', () => {
  for (const value of [null, [], {}, { ...code, version: 2 }, { ...code, secret: 'private' },
    { ...code, mnemonic: 'private' }, { ...code, chainId: '0' }, { ...code, precommitment: '-1' },
    { ...code, precommitment: '1'.repeat(79) }, { ...code, pool: ZeroAddress }, { ...code, asset: '0x1234' },
    { ...code, recovery: ZeroAddress }, { ...code, recovery: undefined }]) {
    assert.throws(() => parseV1ReceiveCode(JSON.stringify(value)));
  }
  assert.throws(() => parseV1ReceiveCode('x'.repeat(4097)), /too large/);
  assert.throws(() => parseV1ReceiveCode('not-a-receive-code'), /Paste a public/);
  const valid = createV1ReceiveLink('https://puddle.example/receive', code);
  assert.throws(() => parseV1ReceiveCode(valid + '&request=other'), /Invalid receive link/);
  for (const base of ['javascript:alert(1)', 'http://example.com/receive', 'https://a:b@example.com/',
    'https://example.com/?track=1', 'https://example.com/#existing']) {
    assert.throws(() => createV1ReceiveLink(base, code));
  }
});
