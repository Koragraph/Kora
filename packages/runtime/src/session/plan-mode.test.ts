import test from 'node:test';
import assert from 'node:assert/strict';
import { GRAPH_READ_SUBCOMMANDS, OPENCODE_GRAPH_READ_ALLOW, isGraphQueryCommand } from './plan-mode';

test('a bare graph query runs in plan mode', () => {
  for (const c of [
    'kora graph explore "retry backoff"',
    'kora-dev graph neighbours sendTurn --direction in',
    'kora graph blast_radius --file src/a.ts 2>&1 | head -80',
    'kora graph search_code Foo | tail -n 20',
  ]) assert.equal(isGraphQueryCommand(c), true, c);
});

test('only read subcommands run unasked: prune, ingest and the rest are not auto-allowed', () => {
  for (const s of ['explore', 'search_code', 'neighbours', 'blast_radius', 'file_symbols', 'overview', 'changes_with', 'recall']) assert.equal(isGraphQueryCommand(`kora graph ${s} Foo`), true, s);
  for (const c of ['kora graph prune --now', 'kora graph prune', 'kora graph ingest .', 'kora graph status', 'kora graph exploreX y', 'kora graph', 'kora-dev graph prune --vacuum']) assert.equal(isGraphQueryCommand(c), false, c);
});

test('OpenCode allow patterns cover exactly the read subcommands, for kora and kora-dev', () => {
  assert.ok(OPENCODE_GRAPH_READ_ALLOW.includes('kora graph explore *'));
  assert.ok(OPENCODE_GRAPH_READ_ALLOW.includes('kora-dev graph recall'));
  assert.ok(!OPENCODE_GRAPH_READ_ALLOW.some((p) => /prune|ingest/.test(p)));
  assert.equal(OPENCODE_GRAPH_READ_ALLOW.length, GRAPH_READ_SUBCOMMANDS.length * 4);
});

test('anything chained, redirected or substituted does not', () => {
  for (const c of [
    'kora graph explore x; rm -rf .',
    'kora graph explore x && touch f',
    'kora graph explore x > out.txt',
    'kora graph explore $(cat secret)',
    'kora graph explore `id`',
    'kora graph explore x | sh',
    'kora ingest .',
    'echo kora graph explore x',
  ]) assert.equal(isGraphQueryCommand(c), false, c);
});
