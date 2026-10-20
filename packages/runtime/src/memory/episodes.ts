import type { Ctx, Row } from './ctx';
import { askJson } from './ctx';
import type { EpisodeHit } from './types';
import { tx } from './db';
import { cleanText, ftsQuery, scrubSecrets } from './text';
import { newId } from './facts';

const SUMMARY_SYSTEM = `You write a short memory summary of a conversation between a user and an AI coworker.
Reply with ONLY JSON: {"summary":"2-4 sentences: what was asked, what was decided or done, anything left open"}. Plain facts, no fluff.`;

export type Transcript = string | Array<{ role: string; text: string }>;

function flatten(t: Transcript): string {
  const s = typeof t === 'string' ? t : t.map((m) => `${m.role}: ${m.text}`).join('\n');
  // keep head and tail of long transcripts
  return s.length > 6000 ? `${s.slice(0, 2500)}\n…\n${s.slice(-3000)}` : s;
}

export async function summarizeThread(ctx: Ctx, a: { threadId: string; blobId: string; transcript: Transcript }): Promise<string> {
  const text = scrubSecrets(flatten(a.transcript));
  const got = await askJson(
    ctx,
    { system: SUMMARY_SYSTEM, prompt: `Conversation:\n${text}\n\nJSON:`, maxTokens: 300 },
    (raw) => {
      const s = (raw as { summary?: unknown } | undefined)?.summary;
      const c = cleanText(s, 700);
      return c.length >= 10 ? c : null;
    },
  );
  // deterministic fallback so a flaky model never leaves a thread unsummarised
  const summary = scrubSecrets(got ?? cleanText(`(auto) ${text.replace(/\s+/g, ' ')}`, 400));
  tx(ctx.db, () => {
    const now = ctx.now();
    const row = ctx.db.prepare('SELECT id FROM episodes WHERE thread_id = ? AND blob_id = ?').get(a.threadId, a.blobId) as Row | undefined;
    let id: string;
    if (row) {
      id = row.id;
      ctx.db.prepare('UPDATE episodes SET summary = ?, updated_at = ? WHERE id = ?').run(summary, now, id);
      ctx.db.prepare("DELETE FROM ep_fts WHERE kind = 'summary' AND ref = ?").run(id);
    } else {
      id = newId('e');
      ctx.db.prepare('INSERT INTO episodes(id, thread_id, blob_id, summary, created_at, updated_at) VALUES(?,?,?,?,?,?)').run(id, a.threadId, a.blobId, summary, now, now);
    }
    ctx.db.prepare("INSERT INTO ep_fts(body, kind, ref, blob_id, thread_id, at) VALUES(?, 'summary', ?, ?, ?, ?)").run(summary, id, a.blobId, a.threadId, now);
  });
  return summary;
}

export function searchEpisodes(ctx: Ctx, a: { blobId?: string; query: string; limit?: number }): EpisodeHit[] {
  const q = ftsQuery(a.query);
  if (!q) return [];
  const rows = ctx.db
    .prepare(
      `SELECT kind, blob_id, thread_id, at, body, snippet(ep_fts, 0, '[', ']', '…', 24) AS snip, bm25(ep_fts) AS b
       FROM ep_fts WHERE ep_fts MATCH @q ${a.blobId ? 'AND blob_id = @blob' : ''}
       ORDER BY b LIMIT @limit`,
    )
    .all({ q, ...(a.blobId ? { blob: a.blobId } : {}), limit: Math.max(1, Math.min(a.limit ?? 5, 50)) }) as Row[];
  const best = rows.reduce((m, r) => Math.max(m, -r.b), 0) || 1;
  return rows.map((r) => ({
    kind: r.kind,
    threadId: r.thread_id,
    blobId: r.blob_id,
    text: r.body,
    snippet: r.snip,
    at: Number(r.at),
    // summaries are denser than raw turns: small boost
    score: (-r.b / best) * (r.kind === 'summary' ? 1 : 0.85),
  })).sort((x, y) => y.score - x.score);
}
