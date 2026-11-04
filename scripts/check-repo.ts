import { execFileSync } from 'node:child_process';
import { isUtf8 } from 'node:buffer';
import { lstat, readFile } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const forbiddenOutput = /(^|\/)(node_modules|\.cache|\.vercel|dist|artifacts|\.vocs|\.waku)(\/|$)/;
const secretFiles = /(^|\/)(?:\.env(?:\..+)?|id_rsa|id_ed25519|[^/]+\.(?:pem|key|p12|pfx|keystore|tgz))$/i;
const privatePilotFiles = /(^|\/)(?:recipient(?:-profile)?|recovery|live-approval|[^/]*(?:live-journal|pilot-plan|deploy-plan))\.json$/i;
const secretPatterns = [
  ['private key material', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['literal wallet private key', /\bprivate[_-]?key\b["']?\s*[:=]\s*["'](?:0x)?[a-f\d]{64}["']/i],
  ['npm access token', /\bnpm_[A-Za-z\d]{30,}\b/],
  ['GitHub access token', /\b(?:gh[pousr]_[A-Za-z\d]{36,}|github_pat_[A-Za-z\d_]{60,})\b/],
  ['AWS access key identifier', /\b(?:AKIA|ASIA)[A-Z\d]{16}\b/],
  ['credential-bearing URL', /https?:\/\/[^\s/"'<>]+:[^\s/@"'<>]+@[^\s/"'<>]+/],
  ['literal npm authentication', /(?:_authToken|_auth)\s*=\s*(?!\$\{)[^\s#]+/],
] as const;

function withoutCode(markdown: string) {
  return markdown.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, '')
    .replace(/<!--[^]*?-->/g, '').replace(/`+[^`\n]*`+/g, '');
}

function headingAnchors(markdown: string) {
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  // Keep inline-code words: they are part of GitHub heading anchors.
  const prose = markdown.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, '');
  for (const match of prose.matchAll(/^ {0,3}#{1,6}\s+(.+?)\s*#*$/gm)) {
    const base = match[1].toLowerCase().replace(/<[^>]*>/g, '')
      .replace(/[^\p{L}\p{N}_\s-]/gu, '').replace(/\s/g, '-');
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count ? `${base}-${count}` : base);
  }
  return anchors;
}

/** Check only files intended for version control. Never include matched values in diagnostics. */
export async function inspectRepository(root: string, candidates: string[]): Promise<string[]> {
  const problems: string[] = [];
  const contents = new Map<string, string>();
  const files = new Set<string>();
  for (const path of new Set(candidates)) {
    if (posix.isAbsolute(path) || path.split('/').includes('..')) {
      problems.push('Unsafe candidate path.');
      continue;
    }
    const absolute = resolve(root, path);
    const stat = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined; // A tracked deletion is not part of the candidate tree.
    });
    if (!stat) continue;
    files.add(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      problems.push(`${path}: expected a regular source file.`);
      continue;
    }
    if (forbiddenOutput.test(path) || privatePilotFiles.test(path)
      || secretFiles.test(path) && posix.basename(path) !== '.env.example'
      || ['sdk/LICENSE', 'sdk/poseidon-lite-NOTICE'].includes(path)) {
      problems.push(`${path}: private data, credentials or generated output must stay out of version control.`);
    }
    if (stat.size > 1_048_576) {
      problems.push(`${path}: file exceeds 1 MiB; keep downloaded artifacts outside version control.`);
      continue;
    }
    const bytes = await readFile(absolute);
    if (!isUtf8(bytes) || bytes.includes(0)) continue;
    const source = bytes.toString('utf8');
    contents.set(path, source);
    for (const [name, pattern] of secretPatterns) {
      for (const match of source.matchAll(new RegExp(pattern.source, pattern.flags + 'g'))) {
        // Reserved example.com credentials are intentional URL-rejection test data.
        // This exception applies only to URL matches in public test source files.
        if (name === 'credential-bearing URL' && path.startsWith('test/') && path.endsWith('.test.ts')
          && URL.parse(match[0])?.hostname === 'example.com') continue;
        problems.push(`${path}:${source.slice(0, match.index).split('\n').length}: possible ${name}; value redacted.`);
      }
    }
  }
  for (const [path, source] of contents) {
    if (!path.endsWith('.md')) continue;
    const prose = withoutCode(source);
    const links = [
      ...Array.from(prose.matchAll(/\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^\n]*["'])?\s*\)/g), match => match[1]),
      ...Array.from(prose.matchAll(/^ {0,3}\[[^\]]+\]:\s*(<[^>]+>|\S+)/gm), match => match[1]),
    ];
    for (const raw of links) {
      const href = raw.replace(/^<|>$/g, '');
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) continue;
      const [location, fragment] = href.split('#', 2);
      let target: string;
      try {
        const local = decodeURIComponent(location.split('?')[0]);
        target = !local ? path : local.startsWith('/') && path.startsWith('docs/src/pages/')
          ? `docs/src/pages/${local === '/' ? 'index' : local.slice(1).replace(/\/$/, '')}.md`
          : posix.normalize(posix.join(posix.dirname(path), local));
      } catch {
        problems.push(`${path}: invalid local link encoding.`);
        continue;
      }
      if (!files.has(target)) {
        const directory = target.replace(/\/$/, '') + '/';
        if (Array.from(files).some(file => file.startsWith(directory))) continue;
        problems.push(`${path}: local link target is missing or not version controlled: ${target}`);
      } else if (fragment && target.endsWith('.md') && !headingAnchors(contents.get(target) ?? '').has(fragment)) {
        problems.push(`${path}: missing heading in ${target}: #${fragment}`);
      }
    }
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  // Includes existing untracked contributions, excludes ignored local pilot data.
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const problems = await inspectRepository(root, paths);
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
  } else console.log(`Repository hygiene and local documentation links pass.`);
}
