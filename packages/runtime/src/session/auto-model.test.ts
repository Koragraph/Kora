import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPrompt, escalation, turnEffort, effortChangeCacheSafe } from './auto-model';

const LIGHT = [
  'where is the retry backoff configured?',
  'what does computeTotals do',
  'who calls parseConfig',
  'how does the session store pick a file name?',
  'explain the ledger module',
  'list the CLI commands this repo has',
  'rename fetchUser to loadUser',
  'fix the typo in the README intro',
  'bump the version to 0.2.0',
  'change the default port to 8080',
  'add a comment above the cache sweep explaining the cutoff',
  'remove the unused import in server.ts',
  'commit this with a good message',
  'write a commit message for the staged changes',
  'create a branch called fix/menu',
  'run the tests and tell me the result',
  'what changed since yesterday?',
  'summarize the diff',
  'show me the settings schema',
];
const STANDARD = [
  'implement credit notes for invoices',
  'add a new endpoint for exporting reports',
  'refactor the driver into smaller modules',
  'the totals are off by one cent somewhere in allocate, find and fix it',
  "what's wrong with the login flow? it crashes on submit",
  'why does the cache miss after a restart?',
  'tests are failing in CI, fix them',
  'write tests for the parser',
  'update all callers of fetchUser to pass the new flag',
  'rename the field across the codebase',
  'plan the migration to the new store',
  'review my branch',
  'think hard about the scheduling algorithm',
  'build me a small CLI that converts csv to json',
  'make it faster',
  'hello',
];

test('auto: light prompts go light, real work stays on the user model', () => {
  for (const t of LIGHT) assert.equal(classifyPrompt({ text: t }).tier, 'light', t);
  for (const t of STANDARD) assert.equal(classifyPrompt({ text: t }).tier, 'standard', t);
});

test('auto: pictures, long or pasted prompts, leads and empty prompts are never light', () => {
  assert.equal(classifyPrompt({ text: 'where is the header?', images: 1 }).tier, 'standard');
  assert.equal(classifyPrompt({ text: `where is this from?\n${'x\n'.repeat(20)}` }).tier, 'standard');
  assert.equal(classifyPrompt({ text: 'where does this come from?\n```\nfoo()\n```' }).tier, 'standard');
  assert.equal(classifyPrompt({ text: 'what is this\nTypeError: x is undefined\n    at foo (a.js:1:2)' }).tier, 'standard');
  assert.equal(classifyPrompt({ text: 'where is the router', orchestrator: true }).tier, 'standard');
  assert.equal(classifyPrompt({ text: '   ' }).tier, 'standard');
});

test('auto: escalation is up-only on complaints, an explicit ask, a stuck turn or real work; follow-up questions stay', () => {
  assert.ok(escalation("that's wrong, the file is in lib/"));
  assert.ok(escalation('still failing'));
  assert.ok(escalation('use sonnet for this'));
  assert.ok(escalation('now implement the export feature'));
  assert.ok(escalation('ok', { stuck: true }));
  assert.equal(escalation('thanks! and where is the logger set up?'), null);
  assert.equal(escalation('rename it to loadUser too'), null);
  assert.equal(escalation(''), null);
});

test('middle tier rules: Opus/Fable Defaults only; effort lifted to high; up-only reasons', () => {
  const { hasMidTier, midEffort, midEscalation, wantsCeiling } = require('./auto-model') as typeof import('./auto-model');
  assert.equal(hasMidTier('claude-opus-5-5'), true);
  assert.equal(hasMidTier('claude-fable-5-1'), true);
  assert.equal(hasMidTier('claude-sonnet-5-5'), false);
  assert.equal(hasMidTier('opus'), true);
  assert.equal(midEffort('medium'), 'high'); assert.equal(midEffort(null), 'high'); assert.equal(midEffort('low'), 'high');
  assert.equal(midEffort('xhigh'), 'xhigh');
  assert.equal(midEscalation('add the missing case'), null);
  assert.equal(midEscalation('now refactor the parser'), null, 'real work is what the middle tier is for');
  assert.ok(midEscalation('that is wrong'));
  assert.ok(midEscalation('use opus for this'));
  assert.ok(midEscalation('', { stuck: true }));
  assert.equal(wantsCeiling('ultrathink about the cache layer'), true);
  assert.equal(wantsCeiling('rename the cache layer'), false);
});

test('turnEffort: only a pure chore goes low (from medium), a complaint goes high only right after a low turn', () => {
  for (const t of ['commit and push', 'run the tests', 'Run the tests again please.', 'thanks! commit it', 'git status']) assert.equal(turnEffort(t, 'medium')?.effort, 'low', t);
  for (const t of ['yes', 'go ahead', 'continue', 'merge it', 'ok', 'run the tests and fix whatever fails', 'commit, then refactor the store']) assert.equal(turnEffort(t, 'medium'), null, t);
  for (const b of ['low', 'high', 'xhigh', 'max']) assert.equal(turnEffort('commit', b), null, `a ${b} pick is never lowered`);
  assert.equal(turnEffort('still fails', 'medium'), null, 'failure wording alone does not raise effort');
  assert.equal(turnEffort('still fails', 'medium', { afterLow: true })?.effort, 'high');
  assert.equal(turnEffort('that is wrong, the import is missing', 'low', { afterLow: true })?.effort, 'high');
  assert.equal(turnEffort('still fails', 'high', { afterLow: true }), null);
  assert.equal(turnEffort('yes', 'medium', { afterLow: true }), null);
});

test('escalation: a light thread stays light only on light follow-ups and bare acknowledgements', () => {
  for (const t of ['ok', 'thanks!', 'got it', 'where is the retry config?', 'what does parseArgs return?']) assert.equal(escalation(t), null, t);
  for (const t of ['yes', 'continue', 'go ahead', 'ok do the next one', 'can you also check the tests dir', 'now make the timeout configurable']) assert.equal(escalation(t), 'the thread moved on to real work', t);
});

test('effortChangeCacheSafe: the 5.5 models and Fable 5 only', () => {
  for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-opus-5-5[1m]']) assert.equal(effortChangeCacheSafe(m), true, m);
  for (const m of ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'default']) assert.equal(effortChangeCacheSafe(m), false, m);
});
