import { readFile } from 'node:fs/promises';
import { dirname, posix } from 'node:path';
import { brand } from './brand.ts';
import { escapeHTML, revisionBadge } from './html.ts';

export const documentation = [
  {source: 'docs/index.md', path: '/docs/', label: 'Start here'},
  {source: 'docs/recovery.md', path: '/docs/recovery/', label: 'Recovery'},
  {source: 'docs/api.md', path: '/docs/api/', label: 'SDK API reference'},
  {source: 'docs/architecture.md', path: '/docs/architecture/', label: 'Architecture'},
  {source: 'docs/bridges.md', path: '/docs/bridges/', label: 'Relay quotes'},
  {source: 'SECURITY.md', path: '/docs/security/', label: 'Security'},
];
const anchor = (text: string) => text.toLowerCase().replace(/[`*]/g, '').replace(/[^\p{L}\p{N}_\s-]/gu, '').replace(/\s/g, '-');

/** Small renderer for the repository's trusted Markdown. Raw HTML is always escaped. */
export function renderMarkdown(markdown: string, source: string) {
  function href(value: string) {
    if (/^(?:https?:|mailto:|#)/.test(value)) return value;
    if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//')) return '#';
    const [file, fragment] = value.split('#');
    const path = posix.normalize(posix.join(dirname(source), file));
    const page = documentation.find(page => page.source === path);
    return (page?.path ?? `${brand.repository}/blob/main/${path}`) + (fragment ? '#' + fragment : '');
  }
  function inline(text: string): string {
    const tokens = /`([^`]+)`|\[([^\]]+)\]\(([^\s)]+)\)|\*\*([^*]+)\*\*/g;
    let output = '', end = 0;
    for (const match of text.matchAll(tokens)) {
      output += escapeHTML(text.slice(end, match.index));
      if (match[1] !== undefined) output += `<code>${escapeHTML(match[1])}</code>`;
      else if (match[2] !== undefined) output += `<a href="${escapeHTML(href(match[3]))}">${inline(match[2])}</a>`;
      else output += `<strong>${escapeHTML(match[4])}</strong>`;
      end = match.index! + match[0].length;
    }
    return output + escapeHTML(text.slice(end));
  }
  const lines = markdown.split('\n'), output: string[] = [], sections: {id: string; title: string}[] = [];
  const counts = new Map<string, number>();
  for (let i = 0; i < lines.length;) {
    const line = lines[i]; if (!line.trim()) { i++; continue; }
    if (line.startsWith('```')) {
      const code: string[] = []; i++;
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
      i++; output.push(`<pre><code>${escapeHTML(code.join('\n'))}</code></pre>`); continue;
    }
    const heading = /^(#{1,3}) (.+)$/.exec(line);
    if (heading) {
      const base = anchor(heading[2]), count = counts.get(base) ?? 0; counts.set(base, count + 1);
      const id = base + (count ? `-${count}` : '');
      output.push(`<h${heading[1].length} id="${escapeHTML(id)}">${inline(heading[2])}</h${heading[1].length}>`);
      if (heading[1].length === 2) sections.push({id, title: heading[2].replace(/`/g, '')});
      i++; continue;
    }
    if (line.trim().startsWith('|') && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      const cells = (row: string) => row.trim().slice(1, -1).split('|').map(cell => inline(cell.trim()));
      const header = cells(line); i += 2; const rows: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(`<tr>${cells(lines[i++]).map(cell => `<td>${cell}</td>`).join('')}</tr>`);
      output.push(`<div class="doc-table"><table><thead><tr>${header.map(cell => `<th>${cell}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`); continue;
    }
    if (/^(?:- |\d+\. )/.test(line)) {
      const ordered = /^\d/.test(line), tag = ordered ? 'ol' : 'ul'; const items: string[] = [];
      const pattern = ordered ? /^\d+\. (.+)$/ : /^- (.+)$/;
      while (i < lines.length && pattern.test(lines[i])) {
        let item = lines[i++].replace(pattern, '$1');
        while (i < lines.length && /^ {2,}\S/.test(lines[i])) item += ' ' + lines[i++].trim();
        items.push(`<li>${inline(item)}</li>`);
      }
      output.push(`<${tag}>${items.join('')}</${tag}>`); continue;
    }
    const paragraph = [line]; i++;
    while (i < lines.length && lines[i].trim() && !/^(?:#|```|- |\d+\. |\|)/.test(lines[i])) paragraph.push(lines[i++]);
    output.push(`<p>${inline(paragraph.join(' '))}</p>`);
  }
  return {html: output.join('\n'), sections};
}

export async function renderDocumentation(page: typeof documentation[number]) {
  const text = await readFile(page.source, 'utf8'); const {html, sections} = renderMarkdown(text, page.source);
  const title = text.match(/^# (.+)/m)?.[1] ?? page.label;
  const links = documentation.map(link => `<a href="${link.path}"${link.path === page.path ? ' aria-current="page"' : ''}>${escapeHTML(link.label)}</a>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#fafaf9"><title>${escapeHTML(title)} — ${escapeHTML(brand.name)}</title>
<script src="/theme.js"></script><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/docs.css"></head>
<body class="docs"><a class="skip-link" href="#content">Skip to content</a><div class="docs-shell">
<header class="docs-header"><a class="brand" href="/">${escapeHTML(brand.name)}</a><nav aria-label="Website"><a href="/">App</a><a href="${escapeHTML(brand.repository)}">GitHub</a>
<button type="button" data-theme-choice="light" aria-label="Light mode">Light</button><button type="button" data-theme-choice="dark" aria-label="Dark mode">Dark</button></nav></header>
<div class="docs-layout"><aside class="docs-sidebar"><p>Documentation</p><nav aria-label="Documentation">${links}</nav>
<p>On this page</p><nav aria-label="On this page">${sections.map(section => `<a href="#${escapeHTML(section.id)}">${escapeHTML(section.title)}</a>`).join('')}</nav></aside>
<main id="content" class="docs-content">${html}<footer><a href="${escapeHTML(brand.repository)}/blob/main/${page.source}">View source</a></footer></main></div></div>${revisionBadge('build-version')}</body></html>`;
}
