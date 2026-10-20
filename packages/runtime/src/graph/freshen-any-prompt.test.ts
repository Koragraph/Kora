// "Stale — re-indexes when you send your next message": any prompt, not only a code-shaped one, heals a stale index
// (in the background; the turn never waits for it).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kora-freshen-')));
process.env.KORAGRAPH_HOME = path.join(home, 'kg'); process.env.KORAGRAPH_DB = path.join(home, 'kg', 'graph.db');
process.env.KORA_INJECT_LOG = '0'; delete process.env.KORA_AUTO_INGEST;

test('a non-code prompt in a stale repo starts the incremental re-index', async () => {
  const repo = path.join(home, 'app'); fs.mkdirSync(repo, { recursive: true });
  const git = (...a: string[]) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8' });
  fs.writeFileSync(path.join(repo, 'a.js'), 'function firstFn() {}\n'); git('init', '-q'); git('add', '.'); git('commit', '-qm', 'i');
  const kgBin = path.resolve(__dirname, '..', '..', 'koragraph', 'bin', 'koragraph.js');
  assert.equal(spawnSync(process.execPath, [kgBin, 'ingest', repo, '--no-hooks'], { env: process.env }).status, 0);
  fs.writeFileSync(path.join(repo, 'b.js'), 'function laterFn() {}\n'); git('add', '.'); git('commit', '-qm', 'ii');
  const { createGraphService } = require('./service') as typeof import('./service');
  const g = createGraphService();
  assert.equal((await g.status(repo)).stale, true);
  const { injectForPrompt } = require('./prompt-inject') as typeof import('./prompt-inject');
  const out = await injectForPrompt({ prompt: 'thanks, looks good', cwd: repo, sessionId: 'freshen-1', graph: g });
  assert.equal(out, null, 'nothing injected for a non-code prompt');
  const t0 = Date.now(); let st = await g.status(repo, { nocache: true });
  while (st.stale && Date.now() - t0 < 30_000) { await new Promise((r) => setTimeout(r, 300)); st = await g.status(repo, { nocache: true }); }
  assert.equal(st.stale, false, 'the background re-index caught the index up to HEAD');
});

process.on('exit', () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* fine */ } });
