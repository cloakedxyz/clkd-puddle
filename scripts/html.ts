import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { brand } from './brand.ts';

const root = new URL('../', import.meta.url);
export const escapeHTML = (value: string) => value.replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export function renderBrand(template: string) {
  return template.replace(/\{\{brand\.(name|displayName|repository)\}\}/g,
    (_, key: 'name' | 'displayName' | 'repository') => escapeHTML(brand[key]));
}

export async function renderApp(mode: 'local' | 'public') {
  const local = mode === 'local';
  const values = {
    scripts: local ? '<script type="module" src="/main.js"></script>' : '',
    docs: local ? 'http://127.0.0.1:5174' : '/docs',
    recovery: local ? 'http://127.0.0.1:5175' : '/docs/recovery',
    label: local ? 'Local deposit test' : 'Private deposits',
    deposit: await readFile(new URL(`app/${local ? 'local' : 'public'}-deposit.html`, root), 'utf8'),
  };
  const template = await readFile(new URL('app/index.html', root), 'utf8');
  return renderBrand(template.replace(/\{\{app\.(scripts|docs|recovery|label|deposit)\}\}/g,
    (_, key: keyof typeof values) => values[key]))
    .replace('<!-- build-version -->', revisionBadge('build-version'));
}

function git(...args: string[]): string | undefined {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return undefined; }
}

// Capture the source revision during the build, including source archives without Git.
export function revisionBadge(className = '') {
  const archiveCommit = process.env.BUILD_COMMIT ?? process.env.VERCEL_GIT_COMMIT_SHA;
  const commit = archiveCommit ?? git('rev-parse', '--verify', 'HEAD');
  if (commit !== undefined && !/^[a-f0-9]{40}$/i.test(commit)) throw new Error('BUILD_COMMIT must be a full Git commit hash.');
  const status = git('status', '--porcelain', '--untracked-files=normal');
  const modified = status === undefined ? !archiveCommit : status.length > 0;
  const label = commit ? `${commit.slice(0, 7)}${modified ? ' · dev' : ''}` : 'dev';
  const title = commit ? `Source commit ${commit}${modified ? ' — includes local changes' : ''}` : 'Development build — source revision unavailable';
  const attributes = `class="${escapeHTML(className)}" title="${escapeHTML(title)}"`;
  return commit
    ? `<a ${attributes} href="${escapeHTML(brand.repository)}/commit/${commit}" target="_blank" rel="noreferrer">${label}</a>`
    : `<span ${attributes}>${label}</span>`;
}
