// The Codex plan-usage probe starts the binary the Codex engine resolves, not a bare `codex` on the daemon's PATH.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeCodexPlanUsage } from './plan-usage';
import { resolveEngineBinary } from '../detect/engine-binary';

// The fake is an extensionless sh script in a POSIX install layout (Windows resolves only PATHEXT files).
test('probeCodexPlanUsage runs an absolute codex path and reads the rate limits', { skip: process.platform === 'win32' }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-codexprobe-'));
  const bin = path.join(home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const fake = path.join(bin, 'codex');
  fs.writeFileSync(fake, [
    '#!/bin/sh',
    'read a',
    'echo \'{"id":1,"result":{}}\'',
    'read b',
    'echo \'{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":12,"windowDurationMins":300,"resetsAt":1900000000}}}}\'',
    'sleep 1',
  ].join('\n'));
  fs.chmodSync(fake, 0o755);
  // the daemon's bare PATH cannot find it, the engine resolver can
  assert.equal(resolveEngineBinary('codex', { env: { PATH: '/usr/bin:/bin' }, home }), fake);
  const report = await probeCodexPlanUsage(4000, fake);
  assert.ok(report, 'a report came back');
  assert.equal(await probeCodexPlanUsage(1500, path.join(home, 'nope')), null, 'a missing binary resolves null, never throws');
  fs.rmSync(home, { recursive: true, force: true });
});

test('idle probes load no user settings and no user MCP servers (deep A3-8)', async () => {
  const { idleProbeOptions } = await import('./list-models');
  const o = idleProbeOptions(new AbortController(), 'default') as Record<string, unknown>;
  assert.deepEqual(o.settingSources, []);
  assert.equal(o.strictMcpConfig, true);
});
