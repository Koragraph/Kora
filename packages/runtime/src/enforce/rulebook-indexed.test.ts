// The first message in a repo that has no code graph yet must not write "THIS REPOSITORY HAS A CODE GRAPH" (aud1 S3-2):
// the agent would run `kora graph …` and get nothing. Not indexed -> the "no graph yet" note; indexed -> the full rulebook.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createEnforcer } from './index';
import type { GraphService } from '../graph/index';

const fakeGraph = (indexed: boolean) => ({ status: async () => ({ indexed }), brief: async () => null }) as unknown as GraphService;
const prep = (graph: GraphService, cwd: string) => createEnforcer({ graph }).prepare({ agent: 'claude', cwd, paneId: 'chat:t', socketPath: '/tmp/none.sock', binPath: path.resolve(__dirname, '..', '..', 'bin', 'kora.js'), command: 'claude', args: [], env: { PATH: process.env.PATH || '' } });
const repo = () => {
  const r = fs.mkdtempSync(path.join(os.homedir(), 'rb-'));
  execSync('git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: r });
  return r;
};

test('unindexed repo: CLAUDE.md block and system prompt say "not indexed", never "has a code graph"', async () => {
  const r = repo();
  const plan = await prep(fakeGraph(false), r);
  const md = fs.readFileSync(path.join(r, 'CLAUDE.md'), 'utf8');
  assert.match(md, /NOT INDEXED BY THE KORA CODE GRAPH/);
  assert.doesNotMatch(md, /HAS A CODE GRAPH/);
  // the block carries the rulebook; no second copy as a system prompt (KORA_RULEBOOK_SYSPROMPT=1 restores it)
  assert.ok(!plan.args.includes('--append-system-prompt'), plan.args.join(' '));
  assert.ok(fs.existsSync(path.join(r, '.claude', 'settings.local.json')), 'hooks are still installed (they switch over once indexed)');
});

test('once the repo is indexed the next prepare swaps the note for the full rulebook', async () => {
  const r = repo();
  await prep(fakeGraph(false), r);
  const plan = await prep(fakeGraph(true), r);
  const md = fs.readFileSync(path.join(r, 'CLAUDE.md'), 'utf8');
  assert.match(md, /THIS REPOSITORY HAS A CODE GRAPH/);
  assert.doesNotMatch(md, /NOT INDEXED/);
  assert.ok(!plan.args.includes('--append-system-prompt'), 'the block alone carries the rulebook');
});
