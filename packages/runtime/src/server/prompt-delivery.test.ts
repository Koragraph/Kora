// Start-up prompt delivery (prompt-delivery.ts) on a fake pane and a virtual clock, with OpenCode screens from the
// manifest fixtures (captured live / synthesized from the v1.18.32 TUI source), so the real detection rules decide.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { manifestsDir } from '../detect/manifest';
import { confirmInputEmptied, confirmStartupDelivery, promptNotTakenConfirmed, promptTakenEvidence, textStillInInput } from './prompt-delivery';

const fixture = (name: string) => fs.readFileSync(path.join(manifestsDir(), 'fixtures', 'opencode', name), 'utf8').split('---8<---\n')[1];
const HOME = fixture('home-idle.txt');             // home route: logo + idle footer (prompt not submitted)
const WORKING = fixture('live-working-esc_interrupt.txt'); // session, esc-interrupt footer
const SESSION_IDLE = fixture('live-idle-miss.txt'); // session view, idle footer (matches idle_prompt)
const SESSION_DRAWING = '  ┃  add a hello.txt with PONG\n  ┃\n\n     Thinking…\n'; // session, no footer rule yet (no-rule)

type Event = { at: number; state?: string; screen?: string; hinted?: 'working' | 'idle' };

/** A fake pane whose state/screen follow a timeline (absolute virtual seconds), and a clock that drives it. */
function harness(opts: { agent: string; role?: string | null; start: { state: string; screen: string }; typedAt: number; timeline: Event[] }) {
  let now = opts.typedAt * 1000;
  const events = opts.timeline.map((e) => ({ ...e, at: e.at * 1000 })).sort((a, b) => a.at - b.at);
  const writes: string[] = []; const logs: string[] = [];
  const pane = {
    id: 'p1', agent: opts.agent, role: opts.role === undefined ? 'worker' : opts.role,
    state: opts.start.state, exited: false, hinted: null as 'working' | 'idle' | null, hintedAt: 0, lastOutputAt: now - 800,
    screen: opts.start.screen,
    write(d: string) { writes.push(d); },
    detectionSnapshot() { return { screen: this.screen, oscTitle: '', oscProgress: '' }; },
  };
  const apply = () => {
    while (events.length && events[0]!.at <= now) {
      const e = events.shift()!;
      if (e.state) pane.state = e.state;
      if (e.screen !== undefined) { pane.screen = e.screen; pane.lastOutputAt = e.at; }
      if (e.hinted) { pane.hinted = e.hinted; pane.hintedAt = e.at; }
    }
  };
  const env = {
    now: () => now,
    sleep: async (ms: number) => { now += ms; apply(); },
    log: (m: string) => { logs.push(m); },
  };
  const retypes = (text: string) => writes.filter((w) => w === text).length;
  return { pane, env, writes, logs, retypes, run: (text: string) => confirmStartupDelivery(pane, text, now, env), at: () => now / 1000 };
}

// The live log (plain agent:"opencode" worker, QA 2026-09-25), seconds after 09:40:
//   spawned 41.0 · unknown→working 43.6 · working→idle 44.99 · [prompt typed ~45.8] · idle→working 46.17 ·
//   working→idle 46.76 · "prompt not taken at start-up (round 2); typing it again" 53.2  ← the defect
const TASK = 'add a hello.txt with PONG and commit it';

test('QA log replay: OpenCode took the prompt, its session idle footer does not trigger a second copy', async () => {
  const h = harness({
    agent: 'opencode', start: { state: 'idle', screen: HOME }, typedAt: 45.8,
    timeline: [
      { at: 46.17, state: 'working', screen: SESSION_DRAWING }, // session opened: prompt accepted (no footer rule yet)
      { at: 46.76, state: 'idle', screen: SESSION_IDLE },       // the idle footer reads as a confirmed idle
    ],
  });
  await h.run(TASK);
  assert.equal(h.retypes(TASK), 0, `the prompt was typed again: ${JSON.stringify(h.writes)}`);
  assert.deepEqual(h.writes, [], 'not even a bare Enter at a session that already took the prompt');
  assert.deepEqual(h.logs, []);
});

test('OpenCode: a brief esc-interrupt footer after the send is a confirmed accept, even if it reads idle afterwards', async () => {
  const h = harness({
    agent: 'opencode', start: { state: 'idle', screen: HOME }, typedAt: 45.8,
    timeline: [
      { at: 46.17, state: 'working', screen: WORKING },
      { at: 46.76, state: 'idle', screen: HOME }, // even a (bogus) home screen later cannot undo a confirmed accept
    ],
  });
  await h.run(TASK);
  assert.equal(h.retypes(TASK), 0);
  assert.deepEqual(h.writes, []);
});

test('OpenCode: the start-up blank is a no-rule idle, never a confirmed "not taken"', async () => {
  const h = harness({
    agent: 'opencode', start: { state: 'idle', screen: '' }, typedAt: 45.8,
    timeline: [{ at: 46.17, state: 'working', screen: '\n' }, { at: 46.76, state: 'idle', screen: '' }],
  });
  await h.run(TASK);
  assert.equal(h.retypes(TASK), 0);
  assert.deepEqual(h.writes, []);
});

test('OpenCode: a genuinely dropped prompt (still on the home screen) gets one bare Enter, then is re-typed once', async () => {
  const h = harness({
    agent: 'opencode', start: { state: 'idle', screen: HOME }, typedAt: 45.8,
    // quiet home screen until the re-type goes in (4 s check + bare Enter + 4 s check ≈ +8 s), then it starts work
    timeline: [{ at: 54.0, state: 'working', screen: WORKING }],
  });
  await h.run(TASK);
  assert.equal(h.retypes(TASK), 1, JSON.stringify(h.writes));
  assert.deepEqual(h.writes, ['\r', '\x15', TASK, '\r']);
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0]!, /prompt not taken at start-up \(round 2\); typing it again/);
});

test('a hook-less agent that drops the prompt (the agy case) is still re-typed once, then left alone once it works', async () => {
  const h = harness({
    agent: 'agy', start: { state: 'idle', screen: '> ' }, typedAt: 10,
    timeline: [{ at: 18.5, state: 'working', screen: 'thinking…' }],
  });
  await h.run(TASK);
  assert.equal(h.retypes(TASK), 1, JSON.stringify(h.writes));
  assert.deepEqual(h.writes, ['\r', '\x15', TASK, '\r']);
});

test('a hook hint of working after the send is authoritative (no escalation at all)', async () => {
  const h = harness({
    agent: 'claude', start: { state: 'idle', screen: '> ' }, typedAt: 10,
    timeline: [{ at: 10.3, hinted: 'working', state: 'working' }, { at: 10.8, state: 'idle' }],
  });
  await h.run(TASK);
  assert.deepEqual(h.writes, []);
});

test('evidence helpers: OpenCode session view = taken; home idle footer = confirmed not taken', () => {
  const p = (screen: string, state = 'idle') => ({ id: 'p', agent: 'opencode', state, exited: false, hintedAt: 0, lastOutputAt: 0, write() {}, detectionSnapshot: () => ({ screen }) });
  assert.equal(promptTakenEvidence(p(SESSION_IDLE), 0), true);
  assert.equal(promptTakenEvidence(p(WORKING, 'working'), 0), true);
  assert.equal(promptTakenEvidence(p(HOME), 0), false);
  assert.equal(promptNotTakenConfirmed(p(HOME)), true);
  assert.equal(promptNotTakenConfirmed(p(SESSION_IDLE)), false);
  assert.equal(promptNotTakenConfirmed(p('')), false, 'start-up blank');
});

// A woken worker (resumed Claude session): the text is typed but never submitted, and the pane's state does not read idle,
// so the state-based escalation never runs. The screen decides: text still in the input box -> one more Enter.
const BOX = (inBox: string) => `  ⏺ earlier work done\n\n╭──────────────────────────────╮\n│ > ${inBox.padEnd(26)} │\n╰──────────────────────────────╯\n  ? for shortcuts\n`;
function woken(screenAfterEnter: (n: number) => string, state = 'working') {
  let now = 0; const writes: string[] = []; const logs: string[] = [];
  const pane: any = {
    id: 'p9', agent: 'claude', role: 'worker', state, exited: false, hinted: null, hintedAt: 0, lastOutputAt: 0, screen: BOX('fix the flaky test'),
    write(d: string) { writes.push(d); if (d === '\r') pane.screen = screenAfterEnter(writes.filter((w) => w === '\r').length); },
    detectionSnapshot() { return { screen: pane.screen, oscTitle: '', oscProgress: '' }; },
  };
  const env = { now: () => now, sleep: async (ms: number) => { now += ms; }, log: (m: string) => logs.push(m) };
  return { pane, writes, logs, env };
}

test('textStillInInput: the typed line in the bottom box, not in the transcript above', () => {
  const h = woken(() => '');
  assert.equal(textStillInInput(h.pane, 'fix the flaky test'), true);
  h.pane.screen = `> fix the flaky test\n  ⏺ on it\n${'\n'.repeat(2)}${BOX('')}`;
  assert.equal(textStillInInput(h.pane, 'fix the flaky test'), false);
});

test('confirmInputEmptied: text left in the box of a working-looking pane gets one more Enter, then it is left alone', async () => {
  const sent = woken(() => BOX(''));
  await confirmInputEmptied(sent.pane, 'fix the flaky test', sent.env);
  assert.deepEqual(sent.writes, ['\r']);
  const stuck = woken(() => BOX('fix the flaky test'));
  await confirmInputEmptied(stuck.pane, 'fix the flaky test', stuck.env);
  assert.equal(stuck.writes.length, 1, 'retries Enter once only');
  assert.match(stuck.logs.join('\n'), /still in the input box/);
});

test('confirmInputEmptied: a submitted prompt, a plain pane and a non-worker are never touched', async () => {
  const ok = woken(() => BOX('')); ok.pane.screen = BOX('');
  await confirmInputEmptied(ok.pane, 'fix the flaky test', ok.env);
  const plain = woken(() => ''); plain.pane.role = null;
  await confirmInputEmptied(plain.pane, 'fix the flaky test', plain.env);
  const blind = woken(() => ''); delete blind.pane.detectionSnapshot;
  await confirmInputEmptied(blind.pane, 'fix the flaky test', blind.env);
  assert.deepEqual([ok.writes, plain.writes, blind.writes], [[], [], []]);
});
