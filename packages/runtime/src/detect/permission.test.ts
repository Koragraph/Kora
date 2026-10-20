import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect, manifestFor } from './manifest';
import { adapterFor, type AutoAnswerCtx } from './agent-adapter';

// The agy edit-approval screen captured from the real run (worker parked on it, mis-read as idle).
const AGY_EDIT = [
  '● Edit(/repo/src/math.js) (ctrl+o to expand)', 'Pending edit', '────────',
  '   1    export function subtract(a, b) { return a - b; }',
  '   2 +  export function multiply(a, b) { return a * b; }',
  '  shift+tab to auto-approve file edits', 'Accept this file edit?',
  '> 1. Yes, accept this change', '  2. No, reject this change',
  '  ↑/↓ Navigate · tab Amend · f full diff', 'esc to cancel',
].join('\n');

const CLAUDE_EDIT = ['⏺ Editing src/auth.ts', 'Do you want to make this edit to auth.ts?', ' ❯ 1. Yes', '   2. Yes, allow all edits', '   3. No'].join('\n');
const CLAUDE_COMMAND = ['● Bash(rm -rf build && npm run build)', 'Do you want to proceed?', ' ❯ 1. Yes', '   2. No'].join('\n');

const ctx = (screen: string, over: Partial<AutoAnswerCtx> = {}): AutoAnswerCtx => ({
  screen, cwd: '/repo', mainRoot: '/repo', trustedRoots: ['/repo'],
  policy: { trustFolder: false, mcpFound: false, readOutsideWorktree: false }, ...over,
});

// ── detection (the alias bug: manifestFor('antigravity') was NULL → approvals never seen as blocked) ──
test("detection: 'antigravity' resolves to the agy manifest", () => {
  assert.equal(manifestFor('antigravity')?.id, 'agy');
});
test('detection: agy edit-approval reads as BLOCKED (was falling through to idle)', () => {
  const r = detect({ screen: AGY_EDIT, oscTitle: '', oscProgress: '' }, 'antigravity');
  assert.equal(r.state, 'blocked');
  assert.match(r.blocker || '', /accept this file edit/i);
});

// ── skip-permission args (workerPermission='auto') ──
test('skipPermissionArgs per agent (verified against each CLI --help)', () => {
  assert.deepEqual(adapterFor('claude').skipPermissionArgs(), ['--dangerously-skip-permissions']);
  assert.deepEqual(adapterFor('antigravity').skipPermissionArgs(), ['--dangerously-skip-permissions']);
  assert.deepEqual(adapterFor('codex').skipPermissionArgs(), ['--dangerously-bypass-approvals-and-sandbox']);
  assert.deepEqual(adapterFor('gemini').skipPermissionArgs(), ['--yolo']);
  assert.deepEqual(adapterFor('cursor').skipPermissionArgs(), []);
});

// ── antigravity is now a real adapter, not the null default ──
test("antigravity adapter exists and doesn't auto-accept without allowEdits", () => {
  assert.equal(adapterFor('antigravity').id, 'antigravity');
  assert.equal(adapterFor('antigravity').autoAnswer(ctx(AGY_EDIT)), null); // escalate: leave it for a human
});

// ── allowlist: accept in-worktree FILE EDITS, NEVER commands ──
test('allowlist: agy edit-approval is accepted when allowEdits', () => {
  const plan = adapterFor('antigravity').autoAnswer(ctx(AGY_EDIT, { allowEdits: true }));
  assert.ok(plan, 'a plan should be returned');
  assert.equal(plan!.kind, 'editApproval');
  assert.ok(plan!.keys.length >= 1);
});
test('allowlist: claude edit-approval accepted; claude COMMAND approval is NOT', () => {
  const a = adapterFor('claude');
  assert.ok(a.autoAnswer(ctx(CLAUDE_EDIT, { allowEdits: true })), 'file edit → accepted');
  assert.equal(a.autoAnswer(ctx(CLAUDE_COMMAND, { allowEdits: true })), null, 'command → never auto-accepted');
});
test('allowlist off by default: no edit is auto-accepted', () => {
  assert.equal(adapterFor('claude').autoAnswer(ctx(CLAUDE_EDIT)), null);
});

test('acceptEditsArgs / modelArgs per agent (verified against each CLI --help); unknown knobs are dropped', () => {
  assert.deepEqual(adapterFor('claude').acceptEditsArgs(), ['--permission-mode', 'acceptEdits']);
  assert.deepEqual(adapterFor('codex').acceptEditsArgs(), ['-s', 'workspace-write', '-a', 'on-request']);
  assert.deepEqual(adapterFor('antigravity').acceptEditsArgs(), ['--mode', 'accept-edits']);
  assert.deepEqual(adapterFor('gemini').acceptEditsArgs(), ['--approval-mode', 'auto_edit']);
  assert.deepEqual(adapterFor('cursor').acceptEditsArgs(), []);
  assert.deepEqual(adapterFor('claude').modelArgs('claude-sonnet-5', 'medium'), ['--model', 'claude-sonnet-5', '--effort', 'medium']);
  assert.deepEqual(adapterFor('codex').modelArgs('gpt-5.3-codex', 'high'), ['--model', 'gpt-5.3-codex', '-c', 'model_reasoning_effort="high"']);
  assert.deepEqual(adapterFor('gemini').modelArgs('gemini-2.5-pro', 'high'), ['-m', 'gemini-2.5-pro']);
  assert.deepEqual(adapterFor('antigravity').modelArgs(undefined, 'low'), ['--effort', 'low']);
  assert.deepEqual(adapterFor('cursor').modelArgs('x', 'y'), []);
});

test('codex trust dialog (v0.155 wording) under a trusted root is auto-answered with "Yes, continue"', () => {
  const screen = `> You are in /tmp/trusted/wt\n  Do you trust the contents of this directory?\n  Working with untrusted contents comes with higher risk of prompt injection.\n\n› 1. Yes, continue\n  2. No, quit\n\n  Press enter to continue\n`;
  const plan = adapterFor('codex').autoAnswer({ screen, cwd: '/tmp/trusted/wt', mainRoot: null, trustedRoots: ['/tmp/trusted'], policy: { trustFolder: true, mcpFound: true, readOutsideWorktree: true } });
  assert.ok(plan, 'expected a key plan');
  assert.equal(plan!.kind, 'trustFolder');
  assert.deepEqual(plan!.keys, ['\r']);
  assert.equal(adapterFor('codex').autoAnswer({ screen, cwd: '/tmp/elsewhere', mainRoot: null, trustedRoots: ['/tmp/trusted'], policy: { trustFolder: true, mcpFound: true, readOutsideWorktree: true } }), null);
});
