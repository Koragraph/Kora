// The swarm-e2e harness must never run the user's real `agy` at boot (deep audit A3-7 / overnight A10).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('swarm-e2e prepareHome points Antigravity at a missing binary, and keeps a home that already has engines.json', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-e2eenv-'));
  const saved = process.env.SWARM_E2E_DIR; process.env.SWARM_E2E_DIR = base;
  const mod = path.join(__dirname, '..', '..', 'scripts', 'swarm-e2e', 'env.cjs');
  delete require.cache[require.resolve(mod)];
  try {
    const e = require(mod);
    fs.mkdirSync(path.join(e.HOME, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(e.HOME, 'tools', 'opencode'), ''); // prepareHome links the real one; keep the test offline
    e.prepareHome();
    const eng = JSON.parse(fs.readFileSync(path.join(e.HOME, 'engines.json'), 'utf8'));
    assert.equal(eng.executables.antigravity, path.join(base, 'no-agy', 'agy'));
    assert.equal(fs.existsSync(eng.executables.antigravity), false);
    fs.writeFileSync(path.join(e.HOME, 'engines.json'), '{"executables":{"antigravity":"/x/agy"}}');
    e.prepareHome();
    assert.equal(JSON.parse(fs.readFileSync(path.join(e.HOME, 'engines.json'), 'utf8')).executables.antigravity, '/x/agy');
  } finally { if (saved === undefined) delete process.env.SWARM_E2E_DIR; else process.env.SWARM_E2E_DIR = saved; fs.rmSync(base, { recursive: true, force: true }); }
});
