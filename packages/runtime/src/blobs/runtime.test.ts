// BlobRuntime end to end on an in-thread memory store: the Phase 1 exit behaviours (a fact told to one blob is used by
// another in a new thread; a correction retires it everywhere; private notes never leak), recall dedupe + the 400 ms
// bound, the no-extractor queue, the mirror file, usage, prompt-stale events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blobs-rt-'));
process.env.KORA_BLOBS_ROOT = path.join(root, 'Blobs');
process.env.KORA_HOME = path.join(root, 'kora-home');

import { BlobStore } from './store';
import { BlobRuntimeImpl, parseMirror } from './runtime';
import { inlineMemoryHost, type ExtractorFn, type MemoryHost } from './memory-host';
import { openMemory } from '../memory';
import { aliasOf, userOf } from '../memory/testkit';
import { blobHome } from './home';

const ENGINE = { instanceId: 'claude', model: 'sonnet', effort: null };

function setup(opts: { script?: (user: string, prompt: string) => unknown; wrapMemory?: (m: MemoryHost) => MemoryHost } = {}) {
  fs.rmSync(path.join(process.env.KORA_HOME!, 'blobs'), { recursive: true, force: true });
  const store = new BlobStore();
  let ext: ExtractorFn | null = null;
  const mem = openMemory({ dbPath: ':memory:', extractor: (r) => (ext ? ext(r) : Promise.reject(new Error('none'))) });
  const state = { available: true, script: opts.script ?? (() => ({ ops: [] })) };
  const oneShot = async (prompt: string) => {
    if (!state.available) return null;
    const out = state.script(userOf(prompt), prompt);
    return { text: typeof out === 'string' ? out : JSON.stringify(out), model: 'fake' };
  };
  let host = inlineMemoryHost(mem, (fn) => { ext = fn; });
  if (opts.wrapMemory) host = opts.wrapMemory(host);
  const rt = new BlobRuntimeImpl({ store, memory: host, oneShot, koraCmd: 'kora', userSkillDirs: [] });
  const popo = store.create({ name: 'Popo', title: 'Researcher', soul: 'Curious.', engine: ENGINE });
  const bobble = store.create({ name: 'Bobble', title: 'Inbox', soul: 'Tidy.', engine: ENGINE });
  return { store, rt, mem, popo, bobble, state, host, oneShot };
}
const turn = (blobId: string, threadId: string, user: string, n: number) => ({ blobId, threadId, messageIds: { user: `u${n}`, assistant: `a${n}` }, userText: user, assistantText: 'Got it, noted.', at: Date.now() });

test('Phase 1 exit: a fact told to Popo is used by Bobble in a new thread; a correction retires it everywhere; private notes stay private', async () => {
  const { rt, mem, popo, bobble } = setup({
    script: (user, prompt) => {
      if (/moved to Austin/i.test(user)) return { ops: [{ op: 'update', scope: 'you', target: aliasOf(prompt, 'Dallas'), text: 'You live in Austin.', explicit: true, confidence: 0.95 }] };
      if (/Dallas/i.test(user)) return { ops: [{ op: 'add', scope: 'you', text: 'You live in Dallas.', confidence: 0.9 }, { op: 'add', scope: 'blob', text: 'Wants sources as a numbered list.', confidence: 0.9 }] };
      return { ops: [] };
    },
  });
  const r1 = await rt.afterTurn(turn(popo.id, 'tA', 'I live in Dallas, my cofounder is Sam', 1));
  assert.equal(r1.length, 2);
  assert.deepEqual(r1.map((r) => [r.kind, r.scope]).sort(), [['added', 'blob'], ['added', 'you']]);
  // what a session sees = its static prompt (the Core notes are baked in) + the per-turn recall; a fact the Core already states is not repeated
  const seen = async (blobId: string, threadId: string, text: string) => `${rt.systemPrompt({ blobId, threadId, agent: 'claude' })}\n${await rt.turnContext({ blobId, threadId, text, agent: 'claude', origin: null })}`;
  const ctx = await seen(bobble.id, 'tB', 'Where do I live? Find me a florist');
  assert.match(ctx, /You live in Dallas/);
  assert.doesNotMatch(ctx, /numbered list/, 'Popo\'s private working note never reaches Bobble');
  const popoCtx = await seen(popo.id, 'tC', 'Give me the sources for the brief');
  assert.match(popoCtx, /numbered list/);
  // correction
  const r2 = await rt.afterTurn(turn(bobble.id, 'tB', "that's wrong, I moved to Austin", 2));
  assert.equal(r2[0].kind, 'updated');
  assert.equal(r2[0].previousText, 'You live in Dallas.');
  const again = await seen(popo.id, 'tD', 'Where do I live?');
  assert.match(again, /You live in Austin/);
  assert.doesNotMatch(again, /live in Dallas/);
  const facts = await rt.factsWire('you', null, true);
  const dallas = facts.find((f) => /Dallas/.test(f.text))!;
  assert.ok(dallas.until !== null, 'retired, with an until date');
  assert.equal(dallas.sourceMessageId, 'u1', 'provenance = the user message');
  assert.equal(dallas.sourceThreadId, 'tA');
  mem.close();
});

test('turnContext: recalled facts are deduped across the last 6 turns, then return; empty text and unknown blob are safe', async () => {
  const { rt, mem, popo } = setup();
  await mem.addFact({ scope: 'you', text: 'Prefers espresso over drip coffee.' });
  const q = 'what coffee do I like, espresso or drip?';
  const c1 = await rt.turnContext({ blobId: popo.id, threadId: 'tX', text: q, agent: 'claude', origin: null });
  assert.match(c1, /espresso/);
  for (let i = 0; i < 4; i++) assert.doesNotMatch(await rt.turnContext({ blobId: popo.id, threadId: 'tX', text: q, agent: 'claude', origin: null }), /espresso/, `turn ${i + 2} is deduped`);
  assert.doesNotMatch(await rt.turnContext({ blobId: popo.id, threadId: 'tX', text: q, agent: 'claude', origin: null }), /espresso/);
  assert.match(await rt.turnContext({ blobId: popo.id, threadId: 'tX', text: q, agent: 'claude', origin: null }), /espresso/, 'after the window it may be injected again');
  assert.match(await rt.turnContext({ blobId: popo.id, threadId: 'other-thread', text: q, agent: 'claude', origin: null }), /espresso/, 'dedupe is per thread');
  assert.equal(await rt.turnContext({ blobId: popo.id, threadId: 'tY', text: '   ', agent: 'claude', origin: null }), '');
  assert.equal(await rt.turnContext({ blobId: 'blob_nope', threadId: 'tY', text: 'hi', agent: 'claude', origin: null }), '');
  mem.close();
});

test('turnContext never blocks a turn: a memory that never answers costs ~400 ms and no recall', async () => {
  const { rt, mem, popo } = setup({ wrapMemory: (m) => ({ ...m, recall: () => new Promise(() => {}), getCore: () => new Promise(() => {}) }) as MemoryHost });
  const t0 = Date.now();
  // the runtime's 400 ms timer is unref'd (it must never hold the daemon open): keep this test's event loop alive, or
  // node --test cancels every later test in the file ("event loop has already resolved")
  const keep = setInterval(() => {}, 100);
  const ctx = await rt.turnContext({ blobId: popo.id, threadId: 'tZ', text: 'where do I live', agent: 'claude', origin: null }).finally(() => clearInterval(keep));
  const ms = Date.now() - t0;
  assert.equal(ctx, '');
  assert.ok(ms >= 350 && ms < 1500, `bounded by the 400 ms recall timeout (took ${ms} ms)`);
  mem.close();
});

test('from-Kora header only on the first turn of a delegated thread; a changed Core rides once as a delta', async () => {
  const { rt, mem, popo } = setup();
  const origin = { kind: 'kora' as const, jobId: 'j1', stepId: 's1', fromThreadId: 'k1', fromBlobId: 'blob_kora' };
  rt.systemPrompt({ blobId: popo.id, threadId: 'tK', agent: 'claude' }); // baseline Core hash
  const first = await rt.turnContext({ blobId: popo.id, threadId: 'tK', text: 'plan the trip', agent: 'claude', origin });
  assert.match(first, /handed to you by Kora/);
  assert.doesNotMatch(await rt.turnContext({ blobId: popo.id, threadId: 'tK', text: 'more', agent: 'claude', origin }), /handed to you by Kora/);
  mem.setCore('blob', popo.id, '- Always answer in Spanish');
  await rt.refreshCore(popo.id);
  const withDelta = await rt.turnContext({ blobId: popo.id, threadId: 'tK', text: 'next', agent: 'claude', origin });
  assert.match(withDelta, /<memory-core-updated>[\s\S]*Spanish/);
  assert.doesNotMatch(await rt.turnContext({ blobId: popo.id, threadId: 'tK', text: 'again', agent: 'claude', origin }), /memory-core-updated/, 'once per change');
  // the mirror file is written and a hand edit is imported before the next recall
  const mirror = path.join(blobHome(popo.id), 'memory.md');
  assert.match(fs.readFileSync(mirror, 'utf8'), /Always answer in Spanish/);
  await new Promise((r) => setTimeout(r, 1700));
  fs.writeFileSync(mirror, '## About the user\n- Lives in Oslo\n\n## My working notes\n- Answer in English\n');
  await rt.turnContext({ blobId: popo.id, threadId: 'tM', text: 'hello there', agent: 'claude', origin: null });
  const core = mem.getCore(popo.id);
  assert.deepEqual({ you: core.you, blob: core.blob }, { you: '- Lives in Oslo', blob: '- Answer in English' });
  assert.deepEqual(parseMirror('## About the user\na\n\n## My working notes\nb\n'), { you: 'a', blob: 'b' });
  mem.close();
});

test('no extractor available: the turn is queued (never lost, never throws) and ingested once a model appears', async () => {
  const { rt, mem, popo, state } = setup({ script: () => ({ ops: [{ op: 'add', scope: 'you', text: 'Likes jazz.', confidence: 0.9 }] }) });
  state.available = false;
  const r = await rt.afterTurn(turn(popo.id, 'tQ', 'I really like jazz music, remember that', 1));
  assert.deepEqual(r, []);
  assert.equal(rt.pendingTurnCount(), 1);
  assert.equal(mem.listFacts().length, 0);
  let now = Date.now();
  (rt as any).now = () => now;
  assert.equal(await rt.drainPending(), 0, 'not due yet: the retry book backs a missed turn off (5 min)');
  now += 6 * 60_000;
  assert.equal(await rt.drainPending(), 0, 'due, but still no model: backs off again');
  state.available = true;
  assert.equal(await rt.drainPending(), 0, 'the second backoff (10 min) has not passed');
  now += 11 * 60_000;
  assert.equal(await rt.drainPending(), 1);
  assert.equal(rt.pendingTurnCount(), 0);
  assert.match(mem.listFacts()[0].text, /jazz/);
  mem.close();
});

test('no model, but the turn holds a plain correction: its receipts are kept, the model part is queued', async () => {
  const { rt, mem, popo, state } = setup({ script: () => ({ ops: [] }) });
  state.available = false;
  await rt.afterTurn(turn(popo.id, 'tA', 'I live in Dallas, remember that', 1));
  state.available = false;
  const r = await rt.afterTurn(turn(popo.id, 'tB', 'Actually I moved to Austin', 2));
  assert.equal(rt.pendingTurnCount() >= 1, true, 'still queued for the model');
  assert.ok(Array.isArray(r), 'never throws, never loses the pre-pass receipts');
  mem.close();
});

test('the retry book file: an old-format line loads as due now; the extractor status gate holds the drain', async () => {
  const { rt, mem, popo, state } = setup({ script: () => ({ ops: [{ op: 'add', scope: 'you', text: 'Likes tea.', confidence: 0.9 }] }) });
  state.available = false;
  await rt.afterTurn(turn(popo.id, 'tG', 'I really like tea, remember that', 1));
  const file = (rt as any).pendingFile() as string;
  const entry = JSON.parse(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)[0]);
  fs.writeFileSync(file, JSON.stringify(entry.item) + '\n'); // the pre-RetryBook format
  assert.equal(rt.pendingTurnCount(), 1);
  state.available = true;
  (rt as any).oneShot = Object.assign((rt as any).oneShot, { status: () => ({ retryAt: Date.now() + 60_000 }) });
  assert.equal(await rt.drainPending(), 0, 'every model is resting: nothing is even tried');
  (rt as any).oneShot.status = () => ({ retryAt: null });
  assert.equal(await rt.drainPending(), 1);
  assert.deepEqual((rt as any).extractorStatus(), { retryAt: null });
  mem.close();
});

test('afterTurn: ignores empty replies; a garbage extractor reply never throws; held items come back as "held"', async () => {
  const { rt, mem, popo, state } = setup({ script: (user) => (/health/.test(user) ? { ops: [{ op: 'add', scope: 'you', text: 'Has a health condition.', sensitive: true, confidence: 0.9 }] } : 'not json at all') });
  assert.deepEqual(await rt.afterTurn({ ...turn(popo.id, 't1', 'hello there my friend', 1), assistantText: '   ' }), []);
  assert.deepEqual(await rt.afterTurn(turn(popo.id, 't1', 'hello there my friend', 2)), []);
  const held = await rt.afterTurn(turn(popo.id, 't1', 'a note about my health condition for you', 3));
  assert.equal(held[0].kind, 'held');
  assert.match(held[0].reason ?? '', /sensitive/i);
  assert.equal(held[0].factId, null);
  void state;
  mem.close();
});

test('usage ledger sums settled turns per blob and thread (input excludes cache reads); promptChanged fires on SOUL / about-me edits', async () => {
  const { rt, store, mem, popo } = setup();
  rt.recordTurnUsage(popo.workspace, 'tU', { inputTokens: 100, cachedInputTokens: 900, outputTokens: 50 });
  rt.recordTurnUsage(path.join(popo.workspace, 'outputs'), 'tU2', { inputTokens: 10, outputTokens: 5 });
  rt.recordTurnUsage('/tmp/not-a-blob', 'tU3', { inputTokens: 999 });
  assert.deepEqual(rt.usage.total(popo.id), { input: 110, cached: 900, output: 55, turns: 2 });
  assert.equal(rt.usage.byThread(popo.id).length, 2);
  assert.equal(rt.usageByBlob().size, 1);
  const seen: Array<string | null> = [];
  const off = rt.onPromptChanged((id) => seen.push(id));
  store.writeSoul(popo.id, 'New soul');
  store.setAboutMe('hi');
  off();
  store.writeSoul(popo.id, 'Another');
  assert.deepEqual(seen, [popo.id, null]);
  mem.close();
});

test('systemPrompt reflects SOUL, about-me and skills for the blob; unknown blob gets nothing', () => {
  const { rt, store, mem, popo } = setup();
  store.setAboutMe('I am Alex.');
  const p = rt.systemPrompt({ blobId: popo.id, threadId: 't', agent: 'codex' });
  assert.match(p, /Curious\./);
  assert.match(p, /I am Alex\./);
  assert.match(p, /kora-spreadsheets/);
  assert.equal(rt.systemPrompt({ blobId: 'blob_nope', threadId: 't', agent: 'claude' }), '');
  const sk = rt.skills(popo.id);
  assert.ok(sk.qualified.includes('kora-blob:kora-slides'));
  assert.ok(fs.existsSync(path.join(sk.dir, '.claude-plugin', 'plugin.json')));
  mem.close();
});

test('About me edited after a thread started reaches that thread on its next turn (once)', async () => {
  const { rt, store, mem, popo } = setup();
  store.setAboutMe('I like long answers.');
  rt.systemPrompt({ blobId: popo.id, threadId: 'tAbout', agent: 'claude' }); // the thread's session started with this
  const turnArgs = (text: string) => ({ blobId: popo.id, threadId: 'tAbout', text, agent: 'claude', origin: null });
  assert.doesNotMatch(await rt.turnContext(turnArgs('hello')), /about-me-updated/);
  store.setAboutMe('I like very short answers.');
  const ctx = await rt.turnContext(turnArgs('hello again'));
  assert.match(ctx, /<about-me-updated>\nI like very short answers\./);
  assert.doesNotMatch(await rt.turnContext(turnArgs('and again')), /about-me-updated/, 'said once per change');
  mem.close();
});

test('maintenance: idle threads are summarised (episodes searchable), pending drained', async () => {
  const { rt, mem, popo } = setup({ script: (_u, p) => (/Conversation:/.test(p) ? { summary: 'Planned the Lisbon trip and chose May dates.' } : { ops: [] }) });
  let now = Date.now();
  (rt as any).now = () => now;
  await rt.afterTurn(turn(popo.id, 'tTrip', 'lets plan the lisbon trip in may', 1));
  assert.equal((await rt.maintenanceTick()).summarised, 0, 'not idle yet');
  now += 11 * 60_000;
  assert.equal((await rt.maintenanceTick()).summarised, 1);
  assert.equal(mem.searchEpisodes({ blobId: popo.id, query: 'lisbon trip may dates' })[0].kind, 'summary');
  mem.close();
});

test('Kora (the Chief): ensureKora is idempotent and pinned; koraReady, runtimeModeFor, and the Claude-memory flag are the store\'s', () => {
  const { rt, store } = setup();
  assert.equal(rt.koraReady(), false);
  const k = rt.ensureKora(ENGINE);
  assert.deepEqual([k.id, k.role, k.pinned, k.name], ['blob_kora', 'chief', true, 'Kora']);
  assert.match(store.soul(k.id), /You are Kora, the Chief/);
  assert.ok(fs.existsSync(path.join(k.workspace, 'outputs')), 'the Finder folder exists');
  assert.equal(rt.ensureKora({ ...ENGINE, model: 'opus' }).engine.model, 'sonnet', 'an existing Kora is untouched');
  assert.equal(rt.koraReady(), true);
  assert.equal(rt.runtimeModeFor('codex', 'auto'), 'auto-accept-edits');
  assert.equal(rt.runtimeModeFor('claude', 'ask'), 'approval-required');
  assert.equal(store.memorySettings().claudeFallback, false);
  store.setFlag('claudeMemoryFallback', true);
  assert.equal(store.memorySettings().claudeFallback, true);
  assert.equal(new BlobStore().memorySettings().claudeFallback, true, 'persisted');
});

test('undoSelfChange restores a SOUL once, and refuses a second undo', () => {
  const { rt, store, popo } = setup();
  const before = store.soul(popo.id);
  const cards: Array<{ cardKind: string; undoToken?: string }> = [];
  const tools = rt.toolSpecs({ blobId: popo.id, threadId: 't1', emitCard: (c: { cardKind: string; undoToken?: string }) => { cards.push(c); } } as never);
  const edit = tools.find((t) => t.name === 'edit_soul')!;
  return Promise.resolve(edit.handler({ soul: 'Terse.', change: 'be terse' } as never)).then(() => {
    assert.equal(store.soul(popo.id), 'Terse.');
    const token = cards.find((c) => c.cardKind === 'self-change')!.undoToken!;
    assert.equal(rt.undoSelfChange(token), true);
    assert.equal(store.soul(popo.id), before);
    assert.equal(rt.undoSelfChange(token), false);
    assert.equal(rt.undoSelfChange('undo_nope'), false);
  });
});

test('the shared "About the user" note is one truth: editing it through one blob rewrites every blob\'s memory.md, and a restart never lets a stale copy overwrite it', async () => {
  const { store, rt, mem, popo, bobble, host, oneShot } = setup();
  const mirror = (id: string) => path.join(blobHome(id), 'memory.md');
  mem.setCore('you', popo.id, '- You live in Oslo');
  await rt.refreshCore(popo.id);
  assert.match(fs.readFileSync(mirror(bobble.id), 'utf8'), /You live in Oslo/, 'the other blob\'s file followed');
  // a stale copy from before another blob edited the note (what the old per-blob mirror left behind after a restart)
  fs.writeFileSync(mirror(bobble.id), '## About the user\n- You live in Rome\n\n## My working notes\n');
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(mirror(bobble.id), old, old);
  const rt2 = new BlobRuntimeImpl({ store, memory: host, oneShot, koraCmd: 'kora', userSkillDirs: [] }); // "restart": nothing remembers what rt wrote
  await rt2.turnContext({ blobId: bobble.id, threadId: 'tR', text: 'hello there friend', agent: 'claude', origin: null });
  assert.equal(mem.getCore(bobble.id).you, '- You live in Oslo', 'the stale file did not overwrite the newer note');
  assert.equal(mem.getCore(popo.id).you, '- You live in Oslo');
  assert.match(fs.readFileSync(mirror(bobble.id), 'utf8'), /You live in Oslo/, 'and the file was brought back in step');
  // a hand edit that IS newer than the note still wins
  await new Promise((r) => setTimeout(r, 1800));
  fs.writeFileSync(mirror(bobble.id), '## About the user\n- You live in Lima\n\n## My working notes\n');
  await rt2.turnContext({ blobId: bobble.id, threadId: 'tR2', text: 'hello again friend', agent: 'claude', origin: null });
  assert.equal(mem.getCore(popo.id).you, '- You live in Lima');
  mem.close();
});

test('deleting a blob also removes its usage ledger entry and caches', async () => {
  const { store, rt, mem, popo } = setup();
  rt.usage.record(popo.id, 'tU', { inputTokens: 5, outputTokens: 5 });
  assert.equal(rt.usage.total(popo.id).turns, 1);
  store.delete(popo.id, popo.name, fs.mkdtempSync(path.join(os.tmpdir(), 'trash-')));
  assert.equal(rt.usage.total(popo.id).turns, 0);
  assert.ok(!rt.usage.all().has(popo.id));
  mem.close();
});

test('deleting a blob drops its queued memory work: retry entries and idle-thread summaries never write it back (pl7 S2-4)', async () => {
  const { store, rt, mem, popo, bobble, state } = setup({ script: () => ({ ops: [{ op: 'add', scope: 'blob', text: 'Wants tea at noon.', confidence: 0.9 }] }) });
  state.available = false;
  await rt.afterTurn(turn(popo.id, 'tD', 'I want tea at noon every day please', 1));
  await rt.afterTurn(turn(bobble.id, 'tE', 'I want coffee at nine every day please', 2));
  assert.equal(rt.pendingTurnCount(), 2);
  store.delete(popo.id, popo.name, fs.mkdtempSync(path.join(os.tmpdir(), 'trash-')));
  await rt.forgetBlob(popo.id);
  assert.equal(rt.pendingTurnCount(), 1, 'only the live blob\'s turn is still queued');
  assert.ok(![...(rt as any).dirty.values()].some((d: any) => d.blobId === popo.id), 'no idle summary is pending for it');
  state.available = true;
  let now = Date.now() + 60 * 60_000;
  (rt as any).now = () => now;
  await rt.maintenanceTick();
  assert.equal(mem.searchEpisodes({ blobId: popo.id, query: 'tea noon' }).length, 0, 'nothing of the deleted blob came back');
  now += 1;
  mem.close();
});

test('a delegated (from Kora) turn gets only task-relevant facts, never the user\'s unrelated personal ones', async () => {
  const { rt, mem, popo } = setup();
  await mem.remember({ scope: 'you', blobId: popo.id, text: 'Your sister Priya lives in Lisbon.', important: true });
  await mem.remember({ scope: 'you', blobId: popo.id, text: 'Your dog is named Miso.', important: true });
  const origin = { kind: 'kora' as const, jobId: 'j1', stepId: 's1', fromThreadId: 'k1', fromBlobId: 'blob_kora' };
  const ctx = await rt.turnContext({ blobId: popo.id, threadId: 'tJ', text: 'Summarise the attached file', agent: 'claude', origin });
  assert.doesNotMatch(ctx, /Priya|Miso/);
  const own = await rt.turnContext({ blobId: popo.id, threadId: 'tJ2', text: 'Summarise the attached file', agent: 'claude', origin: null });
  assert.match(own, /Priya|Miso/, 'the user\'s own chat still gets them');
  mem.close();
});
