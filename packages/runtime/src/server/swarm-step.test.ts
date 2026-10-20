// swarm-step: pure mapping from an OpenCode `part` row / a Koragent `tool.start` event to a swarm worker's
// thought-bubble step. No DB, no sockets — see swarm-watchdog.test.ts for the DB reader and swarm.test.ts for
// SwarmService wiring (tickSteps, the koragent tool.start case).
import test from 'node:test';
import assert from 'node:assert/strict';
import { isReportPath, partToStep, stepFromKoragentToolStart, swarmStepKind, truncateStepText } from './swarm-step';

test('swarmStepKind: the mapped tools, case-insensitively; everything else is "other"', () => {
  assert.equal(swarmStepKind('webfetch'), 'fetch');
  assert.equal(swarmStepKind('WebSearch'), 'search');
  assert.equal(swarmStepKind('read'), 'read');
  assert.equal(swarmStepKind('write'), 'write');
  assert.equal(swarmStepKind('edit'), 'write');
  assert.equal(swarmStepKind('bash'), 'run');
  for (const t of ['glob', 'grep', 'task', 'todowrite', 'kora_explore', 'skill', 'invalid', ''])
    assert.equal(swarmStepKind(t), 'other');
});

test('isReportPath: only a trailing report.md (either slash style), case-insensitive', () => {
  assert.equal(isReportPath('/x/scratch/s18/report.md'), true);
  assert.equal(isReportPath('C:\\x\\REPORT.MD'.toLowerCase()), true);
  assert.equal(isReportPath('/x/scratch/s18/report.md.bak'), false);
  assert.equal(isReportPath('/x/reportage.md'), false);
});

test('truncateStepText: ≤48 by default, ellipsis on the last kept char, whitespace collapsed', () => {
  assert.equal(truncateStepText('  a   b  '), 'a b');
  const long = 'x'.repeat(60);
  const t = truncateStepText(long);
  assert.equal(t.length, 48);
  assert.ok(t.endsWith('…'));
  assert.equal(truncateStepText('short'), 'short');
});

const part = (data: unknown, at = 1000) => partToStep(data, at);

test('partToStep: webfetch → fetch "reading <hostname>", www. stripped', () => {
  const s = part({ type: 'tool', tool: 'webfetch', state: { input: { url: 'https://www.example.com/a/b?q=1' } } }, 5);
  assert.deepEqual(s, { text: 'reading example.com', at: 5, kind: 'fetch' });
});

test('partToStep: websearch → search \'searching "<query, short>"\', the whole step always ≤48 chars', () => {
  const short = part({ type: 'tool', tool: 'websearch', state: { input: { query: 'best sitcoms of the 80s' } } }, 1);
  assert.deepEqual(short, { text: 'searching "best sitcoms of the 80s"', at: 1, kind: 'search' });
  // A long query is cut well before the contracts' 48-char cap (the quotes + "searching " prefix cost 12 chars).
  const long = part({ type: 'tool', tool: 'websearch', state: { input: { query: 'a'.repeat(60) } } }, 2);
  assert.equal(long!.kind, 'search');
  assert.ok(long!.text.startsWith('searching "'));
  assert.ok(long!.text.length <= 48, `≤48 chars: ${long!.text.length}`);
});

test('partToStep: read → read "reading <basename>"', () => {
  const s = part({ type: 'tool', tool: 'read', state: { input: { filePath: '/a/b/c/notes.md' } } }, 2);
  assert.deepEqual(s, { text: 'reading notes.md', at: 2, kind: 'read' });
});

test('partToStep: write/edit → write "writing <basename>", or "writing report" for a report.md', () => {
  const w = part({ type: 'tool', tool: 'write', state: { input: { filePath: '/a/b/out.csv' } } }, 3);
  assert.deepEqual(w, { text: 'writing out.csv', at: 3, kind: 'write' });
  const e = part({ type: 'tool', tool: 'edit', state: { input: { filePath: '/x/scratch/s1/report.md' } } }, 4);
  assert.deepEqual(e, { text: 'writing report', at: 4, kind: 'write' });
});

test('partToStep: bash → run "running <command, truncated>"', () => {
  const s = part({ type: 'tool', tool: 'bash', state: { input: { command: 'python3 analyze.py --input data/orders.csv --out /tmp/y' } } }, 6);
  assert.equal(s!.kind, 'run');
  assert.match(s!.text, /^running python3 analyze/);
  assert.ok(s!.text.length <= 48);
});

test('partToStep: an unmapped tool (glob, kora_explore, …) → other "using <tool>"', () => {
  const s = part({ type: 'tool', tool: 'kora_explore', state: { input: { query: 'x' } } }, 7);
  assert.deepEqual(s, { text: 'using kora_explore', at: 7, kind: 'other' });
});

test('partToStep: a text or reasoning part → think "thinking…", regardless of its own text', () => {
  assert.deepEqual(part({ type: 'text', text: 'Report written. Verified and ready to use…' }, 8), { text: 'thinking…', at: 8, kind: 'think' });
  assert.deepEqual(part({ type: 'reasoning', text: 'No IMDb source link…' }, 9), { text: 'thinking…', at: 9, kind: 'think' });
});

test('partToStep: null for step-start/step-finish/patch/compaction, a missing tool name, or garbage input', () => {
  for (const t of ['step-start', 'step-finish', 'patch', 'compaction']) assert.equal(part({ type: t }, 1), null);
  assert.equal(part({ type: 'tool' }, 1), null, 'no tool name');
  assert.equal(part(null, 1), null);
  assert.equal(part('not an object', 1), null);
  assert.equal(part(42, 1), null);
});

test('stepFromKoragentToolStart: same kind/text mapping, from {tool, title} instead of a part row; always returns a step', () => {
  assert.deepEqual(stepFromKoragentToolStart({ tool: 'webfetch', title: 'https://www.imdb.com/list/ls1/' }, 1), { text: 'reading imdb.com', at: 1, kind: 'fetch' });
  assert.deepEqual(stepFromKoragentToolStart({ tool: 'read', title: '/a/b/report.md' }, 2), { text: 'reading report.md', at: 2, kind: 'read' });
  assert.deepEqual(stepFromKoragentToolStart({ tool: 'write', title: '/a/b/report.md' }, 3), { text: 'writing report', at: 3, kind: 'write' });
  assert.deepEqual(stepFromKoragentToolStart({ tool: 'bash', title: 'npm test' }, 4), { text: 'running npm test', at: 4, kind: 'run' });
  const search = stepFromKoragentToolStart({ tool: 'websearch', title: 'best sitcoms IMDb editors' }, 5);
  assert.deepEqual(search, { text: 'searching "best sitcoms IMDb editors"', at: 5, kind: 'search' });
  assert.deepEqual(stepFromKoragentToolStart({ tool: 'kora_neighbours', title: 'X' }, 6), { text: 'using kora_neighbours', at: 6, kind: 'other' });
});

test('readable steps for shell fetches, OpenCode subtasks and spilled tool output', () => {
  assert.equal(partToStep({ type: 'tool', tool: 'bash', state: { input: { command: 'curl -sL -A "Mozilla/5.0" "https://www.expatistan.com/cost-of-living/seoul"' } } }, 1)?.text, 'fetching expatistan.com');
  assert.equal(partToStep({ type: 'tool', tool: 'bash', state: { input: { command: 'ls -la' } } }, 1)?.text, 'running ls -la');
  assert.equal(partToStep({ type: 'tool', tool: 'task', state: { input: { prompt: 'Research Tallinn' } } }, 1)?.text, 'splitting off a subtask');
  assert.equal(partToStep({ type: 'tool', tool: 'read', state: { input: { filePath: '/Users/x/.local/share/opencode/tool-output/tool_0eda8b42' } } }, 1)?.text, 'reviewing results');
});
