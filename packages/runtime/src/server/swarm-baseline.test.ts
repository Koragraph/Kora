import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { failureIds, judge, checkCommand, ensureBaseline, wrapCheck } from './swarm-baseline';
import { runCheck } from './swarm-foreman';

const VITEST = ` ✓ test/unit/a.test.js (3 tests) 12ms
 FAIL  test/unit/db.test.js > store > writes a row
 FAIL  test/unit/net.test.js [ test/unit/net.test.js ]
 FAIL  test/unit/db.test.js > store > writes a row
 Test Files  2 failed | 1 passed (3)`;

test('failureIds: vitest, pytest, node --test, go, cargo', () => {
  assert.deepEqual(failureIds(VITEST), ['test/unit/db.test.js > store > writes a row', 'test/unit/net.test.js']);
  assert.deepEqual(failureIds('FAILED tests/test_x.py::test_y - AssertionError\nnot ok 3 - adds two\n--- FAIL: TestSum (0.00s)\ntest mod::t ... FAILED'),
    ['TestSum', 'adds two', 'mod::t', 'tests/test_x.py::test_y - AssertionError']);
  assert.deepEqual(failureIds('\u001b[31m FAIL \u001b[39m x.test.ts > y'), ['x.test.ts > y']);
  // vitest full output: the per-test × tree is ignored when canonical FAIL lines exist; retry/timing suffixes dropped
  assert.deepEqual(failureIds(' ❯ test/unit/o.test.js (3 tests | 1 failed)\n   × stops at gate 25ms (retry x2)\n FAIL  test/unit/o.test.js > suite > stops at gate'), ['test/unit/o.test.js > suite > stops at gate']);
  assert.deepEqual(failureIds('   × only tree line 12ms'), ['only tree line']);
});

test('judge: pass, pre-existing only, new failures, no baseline', () => {
  const base = { state: 'failed' as const, exitCode: 1, failures: failureIds(VITEST), at: 0 };
  assert.equal(judge({ exitCode: 0, output: '' }, base).pass, true);
  const same = judge({ exitCode: 1, output: VITEST }, base);
  assert.equal(same.pass, true); assert.match(same.summary, /none new/);
  const worse = judge({ exitCode: 1, output: `${VITEST}\n FAIL  test/unit/new.test.js > broke` }, base);
  assert.equal(worse.pass, false); assert.match(worse.summary, /1 NEW failing test.*\n  test\/unit\/new\.test\.js > broke/s);
  assert.equal(judge({ exitCode: 1, output: VITEST }, null).pass, false);
  assert.equal(judge({ exitCode: 1, output: VITEST }, { ...base, state: 'passed', failures: [] }).pass, false);
});

test('ensureBaseline + kora swarm check: pre-existing failures pass, a new one fails', async () => {
  process.env.KORA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-repo-'));
  const git = (...a: string[]) => assert.equal(spawnSync('git', a, { cwd: repo }).status, 0);
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'fails.txt'), ' FAIL  old.test.js > pre-existing\n');
  git('add', '.'); git('commit', '-q', '-m', 'init');
  const cmd = 'cat fails.txt; exit 1';
  const file = await ensureBaseline(repo, cmd, (c, d, ms) => runCheck(c, d, ms, { keepOutput: true }));
  for (let i = 0; i < 100 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 100));
  const base = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(base.failures, ['old.test.js > pre-existing']);
  let out = '';
  const io = { out: (s: string) => { out += s; }, waitMs: 5000 };
  const cwd = process.cwd();
  process.chdir(repo);
  try {
    assert.equal(await checkCommand(file, cmd, io), 0);
    assert.match(out, /none new/);
    fs.appendFileSync(path.join(repo, 'fails.txt'), ' FAIL  new.test.js > regression\n');
    assert.equal(await checkCommand(file, cmd, io), 1);
    assert.match(out, /new\.test\.js > regression/);
    // flaky: a failure present in only one of the two runs does not count
    fs.writeFileSync(path.join(repo, 'flaky.sh'), 'if [ -f seen ]; then printf " FAIL  old.test.js > pre-existing\\n"; else touch seen; printf " FAIL  old.test.js > pre-existing\\n FAIL  t.test.js > timed out\\n"; fi; exit 1\n');
    out = '';
    assert.equal(await checkCommand(file, 'sh flaky.sh', io), 0);
    assert.match(out, /re-running the check once/);
  } finally { process.chdir(cwd); }
  assert.match(wrapCheck("npm test -- 'x'", file), /swarm check --baseline '.+' -- 'npm test -- '\\''x'\\'''$/);
});
