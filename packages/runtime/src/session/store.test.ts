import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatThreadStore } from './store';
import type { ChatEvent } from './events';

function tmpStore(): ChatThreadStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-chat-'));
  return new ChatThreadStore(dir);
}
const ev = (over: Partial<ChatEvent> = {}): Omit<ChatEvent, 'seq'> =>
  ({ type: 'content.delta', threadId: 'x', at: 0, itemId: 'i', stream: 'assistant_text', delta: 'hi', ...over } as any);

test('create writes a head with sane defaults and an empty log', () => {
  const s = tmpStore();
  const meta = s.create({ agent: 'claude', cwd: '/repo', title: 'T1' });
  assert.equal(meta.title, 'T1');
  assert.equal(meta.state, 'idle');
  assert.equal(meta.lastSeq, 0);
  assert.deepEqual(meta.workerPaneIds, []);
  assert.equal(meta.archived, false);
  assert.ok(s.has(meta.id));
  assert.equal(s.lastSeq(meta.id), 0);
});

test('append assigns a gap-free, monotonic seq per thread', () => {
  const s = tmpStore();
  const a = s.create({ agent: 'claude', cwd: '/r' });
  const b = s.create({ agent: 'claude', cwd: '/r' });
  const seqsA: number[] = [];
  for (let i = 0; i < 5; i++) seqsA.push(s.append(a.id, ev({ threadId: a.id })).seq);
  const seqsB = [s.append(b.id, ev({ threadId: b.id })).seq, s.append(b.id, ev({ threadId: b.id })).seq];
  assert.deepEqual(seqsA, [1, 2, 3, 4, 5], 'per-thread counter is gap-free from 1');
  assert.deepEqual(seqsB, [1, 2], 'a second thread has its own counter');
  assert.equal(s.lastSeq(a.id), 5);
});

test('append stamps threadId + at and never drops an event', () => {
  const s = tmpStore();
  const t = s.create({ agent: 'claude', cwd: '/r' });
  const out = s.append(t.id, ev({ threadId: 'ignored', at: undefined as any }));
  assert.equal(out.threadId, t.id, 'threadId is forced to the log owner');
  assert.ok(out.at > 0, 'at is stamped when absent');
});

test('read replays only events after the cursor, in order, honoring limit', () => {
  const s = tmpStore();
  const t = s.create({ agent: 'claude', cwd: '/r' });
  for (let i = 0; i < 10; i++) s.append(t.id, ev({ threadId: t.id, delta: `d${i}` }));
  const all = s.read(t.id, 0);
  assert.equal(all.events.length, 10);
  assert.equal(all.nextSeq, 10);
  assert.deepEqual(all.events.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const tail = s.read(t.id, 7);
  assert.deepEqual(tail.events.map((e) => e.seq), [8, 9, 10], 'backfill from a cursor skips already-seen seqs');
  const limited = s.read(t.id, 0, 3);
  assert.deepEqual(limited.events.map((e) => e.seq), [1, 2, 3]);
  assert.equal(limited.nextSeq, 3);
});

test('lastSeq survives a fresh store instance (reads the log tail)', () => {
  const s = tmpStore();
  const t = s.create({ agent: 'claude', cwd: '/r' });
  for (let i = 0; i < 4; i++) s.append(t.id, ev({ threadId: t.id }));
  const reopened = new ChatThreadStore(s.root);
  assert.equal(reopened.lastSeq(t.id), 4, 'seq high-water recovered from disk');
  assert.equal(reopened.append(t.id, ev({ threadId: t.id })).seq, 5, 'continues gap-free after reopen');
});

test('update merges head fields and bumps updatedAt; list sorts newest-first', async () => {
  const s = tmpStore();
  const a = s.create({ agent: 'claude', cwd: '/r', title: 'A' });
  await new Promise((r) => setTimeout(r, 2));
  const b = s.create({ agent: 'claude', cwd: '/r', title: 'B' });
  s.update(a.id, { state: 'running', workerPaneIds: ['p1'] });
  const got = s.get(a.id);
  assert.equal(got.state, 'running');
  assert.deepEqual(got.workerPaneIds, ['p1']);
  const list = s.list();
  assert.equal(list[0].id, a.id, 'most-recently-updated thread sorts first');
  assert.ok(list.find((t) => t.id === b.id));
});

test('archive flips a flag; delete removes the thread directory', () => {
  const s = tmpStore();
  const t = s.create({ agent: 'claude', cwd: '/r' });
  s.archive(t.id);
  assert.equal(s.get(t.id).archived, true);
  s.unarchive(t.id);
  assert.equal(s.get(t.id).archived, false);
  s.delete(t.id);
  assert.equal(s.has(t.id), false);
  assert.equal(s.list().find((x) => x.id === t.id), undefined);
});

// B8 (night 2026-10-04): an empty / non-JSON meta.json made every later turn fail with "Unexpected end of JSON input".
test('a damaged meta.json is rebuilt from index.json and the event log; without an index entry the error says why', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-store-damaged-'));
  const store = new ChatThreadStore(dir);
  const t = store.create({ agent: 'claude', cwd: '/work/app', title: 'Fix the login bug', agentMode: 'chat' });
  store.append(t.id, { type: 'thread.started', providerThreadId: 'sess-123' } as any);
  store.append(t.id, { type: 'turn.started', turnId: 'turn_1' } as any);
  store.flushIndex();
  fs.writeFileSync(path.join(dir, t.id, 'meta.json'), '');
  // the index keeps the head while the meta is unreadable (it is the rebuild source)
  store.flushIndex();
  const fresh = new ChatThreadStore(dir);
  const m = fresh.get(t.id);
  assert.equal(m.cwd, '/work/app');
  assert.equal(m.agent, 'claude');
  assert.equal(m.title, 'Fix the login bug');
  assert.equal((m as any).resume, 'sess-123', 'the Claude session can still be resumed');
  assert.equal(m.lastSeq, 2);
  assert.ok(fs.readdirSync(path.join(dir, t.id)).some((f) => f.startsWith('meta.json.damaged-')), 'the damaged copy is kept');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, t.id, 'meta.json'), 'utf8')).cwd, '/work/app', 'rebuilt on disk');

  const orphan = store.create({ agent: 'claude', cwd: '/work/b' });
  fs.writeFileSync(path.join(dir, 'index.json'), '[]');
  fs.writeFileSync(path.join(dir, orphan.id, 'meta.json'), '{"id":');
  assert.throws(() => new ChatThreadStore(dir).get(orphan.id), /saved state is damaged .* Start a new thread/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('security: a thread id that is not one path segment never reaches the filesystem (delete cannot escape the store)', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-chat-sec-'));
  const root = path.join(parent, 'chat');
  const s = new ChatThreadStore(root);
  const keep = s.create({ agent: 'claude', cwd: '/repo', title: 'keep' });
  const sentinel = path.join(parent, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'must survive');
  for (const bad of ['', '.', '..', '../..', `..${path.sep}x`, 'a/b', 'a\\b', 'a\0b']) {
    assert.throws(() => s.delete(bad), /invalid thread id/, JSON.stringify(bad));
    assert.equal(s.has(bad), false);
  }
  assert.ok(fs.existsSync(sentinel), 'the store parent survived');
  assert.ok(s.has(keep.id), 'the store itself survived');
  // A thread dir replaced by a symlink: delete unlinks the link and never recurses into its target.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-chat-outside-'));
  fs.writeFileSync(path.join(outside, 'precious'), 'x');
  fs.symlinkSync(outside, path.join(root, 't_link'));
  s.delete('t_link');
  assert.ok(fs.existsSync(path.join(outside, 'precious')), 'the symlink target survived');
  assert.equal(fs.existsSync(path.join(root, 't_link')), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(root).mode & 0o077, 0, 'chat root is owner-only');
  fs.rmSync(parent, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true });
});
