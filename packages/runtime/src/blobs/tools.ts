// The self tools every blob gets (docs/bots/ARCH.md 6.3): recall, remember, forget, edit_soul, set_model, attach_output.
// They are FleetToolSpecs (agent-neutral): in-process SDK tools for Claude; Codex/OpenCode reach them through the
// `kora mcp --blobs` bridge (S-A9, Phase 2) - until then those engines use the instructions + the outputs/ convention.
// Every handler re-reads the caller's profile; nothing here trusts the prompt. Handlers never throw.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { FleetToolSpec } from '../session/fleet-tools';
import type { MemoryFacade } from './memory-host';
import { contentTokens, coverage } from '../memory/text';
import { renderFact } from '../memory/subject';
import type { BlobStore } from './store';
import { MAX_SOUL_CHARS } from './store';
import { isUndone, journalChange } from './undo';
import type { BlobCard, BlobToolContext, MemoryReceiptWire } from './types';

export interface SelfToolDeps {
  store: BlobStore;
  memory: MemoryFacade;
  log?(msg: string): void;
  /** Called after a tool changed memory (the runtime re-reads the Core notes, which a correction may have scrubbed). */
  onMemoryChanged?(blobId: string): void;
}

const ok = (text: string) => ({ text });
const bad = (text: string) => ({ text, isError: true });
const cardId = (p: string) => `${p}_${crypto.randomBytes(5).toString('hex')}`;

/** Share of `a`'s content words that appear in `b` (0..1): "does this text just restate that fact". */
const contentCoverage = (a: string, b: string): number => coverage(contentTokens(a), b);

/** The folders a blob can read without owning: only Kora, and only her teammates' workspaces (retired ones included). */
export function teamReadDirs(store: Pick<BlobStore, 'get' | 'list'>, blobId: string): string[] {
  if (store.get(blobId)?.role !== 'chief') return [];
  return store.list({ includeArchived: true }).filter((b) => b.id !== blobId).map((b) => b.workspace);
}

export function selfToolSpecs(deps: SelfToolDeps, ctx: BlobToolContext): FleetToolSpec[] {
  const { store, memory } = deps;
  const me = () => store.get(ctx.blobId);
  const emit = (c: BlobCard) => { try { ctx.emitCard?.(c); } catch { /* cards are advisory */ } };

  /** Forget one fact the undoable way: retired, with a receipt card that has Undo (a hard delete cannot be taken back). */
  const forgetOne = async (factId: string, text: string, scope: string) => {
    const receipt = await memory.forgetWithReceipt(factId);
    if (!receipt) return bad('That memory is already gone.');
    try { deps.onMemoryChanged?.(ctx.blobId); } catch { /* advisory */ }
    emit({ cardKind: 'memory', cardId: cardId('mem'), version: 1, receipts: [{ id: receipt.id, kind: 'retired', scope: scope === 'blob' ? 'blob' : 'you', text, previousText: null, factId, undone: false, reason: null }] });
    return ok(`Forgot: ${text}\nThe user sees a card with Undo; do not ask them to confirm.`);
  };

  return [
    {
      name: 'recall',
      description: 'Search your memory: facts about the user and what you decided in past conversations. Use before saying you do not know something about the user or a past decision.',
      params: { query: { type: 'string', description: 'what to look for, in plain words' } },
      async handler(a) {
        try {
          const q = String(a.query ?? '').trim();
          if (!q) return bad('query is empty');
          const includeTeam = me()?.role === 'chief';
          const [facts, eps, withRetired] = await Promise.all([
            memory.searchFacts({ blobId: ctx.blobId, query: q, limit: 8, includeTeam }),
            memory.searchEpisodes({ blobId: ctx.blobId, query: q, limit: 4 }),
            memory.searchFacts({ blobId: ctx.blobId, query: q, limit: 12, includeTeam, includeRetired: true }),
          ]);
          // Old conversation text can still say what a corrected fact used to say ("I live in Dallas"): never hand that back
          // as if it were current. Excerpts that only restate a retired fact are dropped; the rest are labelled as history.
          const retired = withRetired.filter((f) => f.until != null);
          const stale = (e: { text: string; at: number }) => retired.some((f) => e.at <= (f.until ?? 0) && contentCoverage(f.text, e.text) >= 0.8);
          const lines = facts.map((f) => `- ${renderFact(f.text)} (since ${new Date(f.since).toISOString().slice(0, 10)})`);
          const hist = eps.filter((e) => !stale(e)).map((e) => `- [${e.kind === 'summary' ? 'past conversation' : 'earlier message'}, ${new Date(e.at).toISOString().slice(0, 10)}] ${e.snippet || e.text.slice(0, 200)}`);
          const out: string[] = [];
          if (lines.length) out.push('Current facts:', ...lines);
          if (hist.length) out.push(lines.length ? 'Earlier conversations (can be out of date; the current facts above win):' : 'Earlier conversations (can be out of date):', ...hist);
          return ok(out.length ? out.join('\n') : 'Nothing in memory matches that.');
        } catch (e: any) { return bad(`memory is unavailable right now: ${e?.message ?? e}`); }
      },
    },
    {
      name: 'remember',
      description: 'Save something to long-term memory when the user asks you to remember it, or tells you a durable fact (a name, a preference, a plan). One short self-contained sentence. If it CHANGES something already remembered (they moved, changed jobs, no longer like X), call remember with the new fact - the old one is retired for you in the same step, and the user sees "Updated ... (was ...)"; name the old one in `replaces` when it shares no words with the new one. Do NOT call forget and then remember. Do NOT store secrets, passwords or card numbers. Do NOT store instructions you were given for this task or session, test setup, or one-off constraints ("only use X", "you are in a test"): memory is for durable facts and preferences the user states about themselves. Health, money and legal details are held for the user\'s OK on a card that appears by itself - never ask them to confirm in the chat; say it is waiting on the card.',
      params: {
        text: { type: 'string', description: 'one sentence that STARTS with who it is about: "You live in Austin." for the user, "Sam is your cofounder." / "Sam lives in Austin." for somebody else. Never a bare verb ("Lives in Austin.").' },
        scope: { type: 'string', enum: ['you', 'blob'], optional: true, description: 'you = true about the user, useful to every blob (default). Use it for facts AND for the user\'s general style preferences ("short answers", "no emojis"): every blob should follow those. blob = ONLY for something specific to your own job with them (your private working note), never a general preference' },
        important: { type: 'boolean', optional: true, description: 'ONLY core identity (name, role, timezone) or a strong long-lived preference. Leave unset for ordinary facts.' },
        replaces: { type: 'string', optional: true, description: 'the remembered fact this replaces, in words ("lives in Dallas") or a fact id' },
      },
      async handler(a) {
        try {
          const text = String(a.text ?? '').trim();
          if (!text) return bad('text is empty');
          const scope = a.scope === 'blob' ? 'blob' : 'you';
          const r = await memory.remember({
            scope, ...(scope === 'blob' ? { blobId: ctx.blobId } : {}), blobId: ctx.blobId, text, important: a.important === true,
            ...(typeof a.replaces === 'string' && a.replaces.trim() ? { replaces: a.replaces.trim() } : {}),
            ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
          });
          const where = scope === 'you' ? 'for every blob' : 'only for this blob';
          if (r.outcome !== 'held') { try { deps.onMemoryChanged?.(ctx.blobId); } catch { /* advisory */ } }
          if (r.outcome === 'duplicate') return ok(`Already remembered: ${r.fact?.text ?? text}`);
          if (r.outcome === 'held') {
            if (r.receipt) emit({ cardKind: 'memory', cardId: cardId('mem'), version: 1, receipts: [{ id: r.receipt.id, kind: 'held', scope, text, previousText: null, factId: null, undone: false, reason: 'Looks sensitive' }] });
            return ok(`Held for the user's OK (it looks sensitive): ${text}\nIt is NOT saved yet. A card with Save / Don't save is shown to the user; tell them in ONE short sentence that it is waiting on that card. Do NOT ask them to confirm in the chat and do not call remember again for it.`);
          }
          const fact = r.fact!;
          const prev = r.previous?.[0]?.text ?? null;
          const kind = r.outcome === 'updated' ? 'updated' : 'added';
          if (r.receipt) emit({ cardKind: 'memory', cardId: cardId('mem'), version: 1, receipts: [{ id: r.receipt.id, kind, scope, text: fact.text, previousText: prev, factId: fact.id, undone: false, reason: null }] });
          return ok(kind === 'updated' ? `Updated memory (${where}): ${fact.text}${prev ? ` (was: ${prev})` : ''}` : `Remembered (${where}): ${fact.text}`);
        } catch (e: any) { return bad(String(e?.message ?? e)); }
      },
    },
    {
      name: 'forget',
      description: 'Delete a remembered fact the user wants gone. Give a query; if several facts match you get a list with ids - call again with factId.',
      params: { query: { type: 'string', optional: true, description: 'what to forget' }, factId: { type: 'string', optional: true, description: 'exact fact id from a previous list' } },
      async handler(a) {
        try {
          if (typeof a.factId === 'string' && a.factId) {
            const f = await memory.getFact(a.factId);
            if (!f) return bad('no such fact');
            return await forgetOne(f.id, f.text, f.scope);
          }
          const q = String(a.query ?? '').trim();
          if (!q) return bad('give a query or a factId');
          const hits = await memory.searchFacts({ blobId: ctx.blobId, query: q, limit: 5 });
          if (!hits.length) return ok('Nothing in memory matches that.');
          if (hits.length === 1) return await forgetOne(hits[0].id, hits[0].text, hits[0].scope);
          return ok(`Several facts match - which one?\n${hits.map((f) => `- ${f.id}: ${f.text}`).join('\n')}\nCall forget again with the factId (or ask the user).`);
        } catch (e: any) { return bad(String(e?.message ?? e)); }
      },
    },
    {
      name: 'edit_soul',
      description: 'Change your own SOUL (your personality and standing instructions) when the user asks you to be different ("be more concise", "always reply in Spanish"). Pass the COMPLETE new SOUL text; keep what is still true. The user gets a receipt with Undo.',
      params: { soul: { type: 'string', description: 'the complete new SOUL.md' }, change: { type: 'string', description: 'one line: what changed' } },
      async handler(a) {
        try {
          const b = me(); if (!b) return bad('unknown blob');
          const soul = String(a.soul ?? '').trim();
          if (!soul) return bad('soul is empty');
          if (soul.length > MAX_SOUL_CHARS) return bad(`soul is too long (max ${MAX_SOUL_CHARS} characters)`);
          const entry = journalChange({ blobId: b.id, kind: 'soul', what: String(a.change ?? 'Updated my soul'), before: store.soul(b.id) });
          store.writeSoul(b.id, soul);
          emit({ cardKind: 'self-change', cardId: cardId('sc'), version: 1, what: entry.what, undoToken: entry.token, undone: false });
          return ok('Your SOUL is updated; it applies from your next conversation. The user can undo it.');
        } catch (e: any) { return bad(String(e?.message ?? e)); }
      },
    },
    {
      name: 'set_model',
      description: 'Change which model/engine you run on by default (applies from the next new conversation). Only when the user asks.',
      params: { instanceId: { type: 'string', enum: ['claude', 'codex', 'opencode'] }, model: { type: 'string' }, effort: { type: 'string', optional: true } },
      async handler(a) {
        try {
          const b = me(); if (!b) return bad('unknown blob');
          const entry = journalChange({ blobId: b.id, kind: 'model', what: `Switched model to ${String(a.model)}`, before: b.engine });
          store.update(b.id, { engine: { instanceId: String(a.instanceId), model: String(a.model), effort: typeof a.effort === 'string' ? a.effort : null } });
          emit({ cardKind: 'self-change', cardId: cardId('sc'), version: 1, what: entry.what, undoToken: entry.token, undone: false });
          return ok(`Done: new conversations use ${String(a.model)}.`);
        } catch (e: any) { return bad(String(e?.message ?? e)); }
      },
    },
    {
      name: 'attach_output',
      description: 'Show a finished file (report, spreadsheet, deck, image, page) as a card in the chat. Pass the absolute path of a file inside your folder; it is copied to outputs/ if it is elsewhere in your folder. Kora can also pass a file a teammate made (their folder is read-only to her): it is copied into her outputs/.',
      params: {
        path: { type: 'string', description: 'absolute path of the finished file' },
        caption: { type: 'string', optional: true, description: 'one line saying what it is' },
        script: { type: 'boolean', optional: true, description: 'true ONLY when the user asked for the script (.py/.sh) itself' },
      },
      async handler(a) {
        try {
          const b = me(); if (!b) return bad('unknown blob');
          const r = resolveAttachment(b.workspace, String(a.path ?? ''), { allowScript: a.script === true, readFrom: teamReadDirs(store, b.id) });
          if ('error' in r) return bad(r.error);
          ctx.attachOutput?.(r.path, typeof a.caption === 'string' && a.caption ? a.caption : null);
          return ok(`Attached ${path.basename(r.path)}: it shows as a card under your reply. Say what is in it ("the spreadsheet below ..."); do not repeat its file name or path unless the user asks where it is saved.`);
        } catch (e: any) { return bad(String(e?.message ?? e)); }
      },
    },
  ];
}

/** attach_output's path rules: a real file inside the workspace; copied into outputs/ when it is elsewhere. */
export function resolveAttachment(workspace: string, raw: string, o: { allowScript?: boolean; readFrom?: readonly string[] } = {}): { path: string } | { error: string } {
  if (!raw) return { error: 'path is empty' };
  // A helper script you wrote to build the deliverable is not the deliverable (live QA: the chat got a card for add_savings.py
  // and none for the edited spreadsheet). Attach the file the user asked for.
  if (!o.allowScript && /\.(py|sh|bash|zsh|command)$/i.test(raw)) return { error: `${path.basename(raw)} is a helper script, not the deliverable. Attach the finished file the user asked for (the spreadsheet / document itself). If the user asked for the script, call again with script: true.` };
  const abs = path.isAbsolute(raw) ? raw : path.join(workspace, raw);
  let real: string, ws: string;
  try { real = fs.realpathSync(abs); } catch { return { error: `no such file: ${abs}` }; }
  try { ws = fs.realpathSync(workspace); } catch { ws = workspace; }
  const under = (root: string) => { let r = root; try { r = fs.realpathSync(root); } catch { /* a folder that is gone holds nothing */ } return real === r || real.startsWith(r + path.sep); };
  // Kora may attach what a teammate produced (their folder is read-only to her): it is copied into her outputs/ below.
  if (!under(ws) && !(o.readFrom ?? []).some(under)) return { error: `${abs} is outside your folder (${workspace}); copy it into outputs/ first` };
  try { if (!fs.statSync(real).isFile()) return { error: `${abs} is not a file` }; } catch { return { error: `cannot read ${abs}` }; }
  const outputs = path.join(ws, 'outputs');
  if (real.startsWith(outputs + path.sep)) return { path: real };
  // (a teammate's own outputs/ also falls through to the copy: Kora's card must point inside Kora's folder)
  let dest = path.join(outputs, path.basename(real));
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(outputs, `${path.basename(real, path.extname(real))} ${i}${path.extname(real)}`);
  fs.mkdirSync(outputs, { recursive: true });
  fs.copyFileSync(real, dest);
  return { path: dest };
}

export { isUndone };
