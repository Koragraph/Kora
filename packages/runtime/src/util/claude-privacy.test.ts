import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudePrivacyEnv } from './claude-privacy';
import { sessionBaseEnv } from '../session/drivers/claude-driver';

test('Claude privacy switch: off (or no settings file) adds nothing; on adds the two variables', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-priv-'));
  assert.deepEqual(claudePrivacyEnv(home), {}, 'no settings.json');
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ limitClaudeTelemetry: false }));
  assert.deepEqual(claudePrivacyEnv(home), {});
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ limitClaudeTelemetry: true }));
  assert.deepEqual(claudePrivacyEnv(home), { DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
  // the session env strips inherited CLAUDE_CODE_* markers, so the variables must be added AFTER sessionBaseEnv
  assert.equal(sessionBaseEnv({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', A: 'b' }).CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, undefined);
  fs.rmSync(home, { recursive: true, force: true });
});
