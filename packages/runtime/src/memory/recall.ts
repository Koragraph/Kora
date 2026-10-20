// Read path: core notes + best-matching facts packed into a strict token budget.
import type { Ctx, Row } from './ctx';
import type { Fact } from './types';
import { DAY_MS, LIMITS } from './types';
import { estimateTokens, normalize } from './text';
import { getCore } from './core';
import { renderFact } from './subject';
import { isDecayed, rowToFact, rowToQuestion, searchVisible, type Hit } from './facts';

export interface RecallResult {
  core: { you: string; blob: string };
  facts: Fact[];
  /** Ready-to-inject block ('' when memory is empty). */
  promptText: string;
  tokens: { core: number; memory: number; total: number };
  /** Just the memory block (header + facts + open question), without core notes. '' when nothing matched. */
  memoryBlock: string;
  /** Ids of the facts in `facts` (what a caller dedupes on). */
  factIds: string[];
}

export interface RecallArgs {
  blobId: string;
  query: string;
  /** Budget for the memory section (facts + open question). Core notes are capped separately (≈1.5k). */
  budgetTokens?: number;
  /** Chief only: also surface 'team' facts. */
  includeTeam?: boolean;
  /** Fact ids the caller already injected recently: skipped (they do not use up the budget). */
  excludeFactIds?: readonly string[];
  /**
   * A task handed to this blob (a delegated thread, a routine run): only facts that actually match the task text are
   * returned, at most three, and no important fact rides along unmatched. Personal facts a job does not need stay home.
   */
  taskScoped?: boolean;
  /** Mark returned facts as used (keeps them from decaying). Default true. */
  touch?: boolean;
}

const month = (ms: number) => new Date(ms).toISOString().slice(0, 7);

export async function recall(ctx: Ctx, a: RecallArgs): Promise<RecallResult> {
  const budget = Math.max(0, a.budgetTokens ?? 1000);
  const now = ctx.now();
  const core = getCore(ctx, a.blobId);

  let qvec: Float32Array | null = null;
  if (ctx.embedder && a.query.trim()) {
    try {
      qvec = (await ctx.embedder.embed([a.query]))[0] ?? null;
    } catch {
      qvec = null;
    }
  }
  const vis = { blobId: a.blobId, includeTeam: a.includeTeam };
  const hits = new Map<string, Hit>();
  for (const h of searchVisible(ctx, vis, a.query, { qvec })) hits.set(h.fact.id, h);
  // important facts are always candidates, even without a lexical match
  const imp = ctx.db
    .prepare(
      `SELECT * FROM facts f WHERE f.until IS NULL AND f.important = 1 AND (f.scope = 'you' OR (f.scope = 'blob' AND f.blob_id = @blob)${a.includeTeam ? " OR f.scope = 'team'" : ''})
       ORDER BY f.last_used_at DESC LIMIT 20`,
    )
    .all({ blob: a.blobId }) as Row[];
  for (const r of imp) if (!hits.has(r.id)) hits.set(r.id, { fact: rowToFact(r), lex: 0, sem: 0 });

  const coreText = `${core.you}\n${core.blob}`;
  const coreNorm = normalize(coreText);
  const skip = new Set(a.excludeFactIds ?? []);
  const scored = [...hits.values()]
    .filter((h) => !skip.has(h.fact.id) && !isDecayed(h.fact, now) && !(coreNorm && coreNorm.includes(normalize(h.fact.text))))
    .map((h) => {
      const rel = ctx.embedder ? 0.5 * h.lex + 0.5 * h.sem : h.lex;
      const ageDays = (now - Math.max(h.fact.lastUsedAt, h.fact.createdAt)) / DAY_MS;
      const recency = Math.pow(0.5, Math.max(0, ageDays) / 45);
      const score = 0.6 * rel + 0.12 * recency + 0.1 * h.fact.confidence + (h.fact.important ? 0.18 : 0);
      return { h, rel, score };
    })
    // a non-important fact must actually match the message
    .filter((s) => (s.h.fact.important && !a.taskScoped) || s.rel >= (a.taskScoped ? 0.3 : 0.15))
    .sort((x, y) => y.score - x.score);

  // open question the blob may ask naturally (counts against the budget)
  const qrow = ctx.db
    .prepare(
      `SELECT * FROM questions WHERE status = 'open' AND (blob_id = ? OR blob_id IS NULL) AND ask_count < 3
       AND (last_asked_at IS NULL OR last_asked_at < ?) ORDER BY created_at LIMIT 1`,
    )
    .get(a.blobId, now - 6 * 3_600_000) as Row | undefined;

  const header = 'Memory (can be out of date; if the user says otherwise, they are right):';
  let used = estimateTokens(header);
  const lines: string[] = [];
  const picked: Fact[] = [];
  let unmatchedImportant = 0;
  for (const { h, rel } of scored) {
    if (picked.length >= (a.taskScoped ? Math.min(3, LIMITS.recallMaxFacts) : LIMITS.recallMaxFacts)) break;
    // important facts ride along without a match, but only a few, so they cannot crowd out relevant ones
    if (rel < 0.15 && ++unmatchedImportant > 3) continue;
    const line = `- ${renderFact(h.fact.text)} (since ${month(h.fact.since)})`;
    const cost = estimateTokens(line) + 1;
    if (used + cost > budget) continue;
    used += cost;
    lines.push(line);
    picked.push(h.fact);
  }
  let questionLine = '';
  if (qrow) {
    const q = rowToQuestion(qrow);
    const line = `Unsure (bring up naturally only if it fits the conversation): ${q.text}`;
    if (used + estimateTokens(line) + 1 <= budget) {
      used += estimateTokens(line) + 1;
      questionLine = line;
      ctx.db.prepare('UPDATE questions SET ask_count = ask_count + 1, last_asked_at = ? WHERE id = ?').run(now, q.id);
    }
  }
  const memoryBlock = lines.length || questionLine ? [header, ...lines, questionLine].filter(Boolean).join('\n') : '';
  if (!memoryBlock) used = 0;

  if (a.touch !== false && picked.length) {
    const st = ctx.db.prepare('UPDATE facts SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?');
    for (const f of picked) st.run(now, f.id);
  }

  const parts: string[] = [];
  if (core.you) parts.push(`About the user:\n${core.you}`);
  if (core.blob) parts.push(`Your working notes:\n${core.blob}`);
  if (memoryBlock) parts.push(memoryBlock);
  const promptText = parts.join('\n\n');
  const coreTokens = estimateTokens(parts.slice(0, parts.length - (memoryBlock ? 1 : 0)).join('\n\n'));
  const memTokens = memoryBlock ? estimateTokens(memoryBlock) : 0;
  return { core, facts: picked.map((f) => ({ ...f, lastUsedAt: a.touch === false ? f.lastUsedAt : now })), promptText, tokens: { core: coreTokens, memory: memTokens, total: estimateTokens(promptText) }, memoryBlock, factIds: picked.map((f) => f.id) };
}
