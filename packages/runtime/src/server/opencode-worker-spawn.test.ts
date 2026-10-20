// The daemon's agent.spawn for a plain OpenCode worker (what kora_spawn agent:"opencode" reaches): found live
// launching a bare `opencode` off PATH with no model — the pane exited 1 at once. It must launch Kora's managed
// binary with a picked model, and with no OpenCode anywhere refuse before any pane or worktree exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-ocw-'));
process.env.KORA_HOME = home; process.env.KORA_SOCKET_PATH = path.join(home, 's.sock');
process.env.KORA_AUTO_INGEST = '0'; process.env.KORA_AUTO_SETUP = '0'; process.env.KORA_WORKTREES = path.join(home, 'wt');
process.env.KORAGRAPH_DB = path.join(home, 'graph.db'); process.env.KORAGRAPH_PRACTICE_DB = path.join(home, 'practice.db');
// No opencode on PATH, and a login shell that finds none either (the resolver's last resort).
const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'noshell'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
process.env.PATH = `${bin}:/usr/bin:/bin`;
process.env.SHELL = path.join(bin, 'noshell');

const FIXED = ['/opt/homebrew/bin/opencode', '/usr/local/bin/opencode', path.join(os.homedir(), '.opencode/bin/opencode'), path.join(os.homedir(), '.bun/bin/opencode'), path.join(os.homedir(), '.local/bin/opencode')];
const opencodeElsewhere = FIXED.some((p) => fs.existsSync(p));

test('agent.spawn opencode: Kora\'s managed binary + -m <picked model>; missing binary → clear error, no pane', async () => {
  const { createServer } = require('./daemon');
  const h = await createServer({ socketPath: process.env.KORA_SOCKET_PATH, restore: false });
  try {
    // The picker is the swarm's; stub it so the test never reaches Zen over the network.
    h.runtime.swarmSetup.ensureFresh = async () => {};
    h.runtime.swarm.pickModel = () => ({ id: 'opencode/ling-3.0-flash-fin-free', provider: 'zen', label: 'ling', rank: 0, maxConcurrent: null });
    const before = h.runtime.panes.size;
    if (!opencodeElsewhere) {
      await assert.rejects(h.runtime.agentSpawn({ agent: 'opencode', cwd: home, prompt: 'x', worktree: false, orchestratorId: 'chat:t1' }), /OpenCode is not installed — run `kora swarm install` or Settings → Swarm/);
      assert.equal(h.runtime.panes.size, before, 'no pane was spawned');
    }

    if (process.platform === 'win32') return; // the managed binary is opencode.exe there; a #! stand-in cannot be it
    const managed = path.join(home, 'tools', 'opencode', 'current', 'opencode');
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    fs.writeFileSync(managed, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
    await require('./swarm-install').refreshOpencodeBinary(); // drop the 60 s resolve cache
    const info = await h.runtime.agentSpawn({ agent: 'opencode', cwd: home, worktree: false, args: ['--auto'] });
    assert.equal(info.command, managed);
    assert.deepEqual(info.args.slice(0, 3), ['-m', 'opencode/ling-3.0-flash-fin-free', '--auto']);
  } finally { await h.close(); }
});
