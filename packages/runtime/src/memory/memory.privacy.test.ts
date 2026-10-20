// Privacy of what memory keeps (prelaunch QA 2026-10-11): secrets typed in chat never reach the turn store or its
// search index (pl8 S2-1); Forget removes the raw turns, search rows and summaries that say it, and a forgotten fact
// cannot come back through the retry queue (pl7 S2-1, S2-2); a one-field correction keeps the other fields (pl7 S2-3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemory } from './index';
import { scrubSecrets } from './text';
import { clock, fakeExtractor, ops, turn, type Script } from './testkit';

function open(script: Script = () => ops()) {
  const c = clock();
  const mem = openMemory({ dbPath: ':memory:', extractor: fakeExtractor(script), now: c.now });
  return { c, mem };
}

test('scrubSecrets: labelled passwords, token shapes, cards and random keys go; ordinary text stays', () => {
  const cases: Array<[string, string]> = [
    ['The user is samtest and the password is pl8FakePass-0000. Type both.', 'pl8FakePass-0000'],
    ['my PIN: 4821', '4821'],
    ['api key = abc123def456', 'abc123def456'],
    ['use sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv please', 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv'],
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['aws AKIAIOSFODNN7EXAMPLE here', 'AKIAIOSFODNN7EXAMPLE'],
    ['card 4111 1111 1111 1111 exp 12/30', '4111 1111 1111 1111'],
    ['key: Zx9Qw3Er7Ty1Ui5Op2As8Df4Gh6Jk0LmNb', 'Zx9Qw3Er7Ty1Ui5Op2As8Df4Gh6Jk0LmNb'],
  ];
  for (const [input, secret] of cases) {
    const out = scrubSecrets(input);
    assert.ok(!out.includes(secret), `${input} -> ${out}`);
    assert.ok(out.includes('[secret removed]'), out);
  }
  for (const s of ['My phone is 555-0199 and I live in Austin.', 'commit 3f2a9c1b7e5d4a6f8b0c2e4d6f8a0b2c4d6e8f0a', 'See /Users/sam/Projects/kora-dev/packages/runtime/src/memory/index.ts', 'Meeting at 1700000000000 ms epoch']) {
    assert.equal(scrubSecrets(s), s);
  }
});

test('a password typed in chat is not stored in raw turns or the episode index', async () => {
  const { mem, c } = open();
  await mem.ingestTurn({ ...turn('b1', 'The user is samtest and the password is pl8FakePass-0000. Remember it.', c.now()), assistantText: 'I will not store passwords.' });
  assert.equal(mem.searchEpisodes({ query: 'pl8FakePass' }).length, 0);
  assert.equal(mem.searchEpisodes({ query: 'samtest' }).length, 1, 'the rest of the turn stays searchable');
});

test('Forget purges the raw turns, search rows and summaries that say it (UI delete and chat forget)', async () => {
  const { mem, c } = open();
  await mem.ingestTurn({ ...turn('b1', 'Remember my contact info: phone 555-0100.', c.now(), 'th1') });
  await mem.ingestTurn({ ...turn('b1', 'Actually my phone is 555-0199.', c.now() + 1000, 'th1') });
  await mem.summarizeThread({ threadId: 'th1', blobId: 'b1', transcript: [{ role: 'user', text: 'Actually my phone is 555-0199.' }] });
  assert.ok(mem.searchEpisodes({ query: '0199' }).length >= 1);
  const r = await mem.remember({ scope: 'you', blobId: 'b1', text: 'Your reservation phone number is 555-0199.' });
  const receipt = mem.forgetWithReceipt(r.fact!.id);
  assert.ok(receipt, 'chat forget returns an undoable receipt');
  assert.equal(mem.searchEpisodes({ query: '0199' }).length, 0, 'turn and summary rows that said it are gone');
  assert.equal(mem.searchEpisodes({ query: '0100' }).length, 1, 'the unrelated turn stays');
  // after the Undo window the retired row itself is deleted
  c.advanceDays(2);
  assert.equal(mem.listFacts({ includeRetired: true }).filter((f) => f.text.includes('0199')).length, 0);

  const f2 = await mem.addFact({ scope: 'you', text: 'Your locker code word is Bluebird7.' });
  await mem.ingestTurn({ ...turn('b1', 'my locker code word is Bluebird7 ok', c.now(), 'th2') });
  assert.equal(mem.searchEpisodes({ query: 'Bluebird7' }).length, 1);
  assert.equal(mem.forgetFact(f2.id), true);
  assert.equal(mem.searchEpisodes({ query: 'Bluebird7' }).length, 0);
});

test('the retry queue cannot bring a forgotten fact back (old turn replayed after the forget)', async () => {
  let learn = true;
  const { mem, c } = open((u) => (learn && /lisinopril/.test(u) ? ops({ op: 'add', scope: 'you', text: 'You take 20mg of lisinopril every morning.', sensitive: true }) : ops()));
  const old = { ...turn('b1', 'Remember: I take 20mg of lisinopril every morning for my blood pressure.', c.now(), 'th3') };
  // extraction failed at the time: the turn sits in the retry queue. Meanwhile the model saved it, then the user forgot it.
  const saved = await mem.remember({ scope: 'you', blobId: 'b1', text: 'You take 20mg of lisinopril every morning.' });
  c.set(c.now() + 60_000);
  assert.ok(mem.forgetWithReceipt(saved.fact!.id));
  // the drain replays the queued turn
  const rec = await mem.ingestTurn(old);
  assert.deepEqual(rec, []);
  assert.equal(mem.listPending().length, 0, 'no held card comes back');
  assert.equal(mem.searchEpisodes({ query: 'lisinopril' }).length, 0, 'the purged turn is not re-indexed');
  // saying it again AFTER the forget is new information and is learned normally
  learn = true;
  await mem.ingestTurn({ ...turn('b1', 'I take 20mg of lisinopril again since today.', c.now() + 1000, 'th4') });
  assert.equal(mem.searchEpisodes({ query: 'lisinopril' }).length, 1);
});

test('correcting one field of a multi-part fact keeps the other fields (remember tool and extractor update)', async () => {
  const { mem } = open();
  const first = await mem.remember({ scope: 'you', blobId: 'b1', text: 'Your reservation contact: phone 555-0100, email sam@example.test, 2 seats, aisle seat preferred.' });
  const r = await mem.remember({ scope: 'you', blobId: 'b1', text: 'Your reservation phone number is 555-0199, not 555-0100.', replaces: first.fact!.id });
  assert.equal(r.outcome, 'updated');
  assert.match(r.fact!.text, /555-0199/);
  assert.match(r.fact!.text, /sam@example\.test/);
  assert.match(r.fact!.text, /2 seats/);
  assert.doesNotMatch(r.fact!.text, /555-0100/);
  const live = mem.listFacts().map((f) => f.text);
  assert.equal(live.length, 1, live.join(' | '));
  // a detail that can't be swapped in: the old fact stays, the new one is stored beside it
  const k = await mem.remember({ scope: 'you', blobId: 'b1', text: 'Your reservations should avoid window seats near the kitchen.', replaces: r.fact!.id });
  assert.equal(mem.listFacts().length, 2, `kept both (${k.outcome})`);
  // single-valued slot facts are still replaced outright
  await mem.remember({ scope: 'you', blobId: 'b1', text: 'You live in Dallas.' });
  await mem.remember({ scope: 'you', blobId: 'b1', text: 'You live in Austin.' });
  assert.deepEqual(mem.listFacts().map((f) => f.text).filter((t) => /live in/.test(t)), ['You live in Austin.']);
});

test('memory.db and its WAL are owner-only (0600) (pl7 S3)', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { openDb } = await import('./db');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-memdb-'));
  const file = path.join(dir, 'memory.db');
  const db = openDb(file);
  try {
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    if (process.platform !== 'win32') if (fs.existsSync(`${file}-wal`)) assert.equal(fs.statSync(`${file}-wal`).mode & 0o777, 0o600);
  } finally { db.close(); }
});

test('scrubSecrets is idempotent: a second pass leaves the marker whole (plv S3-1)', () => {
  const once = scrubSecrets('my site login password is PlvHunter7731 ok');
  assert.equal(once, 'my site login password is [secret removed] ok');
  assert.equal(scrubSecrets(once), once);
  assert.equal(scrubSecrets(scrubSecrets('token: ghp_abcdefghijklmnopqrstuvwxyz0123456789AB')), scrubSecrets('token: ghp_abcdefghijklmnopqrstuvwxyz0123456789AB'));
});
