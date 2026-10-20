// The test runner sweeps isolation bases an earlier run left behind (deep audit A2-9).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('sweepStaleBases removes dead-owner and old ownerless bases, keeps live and fresh ones', () => {
  const { sweepStaleBases } = require(path.join(__dirname, '..', '..', 'scripts', 'test-isolate.cjs'));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-sweep-'));
  const mk = (name: string, owner?: number, ageH = 0) => {
    const d = path.join(parent, name); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'file'), 'x');
    if (owner !== undefined) fs.writeFileSync(path.join(d, '.owner'), String(owner));
    if (ageH) { const t = new Date(Date.now() - ageH * 3600_000); fs.utimesSync(d, t, t); }
    return d;
  };
  try {
    const dead = spawnSync(process.execPath, ['-e', '0']).pid!; // a pid that has exited
    const a = mk('kt-dead', dead), b = mk('kt-live', process.pid), c = mk('kt-old', undefined, 5), d = mk('kt-fresh'), e = mk('other-dead', dead);
    assert.equal(sweepStaleBases(parent, 'kt-'), 2);
    assert.equal(fs.existsSync(a), false); assert.equal(fs.existsSync(c), false);
    assert.equal(fs.existsSync(b), true); assert.equal(fs.existsSync(d), true); assert.equal(fs.existsSync(e), true, 'only the prefix');
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});
