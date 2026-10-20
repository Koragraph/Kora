// The "start a fresh thread with a brief" chip (overnight B5): a short hand-over of a long thread, so the next one starts at
// ~1k tokens instead of dragging 100k+. The model never sees the transcript: a pure digest (every user prompt, the closing
// words of each turn, the files changed, what failed) is built locally, and a side session (side-session.ts: Haiku, no
// tools) turns it into a brief of at most 300 words. If the side session fails, the digest itself is the brief.
import fs from 'node:fs';
import { sideQuery, type SideQueryFn } from './side-session';
import { locateTranscript } from './prune';

type Entry = Record<string, any>;
const clip = (s: string, n: number): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 3)}...` : t; };

function promptText(e: Entry): string | null {
  if (e.type !== 'user' || e.isSidechain || e.isMeta || e.isCompactSummary) return null;
  const c = e.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && !c.some((b: any) => b?.type === 'tool_result')) return c.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text ?? '')).join('\n') || null;
  return null;
}

export interface ThreadDigest { prompts: string[]; closings: string[]; filesChanged: string[]; failures: string[]; turns: number }

/** The facts of a transcript that a hand-over needs - cheap to compute, a few thousand tokens at most. */
export function digestTranscript(text: string): ThreadDigest {
  const d: ThreadDigest = { prompts: [], closings: [], filesChanged: [], failures: [], turns: 0 };
  const files = new Set<string>();
  const uses = new Map<string, { name: string; input: any }>();
  let lastAssistantText = '';
  const flush = () => { if (lastAssistantText) d.closings.push(clip(lastAssistantText, 500)); lastAssistantText = ''; };
  for (const line of text.split('\n')) {
    if (!line) continue;
    let e: Entry; try { e = JSON.parse(line); } catch { continue; }
    if (e.isSidechain) continue;
    const p = promptText(e);
    if (p !== null) { if (d.turns > 0) flush(); d.turns++; d.prompts.push(clip(p, 400)); continue; }
    if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) {
        if (b?.type === 'text' && String(b.text ?? '').trim()) lastAssistantText = String(b.text);
        if (b?.type === 'tool_use' && b.id) {
          uses.set(String(b.id), { name: String(b.name ?? ''), input: b.input });
          if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(String(b.name)) && typeof b.input?.file_path === 'string') files.add(b.input.file_path);
        }
      }
    } else if (e.type === 'user' && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) {
        if (b?.type === 'tool_result' && b.is_error === true) {
          const u = uses.get(String(b.tool_use_id));
          const what = u?.name === 'Bash' ? `\`${clip(String(u.input?.command ?? ''), 80)}\`` : u?.name ?? 'a tool';
          const f = `${what} failed`;
          if (!d.failures.includes(f) && d.failures.length < 8) d.failures.push(f);
        }
      }
    }
  }
  flush();
  d.filesChanged = [...files].slice(-30);
  return d;
}

/** The digest as plain text (what the side session is given, and the fallback brief). Bounded. */
export function renderDigest(d: ThreadDigest, maxPrompts = 14): string {
  const prompts = d.prompts.slice(-maxPrompts); const closings = d.closings.slice(-maxPrompts);
  const out: string[] = [`The thread had ${d.turns} request${d.turns === 1 ? '' : 's'}. Recent requests, oldest first:`];
  prompts.forEach((p, i) => out.push(`${i + 1}. ${p}`));
  if (closings.length) { out.push('', 'How the latest turns ended:'); closings.slice(-4).forEach((c) => out.push(`- ${c}`)); }
  if (d.filesChanged.length) out.push('', `Files changed: ${d.filesChanged.join(', ')}`);
  if (d.failures.length) out.push('', `Things that failed: ${d.failures.join('; ')}`);
  return out.join('\n');
}

export const BRIEF_SYSTEM = 'You write hand-over briefs so a new coding-agent thread can continue work started in another one.\nWrite at most 300 words with these headings: Goal, Files, Decisions, Next step. Use only the facts given. No preamble.';

export interface BriefResult { brief: string; source: 'side-session' | 'digest'; digestTokens: number }

export async function draftBrief(a: { transcript: string; accountEnv?: Record<string, string>; cwd?: string; queryFn?: SideQueryFn; timeoutMs?: number }): Promise<BriefResult> {
  const d = digestTranscript(a.transcript);
  const digest = renderDigest(d);
  const digestTokens = Math.ceil(digest.length / 4);
  const reply = await sideQuery({ system: BRIEF_SYSTEM, prompt: `Write the brief from this digest of the earlier thread.\n\n${digest}`, ...(a.accountEnv ? { accountEnv: a.accountEnv } : {}), ...(a.cwd ? { cwd: a.cwd } : {}), ...(a.queryFn ? { queryFn: a.queryFn } : {}), ...(a.timeoutMs ? { timeoutMs: a.timeoutMs } : {}) });
  if (reply && reply.split(/\s+/).length <= 450) return { brief: reply, source: 'side-session', digestTokens };
  return { brief: `Context from an earlier thread (summary built locally):\n\n${digest}`, source: 'digest', digestTokens };
}

/** The digest keeps only the last prompts, closings and changed files, so a transcript is read from its tail: a 200 MB one must not sit on the daemon's event loop (S6 2026-10-14). */
export const BRIEF_MAX_BYTES = 12 * 1024 * 1024;
export async function readTail(file: string, max: number): Promise<string> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    if (size <= max) return await fh.readFile('utf8');
    const buf = Buffer.alloc(max);
    await fh.read(buf, 0, max, size - max);
    const text = buf.toString('utf8');
    const nl = text.indexOf('\n'); // drop the cut first line
    return nl >= 0 ? text.slice(nl + 1) : '';
  } finally { await fh.close(); }
}

/** Brief for a thread whose provider session id and cwd are known. Reads the transcript (Claude's own JSONL). */
export async function draftBriefForSession(a: { sessionId: string; cwd: string; configDir?: string | null; accountEnv?: Record<string, string>; queryFn?: SideQueryFn }): Promise<BriefResult | null> {
  const file = locateTranscript(a.sessionId, a.cwd, a.configDir);
  if (!file) return null;
  const transcript = await readTail(file, BRIEF_MAX_BYTES);
  return draftBrief({ transcript, ...(a.accountEnv ? { accountEnv: a.accountEnv } : {}), cwd: a.cwd, ...(a.queryFn ? { queryFn: a.queryFn } : {}) });
}
