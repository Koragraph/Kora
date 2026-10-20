// An agent spawned from INSIDE another agent's worktree (a split beside an agent pane inherits its live cwd) must get
// its own worktree branched from the main checkout, not share the first agent's checkout.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-wts-'));
process.env.KORA_HOME = home; process.env.KORA_SOCKET_PATH = path.join(home, 's.sock');
process.env.KORA_AUTO_INGEST = '0'; process.env.KORA_AUTO_SETUP = '0'; process.env.KORA_WORKTREES = path.join(home, 'wt');
process.env.KORAGRAPH_DB = path.join(home, 'graph.db'); process.env.KORAGRAPH_PRACTICE_DB = path.join(home, 'practice.db');
// a fake `claude` first on PATH so no real agent starts
const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nprintf "fake claude %s\\n" "$*"; sleep 30\n', { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;

function git(cwd: string, ...args: string[]) { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); }

test('agent.spawn from inside a worktree branches a NEW worktree from the main checkout, keeping the sub-directory', async () => {
  const { createServer } = require('./daemon');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-wts-repo-'));
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(repo, 'sub')); fs.writeFileSync(path.join(repo, 'sub', 'a.txt'), 'one\n'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init');
  const h = await createServer({ socketPath: process.env.KORA_SOCKET_PATH, restore: false });
  try {
    const a = await h.runtime.agentSpawn({ agent: 'claude', cwd: repo, worktree: true });
    assert.ok(a.worktree, 'first agent gets a worktree');
    const b = await h.runtime.agentSpawn({ agent: 'claude', cwd: path.join(a.worktree!.path, 'sub'), worktree: true });
    assert.ok(b.worktree, 'second agent, spawned from inside the first worktree, gets a worktree too');
    assert.notEqual(b.worktree!.path, a.worktree!.path, 'and it is a different one');
    assert.equal(fs.realpathSync(b.worktree!.mainRoot), fs.realpathSync(a.worktree!.mainRoot), 'branched from the same main checkout');
    assert.equal(b.cwd, path.join(b.worktree!.path, 'sub'), 'the sub-directory is kept');
    assert.ok(fs.existsSync(path.join(b.cwd, 'a.txt')));
  } finally { await h.close(); }
});

test('worktrees:auto — a FLEET worker (orchestratorId) always gets its own worktree; a plain agent still starts in the checkout', async () => {
  const { createServer } = require('./daemon');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-wts-fleet-'));
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init');
  const h = await createServer({ socketPath: process.env.KORA_SOCKET_PATH, restore: false });
  try {
    // The desktop chat lead is not a pane, so nothing in this checkout counts as an agent: the first worker used to
    // land in the user's checkout itself.
    const w = await h.runtime.agentSpawn({ agent: 'claude', cwd: repo, orchestratorId: 'chat-lead-1' });
    assert.ok(w.worktree, 'a lead-spawned worker is isolated even with no other pane in the checkout');
    assert.notEqual(fs.realpathSync(w.cwd), fs.realpathSync(repo));
    const plain = await h.runtime.agentSpawn({ agent: 'claude', cwd: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nh-wts-plain-'))) });
    assert.equal(plain.worktree ?? null, null, 'a plain agent outside any repo is untouched');
  } finally { await h.close(); }
});
