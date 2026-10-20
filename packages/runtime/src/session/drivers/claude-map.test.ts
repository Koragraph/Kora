import { test } from 'node:test';
import assert from 'node:assert';
import {
  mapSdkMessage, classifyToolKind, classifyApprovalKind, extractPlanSteps, normalizeTurnUsage,
  isInterruptedResult, describeRateLimit, questionsFromAskUserInput, changedFilesFromToolResult,
  toSdkPermissionMode, isKoraTool, isSpawnTool,
} from './claude-driver';

test('classifyToolKind maps built-ins and MCP names', () => {
  assert.equal(classifyToolKind('Bash'), 'command_execution');
  assert.equal(classifyToolKind('Edit'), 'file_change');
  assert.equal(classifyToolKind('Read'), 'file_read');
  assert.equal(classifyToolKind('WebSearch'), 'web_search');
  assert.equal(classifyToolKind('mcp__kora__explore'), 'graph_query');
  assert.equal(classifyToolKind('mcp__other__thing'), 'mcp_tool_call');
});

test('classifyApprovalKind follows the tool kind', () => {
  assert.equal(classifyApprovalKind('Bash'), 'command_execution_approval');
  assert.equal(classifyApprovalKind('Write'), 'file_change_approval');
  assert.equal(classifyApprovalKind('Read'), 'file_read_approval');
  assert.equal(classifyApprovalKind('mcp__x__y'), 'mcp_elicitation_approval');
});

test('extractPlanSteps normalizes TodoWrite items', () => {
  const plan = extractPlanSteps({ todos: [
    { content: 'do a', status: 'completed' },
    { content: 'do b', status: 'in_progress' },
    { content: 'do c', status: 'pending' },
    { content: '', status: 'pending' },
  ] });
  assert.deepEqual(plan, [
    { step: 'do a', status: 'completed' },
    { step: 'do b', status: 'inProgress' },
    { step: 'do c', status: 'pending' },
  ]);
});

test('normalizeTurnUsage folds cache tokens and reports availability', () => {
  const u = normalizeTurnUsage({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 })!;
  assert.equal(u.usageStatus, 'complete');
  assert.equal(u.inputTokens, 100);
  assert.equal(u.outputTokens, 20);
  assert.equal(u.cachedInputTokens, 8);
  assert.equal(normalizeTurnUsage({})!.usageStatus, 'unavailable');
  assert.equal(normalizeTurnUsage(null), undefined);
});

test('isInterruptedResult detects interrupt/abort', () => {
  assert.equal(isInterruptedResult({ terminal_reason: 'interrupted' }), true);
  assert.equal(isInterruptedResult({ stop_reason: 'end_turn' }), false);
  assert.equal(isInterruptedResult({ subtype: 'error_during_execution' }), true);
});

test('describeRateLimit formats window + reset', () => {
  const d = describeRateLimit({ window: 'five_hour', resetsAt: 0 });
  assert.match(d.message, /Claude usage limit reached/);
  assert.equal(d.window, 'five_hour');
});

test('questionsFromAskUserInput parses structured questions', () => {
  const qs = questionsFromAskUserInput({ questions: [{ id: 'q1', header: 'Pick', question: 'Which?', options: [{ label: 'A', description: 'first', value: 'a' }, { label: 'B', description: '' }], multiSelect: true }] });
  assert.equal(qs.length, 1);
  assert.equal(qs[0].id, 'q1');
  assert.equal(qs[0].options[0].value, 'a');
  assert.equal(qs[0].multiSelect, true);
});

test('changedFilesFromToolResult extracts a FileChange for a file_change tool', () => {
  const cf = changedFilesFromToolResult('Edit', { file_path: '/repo/a.ts' }, { additions: 3, deletions: 1 })!;
  assert.deepEqual(cf, [{ path: '/repo/a.ts', additions: 3, deletions: 1 }]);
  assert.equal(changedFilesFromToolResult('Read', { file_path: '/x' }, {}), undefined, 'reads have no changed files');
});

test('toSdkPermissionMode maps runtime modes to SDK modes', () => {
  assert.equal(toSdkPermissionMode('approval-required'), 'default');
  assert.equal(toSdkPermissionMode('auto-accept-edits'), 'acceptEdits');
  assert.equal(toSdkPermissionMode('auto'), 'auto');
  assert.equal(toSdkPermissionMode('auto', true), 'default');
  assert.equal(toSdkPermissionMode('full-access'), 'bypassPermissions');
});

test('isKoraTool / isSpawnTool recognize our own tools', () => {
  assert.equal(isKoraTool('mcp__kora__explore'), true);
  assert.equal(isKoraTool('kora_spawn'), true);
  assert.equal(isKoraTool('Bash'), false);
  assert.equal(isSpawnTool('kora_spawn'), true);
});

// ── mapSdkMessage ──────────────────────────────────────────────────────────────
test('system/init → session.started + thread.started(providerThreadId) + session.state', () => {
  const evs = mapSdkMessage({ type: 'system', subtype: 'init', session_id: 'sess-9', model: 'claude' });
  assert.deepEqual(evs.map((e) => e.type), ['session.started', 'thread.started', 'session.state']);
  assert.equal((evs[1] as any).providerThreadId, 'sess-9');
  assert.equal((evs[2] as any).state, 'ready');
});

test('stream_event text_delta → assistant_text content.delta with a stable per-block itemId', () => {
  const base = { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } } };
  const a = mapSdkMessage(base, { turnId: 'turn_1' });
  const b = mapSdkMessage({ ...base, event: { ...base.event, delta: { type: 'text_delta', text: 'lo' } } }, { turnId: 'turn_1' });
  assert.equal(a[0].type, 'content.delta');
  assert.equal((a[0] as any).stream, 'assistant_text');
  assert.equal((a[0] as any).itemId, (b[0] as any).itemId, 'deltas of the same block share an itemId');
});

test('stream_event thinking_delta → reasoning_text', () => {
  const evs = mapSdkMessage({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'hmm' } } }, { turnId: 't' });
  assert.equal((evs[0] as any).stream, 'reasoning_text');
});

test('assistant tool_use → tool.started keyed by the tool_use id; kora tools + spawn are suppressed', () => {
  const msg = { type: 'assistant', message: { id: 'm1', content: [
    { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls -la' } },
    { type: 'tool_use', id: 'tu_2', name: 'mcp__kora__explore', input: { query: 'x' } },
    { type: 'tool_use', id: 'tu_3', name: 'kora_spawn', input: { agent: 'claude' } },
  ] } };
  const evs = mapSdkMessage(msg, { turnId: 't' });
  assert.equal(evs.length, 1, 'only the Bash tool card; kora tools handled elsewhere');
  assert.equal(evs[0].type, 'tool.started');
  assert.equal((evs[0] as any).itemId, 'tu_1');
  assert.equal((evs[0] as any).toolKind, 'command_execution');
  assert.match((evs[0] as any).title, /^\$ ls -la/);
});

test('assistant TodoWrite → turn.plan; AskUserQuestion → user-input.requested', () => {
  const plan = mapSdkMessage({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 't', name: 'TodoWrite', input: { todos: [{ content: 'step', status: 'pending' }] } }] } }, {});
  assert.equal(plan[0].type, 'turn.plan');
  const ask = mapSdkMessage({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { questions: [{ header: 'H', question: 'Q?', options: [] }] } }] } }, {});
  assert.equal(ask[0].type, 'user-input.requested');
  assert.equal((ask[0] as any).requestId, 'q1');
});

test('user tool_result → tool.result keyed by tool_use_id, with changedFiles for edits', () => {
  const evs = mapSdkMessage({ type: 'user', tool_use_result: { additions: 2, deletions: 0 }, message: { content: [
    { type: 'tool_result', tool_use_id: 'tu_1', tool_name: 'Edit', tool_input: { file_path: '/a.ts' }, is_error: false, content: 'ok' },
  ] } }, {});
  assert.equal(evs[0].type, 'tool.result');
  assert.equal((evs[0] as any).itemId, 'tu_1');
  assert.equal((evs[0] as any).status, 'completed');
  assert.deepEqual((evs[0] as any).changedFiles, [{ path: '/a.ts', additions: 2, deletions: 0 }]);
});

test('user tool_result for a failed tool → status failed', () => {
  const evs = mapSdkMessage({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', tool_name: 'Bash', is_error: true, content: 'boom' }] } }, {});
  assert.equal((evs[0] as any).status, 'failed');
});

test('result → turn.settled with usage; interrupted result is flagged', () => {
  const ok = mapSdkMessage({ type: 'result', subtype: 'success', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 4 } }, { turnId: 'turn_7' });
  const settled = ok.find((e) => e.type === 'turn.settled') as any;
  assert.equal(settled.turnId, 'turn_7');
  assert.equal(settled.state, 'completed');
  assert.equal(settled.usage.outputTokens, 4);
  const interrupted = mapSdkMessage({ type: 'result', terminal_reason: 'interrupted' }, { turnId: 't' });
  assert.equal((interrupted[0] as any).state, 'interrupted');
});

test('result with a rate limit → usage.rate-limit', () => {
  const evs = mapSdkMessage({ type: 'result', subtype: 'success', usage: {}, rate_limit: { window: 'weekly', message: 'slow down' } }, { turnId: 't' });
  assert.ok(evs.some((e) => e.type === 'usage.rate-limit'));
});

test('an unknown message shape fails soft to a runtime.warning', () => {
  const evs = mapSdkMessage({ type: 'assistant', message: null }, {});
  assert.deepEqual(evs, []);
});
