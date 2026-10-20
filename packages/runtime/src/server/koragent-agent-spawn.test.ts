// D20 (Koragent E2E): `kora agent spawn koragent` ran a bare `koragent` off PATH; with none there the pane exited 1
// with an empty screen. It must run the installed binary (KORAGENT_BIN → $KORAGENT_HOME/bin/koragent → PATH, as the
// swarm backend resolves it) and, with none anywhere, refuse before any pane or worktree exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setEditionForTests } from '../edition';

// Koragent (Kora Pro, Bun, a unix:<path> socket) is not ported to Windows yet (docs/windows/PORT.md).
const winSkip = { skip: process.platform === 'win32' };

// Koragent workers are Kora Pro: these tests exercise the Pro path.
setEditionForTests('pro');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-kgs-'));
process.env.KORA_HOME = home; process.env.KORA_SOCKET_PATH = path.join(home, 's.sock');
process.env.KORA_AUTO_INGEST = '0'; process.env.KORA_AUTO_SETUP = '0'; process.env.KORA_WORKTREES = path.join(home, 'wt');
process.env.KORAGRAPH_DB = path.join(home, 'graph.db'); process.env.KORAGRAPH_PRACTICE_DB = path.join(home, 'practice.db');
const kgHome = path.join(home, 'koragent-home');
process.env.KORAGENT_HOME = kgHome;
delete process.env.KORAGENT_BIN;
const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
process.env.PATH = `${bin}:/usr/bin:/bin`;

test('agent.spawn koragent: the installed binary, never a bare PATH lookup; none installed → clear error, no pane', winSkip, async () => {
  const { createServer } = require('./daemon');
  const h = await createServer({ socketPath: process.env.KORA_SOCKET_PATH, restore: false, sweep: false });
  try {
    const before = h.runtime.panes.size;
    await assert.rejects(h.runtime.agentSpawn({ agent: 'koragent', cwd: home, worktree: false }), /Koragent is not installed: set KORAGENT_BIN/);
    assert.equal(h.runtime.panes.size, before, 'no pane was spawned');

    const installed = path.join(kgHome, 'bin', 'koragent');
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.writeFileSync(installed, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'koragent'), '#!/bin/sh\nexit 1\n', { mode: 0o755 }); // a stale one on PATH loses
    const info = await h.runtime.agentSpawn({ agent: 'koragent', cwd: home, worktree: false, args: ['--lead'] });
    assert.equal(info.command, installed);
    assert.deepEqual(info.args, ['--lead']);
  } finally { await h.close(); }
});
