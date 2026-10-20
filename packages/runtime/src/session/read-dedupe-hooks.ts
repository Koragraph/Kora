// Read dedupe for the in-process chat lane (SAV-D, 2026-10-15). The pane hooks (cli/commands/hook.ts) remember every Read of a pane
// session in a tmp file; the chat lane's hooks run inside the daemon, so the log lives in this closure, one per SDK session.
//
// Measured 2026-10-15 (Haiku 5.5, SDK chat lane, docs/savings-2026-10-15/savd.md): an identical re-read of an unchanged file comes back
// in FULL (no native stub) here, and "deny" makes the model simply re-issue the Read (+1 call, +21..29% $), so deny is a measured loss.
// Modes (settings `chatReadDedupe`, shipped shadow; "nudge" is untested live):
//   shadow  decide and log (cost.jsonl `read-dedupe-shadow`), change nothing
//   nudge   PreToolUse additionalContext on the Read: "already in context, unchanged since turn N"
//   deny    the FIRST unchanged re-read inside this context segment is refused with the same sentence; the second attempt always goes through
// Never denied: a changed file (it gets the changed line ranges as context instead), a range the earlier Read did not include, any Read
// after a compaction (the log is dropped on PreCompact / PostCompact, and a resumed session starts with an empty log), a file Read
// only partially (a truncated view is recorded with the lines it really showed). Fail open everywhere.
import { chatReadDedupeMode, type ChatReadDedupeMode } from '../util/savings-settings';
import { logCost } from '../util/cost-log';
import { koraHome } from '../protocol/types';
import { dedupeNotice, recordFor, unchangedReread, type ReadLog, type ReadRecord } from '../ledger/read-dedupe';
import { pathTail } from '../util/os-roots';
import fs from 'node:fs';
import path from 'node:path';

export interface ReadDedupeDeps {
  threadId: string;
  mode?: () => ChatReadDedupeMode;
  home?: string;
  /** the session's working directory, for a relative file_path */
  cwd?: string;
}

const abs = (fp: string, cwd?: string): string => (path.isAbsolute(fp) ? fp : path.resolve(cwd || process.cwd(), fp));

export function createReadDedupeHooks(deps: ReadDedupeDeps): Record<string, unknown> {
  const mode = deps.mode ?? (() => chatReadDedupeMode());
  const home = deps.home ?? koraHome();
  let log: ReadLog = {};
  // Reads of the batch in flight: the model only has their text after the whole batch (parallel tool calls) is answered, so a Read
  // issued in the same batch is not a re-read. PostToolBatch commits them to the log.
  const pending: Array<[string, ReadRecord]> = [];
  const refused = new Set<string>();
  let reads = 0;
  const reset = async (): Promise<Record<string, unknown>> => { log = {}; pending.length = 0; refused.clear(); return {}; };
  const commit = async (): Promise<Record<string, unknown>> => { for (const [k, v] of pending) log[k] = v; pending.length = 0; return {}; };

  const pre = async (input: any): Promise<Record<string, unknown>> => {
    try {
      const m = mode();
      if (m === 'off' || String(input?.tool_name ?? '') !== 'Read') return {};
      const ti = input?.tool_input ?? {};
      if (typeof ti.file_path !== 'string' || !ti.file_path) return {};
      if (ti.pages != null) return {}; // a PDF page range
      const fp = abs(ti.file_path, input?.cwd ?? deps.cwd);
      const notice = dedupeNotice(fp, ti, log);
      if (!notice) return {};
      const unchanged = unchangedReread(fp, ti, log) !== null;
      if (unchanged && m === 'deny' && refused.has(fp)) { refused.delete(fp); return {}; } // the agent asked again: it goes through, quietly
      const action = unchanged ? (m === 'deny' ? 'deny' : 'nudge') : 'changed';
      let size = 0; try { size = fs.statSync(fp).size; } catch { /* gone */ }
      const lim = Number(ti.limit);
      const tokens = Math.round((Number.isFinite(lim) && ti.limit != null ? Math.min(size, lim * 60) : size) / 4);
      const row = (k: 'read-dedupe' | 'read-dedupe-shadow') => logCost({ k, ts: Date.now(), thread: deps.threadId, file: pathTail(fp, 2) || fp, action, tokens }, home);
      if (m === 'shadow') { row('read-dedupe-shadow'); return {}; }
      if (action === 'deny') {
        refused.add(fp);
        row('read-dedupe');
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `${notice} (This Read was skipped to save context. If you really need the text again, repeat the same Read and it will go through.)` } };
      }
      refused.delete(fp);
      row('read-dedupe');
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: notice } };
    } catch { return {}; }
  };

  const post = async (input: any): Promise<Record<string, unknown>> => {
    try {
      if (mode() === 'off' || String(input?.tool_name ?? '') !== 'Read') return {};
      const ti = input?.tool_input ?? {};
      const f = input?.tool_response?.file;
      if (typeof ti.file_path !== 'string' || !f || typeof f !== 'object' || typeof f.content !== 'string') return {}; // image, PDF, notebook, stub: nothing to remember
      const fp = abs(ti.file_path, input?.cwd ?? deps.cwd);
      const rec = recordFor(fp, ti, ++reads);
      if (!rec) return {};
      // what the Read really showed: a long file's whole-file Read is cut to its first lines
      const shown = Number(f.numLines), start = Number(f.startLine), total = Number(f.totalLines);
      if (Number.isFinite(shown) && Number.isFinite(start) && Number.isFinite(total) && shown < total) { rec.offset = start; rec.limit = shown; }
      pending.push([fp, rec]);
      refused.delete(fp);
    } catch { /* advisory */ }
    return {};
  };

  return {
    PreToolUse: [{ matcher: 'Read', hooks: [pre] }],
    PostToolUse: [{ matcher: 'Read', hooks: [post] }],
    PostToolBatch: [{ hooks: [commit] }],
    // After a compaction the earlier Reads are gone from the model's context: forget them
    PreCompact: [{ hooks: [reset] }],
    PostCompact: [{ hooks: [reset] }],
  };
}
