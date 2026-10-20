import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkpointBigWal, compactJsonl, pruneMergeCheck, rotateLog, runHousekeeping } from './housekeeping';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kora-hk-'));

test('rotateLog: copy-then-truncate keeps an O_APPEND writer writing into the live file', () => {
  const d = tmp(); const f = path.join(d, 'server.log');
  const fd = fs.openSync(f, 'a'); // like the daemon's stdio / log stream
  fs.writeSync(fd, 'x'.repeat(2000) + '\n');
  assert.deepEqual(rotateLog(f, 10_000, 2), { rotated: false, dropped: 0 }, 'under cap: untouched');
  fs.writeSync(fd, 'y'.repeat(20_000) + '\n');
  assert.equal(rotateLog(f, 10_000, 2).rotated, true);
  assert.equal(fs.statSync(f).size, 0); assert.equal(fs.statSync(`${f}.1`).size, 22_002);
  fs.writeSync(fd, 'after\n');
  assert.equal(fs.readFileSync(f, 'utf8'), 'after\n', 'the open writer lands at the start of the truncated file, no hole');
  // generations shift and the oldest drops
  fs.writeSync(fd, 'z'.repeat(20_000) + '\n'); rotateLog(f, 10_000, 2);
  fs.writeSync(fd, 'w'.repeat(20_000) + '\n'); const r = rotateLog(f, 10_000, 2);
  assert.equal(r.dropped, 22_002, 'the .2 generation fell off');
  assert.ok(fs.readFileSync(`${f}.1`, 'utf8').startsWith('w')); assert.ok(fs.readFileSync(`${f}.2`, 'utf8').startsWith('after'));
  assert.ok(!fs.existsSync(`${f}.3`));
  fs.closeSync(fd); fs.rmSync(d, { recursive: true, force: true });
});

test('compactJsonl: keeps the newest whole lines, drops a torn first line', () => {
  const d = tmp(); const f = path.join(d, 'outcomes.jsonl');
  const rows = Array.from({ length: 1000 }, (_, i) => JSON.stringify({ i, pad: 'p'.repeat(40) }));
  fs.writeFileSync(f, rows.join('\n') + '\n');
  assert.equal(compactJsonl(f, 1e9, 1000), null, 'under cap: untouched');
  const r = compactJsonl(f, 10_000, 5_000)!;
  assert.ok(r.after <= 5_000 && r.after > 4_000, JSON.stringify(r));
  const kept = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(kept[kept.length - 1].i, 999, 'newest row kept');
  for (let k = 1; k < kept.length; k++) assert.equal(kept[k].i, kept[k - 1].i + 1, 'contiguous, every line parses');
  fs.rmSync(d, { recursive: true, force: true });
});

test('runHousekeeping: ages out caches and markers, leaves the chat store and fresh files alone, reports bytes', () => {
  const home = tmp(); const t = tmp();
  const old = Date.now() - 30 * 24 * 3600_000;
  const touch = (p: string, body = 'x', mtime?: number) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); if (mtime) fs.utimesSync(p, mtime / 1000, mtime / 1000); };
  touch(path.join(home, 'brief-cache', 'old.txt'), 'b'.repeat(100), old);
  touch(path.join(home, 'brief-cache', 'new.txt'), 'b');
  touch(path.join(home, 'chat', 't_1', 'events.ndjson'), '{}\n', old);
  touch(path.join(t, 'kora-inject-abc'), 'm', old); touch(path.join(t, 'kora-inject-new'), 'm'); touch(path.join(t, 'unrelated'), 'u', old);
  touch(path.join(home, 'server.log'), 's'.repeat(3000));
  const r = runHousekeeping({ home, graphHome: path.join(home, 'kg'), graphDb: path.join(home, 'kg', 'graph.db'), tmp: t, limits: { serverLogBytes: 1000 } });
  assert.ok(!fs.existsSync(path.join(home, 'brief-cache', 'old.txt'))); assert.ok(fs.existsSync(path.join(home, 'brief-cache', 'new.txt')));
  assert.ok(fs.existsSync(path.join(home, 'chat', 't_1', 'events.ndjson')), 'chat threads are never touched');
  assert.ok(!fs.existsSync(path.join(t, 'kora-inject-abc'))); assert.ok(fs.existsSync(path.join(t, 'kora-inject-new'))); assert.ok(fs.existsSync(path.join(t, 'unrelated')));
  assert.equal(r.rotated.length, 1); assert.equal(fs.statSync(path.join(home, 'server.log')).size, 0);
  assert.ok(r.reclaimed >= 101, `reclaimed ${r.reclaimed}`);
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(t, { recursive: true, force: true });
});

test('pruneMergeCheck: a killed gate\'s throwaway worktree is removed and its entry pruned from the repo', async () => {
  const d = tmp(); const repo = path.join(d, 'repo');
  const git = (cwd: string, ...a: string[]) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  fs.mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a'), '1'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'i');
  const base = path.join(d, 'merge-check'); const scratch = path.join(base, 'repo', 'abc-0-feat');
  fs.mkdirSync(path.dirname(scratch), { recursive: true });
  git(repo, 'worktree', 'add', '--detach', '-q', scratch, 'HEAD');
  assert.equal(pruneMergeCheck(base, 3600_000).count, 0, 'young: kept (a gate may be running)');
  const r = pruneMergeCheck(base, 3600_000, Date.now() + 2 * 3600_000);
  assert.equal(r.count, 1); assert.ok(r.bytes > 0);
  assert.ok(!fs.existsSync(path.join(base, 'repo')), 'empty per-repo dir removed');
  for (let i = 0; i < 50 && git(repo, 'worktree', 'list').split('\n').length > 1; i++) await new Promise((res) => setTimeout(res, 100));
  assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1, 'git worktree prune dropped the dangling entry');
  fs.rmSync(d, { recursive: true, force: true });
});

test('runHousekeeping: caps app-launch.log and the engine\'s catch-up.log (graph home), leaves small ones alone', () => {
  const home = tmp(); const kg = path.join(home, 'kg'); fs.mkdirSync(kg);
  fs.writeFileSync(path.join(home, 'app-launch.log'), 'a'.repeat(3000));
  fs.writeFileSync(path.join(kg, 'catch-up.log'), 'c'.repeat(3000));
  fs.writeFileSync(path.join(home, 'ingest.log'), 'i'.repeat(10));
  const r = runHousekeeping({ home, graphHome: kg, graphDb: path.join(kg, 'graph.db'), tmp: tmp(), limits: { smallLogBytes: 1000 } });
  assert.deepEqual(r.rotated.map((x) => path.basename(x.file)).sort(), ['app-launch.log', 'catch-up.log']);
  assert.equal(fs.statSync(path.join(kg, 'catch-up.log')).size, 0); assert.equal(fs.statSync(path.join(kg, 'catch-up.log.1')).size, 3000);
  assert.equal(fs.statSync(path.join(home, 'ingest.log')).size, 10);
  assert.equal(r.checkpointed, undefined, 'no store, no checkpoint');
  fs.rmSync(home, { recursive: true, force: true });
});

test('checkpointBigWal: folds an oversized WAL back in a child while a reader stays open, ignores a small one', async () => {
  const Database = require('better-sqlite3');
  const d = tmp(); const file = path.join(d, 'graph.db');
  const w = new Database(file); w.pragma('journal_mode = WAL'); w.pragma('wal_autocheckpoint = 0');
  w.exec('CREATE TABLE t (x TEXT)');
  const ins = w.prepare('INSERT INTO t VALUES (?)'); w.transaction(() => { for (let i = 0; i < 2000; i++) ins.run('x'.repeat(500)); })();
  const reader = new Database(file, { readonly: true });
  assert.equal(reader.prepare('SELECT count(*) AS n FROM t').get().n, 2000);
  assert.equal(checkpointBigWal(file, 2 ** 40), false, 'under cap: nothing started');
  const before = fs.statSync(`${file}-wal`).size;
  assert.ok(before > 100_000, `wal ${before}`);
  assert.equal(checkpointBigWal(file, 1000), true);
  // PASSIVE: the frames reach the main file (the WAL file itself is reused, not shrunk, while connections are open).
  const deadline = Date.now() + 20_000;
  while (fs.statSync(file).size < 500_000 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.ok(fs.statSync(file).size >= 500_000, `main db ${fs.statSync(file).size}`);
  assert.equal(reader.prepare('SELECT count(*) AS n FROM t').get().n, 2000);
  reader.close(); w.close(); fs.rmSync(d, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 }); // the checkpoint child may still hold it (Windows)
});

test('runHousekeeping: stale scratch folders of the daemon\'s own go by age; fresh ones, the warm Haiku folder and other kora-* dirs stay', () => {
  const home = tmp(); const t = tmp();
  const old = (Date.now() - 5 * 24 * 3600_000) / 1000;
  for (const n of ['kora-oneshot-aaa', 'kora-haiku-bbb', 'kora-acp-models-ccc', 'kora-haiku-warm-ddd', 'kora-qa-stack', 'kora-oneshot-fresh']) fs.mkdirSync(path.join(t, n));
  for (const n of ['kora-oneshot-aaa', 'kora-haiku-bbb', 'kora-acp-models-ccc', 'kora-haiku-warm-ddd', 'kora-qa-stack']) fs.utimesSync(path.join(t, n), old, old);
  const r = runHousekeeping({ home, graphHome: path.join(home, 'kg'), graphDb: path.join(home, 'kg', 'graph.db'), tmp: t });
  assert.deepEqual(fs.readdirSync(t).sort(), ['kora-haiku-warm-ddd', 'kora-oneshot-fresh', 'kora-qa-stack']);
  assert.equal(r.pruned.find((p) => p.what === 'stale temp folders')?.count, 3);
  // the hooks' markers live in the private per-user folder
  const priv = path.join(t, `kora-${process.getuid?.() ?? 'u'}`); fs.mkdirSync(priv);
  for (const n of ['kora-inject-old', 'kora-nudge-old-turn', 'kora-inject-new', 'x.sock']) fs.writeFileSync(path.join(priv, n), 'm');
  for (const n of ['kora-inject-old', 'kora-nudge-old-turn', 'x.sock']) fs.utimesSync(path.join(priv, n), old, old);
  runHousekeeping({ home, graphHome: path.join(home, 'kg'), graphDb: path.join(home, 'kg', 'graph.db'), tmp: t });
  assert.deepEqual(fs.readdirSync(priv).sort(), ['kora-inject-new', 'x.sock']);
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(t, { recursive: true, force: true });
});

test('runHousekeeping: undo copies age out at 14 days, spilled Bash output at 7, bounded-reads.jsonl is compacted; fresh files stay', () => {
  const home = tmp(); const t = tmp();
  const day = 24 * 3600_000; const now = Date.now();
  const touch = (p: string, body = 'x', mtime?: number) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); if (mtime) fs.utimesSync(p, mtime / 1000, mtime / 1000); };
  touch(path.join(home, 'compact-undo', 'old.jsonl'), 'u'.repeat(50), now - 20 * day);
  touch(path.join(home, 'compact-undo', 'new.jsonl'), 'u', now - 2 * day);
  touch(path.join(home, 'tool-out', 'thread-a', 'old.txt'), 'o', now - 9 * day);
  touch(path.join(home, 'tool-out', 'thread-b', 'old.txt'), 'o', now - 9 * day);
  touch(path.join(home, 'tool-out', 'thread-b', 'new.txt'), 'n', now - 1 * day);
  const rows = Array.from({ length: 500 }, (_, i) => JSON.stringify({ i, pad: 'p'.repeat(40) }));
  touch(path.join(home, 'swarm', 'bounded-reads.jsonl'), rows.join('\n') + '\n');
  runHousekeeping({ home, graphHome: path.join(home, 'kg'), graphDb: path.join(home, 'kg', 'graph.db'), tmp: t, limits: { injectBytes: 5_000, injectKeepBytes: 2_000 } });
  assert.ok(!fs.existsSync(path.join(home, 'compact-undo', 'old.jsonl'))); assert.ok(fs.existsSync(path.join(home, 'compact-undo', 'new.jsonl')));
  assert.ok(!fs.existsSync(path.join(home, 'tool-out', 'thread-a')), 'an emptied thread folder goes too');
  assert.ok(!fs.existsSync(path.join(home, 'tool-out', 'thread-b', 'old.txt'))); assert.ok(fs.existsSync(path.join(home, 'tool-out', 'thread-b', 'new.txt')));
  assert.ok(fs.statSync(path.join(home, 'swarm', 'bounded-reads.jsonl')).size <= 2_000);
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(t, { recursive: true, force: true });
});
