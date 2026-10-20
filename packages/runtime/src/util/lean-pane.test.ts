import test from 'node:test';
import assert from 'node:assert/strict';
import { leanPaneEnv } from './lean-pane';

test('lean pane: a worker pane caps the skill listing, turns prompt suggestions and the Artifact tool off, keeps auto memory', () => {
  assert.deepEqual(leanPaneEnv({}), { SLASH_COMMAND_TOOL_CHAR_BUDGET: '8000', CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false', CLAUDE_CODE_DISABLE_ARTIFACT: '1' });
});

test('lean pane: the chat lane, a switch-off and the user\'s own values are left alone', () => {
  assert.deepEqual(leanPaneEnv({ KORA_INJECT_OWNER: 'driver' }), {});
  assert.deepEqual(leanPaneEnv({ KORA_LEAN_PANES: '0' }), {});
  assert.deepEqual(leanPaneEnv({ CLAUDE_CODE_DISABLE_ARTIFACT: '0', SLASH_COMMAND_TOOL_CHAR_BUDGET: '30000' }), { CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false' });
});
