// The model-facing memory tools, against a real memory store (live QA 2026-10-09: corrections never retired the old
// fact, Undo failed on a fresh receipt, a health fact was saved silently, old chat text resurfaced a retired claim).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blobs-tmem-'));
process.env.KORA_BLOBS_ROOT = path.join(root, 'Blobs');
process.env.KORA_HOME = path.join(root, 'kora-home');

import { BlobStore } from './store';
import { selfToolSpecs } from './tools';
import { inlineMemoryHost } from './memory-host';
import { openMemory } from '../memory';
import { fakeExtractor } from '../memory/testkit';

function rig() {
  fs.rmSync(path.join(process.env.KORA_HOME!, 'blobs'), { recursive: true, force: true });
  const s = new BlobStore();
  const popo = s.create({ name: 'Popo', title: 'Researcher', soul: 's', engine: { instanceId: 'claude', model: 'sonnet', effort: null } });
  const mem = openMemory({ dbPath: ':memory:', extractor: fakeExtractor(() => ({ ops: [] })) });
  const cards: any[] = [];
  let changed = 0;
  const specs = selfToolSpecs({ store: s, memory: inlineMemoryHost(mem), onMemoryChanged: () => { changed++; } }, { blobId: popo.id, threadId: 't1', agent: 'claude', cwd: popo.workspace, emitCard: (c) => cards.push(c) });
  const tool = (n: string) => specs.find((x) => x.name === n)!;
  return { mem, cards, tool, popo, changed: () => changed };
}

test('remember: "moved to Austin" updates Dallas - card says Updated (was Dallas), and its Undo works', async () => {
  const { mem, cards, tool, popo, changed } = rig();
  await tool('remember').handler({ text: 'Lives in Dallas.' });
  const r = await tool('remember').handler({ text: 'Lives in Austin.', important: true });
  assert.match(r.text, /Updated memory.*You live in Austin.*was: You live in Dallas/);
  const rc = cards.at(-1).receipts[0];
  assert.equal(rc.kind, 'updated');
  assert.equal(rc.previousText, 'You live in Dallas.');
  assert.deepEqual(mem.listFacts({ blobId: popo.id }).map((f) => f.text), ['You live in Austin.']);
  assert.ok(changed() >= 2, 'the runtime is told memory changed (Core notes may need a re-read)');
  // the receipt id on the card is a REAL receipt: Undo works right after, even though the new fact is starred
  assert.equal(mem.undo(rc.id), true);
  assert.deepEqual(mem.listFacts({ blobId: popo.id }).map((f) => f.text), ['You live in Dallas.']);
});

test('remember: a fresh "Remembered" receipt can be undone', async () => {
  const { mem, cards, tool } = rig();
  const r = await tool('remember').handler({ text: 'You like oat milk lattes.', important: true });
  assert.match(r.text, /Remembered/);
  assert.equal(mem.undo(cards[0].receipts[0].id), true);
});

test('remember: `replaces` + sensitive hold + duplicate', async () => {
  const { mem, cards, tool, popo } = rig();
  await tool('remember').handler({ text: 'You are vegetarian.' });
  const r = await tool('remember').handler({ text: 'You eat fish now.', replaces: 'vegetarian' });
  assert.match(r.text, /Updated memory/);
  assert.deepEqual(mem.listFacts({ blobId: popo.id }).map((f) => f.text), ['You eat fish now.']);
  const h = await tool('remember').handler({ text: 'You are allergic to penicillin.' });
  assert.match(h.text, /Held for the user's OK/);
  assert.match(h.text, /NOT saved/);
  assert.equal(cards.at(-1).receipts[0].kind, 'held');
  assert.equal(cards.at(-1).receipts[0].reason, 'Looks sensitive');
  assert.equal(mem.listFacts({ blobId: popo.id }).some((f) => /penicillin/.test(f.text)), false);
  assert.equal(mem.listPending({ blobId: popo.id }).length, 1);
  assert.match((await tool('remember').handler({ text: 'You eat fish now.' })).text, /Already remembered/);
});

test('recall tool: shows current facts only, and old chat text that merely restates a retired fact is not handed back', async () => {
  const { mem, tool, popo } = rig();
  await mem.ingestTurn({ blobId: popo.id, threadId: 't0', messageId: 'm0', userText: 'I live in Dallas and love tacos', assistantText: 'Dallas has great tacos.', at: Date.now() - 86_400_000 });
  await tool('remember').handler({ text: 'Lives in Dallas.' });
  await tool('remember').handler({ text: 'Lives in Austin.' });
  const out = (await tool('recall').handler({ query: 'where do I live' })).text;
  assert.match(out, /Current facts:\n- You live in Austin/);
  assert.doesNotMatch(out.split('Earlier conversations')[0], /Dallas/);
  assert.doesNotMatch(out, /I live in Dallas/, 'the stale excerpt is dropped');
});

import { resolveAttachment } from './tools';
test('attach_output refuses helper scripts unless the user asked for the script', () => {
  const { popo } = rig();
  fs.mkdirSync(path.join(popo.workspace, 'scratch'), { recursive: true });
  fs.writeFileSync(path.join(popo.workspace, 'scratch', 'add_savings.py'), 'print(1)');
  fs.writeFileSync(path.join(popo.workspace, 'scratch', 'budget.xlsx'), 'x');
  const script = resolveAttachment(popo.workspace, path.join(popo.workspace, 'scratch', 'add_savings.py'));
  assert.ok('error' in script && /helper script/.test(script.error));
  assert.ok('path' in resolveAttachment(popo.workspace, path.join(popo.workspace, 'scratch', 'add_savings.py'), { allowScript: true }));
  assert.ok('path' in resolveAttachment(popo.workspace, path.join(popo.workspace, 'scratch', 'budget.xlsx')));
});
