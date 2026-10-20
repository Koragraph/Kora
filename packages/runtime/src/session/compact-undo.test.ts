import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotBeforeCompact, readSnapshot, restoreSnapshot, dropSnapshot } from './compact-undo';
import { claudeSlug } from './prune';
import { SID, thread } from './prune.fixture';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-undo-'));
  const cfg = path.join(dir, 'claude'); const home = path.join(dir, 'home'); const cwd = path.join(dir, 'repo');
  fs.mkdirSync(cwd, { recursive: true });
  const pdir = path.join(cfg, 'projects', claudeSlug(cwd)); fs.mkdirSync(pdir, { recursive: true });
  const file = path.join(pdir, `${SID}.jsonl`);
  const before = thread(6).map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(file, before);
  return { dir, cfg, home, cwd, file, before };
}

test('snapshot then undo: the pre-compaction transcript comes back as a NEW session; the compacted one stays', async () => {
  const s = setup();
  assert.equal(await snapshotBeforeCompact({ threadId: 'th1', sessionId: SID, cwd: s.cwd, configDir: s.cfg, home: s.home }), true);
  assert.equal(readSnapshot('th1', s.home)?.sessionId, SID);
  // the compaction rewrites the live session
  fs.appendFileSync(s.file, JSON.stringify({ type: 'system', subtype: 'compact_boundary', sessionId: SID }) + '\n');
  const r = restoreSnapshot({ threadId: 'th1', configDir: s.cfg, home: s.home });
  assert.ok(r);
  if (!r) return;
  assert.notEqual(r.sessionId, SID);
  const restored = fs.readFileSync(r.file, 'utf8').trim().split('\n');
  assert.equal(restored.length, s.before.trim().split('\n').length, 'the pre-compaction line count, no boundary');
  assert.ok(restored.every((l) => { const j = JSON.parse(l); return !j.sessionId || j.sessionId === r.sessionId; }));
  assert.ok(fs.readFileSync(s.file, 'utf8').includes('compact_boundary'), 'the compacted session is untouched');
  assert.equal(readSnapshot('th1', s.home), null, 'one undo per snapshot');
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('undo is null with no snapshot, a bad id or a missing transcript; ids cannot escape the folder', async () => {
  const s = setup();
  assert.equal(restoreSnapshot({ threadId: 'nothing', configDir: s.cfg, home: s.home }), null);
  assert.equal(await snapshotBeforeCompact({ threadId: '../evil', sessionId: SID, cwd: s.cwd, configDir: s.cfg, home: s.home }), false);
  assert.equal(await snapshotBeforeCompact({ threadId: 'th2', sessionId: 'no-such-session-id', cwd: s.cwd, configDir: s.cfg, home: s.home }), false);
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('undo still works when the compacted session file was replaced since (a later cold resume), and a deleted thread drops its copy', async () => {
  const s = setup();
  assert.equal(await snapshotBeforeCompact({ threadId: 'th3', sessionId: SID, cwd: s.cwd, configDir: s.cfg, home: s.home }), true);
  fs.rmSync(s.file); // the live session's file is gone
  const r = restoreSnapshot({ threadId: 'th3', configDir: s.cfg, home: s.home });
  assert.ok(r, 'restored beside where the session lived');
  assert.equal(path.dirname(r!.file), path.dirname(s.file));
  assert.equal(await snapshotBeforeCompact({ threadId: 'th4', sessionId: r!.sessionId, cwd: s.cwd, configDir: s.cfg, home: s.home }), true);
  dropSnapshot('th4', s.home);
  assert.equal(readSnapshot('th4', s.home), null);
  assert.deepEqual(fs.readdirSync(path.join(s.home, 'compact-undo')), []);
  fs.rmSync(s.dir, { recursive: true, force: true });
});
