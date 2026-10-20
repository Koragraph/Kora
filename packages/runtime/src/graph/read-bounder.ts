// The in-process half of the bounded Read (graph/read-window.ts has the decision): the SDK PreToolUse / PostToolUse
// hooks the ClaudeDriver installs next to the guard hooks, plus the per-thread state they share with `sendTurn`
// (new prompt, this turn's injection). The per-call `kora hook pre-tool` process does the same for panes
// (cli/commands/hook.ts); a chat session sets KORA_INJECT_OWNER=driver so only ONE of the two ever runs.
//
// Fail open, always: every path returns `{}` (the original input goes through) on a timeout, an error, an unindexed
// repository or any doubt. Nothing here may delay a tool call by more than BOUND_BUDGET_MS.
import fs from 'node:fs';
import path from 'node:path';
import {
  decideRead, isGraphLookupCommand, newReadWindowState, noteExplore, noteFileTouched, noteInjection, noteOtherAccess, startTurn, toolResponseText,
  type BoundRecord, type ReadIO, type ReadWindowState,
} from './read-window';
import { boundedReadsMode, type BoundedReadsMode } from '../util/savings-settings';
import { logCost } from '../util/cost-log';

/** The whole decision (status + outline + file read) gets this long; past it the Read goes through untouched. */
export const BOUND_BUDGET_MS = 1000;
/** A source file bigger than this is not line-counted (a generated bundle): its Read passes through. */
export const BOUND_MAX_FILE_BYTES = 4 * 1024 * 1024;
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export interface ReadBounderDeps {
  cwd: string;
  threadId: string;
  graphStatus?: (cwd: string) => Promise<{ indexed: boolean; incomplete?: boolean }>;
  graphCall?: (name: string, args: Record<string, unknown>, opts: { cwd: string; fresh?: boolean }) => Promise<{ text: string }>;
  /** true for keys / credentials (sensitive-guard); injected so this file stays free of the guard's imports */
  sensitive?: (toolName: string, input: Record<string, unknown>, cwd: string) => boolean;
  mode?: () => BoundedReadsMode;
  now?: () => number;
}

export function withBudget<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms); t.unref?.();
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(null); });
  });
}

/** Line and byte count of a file, async, off the event loop; null when unreadable or too big. */
export async function statLines(abs: string): Promise<{ lines: number; bytes: number } | null> {
  try {
    const st = await fs.promises.stat(abs);
    if (!st.isFile() || st.size > BOUND_MAX_FILE_BYTES) return null;
    const buf = await fs.promises.readFile(abs);
    let lines = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) lines++;
    if (buf.length && buf[buf.length - 1] !== 10) lines++;
    return { lines, bytes: buf.length };
  } catch { return null; }
}

export interface ReadBounder {
  state: ReadWindowState;
  /** SDK `hooks` option entries (event -> matcher entries) to merge next to the guard hooks. */
  hooks(): Record<string, unknown>;
  /** A real user prompt starts a turn. */
  beginTurn(prompt: string): void;
  /** The declarations the injection handed the agent this turn. */
  noteInjection(text: string | null | undefined): void;
  /** The bounded record for a tool_use id, if that Read was bounded (the transcript card shows the chip). */
  boundedFor(toolUseId: string): BoundRecord | undefined;
}

export function createReadBounder(deps: ReadBounderDeps): ReadBounder {
  const state = newReadWindowState();
  const byTool = new Map<string, BoundRecord>();
  const mode = deps.mode ?? (() => boundedReadsMode());
  const now = deps.now ?? Date.now;
  let statusCache: { at: number; indexed: boolean } | null = null;

  const io = (cwd: string): ReadIO => ({
    stat: statLines,
    indexed: async () => {
      if (statusCache && now() - statusCache.at < 5000) return statusCache.indexed;
      if (!deps.graphStatus) return false;
      const st = await withBudget(deps.graphStatus(cwd), 700);
      const indexed = !!st && st.indexed === true && !(st as any).incomplete;
      statusCache = { at: now(), indexed };
      return indexed;
    },
    outline: async (rel) => {
      if (!deps.graphCall) return null;
      const r = await withBudget(deps.graphCall('file_symbols', { path: rel }, { cwd, fresh: false }), 700);
      return r?.text ?? null;
    },
    sensitive: (input) => { try { return deps.sensitive ? deps.sensitive('Read', input, cwd) : false; } catch { return true; } },
  });

  const pre = async (input: any, toolUseId?: string): Promise<Record<string, unknown>> => {
    try {
      const name = String(input?.tool_name ?? '');
      const toolInput = (input?.tool_input ?? {}) as Record<string, unknown>;
      const cwd = String(input?.cwd || deps.cwd);
      if (FILE_TOOLS.has(name)) {
        const fp = String(toolInput.file_path ?? toolInput.notebook_path ?? '');
        if (fp) noteFileTouched(state, path.resolve(cwd, fp));
        return {};
      }
      if (name !== 'Read') return {};
      const m = mode();
      if (m === 'off') return {};
      const out = await withBudget(decideRead(state, toolInput, cwd, io(cwd), { mode: m === 'shadow' ? 'shadow' : 'on' }), BOUND_BUDGET_MS);
      if (!out) return {};
      const rel = (p: string) => path.relative(cwd, p).split(path.sep).join('/');
      if (out.expanded) logCost({ k: 'read-expand', ts: now(), thread: deps.threadId, file: rel(out.expanded.path) });
      if (out.shadowRecord) {
        const r = out.shadowRecord;
        logCost({ k: 'read-shadow', ts: now(), thread: deps.threadId, file: rel(r.path), offset: r.offset, limit: r.limit, total: r.total, source: r.source, avoided: r.avoidedTokens });
        return {};
      }
      if (!out.bound) return {};
      const b = out.bound;
      const id = String(toolUseId ?? input?.tool_use_id ?? '');
      if (id) { byTool.set(id, b.record); if (byTool.size > 200) byTool.delete(byTool.keys().next().value as string); }
      logCost({ k: 'read-bound', ts: now(), thread: deps.threadId, file: rel(b.record.path), offset: b.record.offset, limit: b.record.limit, total: b.record.total, source: b.record.source, avoided: b.avoidedTokens });
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: b.updatedInput, additionalContext: b.additionalContext } };
    } catch { return {}; }
  };

  const post = async (input: any): Promise<Record<string, unknown>> => {
    try {
      const name = String(input?.tool_name ?? '');
      if (name === 'Bash' || name === 'Grep') {
        // a bounded file printed by a shell command or a content Grep: the agent paid for it after all (no credit)
        const cwd = String(input?.cwd || deps.cwd);
        for (const b of noteOtherAccess(state, name, (input?.tool_input ?? {}) as Record<string, unknown>, cwd)) logCost({ k: 'read-expand', ts: now(), thread: deps.threadId, file: path.relative(cwd, b.path).split(path.sep).join('/') });
        if (name === 'Grep') return {};
      }
      const isLookup = name === 'Bash' ? isGraphLookupCommand(input?.tool_input?.command) : /^mcp__kora(?:graph)?__(explore|search_code)$/.test(name);
      if (isLookup) noteExplore(state, toolResponseText(input?.tool_response));
    } catch { /* hints are optional */ }
    return {};
  };

  return {
    state,
    hooks: () => ({
      PreToolUse: [{ matcher: 'Read|Edit|Write|MultiEdit|NotebookEdit', hooks: [(input: any, toolUseId?: string) => pre(input, toolUseId)] }],
      PostToolUse: [{ matcher: 'Bash|Grep|mcp__kora.*', hooks: [(input: any) => post(input)] }],
    }),
    beginTurn: (prompt) => startTurn(state, prompt),
    noteInjection: (text) => noteInjection(state, text),
    boundedFor: (id) => byTool.get(id),
  };
}
