// Kora's own git calls are bounded and never prompt (docs/qa/security-2026-10-04/2B-daemon-robustness.md item 3):
// a hung git — a credential/LFS prompt, an fsmonitor, a huge repo — must cost a bounded wait, never freeze the daemon.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The fake git is an extensionless sh script found through PATH (Windows only runs PATHEXT files).
test('a hanging git is cut off at the timeout and runs with prompts disabled', { skip: process.platform === 'win32' }, async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-fakegit-'));
  const log = path.join(bin, 'env.log');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "prompt=$GIT_TERMINAL_PROMPT locks=$GIT_OPTIONAL_LOCKS" >> "${log}"\nexec sleep 20\n`, { mode: 0o755 });
  const savedPath = process.env.PATH;
  const savedTimeout = process.env.KORA_GIT_TIMEOUT_MS;
  process.env.PATH = `${bin}:${savedPath}`;
  process.env.KORA_GIT_TIMEOUT_MS = '1500'; // a fresh script can take ~0.5 s to start on macOS
  try {
    // Loaded after the env is set: GIT_TIMEOUT_MS is read once at module load.
    for (const k of Object.keys(require.cache)) if (/util[\\/]safe-path|server[\\/]worktree/.test(k)) delete require.cache[k];
    const wt = require('./worktree') as typeof import('./worktree');
    const t0 = Date.now();
    assert.equal(wt.mainRoot(bin), null, 'a timed-out git is a failed git');
    const syncMs = Date.now() - t0;
    assert.ok(syncMs < 5000, `sync call bounded (${syncMs} ms)`);
    const t1 = Date.now();
    assert.equal(await wt.mainRootAsync(path.join(bin, 'other')), null);
    assert.ok(Date.now() - t1 < 10_000, 'async call bounded');
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.ok(lines.length >= 1);
    for (const l of lines) assert.equal(l, 'prompt=0 locks=0');
  } finally {
    process.env.PATH = savedPath;
    if (savedTimeout === undefined) delete process.env.KORA_GIT_TIMEOUT_MS; else process.env.KORA_GIT_TIMEOUT_MS = savedTimeout;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('gitEnv keeps the caller env and only adds the no-prompt / no-lock switches', () => {
  const { gitEnv } = require('../util/safe-path') as typeof import('../util/safe-path');
  const env = gitEnv({ PATH: '/x', HOME: '/h', GIT_TERMINAL_PROMPT: '1' });
  assert.deepEqual(env, { PATH: '/x', HOME: '/h', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_OPTIONAL_LOCKS: '0' });
});
