// The desktop-chat lane's sessions for `kora savings`. Panes register their transcript with the ledger; the SDK chat lane
// (threads in <KORA_HOME>/chat) never does, so `kora savings` said "No agent transcripts attached yet" after a day of chats.
// Measured only: the same transcript numbers a pane gets, read from the Claude session each thread resumes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTranscript, summarize, type LedgerSummary } from './transcript';
import { ChatThreadStore } from '../session/store';

export interface ChatSessionRow { paneId: string; title: string; summary: LedgerSummary }

const slug = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-');

function transcriptFor(cwd: string, sessionId: string, configDir: string): string | null {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(sessionId)) return null;
  const base = path.join(configDir, 'projects');
  const cands = [cwd]; try { cands.push(fs.realpathSync(cwd)); } catch { /* gone */ }
  for (const c of cands) { const f = path.join(base, slug(c), `${sessionId}.jsonl`); if (fs.existsSync(f)) return f; }
  return null;
}

/** Summaries for the most recently active Claude chat threads (default 30), newest first. Never throws. */
export function chatSessionRows(opts: { store?: ChatThreadStore; limit?: number; configDir?: string } = {}): ChatSessionRow[] {
  const out: ChatSessionRow[] = [];
  try {
    const store = opts.store ?? new ChatThreadStore();
    const configDir = opts.configDir ?? (process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude'));
    const threads = store.list().filter((t) => t.agent === 'claude' && typeof store.tryGet(t.id)?.resume === 'string').sort((a, b) => b.updatedAt - a.updatedAt);
    for (const t of threads) {
      if (out.length >= (opts.limit ?? 30)) break;
      const f = transcriptFor(t.cwd, String(store.tryGet(t.id)!.resume), configDir);
      if (!f) continue;
      try { const summary = summarize(parseTranscript(f)); if (summary.apiCalls > 0) out.push({ paneId: `chat:${t.id.slice(-8)}`, title: t.title, summary }); } catch { /* unreadable transcript */ }
    }
  } catch { /* no chat store */ }
  return out;
}
