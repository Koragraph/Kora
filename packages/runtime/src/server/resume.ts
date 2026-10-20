// Cheap resume: distil an old Claude transcript into a ~700-token brief so a restart can start a FRESH session
// instead of re-sending the whole conversation at cache-write price. The SessionStart hook includes the file once
// (when KORA_PANE_ID is set and ~/.kora/panes/<paneId>/resume-brief.md exists) and deletes it.
import fs from 'node:fs';
import path from 'node:path';
import { koraHome } from '../protocol/types';
import { parseTranscript, approxTokens, fmtTokens } from '../ledger/transcript';

export const BRIEF_TOKEN_CAP = 700;
const MAX_FILES = 12; const MAX_LAST_ASSISTANT = 1200; const MAX_PROMPT = 600;

export function resumeBriefPath(paneId: string): string { return path.join(koraHome(), 'panes', paneId, 'resume-brief.md'); }

export interface BriefFacts {
  sessionId: string | null; firstPrompt: string | null; lastPrompt: string | null; lastAssistant: string | null;
  files: { file: string; edited: boolean }[]; costUsd: number; apiCalls: number; lastContext: number; model: string | null;
}

const textOf = (content: any): string => typeof content === 'string' ? content : Array.isArray(content) ? content.filter((c) => c?.type === 'text' || typeof c === 'string').map((c) => (typeof c === 'string' ? c : c.text || '')).join('\n') : '';
const clean = (s: string) => s.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/** Everything the brief needs, from one transcript. Cheap: the ledger parser for files and cost, one light pass for text. */
export function briefFacts(transcript: string): BriefFacts {
  const s = parseTranscript(transcript);
  let firstPrompt: string | null = null, lastPrompt: string | null = null, lastAssistant: string | null = null;
  for (const line of fs.readFileSync(transcript, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o: any; try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain) continue;
    if (o.type === 'user' && o.message) {
      const c = o.message.content;
      if (typeof c === 'string' || (Array.isArray(c) && !c.some((x: any) => x?.type === 'tool_result'))) { const t = clean(textOf(c)); if (t) { if (!firstPrompt) firstPrompt = t; lastPrompt = t; } }
    } else if (o.type === 'assistant' && o.message) { const t = clean(textOf(o.message.content)); if (t) lastAssistant = t; }
  }
  const seen = new Map<string, boolean>();
  for (const st of s.steps) for (const t of st.tools) {
    const f = t.cls === 'read' ? t.filesTouched[0] : (t.cls === 'edit' && t.input?.file_path ? String(t.input.file_path) : null);
    if (!f) continue;
    const rel = s.cwd && (f.startsWith(s.cwd + '/') || f.startsWith(s.cwd + path.sep)) ? f.slice(s.cwd.length + 1).split(path.sep).join('/') : f;
    seen.set(rel, (seen.get(rel) || false) || t.cls === 'edit');
  }
  const last = s.steps[s.steps.length - 1];
  return { sessionId: s.sessionId, firstPrompt, lastPrompt, lastAssistant, files: [...seen].map(([file, edited]) => ({ file, edited })), costUsd: s.costUsd, apiCalls: s.totals.apiCalls, lastContext: last?.context ?? 0, model: s.model };
}

const cut = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…');

/** Render the brief, capped at ~BRIEF_TOKEN_CAP tokens (the last assistant text absorbs the cut first). */
export function renderBrief(f: BriefFacts): string {
  const files = f.files.slice(-MAX_FILES);
  const build = (assistantChars: number) => {
    const parts: string[] = [];
    parts.push(`# Resume brief (kora cheap resume)`);
    parts.push(`The previous session${f.sessionId ? ` ${f.sessionId.slice(0, 8)}` : ''} spent $${f.costUsd.toFixed(2)} over ${f.apiCalls} API calls and ended with ${fmtTokens(f.lastContext)} tokens in context. This is a fresh session: nothing below is in context unless you re-read it. Re-read only the ranges you need.`);
    if (f.firstPrompt) parts.push(`\n## First prompt\n${cut(f.firstPrompt, MAX_PROMPT)}`);
    if (f.lastPrompt && f.lastPrompt !== f.firstPrompt) parts.push(`\n## Last user prompt\n${cut(f.lastPrompt, MAX_PROMPT)}`);
    if (files.length) parts.push(`\n## Files read / edited${f.files.length > files.length ? ` (last ${files.length} of ${f.files.length})` : ''}\n${files.map((x) => `- ${x.file}${x.edited ? ' (edited)' : ''}`).join('\n')}`);
    if (f.lastAssistant && assistantChars > 0) parts.push(`\n## Last assistant text\n${cut(f.lastAssistant, assistantChars)}`);
    return parts.join('\n') + '\n';
  };
  let chars = MAX_LAST_ASSISTANT; let out = build(chars);
  while (approxTokens(out) > BRIEF_TOKEN_CAP && chars > 0) { chars = Math.max(0, chars - 200); out = build(chars); }
  return out;
}

/** Write the brief for the pane that is about to start. Returns the path, or null when there is nothing to distil. */
export function writeResumeBrief(paneId: string, transcript: string | null): { path: string; tokens: number } | null {
  if (!transcript || !fs.existsSync(transcript)) return null;
  const facts = briefFacts(transcript);
  if (!facts.firstPrompt && !facts.files.length && !facts.lastAssistant) return null;
  const text = renderBrief(facts); const file = resumeBriefPath(paneId);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
  return { path: file, tokens: approxTokens(text) };
}
