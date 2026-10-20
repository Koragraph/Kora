// The dynamic swarm workflow: milestones from workers, compact progress digests for the lead, races, stall signals.
//
// Measured (bench5x T2, 2026-09-27): a lead that splits six bug reports across workers blind and then waits for final
// reports loses to Opus — cheap workers grep a 117k-line repo for 50–100 steps from a symptom, never say when they are
// lost, and the lead only hears back at the end. The fix is a real feedback loop:
//   - workers post MILESTONES as they go (reproduced / root-cause / fixed / rejected / stuck), with one shell command
//     that works for any worker program (Koragent or OpenCode): `.kora/bin/milestone <kind> "<note>"`;
//   - workers get the code graph as a command too: `.kora/bin/graph "<symbol or behaviour>"`;
//   - the lead waits for EVENTS (kora_wait mode:"event") and reads one-line digests, not screens or full reports;
//   - tasks in the same race group are cancelled as soon as one of them wins (root cause found / fix verified);
//   - a worker that has gone quiet (no milestone, no change) is flagged so the lead can kill it and respawn a sharper
//     task that carries over what was learned (kora_spawn continues:<paneId>).

import fs from 'node:fs';
import path from 'node:path';

export const MILESTONE_KINDS = ['reproduced', 'root-cause', 'fixed', 'rejected', 'stuck', 'note'] as const;
export type MilestoneKind = (typeof MILESTONE_KINDS)[number];
/** A race is won by the first task in its group that reaches one of these. */
export const RACE_WIN_KINDS: ReadonlySet<string> = new Set(['root-cause', 'fixed']);
/** Quiet this long (no milestone, no changed file) while running → flagged for the lead. */
export const QUIET_AFTER_MS = 6 * 60_000;

export interface Milestone { at: number; kind: MilestoneKind; note: string }

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Write the worker's helper commands into `<worktree>/.kora/bin/` (Kora's managed dir, never committed):
 *   milestone <kind> "<note>"   → one JSON line in the task's milestones file
 *   graph "<query>"             → the code graph's explore, against the same store the daemon indexed
 * Returns the milestones file. Never throws (a worker without helpers still runs).
 */
export function writeWorkerHelpers(input: { worktree: string; taskId: string; node: string; koraJs: string; env: Record<string, string | undefined> }): string {
  const bin = path.join(input.worktree, '.kora', 'bin');
  const file = path.join(input.worktree, '.kora', 'swarm', `${input.taskId}.milestones.jsonl`);
  try {
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(path.join(bin, 'milestone'), [
      '#!/bin/sh',
      '# Tell the lead where you are: milestone <reproduced|root-cause|fixed|rejected|stuck|note> "<what, with file:line>"',
      'kind="$1"; shift',
      `case "$kind" in ${MILESTONE_KINDS.join('|')}) ;; *) echo "usage: milestone <${MILESTONE_KINDS.join('|')}> \\"<note>\\"" >&2; exit 2;; esac`,
      `${q(input.node)} -e 'const [k,...n]=process.argv.slice(1);require("fs").appendFileSync(${JSON.stringify(file)},JSON.stringify({at:Date.now(),kind:k,note:n.join(" ").slice(0,600)})+"\\n")' "$kind" "$@"`,
      'echo "milestone recorded: $kind"',
      '',
    ].join('\n'), { mode: 0o755 });
    const envLines = Object.entries(input.env).filter(([, v]) => v).map(([k, v]) => `export ${k}=${q(v!)}`);
    fs.writeFileSync(path.join(bin, 'graph'), [
      '#!/bin/sh',
      '# The code graph: where a symbol or behaviour lives (declarations + callers + a source excerpt). Faster than grep.',
      ...envLines,
      'unset KORA_PANE_ID',
      `exec ${q(input.node)} ${q(input.koraJs)} graph explore "$*"`,
      '',
    ].join('\n'), { mode: 0o755 });
  } catch { /* helpers are an aid, never a requirement */ }
  return file;
}

/** New milestones in `file` past byte `offset`. Never throws. */
export function readMilestones(file: string, offset: number): { items: Milestone[]; offset: number } {
  try {
    const st = fs.statSync(file);
    if (st.size <= offset) return { items: [], offset };
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    const end = text.lastIndexOf('\n');
    if (end < 0) return { items: [], offset };
    const items: Milestone[] = [];
    for (const line of text.slice(0, end).split('\n')) {
      try {
        const m = JSON.parse(line);
        if (m && (MILESTONE_KINDS as readonly string[]).includes(m.kind)) items.push({ at: Number(m.at) || Date.now(), kind: m.kind, note: String(m.note ?? '').slice(0, 600) });
      } catch { /* a torn or foreign line */ }
    }
    return { items, offset: offset + Buffer.byteLength(text.slice(0, end + 1)) };
  } catch {
    return { items: [], offset };
  }
}

export interface SwarmProgress {
  paneId: string; taskId: string; title: string;
  /** starting | running | done | failed | exhausted | cancelled | … */
  phase: string;
  race: string | null;
  runningMs: number;
  milestones: Milestone[];
  changedFiles: string[];
  quiet: boolean;
  note: string | null;
}

/** Quiet = running past QUIET_AFTER_MS with no milestone and no change in the last QUIET_AFTER_MS. Pure. */
export function isQuiet(p: { phase: string; startedAt: number; milestones: Milestone[]; changedFiles: string[]; lastChangeAt?: number | null }, now = Date.now()): boolean {
  if (p.phase !== 'running' && p.phase !== 'starting') return false;
  if (now - p.startedAt < QUIET_AFTER_MS) return false;
  const lastMs = p.milestones.length ? p.milestones[p.milestones.length - 1].at : 0;
  const last = Math.max(lastMs, p.lastChangeAt ?? 0, p.changedFiles.length && !p.lastChangeAt ? now : 0);
  return now - Math.max(last, p.startedAt) >= QUIET_AFTER_MS;
}

/** One line per worker for the lead: state, time, last milestone, what changed, and the flags that need a decision. */
export function digestLine(p: SwarmProgress): string {
  const min = Math.round(p.runningMs / 60_000);
  const last = p.milestones[p.milestones.length - 1];
  const flag = p.quiet ? '  ⚠ QUIET (no milestone, no change for 6+ min: kill it or re-aim it)' : '';
  return `${p.paneId} ${p.phase} ${min}m "${p.title}"${p.race ? ` race=${p.race}` : ''}` +
    `${last ? ` | ${last.kind}: ${last.note.slice(0, 180)}` : ' | no milestone yet'}` +
    `${p.milestones.length > 1 ? ` (+${p.milestones.length - 1} earlier)` : ''}` +
    `${p.changedFiles.length ? ` | changed: ${p.changedFiles.slice(0, 4).join(', ')}${p.changedFiles.length > 4 ? ` +${p.changedFiles.length - 4}` : ''}` : ''}` +
    `${p.note ? ` | ${p.note.slice(0, 160)}` : ''}${flag}`;
}

/** What a replacement worker is told about the one it replaces (kora_spawn continues). */
export function carryOver(prev: { paneId: string; milestones: Milestone[]; changedFiles: string[]; report: string | null }): string {
  const lines = [`## What the previous worker (${prev.paneId}) already learned — do not repeat it`];
  for (const m of prev.milestones) lines.push(`- ${m.kind}: ${m.note}`);
  if (prev.changedFiles.length) lines.push(`- it had changed: ${prev.changedFiles.join(', ')} (that work is NOT in your worktree)`);
  if (prev.report?.trim()) lines.push('', 'Its report:', prev.report.trim().slice(0, 1500));
  if (lines.length === 1) lines.push('- nothing useful: it posted no milestone and changed nothing. Take a different approach.');
  return lines.join('\n');
}

/** Appended to every worker task that has helpers: how to use the graph and how to report progress. */
export const WORKER_AID = [
  '',
  '## Tools Kora gives you (run them from your working directory)',
  '- `.kora/bin/graph "<symbol or behaviour>"` — the code graph: where it lives (declarations with file:line, callers, a',
  '  source excerpt). Use it BEFORE grep or opening files; one call usually finds the spot.',
  '- `.kora/bin/milestone <kind> "<note>"` — tell the lead where you are, AS YOU GO. The lead steers from these; a',
  '  worker that stays silent looks stuck and may be replaced.',
  '  - reproduced: you reproduced the problem (name the failing test or command)',
  '  - root-cause: you found the cause (file:line + one sentence)',
  '  - fixed: the fix is in and your check passes',
  '',
  'Before you post fixed: fix the ROOT CAUSE, not one call site. Use `.kora/bin/graph` to find every other place that',
  'makes the same decision (callers, sibling checks, helpers that gate the same thing) and fix those too. Write the',
  'regression test against the behaviour the report describes (the public function or endpoint a user hits), not only',
  'the line you changed.',
  '  - rejected: the pointer or hypothesis you were given is wrong (say what you found instead)',
  '  - stuck: you cannot make progress (say exactly what blocks you)',
].join('\n');
