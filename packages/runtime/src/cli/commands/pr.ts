import type { IO } from '../main';
import { spawnSync } from 'node:child_process';

export const summary = 'Graph-verified PR check: run the cross-diff semantic gate on GitHub PRs (via gh)';
export const usage = `Usage: kora pr check  <#> [<#> …] [--base <ref>] [--json]
       kora pr verify <#> [<#> …] [--base <ref>] --post [--comment]

check   one PR  → verify its head against its base branch (catches a PR that went stale against a moved base).
        two+ PRs → verify the PR heads against EACH OTHER ("do these open PRs semantically collide?").
verify  same, and with --post writes the verdict back as a PR comment (gh pr comment). Without --post it is a
        dry run: it prints the verdict and the note "(dry-run; pass --post to comment)" and writes nothing.

Requires the GitHub CLI (gh) authenticated for this repo. Exit codes match kora merge: 0 clean · 3 semantic · 4 needs-human.`;

interface Pair { a: string; b: string; status: 'clean' | 'semantic' | 'needs-human'; reason?: string; blame?: { file: string; line: number; symbol: string; byWorker: string; kind?: 'dependent' | 'reference'; inHunk?: boolean; removed?: boolean }[] }
interface Report { pairs: Pair[]; order: string[]; base: string; refs: string[] }
const GLYPH = { clean: '✓', semantic: '■', 'needs-human': '?' } as const;

function gh(args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() };
}
function git(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: String(r.stdout || '').trim() };
}

function markdown(r: Report): string {
  const lines = ['**kora graph-verified merge check**', '', `base \`${r.base.slice(0, 12)}\` · refs: ${r.refs.map((x) => `\`${x}\``).join(', ')}`, ''];
  for (const p of r.pairs) {
    lines.push(`- ${GLYPH[p.status]} \`${p.a}\` × \`${p.b}\` — **${p.status}**`);
    for (const b of p.blame ?? []) lines.push(`    - \`${b.file}:${b.line}\` \`${b.symbol}\`${b.removed ? ' (removed' : ' (changed'} by ${b.byWorker}${b.kind === 'reference' ? '; new reference' : ''}${b.inHunk ? '; edited line' : ''})`);
  }
  const bad = r.pairs.filter((p) => p.status !== 'clean').length;
  lines.push('', bad ? `⚠ ${bad} pair(s) need attention — git would merge these clean; the code graph found a cross-diff coupling.` : '✓ No cross-diff semantic conflicts.');
  return lines.join('\n');
}
function renderText(io: IO, r: Report) {
  io.out(`base ${r.base ? r.base.slice(0, 12) : '(unknown)'}   refs: ${r.refs.join(', ')}\n`);
  for (const p of r.pairs) { io.out(`  ${GLYPH[p.status]} ${p.a} × ${p.b}  ${p.status}${p.reason ? `  — ${p.reason}` : ''}\n`); for (const b of p.blame ?? []) io.out(`      ${b.file}:${b.line}  ${b.symbol}  (${b.removed ? 'removed' : 'changed'} by ${b.byWorker}${b.kind === 'reference' ? ', new reference' : ''}${b.inHunk ? ', edited line' : ''})\n`); }
}
function exitFor(r: Report): number { if (r.pairs.some((p) => p.status === 'semantic')) return 3; if (r.pairs.some((p) => p.status === 'needs-human')) return 4; return 0; }

export async function run(argv: string[], io: IO): Promise<number> {
  const { callOnce } = require('../../protocol/client');
  const verb = argv[0];
  const get = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const flagVals = new Set(['--base']);
  const nums: number[] = [];
  for (let i = 1; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { if (flagVals.has(a)) i++; continue; } const n = Number(a.replace(/^#/, '')); if (Number.isInteger(n)) nums.push(n); }

  if (!verb || !['check', 'verify'].includes(verb) || nums.length < 1) { io.err(usage + '\n'); return 2; }
  if (!gh(['--version']).ok) { io.err('kora pr: GitHub CLI (gh) not found on PATH. Install gh and `gh auth login`.\n'); return 1; }

  // Resolve each PR and fetch its head into a stable local ref so the engine can materialize it.
  const localRefs: string[] = [];
  let baseBranch: string | undefined = get('--base');
  for (const n of nums) {
    const view = gh(['pr', 'view', String(n), '--json', 'headRefName,baseRefName,headRefOid']);
    if (!view.ok) { io.err(`kora pr: cannot read PR #${n}: ${view.err || 'gh pr view failed'}\n`); return 1; }
    let head: { headRefName: string; baseRefName: string; headRefOid: string };
    try { head = JSON.parse(view.out); } catch { io.err(`kora pr: unexpected gh output for #${n}\n`); return 1; }
    const local = `kora-pr-${n}`;
    const fetch = git(['fetch', 'origin', `pull/${n}/head:${local}`, '--force']);
    if (!fetch.ok) { io.err(`kora pr: could not fetch head of #${n} (git fetch origin pull/${n}/head).\n`); return 1; }
    localRefs.push(local);
    if (!baseBranch) baseBranch = head.baseRefName;
  }

  // One PR → [head, base branch] from their fork point (did the base move under the PR?); two+ PRs → the heads
  // against each other, each diffed from its own merge-base with the base branch they all target.
  const refs = localRefs.length === 1 ? [localRefs[0], `origin/${baseBranch}`] : localRefs;
  const targetRef = localRefs.length === 1 ? undefined : `origin/${baseBranch}`;

  let report: Report;
  try { report = await callOnce('merge.verify', { cwd: process.cwd(), refs, targetRef }); }
  catch (e: any) { io.err(`kora pr: ${e.message}\n`); return 1; }

  if (flags.has('--json')) { io.out(JSON.stringify(report, null, 2) + '\n'); return exitFor(report); }
  renderText(io, report);
  const code = exitFor(report);

  if (verb === 'verify') {
    if (!flags.has('--post')) { io.out('\n(dry-run; pass --post to comment on the PR)\n'); return code; }
    // Posting is a side effect — only reached with an explicit --post.
    const body = markdown(report);
    const target = nums[0];
    const post = flags.has('--comment') || true; // comment is the only post mode for now
    if (post) {
      const c = gh(['pr', 'comment', String(target), '--body', body]);
      if (!c.ok) { io.err(`kora pr: failed to post comment on #${target}: ${c.err}\n`); return 1; }
      io.out(`\nposted verdict to PR #${target}.\n`);
    }
  }
  return code;
}
