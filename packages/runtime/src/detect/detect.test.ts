import test from 'node:test';
import assert from 'node:assert/strict';
import { detect, loadManifests, convertRegex, regionText, StateTracker, IDLE_CONFIRM_MS, agentFromArgv, agentFromPsArgs } from './index';

const snap = (screen: string, oscTitle = '', oscProgress = '') => ({ screen, oscTitle, oscProgress });

const CLAUDE_IDLE = `✻ Welcome to Claude Code!

> hello
● Hi! How can I help you today?

──────────────────────────────────────────────
❯
──────────────────────────────────────────────
  ? for shortcuts
`;
const CLAUDE_WORKING = `> refactor the parser
● I'll start by reading the file.

✻ Cogitating… (3s · esc to interrupt)
──────────────────────────────────────────────
❯
──────────────────────────────────────────────
`;
const CLAUDE_BLOCKED = `● I'll list the directory first.

 Bash command

   ls -la
   List files in the current directory

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for: ls
   3. No, and tell Claude what to do differently (esc)

 Esc to cancel
`;
const CODEX_BLOCKED = `• Ran ls -la

› run the tests
  Allow command?
  npm test
  Press enter to confirm or esc to cancel
`;

test('manifests load and every regex compiles', () => {
  const ms = loadManifests();
  assert.ok(ms.get('claude') && ms.get('codex') && ms.get('gemini'));
  assert.ok(ms.get('claude')!.rules.length > 5);
});

test('rust regex conversion', () => {
  assert.ok(convertRegex('^[\\x{2800}-\\x{28FF}] ').test('⠋ Claude'));
  assert.ok(convertRegex('(?i)esc to close\\s*$').test('  ESC TO CLOSE'));
  assert.ok(convertRegex('\\A> You are in [^\\r\\n]+(?:\\r?\\n|$)').test('> You are in /tmp\nmore'));
  assert.ok(convertRegex('(?m)^\\s*❯\\s*$').test('foo\n ❯ \nbar'));
  assert.ok(convertRegex('^\\s*[\\u2800-\\u28FF]+\\s+\\p{Alphabetic}+\\w*ing\\b').test('⠋ Thinking'));
});

test('regions', () => {
  const s = snap('a\n\nb\n───\nbody ❯\n───\nfooter');
  assert.equal(regionText(s, 'prompt_box_body'), 'body ❯');
  assert.equal(regionText(s, 'after_last_horizontal_rule'), 'footer');
  assert.equal(regionText(s, 'bottom_non_empty_lines(2)'), '───\nfooter');
  assert.equal(regionText(s, 'top_non_empty_lines(2)'), 'a\n\nb');
  assert.equal(regionText(s, 'last_non_empty_above_prompt_box'), 'b');
  assert.equal(regionText(snap('x\n› hi\ny'), 'after_last_prompt_marker'), 'y');
  assert.equal(regionText(snap('x\n› hi\ny'), 'whole_recent_without_current_prompt_marker'), '');
  assert.equal(regionText(snap('x\n› hi\n• done'), 'whole_recent_without_current_prompt_marker'), 'x\n› hi\n• done');
});

test('claude: idle prompt box', () => {
  const d = detect(snap(CLAUDE_IDLE), 'claude');
  assert.equal(d.state, 'idle'); assert.equal(d.ruleId, 'live_prompt_box');
});
test('claude: working with esc to interrupt', () => {
  const d = detect(snap(CLAUDE_WORKING), 'claude');
  assert.equal(d.state, 'working'); assert.equal(d.ruleId, 'live_turn_working');
});
test('claude: working from osc title spinner', () => {
  const d = detect(snap(CLAUDE_IDLE, '⠋ Claude Code'), 'claude');
  assert.equal(d.state, 'working'); assert.equal(d.ruleId, 'osc_title_working');
});
test('claude: blocked on permission prompt with blocker text', () => {
  const d = detect(snap(CLAUDE_BLOCKED), 'claude');
  assert.equal(d.state, 'blocked'); assert.equal(d.ruleId, 'bash_permission_prompt');
  assert.equal(d.blocker, 'Do you want to proceed?');
});
test('claude: a numbered list in the agent\'s own output above the idle prompt box is NOT a dialog', () => {
  const screen = `● Done. Summary:\n\n  1. app/greeting.py with greet()\n  2. test_greeting.py (at repo root) with plain asserts\n\n╭──────╮\n│ >    │\n╰──────╯\n  ? for shortcuts\n`;
  const d = detect(snap(screen), 'claude');
  assert.equal(d.state, 'idle');
  const dialog = `● Question\n\n Which option?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel\n`;
  assert.equal(detect(snap(dialog), 'claude').state, 'blocked');
});

test('claude: trust dialog is blocked and the blocker is the question, not the key hint', () => {
  const screen = ` Quick safety check: Is this a project you created or one you trust? (Like your own code)\n\n Claude Code'll be able to read, edit, and execute files here.\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel\n`;
  const d = detect(snap(screen), 'claude');
  assert.equal(d.state, 'blocked'); assert.equal(d.ruleId, 'live_blocked_form');
  assert.ok(d.blocker!.startsWith('Quick safety check'), d.blocker!);
  assert.ok(d.blocker!.length <= 80);
});
test('codex: title spinner working, plain title idle, allow command blocked', () => {
  assert.equal(detect(snap('› ', '⠋ Codex'), 'codex').state, 'working');
  assert.equal(detect(snap('› ', 'Codex'), 'codex').state, 'idle');
  const d = detect(snap(CODEX_BLOCKED, 'Codex'), 'codex');
  assert.equal(d.state, 'blocked'); assert.equal(d.ruleId, 'live_strong_blocker');
  assert.equal(detect(snap('› ', 'Action Required: Codex'), 'codex').state, 'blocked');
});
test('codex: the per-directory trust dialog is blocked (not idle)', () => {
  const screen = `╭──────────────────────────────╮\n│ >_ OpenAI Codex (v0.155.1)   │\n╰──────────────────────────────╯\n\n> You are in /Users/me/.kora/worktrees/r4/codex-plucky-fox\n  Do you trust the contents of this directory?\n  Working with untrusted contents comes with higher risk of prompt injection.\n\n› 1. Yes, continue\n  2. No, quit\n\n  Press enter to continue\n`;
  const d = detect(snap(screen), 'codex');
  assert.equal(d.state, 'blocked');
});

test('no manifest → unknown', () => {
  assert.equal(detect(snap(CLAUDE_IDLE), 'shell').matched, false);
});

test('tracker: working→idle needs quiet period; unknown does not overwrite known', () => {
  const t = new StateTracker();
  let now = 100_000;
  let r = t.update(snap(CLAUDE_WORKING), 'claude', now, now); assert.equal(r.state, 'working'); assert.equal(r.changed, true);
  now += 100; r = t.update(snap(CLAUDE_IDLE), 'claude', now, now - 50); assert.equal(r.state, 'working'); assert.equal(r.changed, false); assert.ok(r.recheckInMs! > 0);
  now += IDLE_CONFIRM_MS + 100; r = t.update(snap(CLAUDE_IDLE), 'claude', now, now - IDLE_CONFIRM_MS - 100); assert.equal(r.state, 'idle'); assert.equal(r.changed, true);
  // an unrecognised screen with no recent output → idle (the known-agent fallback)
  now += 5000; r = t.update(snap('garbage'), 'claude', now, now - 5000); assert.equal(r.state, 'idle'); assert.equal(r.changed, false);
  // a shell (no manifest): working while output flows, idle when quiet
  const sh = new StateTracker();
  assert.equal(sh.update(snap('$ make'), 'shell', now, now).state, 'working');
  assert.equal(sh.update(snap('$ make'), 'shell', now + 3000, now).state, 'idle');
  // unrecognised screen with fresh output → working
  now += 10; r = t.update(snap('garbage'), 'claude', now, now); assert.equal(r.state, 'working');
  // blocked — needs a second look BLOCKED_CONFIRM_MS later (a one-frame dialog never surfaces)
  now += 10; r = t.update(snap(CLAUDE_BLOCKED), 'claude', now, now); assert.equal(r.state, 'working'); assert.equal(r.changed, false);
  now += 500; r = t.update(snap(CLAUDE_BLOCKED), 'claude', now, now); assert.equal(r.state, 'blocked'); assert.equal(r.blocker, 'Do you want to proceed?');
});

test('agent identity from argv and ps', () => {
  assert.equal(agentFromArgv('/bin/zsh', ['-l']), 'shell');
  assert.equal(agentFromArgv('claude', ['--resume', 'x']), 'claude');
  assert.equal(agentFromArgv('/Users/x/.local/bin/codex', []), 'codex');
  assert.equal(agentFromArgv('node', ['/usr/lib/node_modules/@google/gemini-cli/dist/index.js']), 'gemini');
  assert.equal(agentFromArgv('bash', ['-lc', 'claude --continue']), 'claude');
  assert.equal(agentFromArgv('cursor-agent', []), 'cursor');
  assert.equal(agentFromArgv('vim', []), 'unknown');
  assert.equal(agentFromPsArgs('node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js'), 'claude');
  assert.equal(agentFromPsArgs('/bin/zsh -il'), null);
});

test('tracker: a hook "working" hint outranks a scraped idle; "idle" releases it; exit outranks all', () => {
  const t = new StateTracker();
  let now = 500_000;
  let r = t.update(snap(CLAUDE_WORKING), 'claude', now, now); assert.equal(r.state, 'working');
  // mid-turn redraw shows the idle prompt box for a moment — the agent said it is working
  t.hint('working', now);
  now += 2000; r = t.update(snap(CLAUDE_IDLE), 'claude', now, now - 1900); assert.equal(r.state, 'working');
  now += 2000; r = t.update(snap(CLAUDE_IDLE), 'claude', now, now - 1900); assert.equal(r.state, 'working');
  // Stop hook: the same screen now reads idle
  t.hint('idle', now);
  now += 1000; r = t.update(snap(CLAUDE_IDLE), 'claude', now, now - 2900); assert.equal(r.state, 'idle');
  // a permission dialog still wins over a stale "working" hint (only the screen can see it)
  t.hint('working', now);
  now += 100; t.update(snap(CLAUDE_BLOCKED), 'claude', now, now); // first look arms the debounce
  now += 500; r = t.update(snap(CLAUDE_BLOCKED), 'claude', now, now); assert.equal(r.state, 'blocked'); assert.equal(r.blocker, 'Do you want to proceed?');
  r = t.update(snap(CLAUDE_BLOCKED), 'claude', now, now, true); assert.equal(r.state, 'blocked'); // exit keeps the last state
});

test('tracker: a LOST Stop hook cannot hold a quiet idle screen "working" past the quiet override', () => {
  const { HINT_QUIET_OVERRIDE_MS } = require('./tracker');
  const t = new StateTracker();
  let now = 900_000;
  let r = t.update(snap(CLAUDE_WORKING), 'claude', now, now); assert.equal(r.state, 'working');
  t.hint('working', now); // …and the agent's Stop never arrives
  // idle prompt on screen, output stopped 5 s ago: still held (a redraw between tool calls looks like this)
  now += 5000; r = t.update(snap(CLAUDE_IDLE), 'claude', now, now - 5000); assert.equal(r.state, 'working');
  // the same idle screen, silent for longer than the override window: the hint is dropped, the screen wins
  now += HINT_QUIET_OVERRIDE_MS; r = t.update(snap(CLAUDE_IDLE), 'claude', now, now - HINT_QUIET_OVERRIDE_MS - 5000); assert.equal(r.state, 'idle');
  assert.equal(t.hinted, null);
});

test('tracker: blocked needs a second look — a one-frame dialog never surfaces', () => {
  const t = new StateTracker();
  let now = 700_000;
  let r = t.update(snap(CLAUDE_WORKING), 'claude', now, now); assert.equal(r.state, 'working');
  now += 300; r = t.update(snap(CLAUDE_BLOCKED), 'claude', now, now); assert.equal(r.state, 'working'); assert.equal(r.changed, false); assert.ok(r.recheckInMs! > 0);
  now += 100; r = t.update(snap(CLAUDE_WORKING), 'claude', now, now); assert.equal(r.state, 'working'); // gone again: nothing raised
  now += 300; t.update(snap(CLAUDE_BLOCKED), 'claude', now, now);
  now += 450; r = t.update(snap(CLAUDE_BLOCKED), 'claude', now, now); assert.equal(r.state, 'blocked'); assert.equal(r.changed, true);
});

test('tracker: a scraped idle while output is still flowing is working (codex keeps its input line up mid-turn)', () => {
  const t = new StateTracker();
  let now = 900_000;
  const CODEX_RUNNING = `• Ran pytest -q\n  └ 1 passed\n\n› \n  gpt-5.6 medium · ~/repo\n`;
  let r = t.update(snap(CODEX_RUNNING), 'codex', now, now - 200); assert.equal(r.state, 'working', 'output 200ms ago → busy');
  now += 3000; r = t.update(snap(CODEX_RUNNING), 'codex', now, now - 3200); assert.equal(r.state, 'idle', 'quiet for 3s → idle');
  now += 10; r = t.update(snap(CODEX_RUNNING), 'codex', now, now - 100); assert.equal(r.state, 'working', 'from idle too: fresh output → busy');
  const CODEX_TURN = `• Ran pytest -q\n\n  Working (12s • esc to interrupt)\n\n› \n`;
  now += 10; r = t.update(snap(CODEX_TURN), 'codex', now, now - 5000); assert.equal(r.state, 'working', 'the status line says so even when quiet');
});

test('tracker: a blinking title prefix does not count as a new blocker', () => {
  const t = new StateTracker();
  let now = 1_100_000;
  const a = snap('› ', '[ . ] Action Required | run tests');
  const b = snap('› ', '[ ! ] Action Required | run tests');
  t.update(a, 'codex', now, now - 5000); now += 500;
  let r = t.update(a, 'codex', now, now - 5500); assert.equal(r.state, 'blocked'); assert.equal(r.blocker, 'Action Required | run tests');
  now += 1000; r = t.update(b, 'codex', now, now - 6500); assert.equal(r.changed, false, 'same prompt, different frame');
});
