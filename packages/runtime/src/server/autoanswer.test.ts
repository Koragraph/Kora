import test from 'node:test';
import assert from 'node:assert/strict';
import { planAutoAnswer, parseOptions, selectOption, KEY_DOWN, KEY_UP, KEY_ENTER } from './autoanswer';

const policy = { trustFolder: true, mcpFound: true, readOutsideWorktree: true };
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
const MCP = ` New MCP server found in this project: koragraph
 MCP servers may execute code or access system resources.
 ❯ 1. Use this MCP server
   2. Use this and all future MCP servers in this project
   3. Continue without using this MCP server
 Enter to confirm · Esc to cancel`;
const MCP_DEFAULT_LAST = ` New MCP server found in this project: koragraph
   1. Use this MCP server
   2. Use this and all future MCP servers in this project
 ❯ 3. Continue without using this MCP server
 Enter to confirm · Esc to cancel`;
const READ = ` Read outside of working directory
 Read(/Users/me/Projects/app/src/x.ts)
 Do you want to proceed?
 ❯ 1. Yes, keep allowing
   2. Yes
   3. No
 Esc to cancel`;
const BASH = ` Bash command
   rm -rf build
 Do you want to proceed?
 ❯ 1. Yes
   2. No
 Esc to cancel`;

test('parseOptions/selectOption: counts moves from the ❯ line', () => {
  const o = parseOptions(MCP_DEFAULT_LAST);
  assert.equal(o.length, 3); assert.equal(o[2].selected, true);
  assert.deepEqual(selectOption(o, /^use this mcp server/i)!.keys, [KEY_UP, KEY_UP, KEY_ENTER]);
  assert.deepEqual(selectOption(parseOptions(TRUST), /^yes/i)!.keys, [KEY_ENTER]);
  const noMarker = parseOptions('  1. A\n  2. B'); assert.deepEqual(selectOption(noMarker, /^B/)!.keys, [KEY_DOWN, KEY_ENTER]);
});
test('trust dialog: answered only under a trusted root', () => {
  const ok = planAutoAnswer({ screen: TRUST, cwd: '/Users/me/Projects/app', mainRoot: null, trustedRoots: ['/Users/me/Projects'], policy });
  assert.equal(ok?.kind, 'trustFolder'); assert.deepEqual(ok?.keys, [KEY_ENTER]);
  assert.equal(planAutoAnswer({ screen: TRUST, cwd: '/tmp/elsewhere', mainRoot: null, trustedRoots: ['/Users/me/Projects'], policy }), null);
  assert.equal(planAutoAnswer({ screen: TRUST, cwd: '/Users/me/Projects/app', mainRoot: null, trustedRoots: ['/Users/me/Projects'], policy: { ...policy, trustFolder: false } }), null);
  assert.equal(planAutoAnswer({ screen: TRUST, cwd: '/Users/me/Projectsx/app', mainRoot: null, trustedRoots: ['/Users/me/Projects'], policy }), null, 'prefix must be a path boundary');
});
test('mcp found: selects "Use this MCP server" from wherever the cursor is', () => {
  assert.equal(planAutoAnswer({ screen: MCP, cwd: '/x', mainRoot: null, trustedRoots: [], policy }), null, 'an untrusted cwd never auto-accepts an MCP server');
  assert.deepEqual(planAutoAnswer({ screen: MCP, cwd: '/x/app', mainRoot: null, trustedRoots: ['/x'], policy })?.keys, [KEY_ENTER]);
  const p = planAutoAnswer({ screen: MCP_DEFAULT_LAST, cwd: '/x', mainRoot: null, trustedRoots: ['/x'], policy });
  assert.deepEqual(p?.keys, [KEY_UP, KEY_UP, KEY_ENTER]); assert.match(p!.detail, /koragraph/);
});
test('read outside: only when the path is inside mainRoot or a trusted root', () => {
  const p = planAutoAnswer({ screen: READ, cwd: '/Users/me/.kora/worktrees/app/claude-x', mainRoot: '/Users/me/Projects/app', trustedRoots: [], policy });
  assert.equal(p?.kind, 'readOutsideWorktree'); assert.deepEqual(p?.keys, [KEY_ENTER]);
  assert.equal(planAutoAnswer({ screen: READ, cwd: '/w', mainRoot: '/other', trustedRoots: ['/nope'], policy }), null);
});
test('never answers Bash or edit permission prompts', () => {
  assert.equal(planAutoAnswer({ screen: BASH, cwd: '/Users/me/Projects/app', mainRoot: null, trustedRoots: ['/Users/me/Projects'], policy }), null);
  assert.equal(planAutoAnswer({ screen: TRUST + '\n Bash(rm -rf /)', cwd: '/Users/me/Projects/app', mainRoot: null, trustedRoots: ['/Users/me/Projects'], policy }), null);
});
