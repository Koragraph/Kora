// Engine detection: every engine is a row with a reason when unavailable; explicit paths win; nothing throws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_ACP_ENGINES, detectAcpEngines, detectApiEndpoints, detectCliEngine, mergeAcpEngines } from './engine-detect-ext';
import { normalizeEndpoint } from './drivers/api-providers';

test('CLI engines: found on PATH, missing with an install reason, explicit path wins or explains itself', () => {
  const resolve = (n: string) => (n === 'gemini' ? '/opt/bin/gemini' : null);
  const base = { id: 'g', label: 'Gemini CLI', family: 'acp' as const, command: 'gemini' };
  assert.deepEqual(detectCliEngine(base, { resolve }), { id: 'g', label: 'Gemini CLI', family: 'acp', available: true, executable: '/opt/bin/gemini' });
  const miss = detectCliEngine({ ...base, command: 'grok', label: 'Grok CLI' }, { resolve });
  assert.equal(miss.available, false); assert.match(miss.reason!, /`grok` was not found.*Settings > Engines/);
  const ok = detectCliEngine({ ...base, executable: '/x/gemini' }, { resolve, isExecutable: () => true });
  assert.equal(ok.executable, '/x/gemini'); assert.equal(ok.explicitPath, true);
  assert.match(detectCliEngine({ ...base, executable: '/x/gemini' }, { resolve, isExecutable: () => false }).reason!, /does not exist or is not executable/);
  assert.match(detectCliEngine({ ...base, executable: 'gemini' }, { resolve }).reason!, /must be absolute/);
});

test('all built-in ACP engines are listed; the fleet never throws when none is installed', () => {
  const rows = detectAcpEngines(BUILTIN_ACP_ENGINES, { resolve: () => null });
  assert.equal(rows.length, BUILTIN_ACP_ENGINES.length); assert.ok(rows.every((r) => !r.available && r.reason));
  for (const id of ['grok', 'cursor', 'kimi', 'qwen', 'droid']) assert.ok(rows.some((r) => r.id === id), id);
  assert.ok(!rows.some((r) => r.id === 'gemini'), 'Gemini CLI is not auto-detected any more (Antigravity is Google\'s agent)');
});

test('API endpoints: a key-needing endpoint without a key says so; a local one is usable', async () => {
  const eps = [normalizeEndpoint({ id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' }), normalizeEndpoint({ id: 'lm', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1' })];
  const rows = await detectApiEndpoints(eps, { hasKey: () => false });
  assert.equal(rows[0]!.available, false); assert.equal(rows[0]!.needsKey, true); assert.match(rows[0]!.reason!, /needs an API key/);
  assert.equal(rows[1]!.available, true);
  assert.equal((await detectApiEndpoints(eps, { hasKey: (id) => id === 'groq' }))[0]!.available, true);
});

test('mergeAcpEngines: overrides patch built-ins; custom ids must be acp-<slug> with a command', () => {
  const m = mergeAcpEngines([{ agentId: 'gemini', executable: '/x/g', args: ['--acp', '-y'] }, { agentId: 'acp-mine', label: 'Mine', command: 'mycli', args: ['serve'] }, { agentId: 'bad id', label: 'x', command: 'x' }, { agentId: 'acp-nocmd', label: 'x' }]);
  assert.equal(m.find((e) => e.agentId === 'gemini')!.executable, '/x/g'); assert.deepEqual(m.find((e) => e.agentId === 'gemini')!.args, ['--acp', '-y']);
  assert.equal(m.find((e) => e.agentId === 'gemini')!.command, 'gemini');
  assert.equal(m.find((e) => e.agentId === 'acp-mine')!.command, 'mycli');
  assert.equal(m.some((e) => e.agentId === 'bad id' || e.agentId === 'acp-nocmd'), false);
});
