// Live QA 2026-10-09: "I moved to Austin" left "Lives in Dallas" active, Undo failed on a fresh receipt, and a health fact
// saved silently. These pin the fixes: the model-facing remember is contradiction-aware, obvious corrections need no model,
// retired facts never come back, Undo survives automatic changes, sensitive items are held on every path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemory, type MemoryStore } from './index';
import { openDb } from './db';
import { scrubCore, writeCore, readCore } from './core';
import { detectCorrections, slotOf } from './corrections';
import { subjectOf } from './subject';
import type { Ctx } from './ctx';
import { clock, fakeExtractor, ops, turn } from './testkit';

const dead = async () => { throw new Error('no extractor available'); };
function open(extractor: (r: { system: string; prompt: string; maxTokens: number }) => Promise<string> = dead) {
  const c = clock();
  const mem = openMemory({ dbPath: ':memory:', extractor, now: c.now });
  return { c, mem };
}
const active = (m: MemoryStore) => m.listFacts({ blobId: 'popo' }).map((f) => f.text);
const recalled = async (m: MemoryStore, q: string) => (await m.recall({ blobId: 'popo', query: q, touch: false })).promptText;

test('remember: a new value for the same slot retires the old fact in one step, with an "Updated ... (was ...)" receipt', async () => {
  const { mem } = open();
  const a = await mem.remember({ scope: 'you', blobId: 'popo', text: 'You live in Dallas.' });
  assert.equal(a.outcome, 'added');
  const b = await mem.remember({ scope: 'you', blobId: 'popo', text: 'You live in Austin.' });
  assert.equal(b.outcome, 'updated');
  assert.equal(b.receipt?.kind, 'updated');
  assert.equal(b.receipt?.previousText, 'You live in Dallas.');
  assert.deepEqual(active(mem), ['You live in Austin.']);
  assert.equal(mem.getFact(a.fact!.id)?.until != null, true);
  assert.equal(mem.getFact(a.fact!.id)?.supersededBy, b.fact!.id);
  // recall (prompt injection) and the recall tool's search never surface the retired fact
  const p = await recalled(mem, 'where do I live?');
  assert.match(p, /Austin/);
  assert.doesNotMatch(p, /Dallas/);
  assert.equal(mem.searchFacts({ blobId: 'popo', query: 'Dallas' }).length, 0);
  assert.equal(mem.searchFacts({ blobId: 'popo', query: 'Dallas', includeRetired: true }).length, 1);
});

test('remember: `replaces` names the old fact when the words do not overlap; restating is a no-op', async () => {
  const { mem } = open();
  await mem.remember({ scope: 'you', blobId: 'popo', text: 'You are vegetarian.' });
  const r = await mem.remember({ scope: 'you', blobId: 'popo', text: 'You eat fish and chicken since the move.', replaces: 'vegetarian' });
  assert.equal(r.outcome, 'updated');
  assert.deepEqual(active(mem), ['You eat fish and chicken since the move.']);
  const again = await mem.remember({ scope: 'you', blobId: 'popo', text: 'You eat fish and chicken since the move.' });
  assert.equal(again.outcome, 'duplicate');
  assert.equal(again.receipt, undefined);
  // an unrelated fact is just added next to it
  assert.equal((await mem.remember({ scope: 'you', blobId: 'popo', text: 'Sam is the cofounder.' })).outcome, 'added');
});

test('remember: a near-restatement with one word changed replaces; an unrelated fact with the same verb does not', async () => {
  const { mem } = open();
  await mem.remember({ scope: 'you', blobId: 'popo', text: 'You prefer morning meetings.' });
  await mem.remember({ scope: 'you', blobId: 'popo', text: 'You prefer dark roast coffee.' });
  const r = await mem.remember({ scope: 'you', blobId: 'popo', text: 'You prefer afternoon meetings.' });
  assert.equal(r.outcome, 'updated');
  assert.deepEqual(active(mem).sort(), ['You prefer afternoon meetings.', 'You prefer dark roast coffee.']);
});

test('Undo works on a fresh receipt, even after the fact was auto-starred important or recalled', async () => {
  const { mem } = open();
  const r = await mem.remember({ scope: 'you', blobId: 'popo', text: 'You like oat milk lattes.', important: true });
  assert.ok(r.receipt?.id);
  mem.markImportant(r.fact!.id, true);
  await recalled(mem, 'which latte milk');           // recall touches last_used_at / use_count
  assert.equal(mem.undo(r.receipt!.id), true);
  assert.deepEqual(active(mem), []);
  assert.equal(mem.undo(r.receipt!.id), false, 'a second undo is refused');
  // undoing an "Updated" brings the old fact back and removes the new one
  await mem.remember({ scope: 'you', blobId: 'popo', text: 'You live in Dallas.' });
  const u = await mem.remember({ scope: 'you', blobId: 'popo', text: 'You live in Austin.' });
  assert.equal(mem.undo(u.receipt!.id), true);
  assert.deepEqual(active(mem), ['You live in Dallas.']);
});

test('Undo is refused only when the USER rewrote the fact', async () => {
  const { mem } = open();
  const r = await mem.remember({ scope: 'you', blobId: 'popo', text: 'You work nights.' });
  await mem.editFact(r.fact!.id, { text: 'Works night shifts at the hospital.' });
  assert.equal(mem.undo(r.receipt!.id), false);
  assert.deepEqual(active(mem), ['Works night shifts at the hospital.']);
});

test('sensitive facts are held (Approve / Not this) on the remember path, not saved', async () => {
  const { mem } = open();
  const r = await mem.remember({ scope: 'you', blobId: 'popo', text: 'You are allergic to penicillin.' });
  assert.equal(r.outcome, 'held');
  assert.equal(r.reason, 'sensitive');
  assert.deepEqual(active(mem), []);
  assert.equal(mem.listPending({ blobId: 'popo' }).length, 1);
  assert.doesNotMatch(await recalled(mem, 'any allergies penicillin?'), /penicillin/);
  const saved = await mem.approvePending(r.pendingId!);
  assert.equal(saved?.kind, 'added');
  assert.deepEqual(active(mem), ['You are allergic to penicillin.']);
  // "Not this" drops it
  const r2 = await mem.remember({ scope: 'you', blobId: 'popo', text: 'You take medication for anxiety.' });
  assert.equal(mem.rejectPending(r2.pendingId!), true);
  assert.equal(active(mem).length, 1);
});

test('remember refuses secrets and empty text', async () => {
  const { mem } = open();
  await assert.rejects(mem.remember({ scope: 'you', blobId: 'popo', text: 'My password is hunter2hunter2' }));
  await assert.rejects(mem.remember({ scope: 'you', blobId: 'popo', text: '   ' }));
});

test('a private blob note is not retired by another blob remembering a contradictory slot', async () => {
  const { mem } = open();
  await mem.remember({ scope: 'blob', blobId: 'popo', text: 'Lives in Dallas (for the tax project).' });
  await mem.remember({ scope: 'you', blobId: 'wobbo', text: 'You live in Austin.' });
  assert.equal(mem.listFacts({ scope: 'blob', blobId: 'popo' }).length, 1);
});

test('deterministic pre-pass: "I moved to Austin" replaces Dallas with NO extractor (it is down)', async () => {
  const { mem, c } = open();
  await mem.remember({ scope: 'you', blobId: 'popo', text: 'You live in Dallas.' });
  const receipts = await mem.ingestTurn(turn('popo', 'Quick update, I moved to Austin last week.', c.now()));
  assert.deepEqual(active(mem), ['You live in Austin.']);
  assert.equal(receipts.length, 1, 'the receipt is returned even though the extractor failed');
  assert.equal(receipts[0].kind, 'updated');
  assert.equal(receipts[0].previousText, 'You live in Dallas.');
  assert.doesNotMatch(await recalled(mem, 'where do I live'), /Dallas/);
  // idempotent: the queued retry of the same turn changes nothing
  const again = await mem.ingestTurn(turn('popo', 'Quick update, I moved to Austin last week.', c.now()));
  assert.equal(again.length, 0);
  assert.deepEqual(active(mem), ['You live in Austin.']);
});

test('deterministic pre-pass: "I live in Austin now, not Dallas" and "actually" corrections', async () => {
  const { mem, c } = open();
  await mem.remember({ scope: 'you', blobId: 'popo', text: 'You live in Dallas.' });
  await mem.ingestTurn(turn('popo', 'I live in Austin now, not Dallas.', c.now()));
  assert.deepEqual(active(mem), ['You live in Austin.']);
  await mem.remember({ scope: 'you', blobId: 'popo', text: 'You work at Initech.' });
  await mem.ingestTurn(turn('popo', "That's wrong, I work at Acme Corp now.", c.now()));
  assert.deepEqual(active(mem).sort(), ['You live in Austin.', 'You work at Acme Corp.']);
});

test('deterministic pre-pass: "not X anymore" retires the matching fact; unrelated phrases retire nothing', async () => {
  const { mem, c } = open();
  await mem.remember({ scope: 'you', blobId: 'popo', text: 'You eat meat.' });
  await mem.remember({ scope: 'you', blobId: 'popo', text: 'You drink coffee every morning.' });
  const r = await mem.ingestTurn(turn('popo', "I don't eat meat anymore.", c.now()));
  assert.equal(r.some((x) => x.kind === 'retired'), true);
  assert.deepEqual(active(mem), ['You drink coffee every morning.']);
  await mem.ingestTurn(turn('popo', "I'm not sure anymore what we agreed on.", c.now()));
  assert.deepEqual(active(mem), ['You drink coffee every morning.']);
  // Undo on the retire brings it back
  assert.equal(mem.undo(r.find((x) => x.kind === 'retired')!.id), true);
  assert.equal(active(mem).length, 2);
});

test('the pre-pass runs before the model, so a model that also answers does not duplicate', async () => {
  const ex = fakeExtractor((u) => (u.includes('Austin') ? ops({ op: 'add', scope: 'you', text: 'You live in Austin.', confidence: 0.9, explicit: true }) : ops()));
  const { mem, c } = open(ex);
  await mem.remember({ scope: 'you', blobId: 'popo', text: 'You live in Dallas.' });
  await mem.ingestTurn(turn('popo', 'I moved to Austin.', c.now()));
  assert.deepEqual(active(mem), ['You live in Austin.']);
});

test('a retired fact is scrubbed from the machine-written Core notes (and replaced); user-written notes are untouched', () => {
  const ctx = { db: openDb(':memory:'), now: () => 1, closed: false } as unknown as Ctx;
  writeCore(ctx, 'you', '', 'Lives in Dallas and works at Initech. Likes oat milk.', 'auto');
  scrubCore(ctx, 'You live in Dallas.', 'You live in Austin.');
  const t = readCore(ctx, 'you')!.text;
  assert.doesNotMatch(t, /Dallas/);
  assert.match(t, /Austin/);
  assert.match(t, /Initech/);
  assert.match(t, /oat milk/);
  writeCore(ctx, 'blob', 'popo', 'I live in Dallas, my own words.', 'user');
  scrubCore(ctx, 'You live in Dallas.');
  assert.match(readCore(ctx, 'blob', 'popo')!.text, /Dallas/);
});

test('detectCorrections: slots and guardrails', () => {
  assert.deepEqual(slotOf('Lives in Dallas, Texas.'), { slot: 'residence', value: 'dallas', subject: 'user' });
  assert.equal(slotOf('Likes oat milk lattes.'), null);
  assert.equal(slotOf('The dog is called Biscuit.'), null);
  assert.deepEqual(detectCorrections('I moved to Austin', []), [], 'nothing stored, nothing to replace');
  assert.deepEqual(detectCorrections('hello there, how are you today', []), []);
});

// ---- final QA 2026-10-10 (memory) ----

test('remember: a fact about the user\'s sister never retires the user\'s own residence (with or without a replaces hint)', async () => {
  const { mem } = open();
  await mem.remember({ scope: 'you', blobId: 'popo', text: 'You live in Austin.' });
  const a = await mem.remember({ scope: 'you', blobId: 'popo', text: 'Your sister Priya lives in Lisbon.' });
  assert.equal(a.outcome, 'added');
  assert.equal(a.previous, undefined);
  const b = await mem.remember({ scope: 'you', blobId: 'popo', text: 'Your dog Rex lives in Porto.', replaces: 'lives in Austin' });
  assert.equal(b.outcome, 'added', 'a replaces hint cannot cross subjects');
  assert.deepEqual(active(mem).sort(), ['Your dog Rex lives in Porto.', 'Your sister Priya lives in Lisbon.', 'You live in Austin.'].sort());
  // the same hint on a same-subject fact still works
  const c = await mem.remember({ scope: 'you', blobId: 'popo', text: 'You live in Berlin.', replaces: 'lives in Austin' });
  assert.equal(c.outcome, 'updated');
  assert.ok(active(mem).includes('Your sister Priya lives in Lisbon.'));
});

test('subjectOf: "Your <relative> ..." is about the relative', () => {
  assert.equal(subjectOf('Your sister Priya lives in Lisbon.').kind, 'other');
  assert.equal(subjectOf('Your wife works at Initech.').kind, 'other');
  assert.equal(subjectOf('Your favourite tea is oolong.').kind, 'user');
  assert.equal(subjectOf('You live in Austin.').kind, 'user');
});

test('forget removes the raw exchange, the search index and the receipts too; the blob cannot quote it back', async () => {
  const { mem, c } = open();
  const r = await mem.remember({ scope: 'you', blobId: 'popo', text: 'Your favourite tea is oolong.', threadId: 't1', messageId: 'u9' });
  // the raw exchange of that message
  const ex = fakeExtractor(() => ops());
  const m2 = openMemory({ dbPath: ':memory:', extractor: ex, now: c.now });
  await m2.ingestTurn({ blobId: 'popo', threadId: 't1', messageId: 'u9', userText: 'my favourite tea is oolong, remember it', assistantText: 'Noted.', at: c.now() });
  const f = await m2.remember({ scope: 'you', blobId: 'popo', text: 'Your favourite tea is oolong.', threadId: 't1', messageId: 'u9' });
  assert.ok(m2.searchEpisodes({ query: 'oolong tea' }).length > 0);
  assert.ok(m2.listReceipts({ blobId: 'popo' }).some((x) => /oolong/.test(x.text)));
  m2.forgetFact(f.fact!.id);
  assert.deepEqual(m2.searchEpisodes({ query: 'oolong tea' }), []);
  assert.ok(!m2.listReceipts({ blobId: 'popo' }).some((x) => /oolong/.test(x.text)));
  assert.equal(m2.stats().turns, 0);
  void r;
});

test('forget a tool-captured fact (no message link): the thread\'s raw turn that says it goes too, unrelated turns stay', async () => {
  const c = clock();
  const m = openMemory({ dbPath: ':memory:', extractor: dead, now: c.now });
  await m.ingestTurn({ blobId: 'popo', threadId: 't7', messageId: 'u1', userText: 'my favourite tea is oolong, remember it', assistantText: 'Noted.', at: c.now() });
  await m.ingestTurn({ blobId: 'popo', threadId: 't7', messageId: 'u2', userText: 'what is a good podcast about gardening', assistantText: 'Try one.', at: c.now() });
  const f = await m.remember({ scope: 'you', blobId: 'popo', text: 'Your favourite tea is oolong.', threadId: 't7' });
  m.forgetFact(f.fact!.id);
  assert.deepEqual(m.searchEpisodes({ query: 'oolong tea' }), []);
  assert.ok(m.searchEpisodes({ query: 'gardening podcast' }).length > 0);
});

test('forget a tool-captured fact whose thread id differs from the turns\' (daemon id vs UI id): the raw turn still goes', async () => {
  const c = clock();
  const m = openMemory({ dbPath: ':memory:', extractor: dead, now: c.now });
  await m.ingestTurn({ blobId: 'popo', threadId: 'ui-uuid-1', messageId: 'u1', userText: 'my sister Priya lives in Lisbon, remember it', assistantText: 'Noted.', at: c.now() });
  await m.ingestTurn({ blobId: 'popo', threadId: 'ui-uuid-1', messageId: 'u2', userText: 'what is a good podcast about gardening', assistantText: 'Try one.', at: c.now() });
  const f = await m.remember({ scope: 'you', blobId: 'popo', text: 'Your sister Priya lives in Lisbon.', threadId: 't_daemon_9' });
  m.forgetFact(f.fact!.id);
  assert.deepEqual(m.searchEpisodes({ query: 'Priya Lisbon' }), []);
  assert.ok(m.searchEpisodes({ query: 'gardening podcast' }).length > 0);
});

test('double capture (tool + extractor) is one fact, and the extractor pass supplies the missing source link', async () => {
  const ex = fakeExtractor((u) => (/oolong/.test(u) ? ops({ op: 'add', scope: 'you', text: 'Your favourite tea is oolong.', confidence: 0.9 }) : ops()));
  const { mem, c } = open(ex);
  const t = await mem.remember({ scope: 'you', blobId: 'popo', text: 'Your favourite tea is oolong.', threadId: 't1' });
  assert.equal(mem.getFact(t.fact!.id)!.source.messageId, null);
  await mem.ingestTurn({ ...turn('popo', 'my favourite tea is oolong, remember it', c.now(), 't1'), userMessageId: 'u42' });
  const all = mem.listFacts({ blobId: 'popo' }).filter((f) => /oolong/.test(f.text));
  assert.equal(all.length, 1, 'no duplicate');
  assert.equal(all[0]!.source.messageId, 'u42');
  assert.equal(all[0]!.source.threadId, 't1');
});

test('a hand-written Core note that states a fact the user just corrected raises a question instead of silently contradicting', async () => {
  const { mem } = open();
  mem.setCore('you', 'popo', '- You live in Austin.');
  const a = await mem.remember({ scope: 'you', blobId: 'popo', text: 'You live in Austin.' });
  const b = await mem.remember({ scope: 'you', blobId: 'popo', text: 'You live in Berlin.', replaces: a.fact!.id });
  assert.equal(b.outcome, 'updated');
  const qs = mem.pendingQuestions('popo');
  assert.equal(qs.length, 1);
  assert.match(qs[0]!.text, /Your note still says "You live in Austin\."/);
  assert.equal(mem.getCore('popo').you, '- You live in Austin.', 'the user\'s note is never edited behind their back');
});

test('recall for a handed-over task: only facts that match the task, at most 3, no unrelated important facts riding along', async () => {
  const { mem } = open();
  await mem.remember({ scope: 'you', blobId: 'popo', text: 'Your sister Priya lives in Lisbon.', important: true });
  await mem.remember({ scope: 'you', blobId: 'popo', text: 'Your dog is named Miso.', important: true });
  await mem.remember({ scope: 'you', blobId: 'popo', text: 'You prefer summaries in bullet points.' });
  const normal = await mem.recall({ blobId: 'popo', query: 'summarise this file into bullet points', touch: false });
  assert.match(normal.promptText, /Priya/, 'a normal turn lets important facts ride along');
  const task = await mem.recall({ blobId: 'popo', query: 'summarise this file into bullet points', touch: false, taskScoped: true });
  assert.doesNotMatch(task.promptText, /Priya|Miso/);
  assert.match(task.promptText, /bullet points/);
});
