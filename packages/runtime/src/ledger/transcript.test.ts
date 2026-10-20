import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTranscript, focusFiles, filesReferenced, assistantTurns, findTranscript } from './transcript';

function line(o: any) { return JSON.stringify(o) + '\n'; }
function transcript(dir: string, steps: { tools?: { name: string; input: any; result: string }[]; usage?: any }[]): string {
  const f = path.join(dir, 'sess.jsonl'); let out = '';
  out += line({ type: 'user', cwd: dir, sessionId: 's', message: { role: 'user', content: 'do it' } });
  steps.forEach((st, i) => {
    const content: any[] = [{ type: 'text', text: 'ok' }];
    for (const t of st.tools || []) content.push({ type: 'tool_use', id: `t${i}${t.name}`, name: t.name, input: t.input });
    out += line({ type: 'assistant', cwd: dir, sessionId: 's', requestId: `r${i}`, message: { model: 'claude-sonnet-5', usage: st.usage || { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 20000, output_tokens: 50 }, content } });
    for (const t of st.tools || []) out += line({ type: 'user', cwd: dir, sessionId: 's', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}${t.name}`, content: t.result }] } });
  });
  fs.writeFileSync(f, out); return f;
}

test('ledger: usage is summed per API call, tools classified, graph focus files credited once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-ledger-'));
  fs.mkdirSync(path.join(dir, 'src')); fs.writeFileSync(path.join(dir, 'src', 'big.js'), 'x'.repeat(20000)); fs.writeFileSync(path.join(dir, 'src', 'small.js'), 'y'.repeat(2000));
  const explore = '2 match(es)\n■ METHOD foo @ src/big.js:10 — foo()\n  callers: bar@src/small.js:3\n  --- source src/big.js:10-20 ---\n  code\n';
  const f = transcript(dir, [
    { tools: [{ name: 'Bash', input: { command: 'kora graph explore foo' }, result: explore }] },
    { tools: [{ name: 'Bash', input: { command: 'kora graph explore foo again' }, result: explore }] },
    { tools: [{ name: 'Grep', input: { pattern: 'foo' }, result: 'src/small.js:3' }] },
    { tools: [{ name: 'Read', input: { file_path: path.join(dir, 'src', 'small.js') }, result: 'yyy' }] },
    { tools: [] },
  ]);
  const s = parseTranscript(f);
  assert.equal(s.steps.length, 5); assert.equal(s.totals.apiCalls, 5);
  assert.equal(s.totals.context, 5 * 21010);
  assert.deepEqual([s.toolCounts.graph, s.toolCounts.grep, s.toolCounts.read], [2, 1, 1]);
  assert.equal(s.graphCalls[0].via, 'cli');
  assert.deepEqual(focusFiles(explore), ['src/big.js']);
  assert.ok(filesReferenced(explore).includes('src/small.js'));
  assert.ok(s.savings.cacheHitRate > 0 && s.savings.cacheHitRate <= 1, 'only measured cache economics remain');
  assert.ok(s.costUsd > 0);
});

test('assistantTurns: the worker report a TUI pane can no longer show — prose only, newest last, sidechain skipped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-turns-'));
  const f = path.join(dir, 'w.jsonl');
  const line = (o: unknown) => JSON.stringify(o) + '\n';
  fs.writeFileSync(f, [
    line({ type: 'user', message: { role: 'user', content: 'research zep' }, timestamp: '2026-01-01T00:00:00Z' }),
    line({ type: 'assistant', timestamp: '2026-01-01T00:00:01Z', message: { content: [{ type: 'text', text: 'Looking it up.' }] } }),
    // a tool-only step says nothing out loud
    line({ type: 'assistant', timestamp: '2026-01-01T00:00:02Z', message: { content: [{ type: 'tool_use', name: 'WebSearch', input: {} }] } }),
    // a subagent echo is not the worker's own voice
    line({ type: 'assistant', isSidechain: true, timestamp: '2026-01-01T00:00:03Z', message: { content: [{ type: 'text', text: 'from a subagent' }] } }),
    // one API call split across blocks folds into a single turn
    line({ type: 'assistant', timestamp: '2026-01-01T00:00:04Z', message: { content: [{ type: 'text', text: '## Zep' }] } }),
    line({ type: 'assistant', timestamp: '2026-01-01T00:00:04Z', message: { content: [{ type: 'text', text: 'Temporal knowledge graph.' }] } }),
  ].join(''));

  const all = assistantTurns(f);
  assert.deepEqual(all.map((t) => t.text), ['Looking it up.', '## Zep\nTemporal knowledge graph.']);
  assert.deepEqual(assistantTurns(f, 1).map((t) => t.text), ['## Zep\nTemporal knowledge graph.']);
  assert.deepEqual(assistantTurns(path.join(dir, 'missing.jsonl')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('findTranscript: locates <sessionId>.jsonl under any ~/.claude/projects slug', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-home-'));
  const slug = path.join(home, '.claude', 'projects', '-Users-x-repo');
  fs.mkdirSync(slug, { recursive: true });
  fs.writeFileSync(path.join(slug, 's-1.jsonl'), '');
  assert.equal(findTranscript('s-1', home), path.join(slug, 's-1.jsonl'));
  assert.equal(findTranscript('s-missing', home), null);
  fs.rmSync(home, { recursive: true, force: true });
});

test('Haiku 5.5 is billed at the long-prompt rates for a request past 100K prompt tokens (deep A3-12)', async () => {
  const { requestCostOf, costOf } = await import('./transcript');
  const short = { input: 1000, cacheWrite: 0, cacheRead: 50_000, output: 1000 };
  assert.equal(requestCostOf(short, 'claude-haiku-5-5'), costOf(short, 'claude-haiku-5-5'), 'under the threshold: the flat row');
  const long = { input: 1000, cacheWrite: 0, cacheRead: 150_000, output: 1000 };
  // 1000 in @0.50 + 150000 read @0.05 + 1000 out @2.50, per million
  assert.ok(Math.abs(requestCostOf(long, 'claude-haiku-5-5') - (1000 * 0.5 + 150_000 * 0.05 + 1000 * 2.5) / 1e6) < 1e-12);
  assert.ok(requestCostOf(long, 'claude-haiku-5-5') > costOf(long, 'claude-haiku-5-5') * 4.9);
  assert.equal(requestCostOf(long, 'claude-sonnet-5-5'), costOf(long, 'claude-sonnet-5-5'), 'no tier on other models');
});

test('findTranscript searches CLAUDE_CONFIG_DIR accounts too', async () => {
  const { findTranscript: find } = await import('./transcript');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-home-'));
  const acct = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-acct-'));
  fs.mkdirSync(path.join(acct, 'projects', '-x'), { recursive: true });
  const f = path.join(acct, 'projects', '-x', 'sess-9.jsonl'); fs.writeFileSync(f, '{}\n');
  assert.equal(find('sess-9', home), null);
  assert.equal(find('sess-9', home, [acct]), f);
});

test('guessClaudeTranscript: the one fresh, unclaimed transcript in the cwd\'s project dir', async () => {
  const { guessClaudeTranscript, claudeProjectSlug } = await import('./transcript');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-guess-'));
  const cwd = '/tmp/wt/my.repo';
  assert.equal(claudeProjectSlug(cwd), '-tmp-wt-my-repo');
  const dir = path.join(home, '.claude', 'projects', claudeProjectSlug(cwd)); fs.mkdirSync(dir, { recursive: true });
  const old = path.join(dir, 'old.jsonl'); fs.writeFileSync(old, '{}\n');
  const t0 = Date.now(); fs.utimesSync(old, new Date(t0 - 3600_000), new Date(t0 - 3600_000));
  assert.equal(guessClaudeTranscript({ cwds: [cwd], home, since: t0 }), null);
  const a = path.join(dir, 'a.jsonl'); fs.writeFileSync(a, '{}\n');
  assert.equal(guessClaudeTranscript({ cwds: [cwd], home, since: t0 }), a);
  const b = path.join(dir, 'b.jsonl'); fs.writeFileSync(b, '{}\n');
  assert.equal(guessClaudeTranscript({ cwds: [cwd], home, since: t0 }), null, 'two candidates: no guess');
  assert.equal(guessClaudeTranscript({ cwds: [cwd], home, since: t0, claimed: new Set([a]) }), b);
});

test('Sonnet 5.5 reads at the pricing page\'s $0.10/M, not the Agent SDK\'s $0.20/M (both checked 2026-10-15)', async () => {
  const { costOf } = await import('./transcript');
  // claude-sonnet-5-5 modelUsage of a 2-turn isolated session: SDK costUSD 0.0800302 (costBasis "list", reads at $0.20/M)
  const sdk = 0.0800302;
  const ours = costOf({ input: 4, output: 6, cacheRead: 10_831, cacheWrite: 19_449 }, 'claude-sonnet-5-5');
  assert.ok(Math.abs(ours - (sdk - 10_831 * 0.1 / 1e6)) < 1e-9, `ours ${ours} vs SDK ${sdk}`);
});
