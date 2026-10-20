import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTool, emptyBucket, foldAssistant, foldInjections, summarize, gate, median, spread, RunMetrics, emptyTools, steadyCostOf } from './metrics';

test('classifyTool: whole vs range reads, bash greps, graph via CLI and MCP', () => {
  assert.equal(classifyTool('Read', { file_path: 'a' }), 'wholeFileRead');
  assert.equal(classifyTool('Read', { file_path: 'a', offset: 3 }), 'rangeRead');
  assert.equal(classifyTool('Grep', { pattern: 'x' }), 'grep');
  assert.equal(classifyTool('Bash', { command: 'rg foo src' }), 'bashSearch');
  assert.equal(classifyTool('Bash', { command: 'kora graph explore foo' }), 'graph');
  assert.equal(classifyTool('mcp__kora__explore', {}), 'graph');
  assert.equal(classifyTool('Agent', {}), 'subagent');
  assert.equal(classifyTool('Bash', { command: 'npm test' }), 'other');
});

test('foldAssistant accumulates usage per API call and flags a search', () => {
  const b = emptyBucket();
  foldAssistant(b, { usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 7 }, content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'x' } }] });
  foldAssistant(b, { usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'y' } }] });
  // one API call streamed as two events (thinking block, then tool_use) with the same message id: usage counted once
  foldAssistant(b, { id: 'msg_1', usage: { input_tokens: 5, cache_creation_input_tokens: 40000, output_tokens: 3 }, content: [{ type: 'thinking' }] });
  foldAssistant(b, { id: 'msg_1', usage: { input_tokens: 5, cache_creation_input_tokens: 40000, output_tokens: 3 }, content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'z', limit: 5 } }] });
  assert.equal(b.apiCalls, 3); assert.equal(b.cacheWrite, 40005); assert.equal(b.tools.rangeRead, 1, 'tool blocks still counted per event');
  assert.equal(b.firstCallCacheWrite, 5, 'first call recorded once');
  const c = emptyBucket(); foldAssistant(c, { id: 'm', usage: { cache_creation_input_tokens: 44000, cache_read_input_tokens: 24000, output_tokens: 1 }, content: [] });
  assert.equal(c.firstCallCacheWrite, 44000); assert.ok(steadyCostOf(0.185, 44000, 'claude-sonnet-5') < 0.05, 'the cold-prefix write is stripped');
  assert.equal(b.apiCalls, 3);
  assert.equal(b.cacheRead, 100); assert.equal(b.tools.read, 2); assert.equal(b.tools.wholeFileRead, 1); assert.equal(b.tools.grep, 1); assert.equal(b.searched, true);
});

test('foldInjections separates hits from misses with reasons and prices injected chars', () => {
  const r = foldInjections([
    { ts: 't', decision: 'injected', reason: 'injected', decls: 2, chars: 800, sessionId: 's' },
    { ts: 't', decision: 'miss', reason: 'explore-timeout', decls: 0, chars: 0, sessionId: 's' },
    { ts: 't', decision: 'skipped', reason: 'not-code-shaped', decls: 0, chars: 0, sessionId: 's' },
  ]);
  assert.equal(r.graphHits, 1); assert.equal(r.graphMisses, 1); assert.equal(r.injectedDecls, 2); assert.equal(r.injectedTokens, 200); assert.deepEqual(r.missReasons, { 'explore-timeout': 1 });
});

function run(p: Partial<RunMetrics>): RunMetrics {
  if (p.cost != null && p.steadyCost == null) p = { ...p, steadyCost: p.cost };
  return { schema: 2, suite: 's', task: 't', kind: 'understand', regime: 'indexed', condition: 'baseline', repeat: 0, model: 'm', effort: 'e', sessionId: null, startedAt: 'x', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 1, firstCallCacheWrite: 0, firstCallCacheRead: 0, steadyCost: 1, precision: { noRead: 0, match: 0, other: 0 }, turns: 1, toolCalls: emptyTools(), wallClock: 1, injectedTokens: 0, injectedDecls: 0, injections: 0, graphHits: 0, graphMisses: 0, missReasons: {}, fellBackToGrep: 0, success: true, successDetail: [], error: null, ...p };
}
const meta = { suite: 's', repo: { path: '/r', sha: 'abc' }, model: 'm', effort: 'e', repeats: 3, conditions: ['baseline', 'kora'] };

test('summarize: medians, savings only where both arms succeeded, noise band', () => {
  const runs = [
    run({ task: 'a', condition: 'baseline', cost: 1.0 }), run({ task: 'a', condition: 'baseline', cost: 1.2 }), run({ task: 'a', condition: 'baseline', cost: 0.9 }),
    run({ task: 'a', condition: 'kora', cost: 0.5, injectedDecls: 2, injectedTokens: 150 }), run({ task: 'a', condition: 'kora', cost: 0.6, injectedDecls: 2, injectedTokens: 150 }), run({ task: 'a', condition: 'kora', cost: 0.55, injectedDecls: 1, injectedTokens: 100 }),
    run({ task: 'b', condition: 'baseline', cost: 1.0 }), run({ task: 'b', condition: 'kora', cost: 0.2, success: false }),
  ];
  const s = summarize(runs, meta);
  const a = s.tasks.find((t) => t.task === 'a')!; const b = s.tasks.find((t) => t.task === 'b')!;
  assert.equal(a.arms.baseline.cost.median, 1.0); assert.equal(a.arms.kora.cost.median, 0.55); assert.equal(a.savingsPct, 45); assert.equal(a.bothSucceeded, true); assert.equal(a.noise, false);
  assert.equal(b.savingsPct, null, 'a cheaper WRONG answer is not a saving'); assert.equal(b.bothSucceeded, false);
  assert.equal(s.overallSavingsPct, 45, 'overall counts only comparable tasks');
  assert.equal(median([3, 1, 2]), 2); assert.ok(spread([1, 1.2, 0.9]) > 0.29 && spread([1, 1.2, 0.9]) < 0.31);
});

test('gate fails on savings regression, success drop, injected-token inflation, and silent injection kill', () => {
  const base = summarize([run({ task: 'a', condition: 'baseline', cost: 1 }), run({ task: 'a', condition: 'kora', cost: 0.5, injectedDecls: 2, injectedTokens: 100 })], meta);
  const same = summarize([run({ task: 'a', condition: 'baseline', cost: 1 }), run({ task: 'a', condition: 'kora', cost: 0.52, injectedDecls: 2, injectedTokens: 110 })], meta);
  assert.equal(gate(base, same).ok, true, JSON.stringify(gate(base, same).lines));
  const worse = summarize([run({ task: 'a', condition: 'baseline', cost: 1 }), run({ task: 'a', condition: 'kora', cost: 0.9, injectedDecls: 2, injectedTokens: 100 })], meta);
  assert.equal(gate(base, worse).ok, false);
  const killed = summarize([run({ task: 'a', condition: 'baseline', cost: 1 }), run({ task: 'a', condition: 'kora', cost: 0.6, injectedDecls: 0, injectedTokens: 0 })], meta);
  const g = gate(base, killed); assert.equal(g.ok, false); assert.ok(g.lines.some((l) => /silent injection kill/.test(l)), g.lines.join('\n'));
  const cheaperWithout = summarize([run({ task: 'a', condition: 'baseline', cost: 1 }), run({ task: 'a', condition: 'kora', cost: 0.4, injectedDecls: 0, injectedTokens: 0 })], meta);
  const g2 = gate(base, cheaperWithout); assert.equal(g2.ok, true, g2.lines.join('\n')); assert.ok(g2.lines.some((l) => /not a kill/.test(l)));
  const inflated = summarize([run({ task: 'a', condition: 'baseline', cost: 1 }), run({ task: 'a', condition: 'kora', cost: 0.5, injectedDecls: 2, injectedTokens: 400 })], meta);
  assert.equal(gate(base, inflated).ok, false);
  const failing = summarize([run({ task: 'a', condition: 'baseline', cost: 1 }), run({ task: 'a', condition: 'kora', cost: 0.5, injectedDecls: 2, injectedTokens: 100, success: false })], meta);
  assert.equal(gate(base, failing).ok, false);
});
