import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemory, createHashEmbedder, CoreTooLargeError } from './index';
import { clock, fakeExtractor, ops, turn } from './testkit';

test('episodes: summarize a thread, search summaries and raw turns; fallback summary when the model fails', async () => {
  const c = clock();
  let reply: unknown = { summary: 'Decided to launch the newsletter on Thursdays and to use Substack.' };
  const mem = openMemory({ dbPath: ':memory:', extractor: fakeExtractor(() => reply), now: c.now });
  await mem.ingestTurn(turn('popo', 'lets discuss the pricing for the newsletter', c.now(), 'th-1'));
  const s = await mem.summarizeThread({ threadId: 'th-1', blobId: 'popo', transcript: [{ role: 'user', text: 'newsletter plan' }, { role: 'assistant', text: 'ok' }] });
  assert.match(s, /Substack/);
  const hits = mem.searchEpisodes({ blobId: 'popo', query: 'what did we decide about substack' });
  assert.equal(hits[0].kind, 'summary');
  assert.equal(hits[0].threadId, 'th-1');
  assert.ok(mem.searchEpisodes({ blobId: 'popo', query: 'pricing newsletter' }).some((h) => h.kind === 'turn'));
  // re-summarising replaces, not duplicates
  reply = 'garbage';
  const s2 = await mem.summarizeThread({ threadId: 'th-1', blobId: 'popo', transcript: 'user: we also chose weekly cadence' });
  assert.match(s2, /^\(auto\)/);
  assert.equal(mem.stats().episodes, 1);
  assert.equal(mem.searchEpisodes({ blobId: 'popo', query: 'substack' }).filter((h) => h.kind === 'summary').length, 0);
  assert.equal(mem.searchEpisodes({ query: '"; DROP TABLE facts; --' }).length, 0, 'odd queries are safe');
});

test('core notes: size-capped, rewritten not appended, tidy refreshes only auto notes', async () => {
  const c = clock();
  const mem = openMemory({ dbPath: ':memory:', extractor: fakeExtractor(() => ({ text: '- Runs Acme Robotics\n- Likes terse answers' })), now: c.now });
  assert.throws(() => mem.setCore('blob', 'popo', 'y'.repeat(5000)), CoreTooLargeError);
  await mem.addFact({ scope: 'you', text: 'Runs Acme Robotics.', important: true });
  await mem.addFact({ scope: 'you', text: 'Likes terse answers.', important: true });
  const rep = await mem.tidy();
  assert.deepEqual(rep.coresRefreshed, ['you:']);
  assert.match(mem.getCore('popo').you, /Acme/);
  assert.equal((await mem.tidy()).coresRefreshed.length, 0, 'unchanged facts → no rewrite');
  mem.setCore('you', 'popo', '- I wrote this myself');
  await mem.addFact({ scope: 'you', text: 'Brand new important thing.', important: true });
  await mem.tidy();
  assert.equal(mem.getCore('popo').you, '- I wrote this myself', 'user-owned core is never overwritten');
  mem.setTeamCore('- Dimp: research');
  assert.equal(mem.getTeamCore(), '- Dimp: research');
});

test('tidy can be cancelled and a second tidy call shares the in-flight run', async () => {
  const mem = openMemory({ dbPath: ':memory:', extractor: fakeExtractor(() => ({ merge: [], conflicts: [] })) });
  for (let i = 0; i < 30; i++) await mem.addFact({ scope: 'you', text: `Unique fact number ${i} about topic${i}` });
  const ac = new AbortController();
  ac.abort();
  assert.equal((await mem.tidy({ signal: ac.signal })).cancelled, true);
  const p1 = mem.tidy();
  const p2 = mem.tidy();
  assert.equal(p1, p2);
  assert.equal((await p1).cancelled, false);
  assert.equal(mem.needsTidy(), false);
});

test('optional embedder: vectors are stored, tidy backfills, recall still respects visibility', async () => {
  const mem = openMemory({ dbPath: ':memory:', extractor: fakeExtractor(() => ops()), embedder: createHashEmbedder() });
  const f = await mem.addFact({ scope: 'blob', blobId: 'popo', text: 'Prefers espresso over drip coffee.' });
  await mem.addFact({ scope: 'you', text: 'Allergic to peanuts.', important: false });
  assert.equal(mem.stats().facts.embedded, 2);
  // semantic-ish: a misspelling with no exact token match still finds the fact through hashed trigrams
  const r = await mem.recall({ blobId: 'popo', query: 'espreso please' });
  assert.ok(r.facts.some((x) => x.id === f.id));
  assert.equal((await mem.recall({ blobId: 'other', query: 'espreso please' })).facts.length, 0);
  await mem.editFact(f.id, { text: 'Prefers matcha.' });
  assert.equal(mem.stats().facts.embedded, 2, 'edited fact is re-embedded');
  assert.equal(mem.forgetFact(f.id), true);
  assert.equal(mem.getFact(f.id), undefined);
});

test('manual edits: edit, mark important, forget; secrets refused', async () => {
  const mem = openMemory({ dbPath: ':memory:', extractor: fakeExtractor(() => ops()) });
  const f = await mem.addFact({ scope: 'you', text: 'Likes jazz.' });
  await mem.editFact(f.id, { text: 'Loves jazz.' });
  assert.equal(mem.searchFacts({ blobId: 'x', query: 'jazz' })[0].text, 'Loves jazz.');
  assert.equal(mem.searchFacts({ blobId: 'x', query: 'likes' }).length, 0, 'fts follows the edit');
  mem.markImportant(f.id);
  assert.equal(mem.getFact(f.id)!.important, true);
  await assert.rejects(mem.addFact({ scope: 'you', text: 'api key: sk-abcdefghijklmnop1234' }));
});

test('persistence: reopening the same file keeps everything', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-'));
  try {
    const path = join(dir, 'sub', 'memory.db');
    const a = openMemory({ dbPath: path, extractor: fakeExtractor(() => ops()) });
    await a.addFact({ scope: 'you', text: 'Birthday is in June.', important: true });
    a.close();
    const b = openMemory({ dbPath: path, extractor: fakeExtractor(() => ops()) });
    assert.equal((await b.recall({ blobId: 'x', query: 'when is my birthday' })).facts.length, 1);
    assert.equal(b.stats().schemaVersion, 3);
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
