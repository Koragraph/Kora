// What a thread was STARTED with, remembered across resumes. A Claude thread's prompt cache is keyed on its tool list,
// skills listing and system prompt, so a lever that changes them (the safe tool subset, "Lean context", the no-graph
// rulebook) may only ever apply to a thread that began with it: a resume re-sends the same options, and a live thread's
// tools never change. One tiny JSON file per thread under <KORA_HOME>/thread-flags/. Best effort: an unreadable file
// means "a legacy thread", which keeps the old behaviour.
import fs from 'node:fs';
import path from 'node:path';
import { koraHome } from '../protocol/types';

export interface ThreadFlags {
  /** started with the safe tool subset (no cron / wake-up / remote-trigger / worktree tools) */
  safeTools?: boolean;
  /** started with "Lean context" (no skills listing, no auto-memory) */
  lean?: boolean;
  /** started in a repo that was not indexed: its system prompt (frozen by the resume snapshot) says "no code graph" */
  noGraphRulebook?: boolean;
  /** an assistant/blob lane: none of Kora's code-thread prompt (fleet tool schemas, rule append, CLAUDE.md block) is in its calls */
  noKoraPrompt?: boolean;
}

const SAFE_ID = /^[A-Za-z0-9._-]{1,120}$/;
function fileFor(threadId: string, home: string): string | null { return SAFE_ID.test(threadId) ? path.join(home, 'thread-flags', `${threadId}.json`) : null; }

export function readThreadFlags(threadId: string, home: string = koraHome()): ThreadFlags {
  const f = fileFor(threadId, home); if (!f) return {};
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const out: ThreadFlags = {};
    if (j?.safeTools === true) out.safeTools = true;
    if (j?.lean === true) out.lean = true;
    if (j?.noGraphRulebook === true) out.noGraphRulebook = true;
    if (j?.noKoraPrompt === true) out.noKoraPrompt = true;
    return out;
  } catch { return {}; }
}
export function updateThreadFlags(threadId: string, patch: { [K in keyof ThreadFlags]?: ThreadFlags[K] | null }, home: string = koraHome()): void {
  const f = fileFor(threadId, home); if (!f) return;
  try {
    const next: Record<string, unknown> = { ...readThreadFlags(threadId, home) };
    for (const [k, v] of Object.entries(patch)) { if (v === null || v === undefined || v === false) delete next[k]; else next[k] = v; }
    if (!Object.keys(next).length) { fs.rmSync(f, { force: true }); return; }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(next));
  } catch { /* best effort */ }
}

/** A deleted thread's flags file goes with it. */
export function dropThreadFlags(threadId: string, home: string = koraHome()): void {
  const f = fileFor(threadId, home); if (!f) return;
  try { fs.rmSync(f, { force: true }); } catch { /* best effort */ }
}
