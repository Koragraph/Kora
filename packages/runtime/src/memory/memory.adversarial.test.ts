// The adversarial memory set (live QA #2, 2026-10-09). A weak free extractor, a careless blob and an ambiguous user message must
// never corrupt what memory believes about the USER. Every case below is a way the live run actually went wrong, or the
// closest variation of it. The extractor here is deliberately BAD: it says whatever the scenario needs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemory, type MemoryStore } from './index';
import { aliasOf, clock, fakeExtractor, ops, turn, type Script } from './testkit';
import { correctionEvidence, firstPersonBefore, hasUngroundedDetail, isOtherPersonContact, renderFact, retireEvidence, subjectOf, toYouForm, withExplicitSubject } from './subject';
import { detectCorrections } from './corrections';
import type { Fact } from './types';

function open(script: Script = () => ops()) {
  const c = clock();
  const mem = openMemory({ dbPath: ':memory:', extractor: fakeExtractor(script), now: c.now });
  return { c, mem };
}
const active = (m: MemoryStore) => m.listFacts().map((f) => f.text).sort();
const fact = (text: string): Fact => ({ id: 'f', scope: 'you', text, since: 1, confidence: 1, important: false, createdAt: 1, lastUsedAt: 1, useCount: 0, source: { threadId: null, messageId: null } });

async function seeded(script: Script) {
  const s = open(script);
  await s.mem.remember({ scope: 'you', blobId: 'popo', text: 'You live in Dallas.' });
  await s.mem.remember({ scope: 'you', blobId: 'popo', text: 'Sam is your cofounder.' });
  return s;
}

// ---------- the Dallas / Austin / Sam corruption ----------

test('"my friend Sam moved to Austin" never replaces where the USER lives (the model says it did, explicitly)', async () => {
  for (const reply of [
    { op: 'update', scope: 'you', target: 'DALLAS', text: 'Lives in Austin.', explicit: true, confidence: 0.95 }, // subject-less, the live bug
    { op: 'update', scope: 'you', target: 'DALLAS', text: 'You live in Austin.', explicit: true, confidence: 0.95 }, // lying about the subject
    { op: 'update', scope: 'you', target: 'DALLAS', text: 'The user lives in Austin (moved from Dallas in September 2026).', explicit: true, confidence: 0.95 }, // the live text, with a made-up date
    { op: 'retire', target: 'DALLAS', explicit: true },
  ]) {
    const { mem, c } = await seeded((_u, p) => ops({ ...reply, target: aliasOf(p, 'Dallas') }));
    const rec = await mem.ingestTurn(turn('popo', 'My friend Sam moved to Austin last month, we should plan a visit.', c.now()));
    assert.deepEqual(active(mem), ['Sam is your cofounder.', 'You live in Dallas.'], JSON.stringify(reply));
    assert.equal(rec.filter((r) => r.kind === 'retired' || r.kind === 'updated').length, 0);
    assert.equal(mem.pendingQuestions('popo').length, 0, 'about somebody else: nothing to ask either');
  }
});

test('deterministic pre-pass: somebody else moving, working or quitting never touches the user\'s facts', async () => {
  const { mem, c } = await seeded(() => ops());
  await mem.remember({ scope: 'you', blobId: 'popo', text: 'You eat meat.' });
  await mem.remember({ scope: 'you', blobId: 'popo', text: 'You work at Initech.' });
  for (const msg of [
    'Sam moved to Austin last week.',
    'Sam just moved to Austin, I am jealous.',
    'My brother relocated to Austin.',
    'They live in Austin now.',
    'He works at Acme now and loves it.',
    'Sam no longer eats meat anymore.',
    "My sister doesn't eat meat anymore.",
    'My cofounder Sam started at Acme last week.',
    'I told Sam that she lives in Austin now, not Dallas.',
  ]) {
    const rec = await mem.ingestTurn(turn('popo', msg, c.now()));
    assert.equal(rec.length, 0, msg);
  }
  assert.deepEqual(active(mem), ['Sam is your cofounder.', 'You eat meat.', 'You live in Dallas.', 'You work at Initech.']);
  // and the user's own words still do (no model at all)
  await mem.ingestTurn(turn('popo', 'Update: I moved to Austin last month.', c.now()));
  assert.ok(active(mem).includes('You live in Austin.') && !active(mem).includes('You live in Dallas.'));
});

test('"where do I live" and "where does Sam live" each read a fact with an explicit subject', async () => {
  const { mem } = open();
  await mem.remember({ scope: 'you', blobId: 'popo', text: 'You live in Dallas.' });
  await mem.remember({ scope: 'you', blobId: 'popo', text: 'Sam lives in Austin.' });
  const r = await mem.recall({ blobId: 'popo', query: 'where do I live, and where does Sam live?', touch: false });
  assert.match(r.memoryBlock, /You live in Dallas/);
  assert.match(r.memoryBlock, /Sam lives in Austin/);
  assert.equal(active(mem).length, 2, 'a fact about Sam and a fact about the user fill different slots');
  // a new city for Sam retires Sam's old city, not the user's
  await mem.remember({ scope: 'you', blobId: 'popo', text: 'Sam lives in Denver.' });
  assert.deepEqual(active(mem), ['Sam lives in Denver.', 'You live in Dallas.']);
  await mem.remember({ scope: 'you', blobId: 'popo', text: 'You live in Austin.' });
  assert.deepEqual(active(mem), ['Sam lives in Denver.', 'You live in Austin.']);
});

test('an old subject-less fact still reads correctly: "Lives in Dallas." renders as "You live in Dallas."', async () => {
  const { mem } = open();
  await mem.addFact({ scope: 'you', text: 'Lives in Dallas.' }); // written before explicit subjects existed
  await mem.addFact({ scope: 'you', text: 'Name is Dana.' });
  const r = await mem.recall({ blobId: 'popo', query: 'where do I live and what is my name', touch: false });
  assert.match(r.memoryBlock, /You live in Dallas/);
  assert.match(r.memoryBlock, /Your name is Dana/);
  assert.doesNotMatch(r.memoryBlock, /- Lives in/);
  // the new fact retires the old one (same subject, same slot) even though the old line has no subject
  await mem.remember({ scope: 'you', blobId: 'popo', text: 'You live in Austin.' });
  assert.deepEqual(active(mem), ['Name is Dana.', 'You live in Austin.']);
});

// ---------- vetting a model's ops ----------

test('a model that gives no subject is repaired only when the user said it in the first person; otherwise dropped', async () => {
  const bare = (text: string) => () => ops({ op: 'add', scope: 'you', text, confidence: 0.9 });
  let s = open(bare('Lives in Austin.'));
  await s.mem.ingestTurn(turn('popo', 'I live in Austin, it is warm here', s.c.now()));
  assert.deepEqual(active(s.mem), ['You live in Austin.']);
  for (const user of ['Sam lives in Austin, it is warm there', 'my cofounder lives in Austin these days', 'She lives in Austin and I live in Dallas but she says hi']) {
    s = open(bare('Lives in Austin.'));
    await s.mem.ingestTurn(turn('popo', user, s.c.now()));
    assert.deepEqual(active(s.mem), [], user);
  }
  s = open(bare('Allergic to penicillin.')); // an adjective: cannot be conjugated safely
  await s.mem.ingestTurn(turn('popo', 'I am allergic to penicillin', s.c.now()));
  assert.equal(s.mem.listFacts().length, 0);
});

test('a free model may not retire or replace a fact without the user\'s own words as evidence', async () => {
  const cases: Array<{ user: string; op: object; stays: boolean }> = [
    { user: 'what is the weather in Austin today?', op: { op: 'retire', explicit: true }, stays: true },
    { user: 'what is the weather in Austin today?', op: { op: 'update', text: 'You live in Austin.', explicit: true, confidence: 0.95 }, stays: true },
    { user: 'I like Austin barbecue a lot', op: { op: 'update', text: 'You live in Austin.', explicit: true, confidence: 0.95 }, stays: true },
    { user: 'I live in Austin barbecue country, joking', op: { op: 'conflict', text: 'You live in Austin.' }, stays: true },
    { user: 'I moved to Austin last month.', op: { op: 'update', text: 'You live in Austin.', explicit: true, confidence: 0.95 }, stays: false },
    { user: "that's wrong, I live in Austin now", op: { op: 'update', text: 'You live in Austin.', confidence: 0.9 }, stays: false },
    { user: "I don't live in Dallas anymore", op: { op: 'retire', explicit: true }, stays: false },
  ];
  for (const k of cases) {
    const { mem, c } = open((_u, p) => ops({ scope: 'you', target: aliasOf(p, 'Dallas'), ...k.op }));
    await mem.remember({ scope: 'you', blobId: 'popo', text: 'You live in Dallas.' });
    await mem.ingestTurn(turn('popo', k.user, c.now()));
    const dallas = mem.listFacts().some((f) => f.text === 'You live in Dallas.');
    assert.equal(dallas, k.stays, `${k.user} :: ${JSON.stringify(k.op)}`);
  }
});

test('a model op that says "update" about a different kind of fact adds beside the old one; it never retires it', async () => {
  const { mem, c } = open((_u, p) => ops({ op: 'update', scope: 'you', target: aliasOf(p, 'Dallas'), text: 'You work at Acme.', explicit: true, confidence: 0.95 }));
  await mem.remember({ scope: 'you', blobId: 'popo', text: 'You live in Dallas.' });
  await mem.ingestTurn(turn('popo', 'I started at Acme this week, so exciting', c.now()));
  assert.deepEqual(active(mem), ['You live in Dallas.', 'You work at Acme.']);
});

test('a plain refinement replaces without needing a correction word; an unrelated fact keeps both', async () => {
  const { mem, c } = open((_u, p) => ops({ op: 'update', scope: 'you', target: aliasOf(p, 'Texas'), text: 'You live in Austin, Texas.', confidence: 0.9 }));
  await mem.remember({ scope: 'you', blobId: 'popo', text: 'You live in Texas.' });
  const rec = await mem.ingestTurn(turn('popo', 'I live in Austin, Texas, near the river', c.now()));
  assert.equal(rec[0]?.kind, 'updated');
  assert.deepEqual(active(mem), ['You live in Austin, Texas.']);
});

test('dates and numbers the user never said are dropped from a fact (no invented "September 2026")', async () => {
  const { mem, c } = open(() => ops({ op: 'add', scope: 'you', text: 'You started running in March 2024.', confidence: 0.9 }));
  await mem.ingestTurn(turn('popo', 'I started running a while ago and love it', c.now()));
  assert.deepEqual(active(mem), []);
  const s2 = open(() => ops({ op: 'add', scope: 'you', text: 'You started running in March 2024.', confidence: 0.9 }));
  await s2.mem.ingestTurn(turn('popo', 'I started running in March 2024 and love it', s2.c.now()));
  assert.deepEqual(active(s2.mem), ['You started running in March 2024.']);
});

test('other people\'s email addresses and phone numbers are held as Pending, never stored or recalled', async () => {
  for (const text of ["Sam's email is sam@example.com.", 'Sam can be reached at sam@example.com.', 'Sam phone number is 555-123-4567.', 'You can reach Sam at sam@example.com.', 'The user can contact Sam on +1 415 555 0100.']) {
    const { mem, c } = open(() => ops({ op: 'add', scope: 'you', text, confidence: 0.95 }));
    const rec = await mem.ingestTurn(turn('popo', 'Sam is my cofounder, reach him at sam@example.com or 555-123-4567 or +1 415 555 0100', c.now()));
    assert.deepEqual(rec.map((r) => r.kind), ['pending'], text);
    assert.equal(mem.listFacts().length, 0, text);
    assert.equal((await mem.recall({ blobId: 'wobbo', query: "what is Sam's email or phone number?", touch: false })).facts.length, 0, text);
    assert.equal(mem.listPending().length, 1);
  }
  // the user's own address is fine
  const own = open(() => ops({ op: 'add', scope: 'you', text: 'Your email is dana@example.com.', confidence: 0.95 }));
  await own.mem.ingestTurn(turn('popo', 'my email is dana@example.com', own.c.now()));
  assert.deepEqual(active(own.mem), ['Your email is dana@example.com.']);
});

test('the remember tool path holds other people\'s contact details too, and refuses a sentence with no subject it cannot repair', async () => {
  const { mem } = open();
  const r = await mem.remember({ scope: 'you', blobId: 'popo', text: "Sam's email is sam@example.com." });
  assert.equal(r.outcome, 'held');
  assert.equal(mem.listFacts().length, 0);
  await assert.rejects(mem.remember({ scope: 'you', blobId: 'popo', text: 'Allergic to penicillin.' }), /who the fact is about/);
  const ok = await mem.remember({ scope: 'you', blobId: 'popo', text: 'Lives in Austin.' }); // a verb-first line is repaired
  assert.equal(ok.fact?.text, 'You live in Austin.');
});

test('pending items dedupe by normalised fact: the tool, the extractor and a retry raise ONE card', async () => {
  const text = "Sam's email is sam@example.com.";
  const { mem, c } = open(() => ops({ op: 'add', scope: 'you', text: 'Sam email is sam@example.com', confidence: 0.9 }));
  const held = await mem.remember({ scope: 'you', blobId: 'popo', text });
  assert.equal(held.outcome, 'held');
  const rec = await mem.ingestTurn(turn('popo', 'Sam is my cofounder, his email is sam@example.com', c.now()));
  assert.equal(rec.length, 0, 'the extractor did not raise a second card');
  await mem.ingestTurn(turn('popo', 'again: Sam is my cofounder, his email is sam@example.com', c.now()));
  assert.equal(mem.listPending().length, 1);
  // a health fact worded two ways is one card as well
  const h = open(() => ops({ op: 'add', scope: 'you', text: 'The user is allergic to penicillin.', confidence: 0.9 }));
  await h.mem.remember({ scope: 'you', blobId: 'popo', text: 'You are allergic to penicillin.' });
  await h.mem.ingestTurn(turn('popo', 'I am allergic to penicillin, noted', h.c.now()));
  assert.equal(h.mem.listPending().length, 1);
});

test('a Kora hand-off brief is indexed but never learned from', async () => {
  const { mem, c } = open(() => ops({ op: 'add', scope: 'you', text: 'You live in Lisbon.', confidence: 0.95 }));
  const rec = await mem.ingestTurn({ ...turn('popo', 'Kora: please research flights for the user, who lives in Lisbon and is allergic to nuts', c.now()), learn: false });
  assert.deepEqual(rec, []);
  assert.equal(mem.listFacts().length, 0);
  assert.equal(mem.listPending().length, 0);
  assert.ok(mem.searchEpisodes({ blobId: 'popo', query: 'flights Lisbon' }).length > 0, 'still searchable');
});

test('a user rewrite ("actually I eat fish again") passes the model check; a mistargeted one does not', async () => {
  const { mem, c } = open((_u, p) => ops({ op: 'update', scope: 'you', target: aliasOf(p, 'vegetarian'), text: 'You eat fish.', confidence: 0.9 }));
  await mem.remember({ scope: 'you', blobId: 'popo', text: 'You are vegetarian.' });
  const rec = await mem.ingestTurn(turn('popo', "Actually I'm eating fish again", c.now()));
  assert.equal(rec[0]?.kind, 'updated');
  assert.deepEqual(active(mem), ['You eat fish.']);
  const s2 = open((_u, p) => ops({ op: 'update', scope: 'you', target: aliasOf(p, 'vegetarian'), text: 'You eat fish.', confidence: 0.9 }));
  await s2.mem.remember({ scope: 'you', blobId: 'popo', text: 'You are vegetarian.' });
  await s2.mem.ingestTurn(turn('popo', 'Actually my brother is eating fish again', s2.c.now()));
  assert.deepEqual(active(s2.mem), ['You are vegetarian.']);
});

// ---------- the pieces ----------

test('subjectOf / toYouForm / renderFact', () => {
  assert.deepEqual(subjectOf('You live in Dallas.'), { kind: 'user' });
  assert.deepEqual(subjectOf("Your cofounder is Sam."), { kind: 'user' });
  assert.deepEqual(subjectOf('The user lives in Dallas.'), { kind: 'user' });
  assert.deepEqual(subjectOf('Lives in Dallas.'), { kind: 'implicit' });
  assert.deepEqual(subjectOf('Name is Dana.'), { kind: 'implicit' });
  assert.deepEqual(subjectOf('Prefers morning meetings.'), { kind: 'implicit' });
  assert.deepEqual(subjectOf('Sam lives in Austin.'), { kind: 'other', name: 'sam' });
  assert.deepEqual(subjectOf('Sam is your cofounder.'), { kind: 'other', name: 'sam' });
  assert.deepEqual(subjectOf("Sam's brother lives in Austin."), { kind: 'other', name: "sam s brother" });
  assert.equal(toYouForm('Lives in Dallas, Texas.'), 'You live in Dallas, Texas.');
  assert.equal(toYouForm('Has a dog named Pixel.'), 'You have a dog named Pixel.');
  assert.equal(toYouForm('Is vegetarian.'), 'You are vegetarian.');
  assert.equal(toYouForm('Studies law.'), 'You study law.');
  assert.equal(toYouForm('Name is Dana.'), 'Your name is Dana.');
  assert.equal(toYouForm('Allergic to nuts.'), null);
  assert.equal(renderFact('Sam lives in Austin.'), 'Sam lives in Austin.');
  assert.equal(renderFact('Allergic to nuts.'), 'Allergic to nuts.');
  assert.equal(withExplicitSubject('I live in Austin.', 'whatever'), 'You live in Austin.');
  assert.equal(withExplicitSubject('My cofounder is Sam.', 'whatever'), 'Your cofounder is Sam.');
});

test('firstPersonBefore: only "I" / "we" / nobody counts as the actor', () => {
  for (const ok of ['', 'I ', 'Update: I ', 'so I just ', "I've ", 'Actually, ', 'We ', 'and I recently ']) assert.equal(firstPersonBefore(ok), true, JSON.stringify(ok));
  for (const no of ['Sam ', 'Sam just ', 'My friend Sam ', 'They ', 'He said she ', 'my brother ', 'I think Sam ', 'It ']) assert.equal(firstPersonBefore(no), false, JSON.stringify(no));
});

test('evidence checks are about the user\'s words, not the assistant\'s', () => {
  const t = 'You live in Dallas.';
  assert.equal(correctionEvidence({ userText: 'I moved to Austin last month', newText: 'You live in Austin.', targetText: t }), true);
  assert.equal(correctionEvidence({ userText: 'Moved to Austin, Dallas is wrong', newText: 'You live in Austin.', targetText: t }), true);
  assert.equal(correctionEvidence({ userText: 'Sam moved to Austin last month', newText: 'You live in Austin.', targetText: t }), false);
  assert.equal(correctionEvidence({ userText: 'my friend Sam lives in Austin now', newText: 'You live in Austin.', targetText: t }), false);
  assert.equal(correctionEvidence({ userText: 'I like Austin', newText: 'You live in Austin.', targetText: t }), false, 'no change word');
  assert.equal(correctionEvidence({ userText: 'I moved to Boston', newText: 'You live in Austin.', targetText: t }), false, 'the value is not what the user said');
  assert.equal(retireEvidence("I don't live in Dallas anymore", t), true);
  assert.equal(retireEvidence('Sam no longer lives in Dallas', t), false);
  assert.equal(retireEvidence('what about Dallas?', t), false);
  assert.equal(hasUngroundedDetail('You live in Austin (since September 2026).', 'I live in Austin'), true);
  assert.equal(hasUngroundedDetail('You were born in 1990.', 'I was born in 1990'), false);
  assert.equal(isOtherPersonContact('Your email is dana@example.com.'), false);
  assert.equal(isOtherPersonContact('Sam email: sam@example.com'), true);
  assert.equal(isOtherPersonContact('You prefer morning meetings.'), false);
});

test('detectCorrections skips a third party at the head of the clause', () => {
  const facts = [fact('You live in Dallas.'), fact('You eat meat.')];
  assert.deepEqual(detectCorrections('Sam moved to Austin', facts), []);
  assert.deepEqual(detectCorrections('they live in Austin now', facts), []);
  assert.deepEqual(detectCorrections("she doesn't eat meat anymore", facts), []);
  assert.equal(detectCorrections('I moved to Austin', facts).length, 1);
  assert.equal(detectCorrections("I don't eat meat anymore", facts).length, 1);
});


// ---------- launch QA 2026-10-09: task instructions and test scaffolding are not facts about the user ----------

test('instructions to the agent, test scaffolding and one-off task constraints are never stored (extractor and remember)', async () => {
  const bad: Array<[string, string]> = [
    ['Only use my LQ- blobs for this, and keep it short.', 'You want tasks handled with your own LQ- blobs and kept short.'],
    ['Heads up: you are in a QA test. Use only the LQ- blobs.', 'You are in a QA test.'],
    ['Write an invite to Riley, a new teammate, for Friday.', 'Riley is a new teammate on your team.'],
    ['Research hotels for this task and only use the LQ-Rsch blob.', 'You only use the LQ-Rsch blob for research.'],
    ['For this session do not touch my other blobs.', 'You do not want other blobs touched during this session.'],
  ];
  for (const [user, extracted] of bad) {
    const { mem, c } = open(() => ops({ op: 'add', scope: 'you', text: extracted, confidence: 0.95 }));
    const rec = await mem.ingestTurn(turn('popo', user, c.now()));
    assert.deepEqual(active(mem), [], `${user} -> ${extracted}`);
    assert.equal(rec.filter((r) => r.kind === 'added' || r.kind === 'pending').length, 0, user);
  }
  // the remember tool path refuses the same scaffolding
  const { mem } = open();
  await assert.rejects(() => mem.remember({ scope: 'you', blobId: 'popo', text: 'You are in a QA test.' }), /instruction for this task/);
  await assert.rejects(() => mem.remember({ scope: 'you', blobId: 'popo', text: 'You want tasks handled with your own LQ- blobs.' }), /instruction for this task/);
});

test('durable things the user says about themselves inside a task message still land', async () => {
  const { mem, c } = open(() => ops({ op: 'add', scope: 'you', text: 'You live in Austin.', confidence: 0.95 }));
  await mem.ingestTurn(turn('popo', 'Find me a dentist near where I live. I live in Austin.', c.now()));
  assert.deepEqual(active(mem), ['You live in Austin.']);
});

test('a how-to-work preference given as an order stays a blob note', async () => {
  const { mem, c } = open(() => ops({ op: 'add', scope: 'blob', text: 'Wants research summaries as three bullets.', confidence: 0.9 }));
  await mem.ingestTurn(turn('popo', 'give me research summaries as three bullets', c.now()));
  assert.equal(mem.listFacts({ scope: 'blob', blobId: 'popo' }).length, 1);
});

test('a standing "keep answers short" preference is kept (and its receipt matches the store); a one-off length limit is not', async () => {
  const { mem, c } = open(() => ops({ op: 'add', scope: 'you', text: 'You prefer short answers.', confidence: 0.95, important: true, explicit: true }));
  const rec = await mem.ingestTurn(turn('popo', 'Please keep answers short, I read on my phone.', c.now()));
  assert.deepEqual(active(mem), ['You prefer short answers.']);
  assert.equal(rec.filter((r) => r.kind === 'added').length, 1);
  const one = open(() => ops({ op: 'add', scope: 'you', text: 'You want a short answer.', confidence: 0.95 }));
  await one.mem.ingestTurn(turn('popo', 'Write a short answer about hotels for this task.', one.c.now()));
  assert.deepEqual(active(one.mem), []);
});
