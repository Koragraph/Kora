import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeModelForLaunch, effectiveClaudeDefault } from './claude-default-model';

function cfg(settings?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-claudecfg-'));
  if (settings !== undefined) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
  return dir;
}

test('Default follows the user\'s Claude setting, else Sonnet', () => {
  assert.equal(effectiveClaudeDefault(cfg()), 'sonnet');
  assert.equal(effectiveClaudeDefault(cfg({ model: 'opus' })), 'opus');
  assert.equal(effectiveClaudeDefault(cfg({ model: 'default' })), 'sonnet');
  assert.equal(effectiveClaudeDefault(cfg({ model: '  ' })), 'sonnet');
});

test('only the "default" slug is rewritten; an explicit Opus pick is never changed', () => {
  assert.equal(claudeModelForLaunch('default', cfg()), 'sonnet');
  assert.equal(claudeModelForLaunch('opus', cfg({ model: 'sonnet' })), 'opus');
  assert.equal(claudeModelForLaunch('claude-opus-5-5', cfg()), 'claude-opus-5-5');
  assert.equal(claudeModelForLaunch(undefined, cfg()), undefined);
});
