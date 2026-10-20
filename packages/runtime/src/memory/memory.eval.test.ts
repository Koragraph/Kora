// The fixed memory test set. Every memory change must keep this green.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemory, estimateTokens, type MemoryStore } from './index';
import { aliasOf, clock, fakeExtractor, ops, T0, turn } from './testkit';

function setup(script: Parameters<typeof fakeExtractor>[0]) {
  const c = clock();
  const ex = fakeExtractor(script);
  const mem = openMemory({ dbPath: ':memory:', extractor: ex, now: c.now });
  return { c, ex, mem };
}
const texts = (m: MemoryStore, blobId: string, q: string) => m.recall({ blobId, query: q, touch: false }).then((r) => r.facts.map((f) => f.text));

test('recall across threads', async () => {
  const { mem, c } = setup((u) => (u.includes('Lisbon') ? ops({ op: 'add', scope: 'you', text: 'You live in Lisbon.', confidence: 0.9 }) : ops()));
  await mem.ingestTurn(turn('popo', 'I live in Lisbon these days', c.now(), 'thread-1'));
  const r = await mem.recall({ blobId: 'popo', query: 'where should we hold the meetup in Lisbon?' });
  assert.deepEqual(r.facts.map((f) => f.text), ['You live in Lisbon.']);
  assert.match(r.promptText, /You live in Lisbon/);
  assert.equal(r.facts[0].source.threadId, 'thread-1');
});

test('recall across days; decay drops stale trivia but search still finds it', async () => {
  const { mem, c } = setup((u) =>
    u.includes('oat') ? ops({ op: 'add', scope: 'you', text: 'You like oat milk lattes.', confidence: 0.8 }) : ops({ op: 'add', scope: 'you', text: 'Your name is Dana.', confidence: 0.95, important: true }),
  );
  await mem.ingestTurn(turn('popo', 'I like oat milk lattes', c.now()));
  await mem.ingestTurn(turn('popo', 'My name is Dana, call me Dana', c.now()));
  c.advanceDays(30);
  assert.deepEqual((await texts(mem, 'popo', 'which latte milk should I order')).sort(), ['You like oat milk lattes.', 'Your name is Dana.']);
  c.advanceDays(200);
  assert.deepEqual(await texts(mem, 'popo', 'which latte milk should I order'), ['Your name is Dana.'], 'stale trivia left recall; important stays');
  assert.equal(mem.searchFacts({ blobId: 'popo', query: 'oat latte' }).length, 1, 'but is still searchable');
  assert.ok((await texts(mem, 'popo', 'anything at all')).includes('Your name is Dana.'), 'important facts never decay');
});

test('recalled facts stay alive (usage refreshes decay)', async () => {
  const { mem, c } = setup(() => ops({ op: 'add', scope: 'you', text: 'You run a bakery called Crumb.', confidence: 0.9 }));
  await mem.ingestTurn(turn('popo', 'I run a bakery called Crumb', c.now()));
  for (let i = 0; i < 4; i++) {
    c.advanceDays(60);
    assert.equal((await mem.recall({ blobId: 'popo', query: 'bakery Crumb' })).facts.length, 1);
  }
});

test('shared "you" fact is visible to another blob; private blob note is not', async () => {
  const { mem, c } = setup((u) =>
    u.includes('Sam')
      ? ops({ op: 'add', scope: 'you', text: 'Sam is the cofounder.', confidence: 0.9 })
      : ops({ op: 'add', scope: 'blob', text: 'Wants research summaries as three bullets.', confidence: 0.9 }),
  );
  await mem.ingestTurn(turn('popo', 'Sam is my cofounder', c.now()));
  await mem.ingestTurn(turn('popo', 'give me research summaries as three bullets', c.now()));
  const other = await mem.recall({ blobId: 'bobble', query: 'who is Sam, and how do research summaries look?' });
  assert.deepEqual(other.facts.map((f) => f.text), ['Sam is the cofounder.']);
  assert.ok(!other.promptText.includes('bullets'));
  assert.equal(mem.searchFacts({ blobId: 'bobble', query: 'research summaries bullets' }).length, 0);
  assert.equal(mem.listFacts({ blobId: 'bobble' }).length, 1);
  assert.equal(mem.listFacts({ scope: 'blob', blobId: 'bobble' }).length, 0);
  assert.equal((await mem.recall({ blobId: 'popo', query: 'research summaries bullets' })).facts.length, 1);
  // episodes are private too
  assert.equal(mem.searchEpisodes({ blobId: 'bobble', query: 'research summaries' }).length, 0);
  assert.ok(mem.searchEpisodes({ blobId: 'popo', query: 'research summaries' }).length > 0);
});

test('team facts are only visible to the Chief', async () => {
  const { mem, c } = setup(() => ops({ op: 'add', scope: 'team', text: 'Dimp is good at market research.', confidence: 0.9 }));
  await mem.ingestTurn({ ...turn('kora', 'Dimp did great research for me', c.now()), allowTeam: true });
  assert.equal((await mem.recall({ blobId: 'popo', query: 'who is good at market research', includeTeam: true })).facts.length, 1, 'includeTeam is the caller\'s switch');
  assert.equal((await mem.recall({ blobId: 'popo', query: 'who is good at market research' })).facts.length, 0);
  // a non-chief turn cannot write team scope
  const s2 = setup(() => ops({ op: 'add', scope: 'team', text: 'Pretends to be team.', confidence: 0.9 }));
  await s2.mem.ingestTurn(turn('popo', 'something something team', s2.c.now()));
  assert.equal(s2.mem.listFacts({ scope: 'team' }).length, 0);
});

test('a correction retires the old fact for every blob immediately', async () => {
  const { mem, c } = setup((u, p) =>
    u.includes('eat meat')
      ? ops({ op: 'add', scope: 'you', text: 'You eat meat.', confidence: 0.9 })
      : ops({ op: 'update', scope: 'you', target: aliasOf(p, 'eat meat'), text: 'You are vegetarian.', explicit: true, confidence: 0.95 }),
  );
  await mem.ingestTurn(turn('popo', 'I eat meat, mostly chicken', c.now()));
  assert.equal((await texts(mem, 'bobble', 'what should we cook for dinner, any meat?')).length, 1);
  c.advanceDays(2);
  const rec = await mem.ingestTurn(turn('bobble', "that's wrong, I'm vegetarian now, no meat", c.now()));
  assert.equal(rec[0].kind, 'updated');
  for (const b of ['popo', 'bobble', 'dimp']) {
    const t = await texts(mem, b, 'what should we cook for dinner, any meat? vegetarian?');
    assert.deepEqual(t, ['You are vegetarian.'], `blob ${b}`);
  }
  const old = mem.listFacts({ includeRetired: true }).find((f) => f.text === 'You eat meat.')!;
  assert.ok(old.until && old.retiredReason === 'corrected' && old.supersededBy);
});

test('a contradiction that cannot be resolved is flagged as a question, not applied', async () => {
  const { mem, c } = setup((u, p) =>
    u.includes('mornings')
      ? ops({ op: 'add', scope: 'you', text: 'You prefer mornings for meetings.', confidence: 0.9, important: true })
      : ops({ op: 'update', scope: 'you', target: aliasOf(p, 'mornings'), text: 'You prefer afternoons for meetings.', confidence: 0.8 }),
  );
  await mem.ingestTurn(turn('popo', 'I prefer mornings for meetings', c.now()));
  c.advanceDays(10);
  const rec = await mem.ingestTurn(turn('popo', 'can we do meetings in the afternoon this week', c.now()));
  assert.equal(rec.length, 0);
  assert.deepEqual(mem.listFacts().map((f) => f.text), ['You prefer mornings for meetings.']);
  const qs = mem.pendingQuestions('popo');
  assert.equal(qs.length, 1);
  assert.equal(qs[0].proposed, 'You prefer afternoons for meetings.');
  const r = await mem.recall({ blobId: 'popo', query: 'schedule a meeting' });
  assert.match(r.promptText, /Unsure/);
  // asked once; not nagged again right away
  assert.doesNotMatch((await mem.recall({ blobId: 'popo', query: 'schedule a meeting' })).promptText, /Unsure/);
  const res = await mem.resolveQuestion(qs[0].id, 'new');
  assert.equal(res?.kind, 'updated');
  assert.deepEqual(mem.listFacts().map((f) => f.text), ['You prefer afternoons for meetings.']);
  assert.equal(mem.pendingQuestions('popo').length, 0);
});

test('tidy merges duplicates (keeps importance), is idempotent', async () => {
  const { mem, c } = setup(() => ({ merge: [], conflicts: [] }));
  await mem.addFact({ scope: 'you', text: 'Works at Acme Robotics as a designer.' });
  await mem.addFact({ scope: 'you', text: 'Works as a designer at Acme Robotics.', important: true });
  await mem.addFact({ scope: 'you', text: 'Has a dog named Pixel.' });
  c.advanceDays(1);
  const rep = await mem.tidy();
  assert.equal(rep.dedupedFacts, 1);
  const active = mem.listFacts();
  assert.equal(active.length, 2);
  assert.ok(active.find((f) => /designer/.test(f.text))!.important);
  const rep2 = await mem.tidy();
  assert.equal(rep2.dedupedFacts, 0);
  assert.equal(rep2.llmCalls, 0, 'unchanged groups are skipped');
  // undo of an automatic merge restores the duplicate
  assert.ok(mem.undo(rep.receipts[0].id));
  assert.equal(mem.listFacts().length, 3);
});

test('tidy applies LLM merge/contradiction decisions safely and asks when unsure', async () => {
  let reply: object = { merge: [], conflicts: [] };
  const { mem, c } = setup(() => reply);
  const a = await mem.addFact({ scope: 'you', text: 'Lives in Dallas.' });
  c.advanceDays(30);
  const b = await mem.addFact({ scope: 'you', text: 'Moved to Austin.' });
  void a;
  void b;
  reply = { merge: [{ keep: 'F9', drop: ['F1'] }], conflicts: [{ older: 'F1', newer: 'F2', resolution: 'newer' }] };
  const rep = await mem.tidy();
  assert.equal(rep.contradictionsResolved, 1);
  assert.deepEqual(mem.listFacts().map((f) => f.text), ['Moved to Austin.']);

  const s2 = setup(() => ({ merge: [], conflicts: [{ older: 'F1', newer: 'F2', resolution: 'ask' }] }));
  await s2.mem.addFact({ scope: 'you', text: 'Prefers tea.' });
  s2.c.advanceDays(1);
  await s2.mem.addFact({ scope: 'you', text: 'Prefers coffee.' });
  const r2 = await s2.mem.tidy();
  assert.equal(r2.questionsRaised, 1);
  assert.equal(s2.mem.listFacts().length, 2, 'unsure → nothing retired');
  assert.equal(s2.mem.pendingQuestions('anyone').length, 1);
});

test('sensitive and low-confidence items go pending until approved', async () => {
  const { mem, c } = setup((u) =>
    u.includes('anxiety')
      ? ops({ op: 'add', scope: 'you', text: 'You take medication for anxiety.', confidence: 0.95 })
      : u.includes('maybe')
        ? ops({ op: 'add', scope: 'you', text: 'You might switch to Linux.', confidence: 0.4 })
        : ops({ op: 'add', scope: 'you', text: 'Maya is going through a divorce.', confidence: 0.9, sensitive: true }),
  );
  const r1 = await mem.ingestTurn(turn('popo', 'I take medication for my anxiety', c.now()));
  const r2 = await mem.ingestTurn(turn('popo', 'maybe I will switch to Linux', c.now()));
  const r3 = await mem.ingestTurn(turn('popo', 'my sister is going through something', c.now()));
  assert.deepEqual([r1[0].kind, r2[0].kind, r3[0].kind], ['pending', 'pending', 'pending']);
  assert.equal(mem.listFacts().length, 0);
  assert.equal(mem.listPending().length, 3);
  assert.equal((await texts(mem, 'popo', 'anxiety medication')).length, 0, 'pending is never recalled');
  const ok = await mem.approvePending(r1[0].pendingId!);
  assert.equal(ok?.kind, 'added');
  assert.deepEqual(await texts(mem, 'popo', 'anxiety medication'), ['You take medication for anxiety.']);
  assert.ok(mem.rejectPending(r2[0].pendingId!));
  assert.equal(mem.approvePending(r2[0].pendingId!) instanceof Promise, true);
  assert.equal(await mem.approvePending(r2[0].pendingId!), null, 'rejected stays rejected');
  assert.equal(mem.listPending().length, 1);
});

test('undo restores prior state for added, updated and retired', async () => {
  const { mem, c } = setup((u, p) =>
    u.startsWith('I live')
      ? ops({ op: 'add', scope: 'you', text: 'You live in Dallas.', confidence: 0.9 })
      : u.startsWith('Moved')
        ? ops({ op: 'update', scope: 'you', target: aliasOf(p, 'Dallas'), text: 'You live in Austin.', explicit: true, confidence: 0.9 })
        : ops({ op: 'retire', scope: 'you', target: aliasOf(p, 'Dallas'), explicit: true }),
  );
  const [added] = await mem.ingestTurn(turn('popo', 'I live in Dallas', c.now()));
  const [updated] = await mem.ingestTurn(turn('popo', 'Moved to Austin, Dallas is wrong', c.now()));
  assert.deepEqual(mem.listFacts().map((f) => f.text), ['You live in Austin.']);
  assert.ok(mem.undo(updated.id));
  assert.deepEqual(mem.listFacts().map((f) => f.text), ['You live in Dallas.']);
  assert.equal(mem.undo(updated.id), false, 'undo is one-shot');
  const [retired] = await mem.ingestTurn(turn('popo', 'forget where I live, Dallas is gone', c.now()));
  assert.equal(retired.kind, 'retired');
  assert.equal(mem.listFacts().length, 0);
  assert.ok(mem.undo(retired.id));
  assert.equal(mem.listFacts().length, 1);
  assert.ok(mem.undo(added.id));
  assert.equal(mem.listFacts().length, 0);
});

test('recall never exceeds its budget', async () => {
  const { mem } = setup(() => ops());
  for (let i = 0; i < 80; i++) await mem.addFact({ scope: 'you', text: `Project ${i} uses the quarterly report format number ${i} with extra detail words here.`, important: i % 3 === 0 });
  mem.setCore('you', 'popo', '- Name is Dana.');
  for (const budget of [0, 30, 120, 300, 1000]) {
    const r = await mem.recall({ blobId: 'popo', query: 'quarterly report format project', budgetTokens: budget });
    assert.ok(r.tokens.memory <= budget, `memory ${r.tokens.memory} <= ${budget}`);
    assert.ok(estimateTokens(r.promptText) <= budget + r.tokens.core + 2);
  }
  assert.throws(() => mem.setCore('you', 'popo', 'x'.repeat(4000)), /too long/);
  assert.equal(mem.getCore('popo').you, '- Name is Dana.', 'a rejected rewrite leaves the note intact');
});

test('garbage extractor output never corrupts memory', async () => {
  let current: unknown = '';
  const { mem, c } = setup(() => {
    if (current === '__throw__') throw new Error('network down');
    return current as string;
  });
  const msg = 'this message is long enough';
  const garbage: unknown[] = [
    'lol sorry I cannot help',
    '',
    '{"ops": "nope"}',
    '[1,2,3]',
    '```json\n{"ops":[{"op":"add","text":"half"\n```',
    '__throw__',
    JSON.stringify({ ops: [{ op: 'explode', text: 'x' }, { op: 'add' }, 7, null, { op: 'retire', target: 'F9', explicit: true }] }),
    JSON.stringify({ ops: [{ op: 'add', scope: 'you', text: 'my password is hunter2hunter2', confidence: 0.99 }, { op: 'add', scope: 'you', text: 'card 4111 1111 1111 1111', confidence: 0.99 }] }),
  ];
  for (const g of garbage) {
    current = g;
    assert.deepEqual(await mem.ingestTurn(turn('popo', msg, c.now())), [], `garbage: ${String(g).slice(0, 30)}`);
  }
  assert.equal(mem.stats().facts.active + mem.stats().facts.retired, 0);
  assert.equal(mem.stats().pending, 0, 'secrets are not even held as pending');

  current = JSON.stringify({ ops: [{ op: 'update', text: 'You have a dog named Pixel.', target: 'F42', confidence: 0.9, scope: 'you' }] });
  assert.equal((await mem.ingestTurn(turn('popo', msg, c.now())))[0].kind, 'added');
  current = '```json\n{"ops":[{"op":"add","scope":"you","text":"You like fenced code blocks.","confidence":"0.9"}]}\n```';
  assert.equal((await mem.ingestTurn(turn('popo', msg, c.now())))[0].kind, 'added');
  assert.deepEqual(mem.listFacts().map((f) => f.text).sort(), ['You have a dog named Pixel.', 'You like fenced code blocks.']);
  // raw turns were indexed for episode search even when extraction failed
  assert.ok(mem.searchEpisodes({ query: 'message long enough' }).length > 0);
});
