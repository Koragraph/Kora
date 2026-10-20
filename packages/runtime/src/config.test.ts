import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeConfig, patchFromPath, getPath, parseConfigValue, DEFAULTS } from './config';

test('mergeConfig: nested objects merge, scalars and arrays replace', () => {
  const m = mergeConfig(DEFAULTS, { autoCompact: { enabled: true }, trustedRoots: ['/x'], compactWarnTokens: 5 });
  assert.equal(m.autoCompact.enabled, true); assert.equal(m.autoCompact.contextTokens, DEFAULTS.autoCompact.contextTokens);
  assert.deepEqual(m.trustedRoots, ['/x']); assert.equal(m.compactWarnTokens, 5);
  assert.equal(DEFAULTS.autoCompact.enabled, false, 'defaults are not mutated');
});
test('patchFromPath / getPath / parseConfigValue', () => {
  assert.deepEqual(patchFromPath('autoCompact.enabled', true), { autoCompact: { enabled: true } });
  assert.equal(getPath({ a: { b: 3 } }, 'a.b'), 3); assert.equal(getPath({ a: 1 }, 'a.b'), undefined);
  assert.equal(parseConfigValue('true'), true); assert.equal(parseConfigValue('2.5'), 2.5); assert.equal(parseConfigValue('cheap'), 'cheap');
  assert.deepEqual(parseConfigValue('["/a","/b"]'), ['/a', '/b']);
});
test('loadConfig/saveConfig round-trip through a temp KORA_HOME', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-cfg-')); const prev = process.env.KORA_HOME; process.env.KORA_HOME = home;
  try {
    const { loadConfig, saveConfig, invalidateConfig } = require('./config') as typeof import('./config');
    invalidateConfig();
    assert.equal(loadConfig().restartMode, 'resume');
    assert.equal(loadConfig().autoAnswer.mcpFound, false, 'a repo\'s .mcp.json server is never auto-approved by default');
    const c = saveConfig(patchFromPath('autoAnswer.mcpFound', true));
    assert.equal(c.autoAnswer.mcpFound, true); assert.equal(c.autoAnswer.trustFolder, true);
    const raw = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    assert.deepEqual(raw, { autoAnswer: { mcpFound: true } }, 'only the patch is written, defaults stay implicit');
  } finally { if (prev === undefined) delete process.env.KORA_HOME; else process.env.KORA_HOME = prev; }
});
