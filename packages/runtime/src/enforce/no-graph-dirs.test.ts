// The rulebook says "THIS REPOSITORY HAS A CODE GRAPH" and the hooks redirect greps to it: neither may be written where no
// graph can exist. Measured 2026-10-02: a chat opened in ~ wrote ~/CLAUDE.md (loaded by every Claude Code session under
// the home dir, in Kora or not) and ~/.claude/settings.local.json; a chat in a plain folder got both files too.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createEnforcer } from './index';

const prep = (cwd: string) => createEnforcer().prepare({ agent: 'claude', cwd, paneId: 'chat:t', socketPath: '/tmp/none.sock', binPath: path.resolve(__dirname, '..', '..', 'bin', 'kora.js'), command: 'claude', args: [], env: { PATH: process.env.PATH || '' } });
const wrote = (dir: string) => ['CLAUDE.md', 'AGENTS.md', path.join('.claude', 'settings.local.json')].filter((f) => fs.existsSync(path.join(dir, f)));

test('no rulebook or hooks in the home dir or a plain (non-git) folder; a git project still gets both', async () => {
  const home = os.homedir(); // the isolated test home (scripts/test-isolate.cjs)
  assert.notEqual(home, process.env.KORA_TEST_REAL_HOME, 'never run this against the real home');
  const plan = await prep(home);
  assert.deepEqual(wrote(home), [], `nothing written into ${home}`);
  assert.ok(!(plan.args || []).includes('--append-system-prompt'), 'no "this repo has a graph" system prompt either');
  assert.ok(plan.notes.some((n) => /no rulebook\/hooks/.test(n)), plan.notes.join(' | '));

  const plain = fs.mkdtempSync(path.join(home, 'notes-'));
  await prep(plain);
  assert.deepEqual(wrote(plain), [], 'plain folder untouched');
  const inst = await createEnforcer().install({ agent: 'all', cwd: plain });
  assert.ok(inst.results.some((r) => r.action === 'skipped' && /not a git checkout/.test(r.detail || '')));
  assert.deepEqual(wrote(plain), [], 'install skips it too');

  const repo = fs.mkdtempSync(path.join(home, 'proj-'));
  execSync('git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: repo });
  const ok = await prep(repo);
  assert.ok(wrote(repo).includes('CLAUDE.md') && wrote(repo).includes(path.join('.claude', 'settings.local.json')), 'a real project is enforced');
  assert.ok(!(ok.args || []).includes('--append-system-prompt'), 'the CLAUDE.md block carries the rulebook: no second copy');
});
