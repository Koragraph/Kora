// Shared shape of a per-agent enforcement adapter.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AgentId } from '../../protocol/types';
import type { AdapterResult, PrepareInput } from '../index';
import { rulebook, rulebookNoGraph } from '../../graph/howto';

export interface AdapterCtx {
  root: string;              // repo root (or cwd when not a git checkout)
  brief: string | null;      // cached session brief for this root, or null when not computed yet
  binPath: string;           // absolute path to bin/kora.js
  nodeBin: string;           // absolute path to the node binary running kora
  create: boolean;           // create the instruction file when absent
  /** False when the repo has no code graph yet (the rulebook then says so instead of promising one); undefined = not known */
  indexed?: boolean;
  readOnly?: boolean;        // prepare() must write nothing into the repo (an untrusted folder: the rulebook rides as a system prompt)
  replaceKoragraphHooks?: boolean;
}

export interface PrepareDelta { args: string[]; env: Record<string, string>; notes: string[] }

export interface Adapter {
  id: AgentId;
  /** executable to probe with `which` to decide whether this agent is installed */
  bin: string | null;
  /** true when prepare() embeds the session brief in the managed block (worth waiting for it) */
  needsBrief: boolean;
  install(ctx: AdapterCtx): AdapterResult[];
  uninstall(ctx: AdapterCtx): AdapterResult[];
  status(ctx: AdapterCtx): AdapterResult[];
  prepare(input: PrepareInput, ctx: AdapterCtx): PrepareDelta;
}

export const BLOCK_MAX = 3000;

/** Managed-block body: the rulebook, plus the session brief for agents with no hook channel. */
/**
 * Agents with no ranged Read tool (Codex, Gemini/Antigravity, generic AGENTS.md readers) open code with shell `cat`/`sed`
 * or a whole-file viewer. The rulebook's "Read with offset/limit" does not tell them how, so they get the shell form.
 * One short line: the whole file is written into the prompt cache once and re-billed on every later call.
 */
export const SHELL_READ_LINE = 'Reading code: never `cat` or open a source file over ~300 lines whole. Take the line range from the graph (file:line) or `rg -n`, then `sed -n \'START,ENDp\' file`; every line you print is re-billed on every later call.';

export function blockBody(ctx: AdapterCtx, withBrief: boolean, opts: { shell?: boolean } = {}): string {
  const base = ctx.indexed === false ? rulebookNoGraph() : rulebook();
  const head = opts.shell ? `${base}\n${SHELL_READ_LINE}` : base;
  if (!withBrief || !ctx.brief) return head;
  const room = BLOCK_MAX - head.length - 2;
  if (room < 200) return head;
  const brief = ctx.brief.length > room ? `${ctx.brief.slice(0, room - 1)}…` : ctx.brief;
  return `${head}\n\n${brief}`;
}

/**
 * The block for an instruction file that also carries the session brief (Codex / Gemini / OpenCode / Cursor / generic
 * AGENTS.md: no session hook, so the brief travels in the file). The brief (node counts, a STALE line, open loops)
 * changes every session, and auto-setup refreshes every repo under the trusted roots at each daemon start: in a file
 * the repo TRACKS that was a git change after every start, for users who never ran those agents. A tracked file gets
 * the stable rulebook only (the agents still get graph declarations per prompt through their injection lanes).
 */
export function briefBlockBody(ctx: AdapterCtx, file: string, opts: { shell?: boolean } = {}): string {
  return blockBody(ctx, !isTrackedInGit(file), opts);
}

const trackedMemo = new Map<string, { at: number; tracked: boolean }>();
/** Is `file` in its repo's git index? Memoized 5 min per path (prepare runs per session; this is a git call). */
export function isTrackedInGit(file: string): boolean {
  const hit = trackedMemo.get(file);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.tracked;
  let tracked = false;
  try {
    // A file that does not exist yet will be created by Kora and kept out of git (excludeCreatedFile): no git call.
    if (!fs.existsSync(file)) return false;
    const r = spawnSync('git', ['-C', path.dirname(file), 'ls-files', '--error-unmatch', '--', path.basename(file)], {
      timeout: 2000,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    tracked = r.status === 0;
  } catch {
    tracked = false;
  }
  if (trackedMemo.size > 500) trackedMemo.clear();
  trackedMemo.set(file, { at: Date.now(), tracked });
  return tracked;
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.some((a) => a === flag || a.startsWith(`${flag}=`));
}
