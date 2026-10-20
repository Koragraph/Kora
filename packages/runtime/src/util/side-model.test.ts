import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { firstPartyRoute, sideModelEnv, SIDE_MODEL } from './side-model';

test('side calls: Haiku 5.5 by default; the user choice, other clouds, a gateway and the off switch leave Claude Code alone', () => {
  assert.deepEqual(sideModelEnv({}), { ANTHROPIC_DEFAULT_HAIKU_MODEL: SIDE_MODEL });
  assert.deepEqual(sideModelEnv({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }), { ANTHROPIC_DEFAULT_HAIKU_MODEL: SIDE_MODEL });
  assert.deepEqual(sideModelEnv({ ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5' }), {});
  assert.deepEqual(sideModelEnv({ ANTHROPIC_SMALL_FAST_MODEL: 'x' }), {});
  assert.deepEqual(sideModelEnv({ CLAUDE_CODE_USE_BEDROCK: '1' }), {});
  assert.deepEqual(sideModelEnv({ CLAUDE_CODE_USE_VERTEX: '1' }), {});
  assert.deepEqual(sideModelEnv({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000' }), {});
  assert.deepEqual(sideModelEnv({ KORA_SIDE_MODEL: '0' }), {});
});

test('a route set in the user\'s Claude settings env counts (Claude Code applies it over the process env)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-side-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } }));
  assert.equal(firstPartyRoute({ CLAUDE_CONFIG_DIR: dir }), false);
  assert.deepEqual(sideModelEnv({ CLAUDE_CONFIG_DIR: dir }), {});
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'my-haiku' } }));
  assert.deepEqual(sideModelEnv({ CLAUDE_CONFIG_DIR: dir }), {}, 'their own small model wins');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'opus' }));
  assert.equal(firstPartyRoute({ CLAUDE_CONFIG_DIR: dir }), true);
});
