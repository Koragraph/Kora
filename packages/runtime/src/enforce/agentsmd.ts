// The managed instruction block: an idempotent region between markers inside whatever file the
// agent already loads unconditionally (AGENTS.md, CLAUDE.md, GEMINI.md, .cursor/rules/*.mdc).
// Only the region between the markers is ever touched; the developer's own content survives.
import { koraHome } from '../protocol/types';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../util/atomic-write';
import type { AdapterResult } from './index';
import { unsafeRepoWrite } from '../util/safe-path';

export const BEGIN = '<!-- kora:begin -->';
export const END = '<!-- kora:end -->';
// A block is a BEGIN followed by its END with no other BEGIN in between: a BEGIN whose END the user deleted is left as
// their text (the old pattern matched from that orphan BEGIN across the user's notes to our next END and replaced them).
const BLOCK_RE = /<!-- kora:begin -->(?:(?!<!-- kora:begin -->)[\s\S])*?<!-- kora:end -->\n?/;
const BLOCK_RE_ALL = new RegExp(BLOCK_RE.source, 'g');

/**
 * A file Kora CREATED only to hold its block (a repo had no CLAUDE.md / AGENTS.md) goes into the repo's
 * .git/info/exclude, so a `git add -A` never commits Kora's rulebook into the user's project. Never for a file the
 * user already had (they chose to track it). Best effort: not a git repo, or git missing, changes nothing.
 */
export function excludeCreatedFile(file: string): void {
  try {
    // Worker worktrees (<KORA_HOME>/worktrees) are created per spawn, under load: no sync git there, and the merge
    // already leaves Kora's untracked files behind.
    const home = koraHome();
    if (path.resolve(file).startsWith(path.join(home, 'worktrees') + path.sep)) return;
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const r = spawnSync('git', ['-C', path.dirname(file), 'rev-parse', '--show-toplevel', '--git-path', 'info/exclude'], { encoding: 'utf8', timeout: 2000 });
    if (r.status !== 0) return;
    const [top, excl] = r.stdout.trim().split('\n');
    if (!top || !excl) return;
    // git answers with the real path (/private/tmp on macOS for /tmp).
    const rel = path.relative(fs.realpathSync(top), path.join(fs.realpathSync(path.dirname(file)), path.basename(file))).split(path.sep).join('/');
    if (!rel || rel.startsWith('..')) return;
    const exclude = path.resolve(path.dirname(file), excl);
    let cur = ''; try { cur = fs.readFileSync(exclude, 'utf8'); } catch { cur = ''; }
    const line = `/${rel}`;
    if (cur.split('\n').some((l) => l.trim() === line)) return;
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `${cur.endsWith('\n') || !cur ? '' : '\n'}# kora: created to hold its rulebook (delete this line to commit the file)\n${line}\n`);
  } catch { /* fine */ }
}

export function renderBlock(body: string): string {
  return `${BEGIN}\n${body.trim()}\n${END}\n`;
}

export function hasBlock(file: string): boolean {
  try { return BLOCK_RE.test(fs.readFileSync(file, 'utf8')); } catch { return false; }
}

/** Write/refresh the block in `file`. `frontmatter` is prepended only when the file is created. */
export function upsertBlock(file: string, body: string, opts: { create?: boolean; frontmatter?: string; agent?: string; root?: string } = {}): AdapterResult {
  const create = opts.create !== false;
  const agent = opts.agent || 'generic';
  // A repo can commit CLAUDE.md / AGENTS.md (or .cursor/) as a symlink to ~/.zshrc or anywhere else: never write through it.
  const unsafe = unsafeRepoWrite(file, opts.root);
  if (unsafe) return { agent, action: 'skipped', file, detail: unsafe };
  let existing: string | null = null;
  try { existing = fs.readFileSync(file, 'utf8'); } catch { existing = null; }
  const block = renderBlock(body);
  if (existing == null) {
    if (!create) return { agent, action: 'absent', file, detail: 'file does not exist and --no-create was given' };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, `${opts.frontmatter || ''}${block}`);
    excludeCreatedFile(file);
    return { agent, action: 'installed', file, detail: 'created with managed block' };
  }
  let next: string;
  if (BLOCK_RE.test(existing)) {
    // One block: the first copy is refreshed in place, any later copy (a merge that kept both sides) is dropped.
    let first = true;
    next = existing.replace(BLOCK_RE_ALL, () => { if (first) { first = false; return block; } return ''; });
    if (next === existing) return { agent, action: 'managed', file, detail: 'managed block up to date' };
    writeFileAtomic(file, next);
    return { agent, action: 'refreshed', file, detail: 'managed block refreshed in place' };
  }
  next = `${existing.replace(/\s*$/, '')}\n\n${block}`;
  writeFileAtomic(file, next);
  return { agent, action: 'installed', file, detail: 'managed block appended' };
}

export function removeBlock(file: string, agent = 'generic', root?: string): AdapterResult {
  const unsafe = unsafeRepoWrite(file, root);
  if (unsafe) return { agent, action: 'skipped', file, detail: unsafe };
  let existing: string | null = null;
  try { existing = fs.readFileSync(file, 'utf8'); } catch { return { agent, action: 'absent', file }; }
  if (!BLOCK_RE.test(existing)) return { agent, action: 'absent', file, detail: 'no managed block' };
  const stripped = existing.replace(BLOCK_RE_ALL, '').replace(/\n{3,}$/, '\n\n');
  // A file that was nothing but our block (plus optional frontmatter we wrote) is removed outright.
  if (stripped.replace(/^---[\s\S]*?---\s*/, '').trim() === '') {
    fs.rmSync(file);
    return { agent, action: 'removed', file, detail: 'file removed (held only the managed block)' };
  }
  writeFileAtomic(file, stripped);
  return { agent, action: 'removed', file, detail: 'managed block removed' };
}

export function blockStatus(file: string, agent = 'generic'): AdapterResult {
  return hasBlock(file) ? { agent, action: 'managed', file } : { agent, action: 'absent', file };
}
