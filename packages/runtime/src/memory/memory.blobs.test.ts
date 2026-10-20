// The memory API additions Blobs needs (ARCH section 4): provenance ids, recall exclusion + fields, forgetBlob,
// "newest facts are update candidates".
import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemory } from './index';
import { aliasOf, clock, fakeExtractor, ops } from './testkit';

test('ingestTurn stores the USER message id as provenance (userMessageId wins over messageId)', async () => {
  const c = clock();
  const mem = openMemory({ dbPath: ':memory:', extractor: fakeExtractor(() => ops({ op: 'add', scope: 'you', text: 'You like tea.', confidence: 0.9 })), now: c.now });
  await mem.ingestTurn({ blobId: 'popo', threadId: 't1', userMessageId: 'u-9', assistantMessageId: 'a-9', userText: 'I like tea very much', assistantText: 'Nice', at: c.now() });
  assert.deepEqual(mem.listFacts()[0].source, { threadId: 't1', messageId: 'u-9' });
});

test('recall exposes memoryBlock + factIds and skips excludeFactIds without spending budget on them', async () => {
  const c = clock();
  const mem = openMemory({ dbPath: ':memory:', extractor: fakeExtractor(() => ({})), now: c.now });
  const a = await mem.addFact({ scope: 'you', text: 'Prefers espresso coffee.' });
  const b = await mem.addFact({ scope: 'you', text: 'Dislikes decaf coffee.' });
  const r = await mem.recall({ blobId: 'popo', query: 'which coffee do I like' });
  assert.deepEqual(new Set(r.factIds), new Set([a.id, b.id]));
  assert.match(r.memoryBlock, /espresso/);
  assert.doesNotMatch(r.memoryBlock, /Core|About the user/);
  const r2 = await mem.recall({ blobId: 'popo', query: 'which coffee do I like', excludeFactIds: [a.id] });
  assert.deepEqual(r2.factIds, [b.id]);
  assert.equal((await mem.recall({ blobId: 'popo', query: 'which coffee do I like', excludeFactIds: [a.id, b.id] })).memoryBlock, '');
});

test('forgetBlob deletes a blob\'s private facts, core, episodes and receipts but keeps shared "you" facts and other blobs', async () => {
  const c = clock();
  const mem = openMemory({ dbPath: ':memory:', extractor: fakeExtractor(() => ({ summary: 'A chat about newsletters and pricing.' })), now: c.now });
  await mem.addFact({ scope: 'you', text: 'Lives in Dallas.' });
  await mem.addFact({ scope: 'blob', blobId: 'popo', text: 'Popo private: uses numbered sources.' });
  await mem.addFact({ scope: 'blob', blobId: 'bobble', text: 'Bobble private: triage by sender.' });
  mem.setCore('blob', 'popo', '- popo notes');
  await mem.summarizeThread({ threadId: 't1', blobId: 'popo', transcript: 'user: newsletters pricing' });
  await mem.ingestTurn({ blobId: 'popo', threadId: 't1', messageId: 'm1', userText: 'lets talk newsletters and pricing', assistantText: 'ok', at: c.now() });
  assert.equal(mem.forgetBlob('popo').facts, 1);
  assert.deepEqual(mem.listFacts({ blobId: 'popo' }).map((f) => f.text), ['Lives in Dallas.']);
  assert.equal(mem.listFacts({ blobId: 'bobble' }).length, 2);
  assert.equal(mem.getCore('popo').blob, '');
  assert.equal(mem.searchEpisodes({ blobId: 'popo', query: 'newsletters pricing' }).length, 0);
  assert.equal(mem.stats().episodes, 0);
  assert.equal(mem.searchFacts({ blobId: 'popo', query: 'numbered sources' }).length, 0);
});

test('a correction that shares no word with the old fact still reaches the extractor as a candidate', async () => {
  const c = clock();
  const mem = openMemory({
    dbPath: ':memory:', now: c.now,
    extractor: fakeExtractor((user, prompt) => (/Austin/.test(user) ? ops({ op: 'update', scope: 'you', target: aliasOf(prompt, 'Dallas'), text: 'You live in Austin.', explicit: true, confidence: 0.95 }) : ops())),
  });
  await mem.addFact({ scope: 'you', text: 'Lives in Dallas.' });
  const [r] = await mem.ingestTurn({ blobId: 'popo', threadId: 't', userMessageId: 'u1', userText: "that's wrong, I moved to Austin", assistantText: 'Got it', at: c.now() });
  assert.equal(r.kind, 'updated');
  assert.deepEqual(mem.listFacts().map((f) => f.text), ['You live in Austin.']);
});
