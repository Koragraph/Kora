// Spill-and-compress for big Bash output (overnight B16, content-aware since 2026-10-14). A command that prints a lot (a test
// run, a build log, an install) re-bills every character on every later call of the thread. output-compress.ts looks at the
// shape of the output (test runner, package-manager progress, repeated lines, escape codes) and
// removes what a reader never needs; anything unrecognised over 8,000 chars gets the old head / error lines / tail trim. The full
// text goes to a file the agent is told the path of.
//
// SHADOW by default (settings `bashTrim`): the hook only works out what a compression WOULD have saved and logs it to cost.jsonl
// (`bash-trim-shadow`, with the compressor name); the output is never touched. "On" replaces the tool output through PostToolUse
// `updatedToolOutput` (the Bash response shape {stdout, stderr, interrupted, isImage}, other fields kept). Fail open everywhere:
// any error, a timeout or a doubt returns `{}` and the original output goes through. The master plan's fact-check found a raw
// cap risky (an agent may need a line the trim dropped), which is why this ships measuring first.
import fs from 'node:fs';
import path from 'node:path';
import { koraHome } from '../protocol/types';
import { bashTrimMode, type BoundedReadsMode } from '../util/savings-settings';
import { logCost } from '../util/cost-log';
import { compressBashOutput, headTailTrim, FOOTER_RESERVE, MAX_INPUT_CHARS, TRIM_MIN_CHARS, KEEP_HEAD_LINES, KEEP_TAIL_LINES, type CompressResult, type TrimResult } from './output-compress';
import { alreadyTrimmed, wrapRunnerCommand, type WrapSpec } from './trim-wrap';

export { TRIM_MIN_CHARS, KEEP_HEAD_LINES, KEEP_TAIL_LINES, type TrimResult };
const SPILL_BUDGET_MS = 1500;

/** The old head / errors / tail trim (kept as the fallback inside compressBashOutput). Null when small or not worth it. Pure. */
export const trimBashOutput = headTailTrim;

const SAFE = /[^A-Za-z0-9._-]/g;
export function toolOutDir(threadId: string, home: string = koraHome()): string {
  const seg = threadId.replace(SAFE, '_').slice(0, 80);
  // '.' and '..' survive the character filter and would name tool-out itself / the Kora home (S6 2026-10-14).
  return path.join(home, 'tool-out', !seg || /^\.+$/.test(seg) ? 'thread' : seg);
}

/** A deleted thread's spilled Bash output goes with it. */
export function dropToolOut(threadId: string, home: string = koraHome()): void {
  try { fs.rmSync(toolOutDir(threadId, home), { recursive: true, force: true }); } catch { /* best effort */ }
}

let swept = false;
/** Spill files older than a week go (once per process, async, best effort). */
export function sweepOnce(home: string): void {
  if (swept) return;
  swept = true;
  void (async () => {
    try {
      const root = path.join(home, 'tool-out');
      const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
      for (const t of await fs.promises.readdir(root)) {
        const dir = path.join(root, t);
        let any = false;
        for (const f of await fs.promises.readdir(dir).catch(() => [] as string[])) {
          const p = path.join(dir, f);
          const st = await fs.promises.stat(p).catch(() => null);
          if (st && st.mtimeMs < cutoff) await fs.promises.rm(p, { force: true }).catch(() => {}); else any = true;
        }
        if (!any) await fs.promises.rmdir(dir).catch(() => {});
      }
    } catch { /* nothing to sweep */ }
  })();
}

async function spill(threadId: string, n: number, full: string, home: string): Promise<string | null> {
  try {
    const dir = toolOutDir(threadId, home);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${Date.now().toString(36)}-${n}.txt`);
    await fs.promises.writeFile(file, full, { mode: 0o600 });
    sweepOnce(home);
    return file;
  } catch { return null; }
}

function withBudget<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms); t.unref?.();
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(null); });
  });
}

/**
 * The line that follows a compressed output: what was done and where the full text is. `what` is the field name for the PostToolUse
 * path (stdout / stderr) and 'output' for `kora trim-run`, whose file holds stdout and stderr interleaved as they arrived.
 * `alreadyTrimmed` (trim-wrap.ts) finds the 'output' form.
 */
export function trimFooter(f: { what: string; compressor: string; note: string; rawChars: number; totalLines: number; file: string }): string {
  return `\n[Kora compressed this ${f.what} (${f.compressor}): ${f.note}. Original: ${f.rawChars} chars, ${f.totalLines} lines; the full text${f.what === 'output' ? ' (stdout and stderr in the order they arrived)' : ''} is saved at ${f.file} (Read it with offset and limit, or grep it).]`;
}

export interface BashTrimDeps {
  threadId: string;
  mode?: () => BoundedReadsMode;
  home?: string;
  /**
   * The wrapper for `kora trim-run`, or null when this session must not wrap (not "On", not Full access, no CLI to run). With it,
   * "On" also trims the output of FAILING commands: a PreToolUse rewrite runs a recognised test / build runner under the wrapper.
   */
  wrap?: () => WrapSpec | null;
  /** the transcript shows a quiet line for a trim that really happened (On only) */
  onTrimmed?: (info: { threadId: string; file: string; totalLines: number; savedTokens: number }) => void;
}

const compressField = (value: unknown, command: string | undefined): CompressResult | null => (typeof value === 'string' ? compressBashOutput(value, { command }) : null);

/**
 * Output too big for Claude Code (~30k chars) arrives here as a truncated head with `persistedOutputPath` (the CLI's copy of the
 * whole output), and the CLI shows the model only a 2 KB preview of whatever stdout ends up as while those fields stay. Found
 * live 2026-10-14: compressing the head missed the failure further down, and the CLI cut our text to its preview. So the
 * full text is read from the CLI's file and the fields are dropped from a replacement. Kept only when a shape compressor
 * makes it short: a long head / tail trim would cost more than the CLI's 2 KB preview.
 */
export const PERSISTED_MAX_CHARS = 6000;
/** What the model sees of a persisted output without us: the CLI's wrapper plus its 2 KB preview (measured 2,200 chars). */
const PERSISTED_PREVIEW_CHARS = 2200;
async function persistedText(resp: Record<string, unknown>): Promise<string | null> {
  const p = resp.persistedOutputPath;
  if (typeof p !== 'string' || !path.isAbsolute(p)) return null;
  try {
    const st = await fs.promises.stat(p);
    if (!st.isFile() || st.size > MAX_INPUT_CHARS) return null;
    return await fs.promises.readFile(p, 'utf8');
  } catch { return null; }
}

/** SDK `hooks` entries: PostToolUse on Bash. stdout and stderr are each compressed on their own; each gets its own spill file. */
export function createBashTrimHooks(deps: BashTrimDeps): Record<string, unknown> {
  const mode = deps.mode ?? (() => bashTrimMode());
  const home = deps.home ?? koraHome();
  let n = 0;
  const hook = async (input: any): Promise<Record<string, unknown>> => {
    try {
      const m = mode();
      if (m === 'off') return {};
      if (String(input?.tool_name ?? '') !== 'Bash') return {};
      const resp = input?.tool_response;
      if (!resp || typeof resp !== 'object' || typeof resp.stdout !== 'string') return {};
      if (resp.isImage === true || resp.interrupted === true || resp.backgroundTaskId) return {};
      if (alreadyTrimmed(resp.stdout)) return {}; // `kora trim-run` did it
      const command = typeof input?.tool_input?.command === 'string' ? input.tool_input.command : undefined;
      const persisted = typeof resp.persistedOutputPath === 'string' ? await withBudget(persistedText(resp), SPILL_BUDGET_MS) : null;
      if (typeof resp.persistedOutputPath === 'string' && persisted == null) return {}; // only the head is here: leave the CLI's preview
      const source = (name: 'stdout' | 'stderr'): unknown => (name === 'stdout' && persisted != null ? persisted : resp[name]);
      const fields = (['stdout', 'stderr'] as const)
        .map((name) => ({ name, raw: source(name), res: compressField(source(name), command) }))
        .filter((f): f is { name: 'stdout' | 'stderr'; raw: string; res: CompressResult } => f.res !== null)
        .filter((f) => persisted == null || f.name !== 'stdout' || (!/(^|\+)head-tail$/.test(f.res.compressor) && f.res.text.length <= PERSISTED_MAX_CHARS));
      if (!fields.length) return {};
      // "saved" is against what the model would have seen: the CLI's preview for a persisted stdout, else the raw text
      const seen = (f: { name: string; raw: string }) => (persisted != null && f.name === 'stdout' ? PERSISTED_PREVIEW_CHARS : f.raw.length);
      const bytes = fields.reduce((a, f) => a + f.raw.length, 0);
      const lines = fields.reduce((a, f) => a + f.res.totalLines, 0);
      const errors = fields.reduce((a, f) => a + f.res.keptErrorLines, 0);
      const compressor = fields.map((f) => (fields.length > 1 ? `${f.name}:${f.res.compressor}` : f.res.compressor)).join(',');
      const row = (k: 'bash-trim-shadow' | 'bash-trim', saved: number) => ({ k, ts: Date.now(), thread: deps.threadId, bytes, lines, errors, saved, c: compressor } as const);
      if (m === 'shadow') {
        logCost(row('bash-trim-shadow', Math.floor(fields.reduce((a, f) => a + Math.max(0, seen(f) - f.res.text.length), 0) / 4)), home);
        return {};
      }
      const out: Record<string, unknown> = { ...resp };
      let savedChars = 0;
      let firstFile = '';
      let firstLines = 0;
      for (const f of fields) {
        const file = await withBudget(spill(deps.threadId, ++n, f.raw, home), SPILL_BUDGET_MS);
        if (!file) continue; // could not keep the full text: do not drop it
        const footer = trimFooter({ what: f.name, compressor: f.res.compressor, note: f.res.note, rawChars: f.raw.length, totalLines: f.res.totalLines, file });
        out[f.name] = f.res.text + footer;
        savedChars += Math.max(0, seen(f) - (f.res.text.length + footer.length));
        if (!firstFile) { firstFile = file; firstLines = f.res.totalLines; }
      }
      if (!firstFile) return {};
      if (persisted != null && typeof out.stdout === 'string' && out.stdout !== resp.stdout) { delete out.persistedOutputPath; delete out.persistedOutputSize; }
      const savedTokens = Math.floor(savedChars / 4);
      logCost(row('bash-trim', savedTokens), home);
      try { deps.onTrimmed?.({ threadId: deps.threadId, file: firstFile, totalLines: firstLines, savedTokens }); } catch { /* advisory */ }
      return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: out } };
    } catch { return {}; }
  };
  // PreToolUse: a recognised test / build runner is run under `kora trim-run` ("On" + Full access only). The model's command is the one in the transcript.
  const pre = async (input: any): Promise<Record<string, unknown>> => {
    try {
      if (mode() !== 'on' || !deps.wrap) return {};
      if (String(input?.tool_name ?? '') !== 'Bash') return {};
      const ti = input?.tool_input;
      if (!ti || typeof ti.command !== 'string' || ti.run_in_background === true) return {};
      const spec = deps.wrap();
      if (!spec) return {};
      const wrapped = wrapRunnerCommand(ti.command, spec);
      if (!wrapped) return {};
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...ti, command: wrapped } } };
    } catch { return {}; }
  };
  // PostToolUseFailure cannot replace output, so a failing command that was not wrapped can only be MEASURED: what a compression would have saved.
  const failed = async (input: any): Promise<Record<string, unknown>> => {
    try {
      if (mode() === 'off') return {};
      if (String(input?.tool_name ?? '') !== 'Bash' || input?.is_interrupt === true) return {};
      const error = input?.error;
      if (typeof error !== 'string' || alreadyTrimmed(error)) return {};
      const command = typeof input?.tool_input?.command === 'string' ? input.tool_input.command : undefined;
      if (command && command.includes(' trim-run --home ')) return {};
      const res = compressBashOutput(error, { command });
      if (!res) return {};
      logCost({ k: 'bash-trim-shadow', ts: Date.now(), thread: deps.threadId, bytes: error.length, lines: res.totalLines, errors: res.keptErrorLines, saved: Math.floor(Math.max(0, error.length - res.text.length - FOOTER_RESERVE) / 4), c: `${res.compressor}@fail` }, home);
    } catch { /* advisory */ }
    return {};
  };
  return { PreToolUse: [{ matcher: 'Bash', hooks: [pre] }], PostToolUse: [{ matcher: 'Bash', hooks: [hook] }], PostToolUseFailure: [{ matcher: 'Bash', hooks: [failed] }] };
}
