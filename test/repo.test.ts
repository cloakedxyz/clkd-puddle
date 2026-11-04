import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import test from 'node:test';
import { inspectRepository } from '../scripts/check-repo.ts';

test('repository guard rejects private/generated files and redacts secret values', async t => {
  const root = await mkdtemp(join(tmpdir(), 'puddle-repo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = 'npm_' + 'a'.repeat(36);
  const key = '0x' + 'b'.repeat(64);
  const sources = {
    '.env': 'SETTING=example\n',
    '.env.example': 'SETTING=\n',
    '.cache/recipient.json': '{}\n',
    'sdk/dist/index.js': '// generated\n',
    'deployments/recovery.json': '{}\n',
    'credentials.txt': `token=${token}\nprivateKey = '${key}'\n`,
    'deployments/public.json': '{"chainId":42161}\n',
  };
  for (const [path, value] of Object.entries(sources)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), value);
  }
  const problems = await inspectRepository(root, Object.keys(sources));
  assert.equal(problems.length, 6);
  assert(problems.some(problem => problem.includes('npm access token')));
  assert(problems.some(problem => problem.includes('wallet private key')));
  assert(!problems.some(problem => problem.includes('.env.example') || problem.includes('public.json')));
  assert(!problems.join('\n').includes(token));
  assert(!problems.join('\n').includes(key));
});

test('repository guard checks local links and headings, including product-doc routes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'puddle-links-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sources = {
    'README.md': '# Home\n[guide](docs/guide.md#using-the-sdk)\n[ref][guide]\n\n[guide]: docs/guide.md\n'
      + '```md\n[example](ignored-placeholder.md)\n```\n`[inline](ignored.md)`\n'
      + '[remote](https://example.com/never-requested)\n[missing](absent.md)\n[heading](docs/guide.md#absent)\n',
    'docs/guide.md': '# Guide\n## Using the `SDK`\n',
    'docs/src/pages/index.md': '# Product\n[fees](/fees)\n[here](#product)\n',
    'docs/src/pages/fees.md': '# Fees\n[home](/)\n',
  };
  for (const [path, value] of Object.entries(sources)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), value);
  }
  const problems = await inspectRepository(root, [...Object.keys(sources), 'deleted.md']);
  assert.equal(problems.length, 2);
  assert(problems.some(problem => problem.endsWith('absent.md')));
  assert(problems.some(problem => problem.endsWith('#absent')));
});

test('repository guard refuses symlinks and path traversal without reading their contents', async t => {
  const root = await mkdtemp(join(tmpdir(), 'puddle-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink('/not-a-repository-file', join(root, 'linked'));
  const problems = await inspectRepository(root, ['linked', '../outside', '/absolute']);
  assert.equal(problems.length, 3);
  assert(problems.includes('linked: expected a regular source file.'));
});

test('dummy example.com URL credentials are allowed only in test fixtures and do not hide later matches', async t => {
  const root = await mkdtemp(join(tmpdir(), 'puddle-fixtures-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'test'));
  const dummy = ['https:', '', 'a:b@example.com'].join('/');
  const other = ['https:', '', 'a:b@rpc.invalid'].join('/');
  const invalid = ['https:', '', 'a:b@]'].join('/');
  await writeFile(join(root, 'test/example.test.ts'), `${dummy}\n${other}\n${invalid}\n`);
  await writeFile(join(root, 'app.ts'), dummy);
  const problems = await inspectRepository(root, ['test/example.test.ts', 'app.ts']);
  assert.equal(problems.length, 3);
  assert(problems.some(problem => problem.startsWith('test/example.test.ts:2:')));
  assert(problems.some(problem => problem.startsWith('test/example.test.ts:3:')));
  assert(problems.some(problem => problem.startsWith('app.ts:1:')));
});
