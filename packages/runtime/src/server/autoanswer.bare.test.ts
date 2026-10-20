import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOptions, planAutoAnswer, KEY_DOWN, KEY_ENTER } from './autoanswer';

// The real Claude Code 2.1.266 trust dialog: bare ❯-marked options (NOT numbered), default on the SAFE option.
const TRUST = [
  '────────────────────────────────────────',
  ' Accessing workspace:',
  ' /trusted/root/testrepo',
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
  " project, or work from your team). If not, take a moment to review what's in this folder first.",
  " Claude Code'll be able to read, edit, and execute files here.",
  '',
  ' Security guide',
  '',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  '',
  ' Enter to confirm · Esc to cancel',
  '',
].join('\n');

test('parseOptions: bare arrow dialog is parsed in order with the ❯ line selected', () => {
  const opts = parseOptions(TRUST);
  assert.deepEqual(opts.map((o) => o.text), ['No, exit', 'Yes, I trust this folder']);
  assert.equal(opts[0].selected, true);
  assert.equal(opts[1].selected, false);
});

test('planAutoAnswer: trust dialog moves DOWN to Yes then Enter (never blind-Enters onto No/exit)', () => {
  const plan = planAutoAnswer({
    screen: TRUST, cwd: '/trusted/root/testrepo', mainRoot: null,
    trustedRoots: ['/trusted/root'], policy: { trustFolder: true, mcpFound: true, readOutsideWorktree: true },
  });
  assert.ok(plan, 'expected a plan');
  assert.equal(plan!.kind, 'trustFolder');
  assert.deepEqual(plan!.keys, ['\x1b[B', '\r']); // DOWN then ENTER
});

test('planAutoAnswer: still refuses trust when cwd is outside every trusted root', () => {
  const plan = planAutoAnswer({
    screen: TRUST, cwd: '/somewhere/else/testrepo', mainRoot: null,
    trustedRoots: ['/trusted/root'], policy: { trustFolder: true, mcpFound: true, readOutsideWorktree: true },
  });
  assert.equal(plan, null);
});

test('planAutoAnswer: a Bash permission prompt is never auto-answered, bare-marker or not', () => {
  const bash = [' Bash command', ' rm -rf build/', '', ' ❯ No', '   Yes', '', ' Enter to confirm'].join('\n');
  const plan = planAutoAnswer({
    screen: bash, cwd: '/trusted/root/testrepo', mainRoot: null,
    trustedRoots: ['/trusted/root'], policy: { trustFolder: true, mcpFound: true, readOutsideWorktree: true },
  });
  assert.equal(plan, null);
});

test('auto-answer: a NARROW pane wraps the trust dialog — phrase still matches, wrapped option lines merge', () => {
  // exactly what a 22-column pane showed (measured): the question and the Yes option both wrapped
  const screen = [
    ' Do you trust the', ' files in this', ' folder?', '', ' Is this a project', ' you created or one', ' you trust? (Like',
    ' your own code…', '', ' Security guide', '', ' ❯ No, exit', '   Yes, I trust this', '   folder', '', ' Enter to confirm ·', ' Esc to cancel',
  ].join('\n');
  const plan = planAutoAnswer({ screen, cwd: '/p/repo', mainRoot: null, trustedRoots: ['/p'], policy: { trustFolder: true, mcpFound: true, readOutsideWorktree: true } });
  assert.ok(plan, 'dialog recognised despite wrapping');
  assert.equal(plan!.kind, 'trustFolder');
  assert.deepEqual(plan!.keys, [KEY_DOWN, KEY_ENTER], 'one move from "No, exit" to the merged "Yes, I trust this folder"');
  assert.equal(parseOptions(screen).length, 2);
});
