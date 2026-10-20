// The memory store in a real worker thread: calls round-trip, the extractor is served from the main thread, errors keep
// their name, the event loop keeps ticking during work, close is clean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { memoryHost } from './memory-host';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memhost-'));

test('worker-backed memory: add/recall/core/ingest (extractor proxied to the host) and CoreTooLargeError survives the boundary', async () => {
  const mem = memoryHost(path.join(dir, 'memory.db'));
  const seen: string[] = [];
  mem.setExtractor(async (req) => {
    seen.push(req.prompt);
    return JSON.stringify({ ops: [{ op: 'add', scope: 'you', text: 'You own a bakery.', confidence: 0.9 }] });
  });
  try {
    const f = await mem.addFact({ scope: 'you', text: 'Prefers espresso coffee.' });
    assert.equal((await mem.getFact(f.id))?.text, 'Prefers espresso coffee.');
    const r = await mem.recall({ blobId: 'popo', query: 'what coffee do I like' });
    assert.deepEqual(r.factIds, [f.id]);
    const receipts = await mem.ingestTurn({ blobId: 'popo', threadId: 't1', userMessageId: 'u1', assistantMessageId: 'a1', userText: 'I own a bakery on Main Street', assistantText: 'Lovely', at: Date.now() });
    assert.equal(receipts[0].kind, 'added');
    assert.equal(seen.length, 1, 'the extractor ran on the main thread');
    assert.deepEqual((await mem.listFacts({})).map((x) => x.text).sort(), ['Prefers espresso coffee.', 'You own a bakery.']);
    await assert.rejects(mem.setCore('blob', 'popo', 'y'.repeat(6000)), (e: any) => e.name === 'CoreTooLargeError');
    // the event loop is not blocked while the worker works
    let ticks = 0; const t = setInterval(() => ticks++, 2);
    await Promise.all(Array.from({ length: 30 }, (_, i) => mem.addFact({ scope: 'you', text: `Unique fact ${i} about topic${i}` })));
    clearInterval(t);
    assert.ok(ticks >= 1, 'timers kept firing during the work');
    assert.equal((await mem.stats()).facts.active, 32);
    // a call the worker rejects stays a clean error
    await assert.rejects(mem.editFact(f.id, { text: '' }), /invalid fact text/);
  } finally { await mem.close(); }
  await assert.rejects(mem.stats(), /closed/);
});

test('worker-backed memory without an extractor: ingest degrades to "indexed, nothing learned" instead of throwing', async () => {
  const mem = memoryHost(path.join(dir, 'm2.db'));
  try {
    const r = await mem.ingestTurn({ blobId: 'popo', threadId: 't', userMessageId: 'u', userText: 'I own a bakery on Main Street', assistantText: 'ok', at: Date.now() });
    assert.deepEqual(r, []);
    assert.equal((await mem.searchEpisodes({ blobId: 'popo', query: 'bakery Main Street' })).length, 1);
  } finally { await mem.close(); }
});

test('a hung extractor ends at the engine deadline (not a host "timed out"); the no-model corrections still land and are returned', async () => {
  const mem = memoryHost(path.join(dir, 'hung.db'), undefined, { extractDeadlineMs: 400 });
  mem.setExtractor(() => new Promise<string>(() => {})); // never answers
  try {
    await mem.remember({ scope: 'you', blobId: 'popo', text: 'You live in Dallas.' });
    const t0 = Date.now();
    const receipts = await mem.ingestTurn({ blobId: 'popo', threadId: 't1', userMessageId: 'u1', assistantMessageId: 'a1', userText: 'I moved to Austin last month', assistantText: 'Nice', at: Date.now() });
    assert.ok(Date.now() - t0 < 3_000, 'returned at the deadline');
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].kind, 'updated');
    assert.deepEqual((await mem.listFacts({})).map((x) => x.text), ['You live in Austin.']);
  } finally { await mem.close(); }
});

test('remember through the worker boundary: update + Undo by the receipt id', async () => {
  const mem = memoryHost(path.join(dir, 'rem.db'));
  mem.setExtractor(async () => '{"ops":[]}');
  try {
    await mem.remember({ scope: 'you', blobId: 'popo', text: 'You live in Dallas.' });
    const r = await mem.remember({ scope: 'you', blobId: 'popo', text: 'You live in Austin.' });
    assert.equal(r.outcome, 'updated');
    assert.equal(r.receipt?.previousText, 'You live in Dallas.');
    assert.equal(await mem.undo(r.receipt!.id), true);
    assert.deepEqual((await mem.listFacts({})).map((x) => x.text), ['You live in Dallas.']);
  } finally { await mem.close(); }
});
