import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { adapterFor } from './agent-adapter';
import { planAutoAnswer, KEY_ENTER } from '../server/autoanswer';

const policy = { trustFolder: true, mcpFound: true, readOutsideWorktree: true };

// A real Claude trust-folder screen, copied from src/server/autoanswer.test.ts.
const TRUST = `╭──────────────────────────────────────────────╮
│ Do you trust the files in this folder?       │
│                                              │
│ /Users/me/Projects/app                       │
│                                              │
│ Is this a project you created or one you trust? │
│                                              │
│ ❯ 1. Yes, I trust this folder                │
│   2. No, exit                                │
╰──────────────────────────────────────────────╯
 Enter to confirm · Esc to cancel`;

// Codex command approval (from src/detect/detect.test.ts) — the world-changing kind, never auto-answered.
const CODEX_CMD = `• Ran ls -la

› run the tests
  Allow command?
  npm test
  Press enter to confirm or esc to cancel
`;

// Codex first-run trust-folder prompt (version-controlled dir).
const CODEX_TRUST = ` You are running Codex in /Users/me/Projects/app
 Since this folder is version controlled, you may wish to allow Codex to work
 in this folder without asking for approval.
 ❯ 1. Yes, allow Codex to work in this folder without asking for approval
   2. No, ask me to approve edits and commands
 Press enter to confirm or esc to cancel`;

test('canCompact is claude-only', () => {
  assert.equal(adapterFor('claude').canCompact, true);
  assert.equal(adapterFor('codex').canCompact, false);
  assert.equal(adapterFor('gemini').canCompact, false);
});

test('claude.autoAnswer delegates to planAutoAnswer (same plan)', () => {
  const ctx = { screen: TRUST, cwd: '/Users/me/Projects/app', mainRoot: null, trustedRoots: ['/Users/me/Projects'], policy };
  const viaAdapter = adapterFor('claude').autoAnswer(ctx);
  const direct = planAutoAnswer(ctx);
  assert.deepEqual(viaAdapter, direct);
  assert.equal(viaAdapter?.kind, 'trustFolder');
  assert.deepEqual(viaAdapter?.keys, [KEY_ENTER]);
  // and it honors the same gate: outside a trusted root → null
  assert.equal(adapterFor('claude').autoAnswer({ ...ctx, cwd: '/tmp/elsewhere' }), null);
});

test('spawnEnv isolates per account, {} when none', () => {
  const codex = adapterFor('codex').spawnEnv('p1', 'work2');
  assert.ok(codex.CODEX_HOME);
  assert.ok(codex.CODEX_HOME.endsWith(path.join('accounts', 'codex', 'work2')), codex.CODEX_HOME);
  assert.deepEqual(adapterFor('codex').spawnEnv('p1', null), {});

  const claude = adapterFor('claude').spawnEnv('p1', 'main');
  assert.ok(claude.CLAUDE_CONFIG_DIR);
  assert.ok(claude.CLAUDE_CONFIG_DIR.endsWith(path.join('accounts', 'claude', 'main')), claude.CLAUDE_CONFIG_DIR);
  assert.deepEqual(adapterFor('claude').spawnEnv('p1', null), {});

  assert.deepEqual(adapterFor('gemini').spawnEnv('p1', 'x'), {});
});

test('codex.autoAnswer: conservative', () => {
  const base = { cwd: '/Users/me/Projects/app', mainRoot: null, trustedRoots: ['/Users/me/Projects'], policy };
  // command approval is the agent asking to act — left to a human
  assert.equal(adapterFor('codex').autoAnswer({ ...base, screen: CODEX_CMD }), null);
  // an ambiguous / unknown screen → null
  assert.equal(adapterFor('codex').autoAnswer({ ...base, screen: '› \n  something happened\n' }), null);
  // trust-folder answered only under a trusted root and with the policy flag
  const ok = adapterFor('codex').autoAnswer({ ...base, screen: CODEX_TRUST });
  assert.equal(ok?.kind, 'trustFolder');
  assert.deepEqual(ok?.keys, [KEY_ENTER]);
  assert.equal(adapterFor('codex').autoAnswer({ ...base, screen: CODEX_TRUST, cwd: '/tmp/elsewhere' }), null);
  assert.equal(adapterFor('codex').autoAnswer({ ...base, screen: CODEX_TRUST, policy: { ...policy, trustFolder: false } }), null);
});
