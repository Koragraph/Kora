// swarm-watchdog: the pure T1/T2 decision (nudge, reassign, active grace, idle-without-report, spend cap) and the
// OpenCode DB reader (progress + cost per worktree) against a tiny sqlite fixture with OpenCode's own columns.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ACTIVE_GRACE_MS, BUDGET_GRACE_MS, IDLE_NO_REPORT_MS, OpencodeActivity, SILENT_STREAM_MS, watchdogDecision, type WatchdogInput } from './swarm-watchdog';

const T1 = 8 * 60_000, T2 = 15 * 60_000, START = 1_000_000;
const at = (ms: number, o: Partial<WatchdogInput> = {}): WatchdogInput => ({
  // a worker that last made progress 2 minutes ago (the silent-stream rule has its own test)
  now: START + ms, attemptStartedAt: START, lastProgressAt: Math.max(START, START + ms - 2 * 60_000), hasReport: false, inVerify: false, idleSince: null,
  idleNudged: false, wdNudged: false, settings: { nudgeAfterMs: T1, reassignAfterMs: T2 }, ...o,
});

test('watchdog: nothing before T1, one nudge at T1, reassign at T2', () => {
  assert.equal(watchdogDecision(at(T1 - 1)).kind, 'none');
  assert.deepEqual(watchdogDecision(at(T1)), { kind: 'nudge', elapsedMs: T1 });
  assert.equal(watchdogDecision(at(T1 + 60_000, { wdNudged: true })).kind, 'none', 'nudged once only');
  assert.deepEqual(watchdogDecision(at(T2, { wdNudged: true })), { kind: 'reassign', why: 'slow' });
});

test('watchdog: a stream silent for 4 min (no model progress) is reassigned without waiting for T2', () => {
  const silent = (ms: number) => at(ms, { lastProgressAt: START + 30_000 });
  assert.equal(watchdogDecision(silent(30_000 + SILENT_STREAM_MS - 1)).kind, 'none');
  assert.deepEqual(watchdogDecision(silent(30_000 + SILENT_STREAM_MS)), { kind: 'reassign', why: 'slow' });
  // idle (waiting for a reply) is the idle path's business, not this one
  assert.equal(watchdogDecision(at(30_000 + SILENT_STREAM_MS, { lastProgressAt: START + 30_000, idleSince: START + 40_000 })).kind, 'none');
});

test('watchdog: a worker still making progress at T2 gets until 1.5 × T2', () => {
  const busy = (ms: number) => at(ms, { wdNudged: true, lastProgressAt: START + ms - ACTIVE_GRACE_MS / 2 });
  assert.equal(watchdogDecision(busy(T2)).kind, 'none');
  assert.equal(watchdogDecision(busy(T2 * 1.5)).kind, 'reassign');
});

test('watchdog: a report or the verify pipeline hands the task back; T=0 turns a stage off', () => {
  assert.equal(watchdogDecision(at(T2 * 2, { hasReport: true })).kind, 'none');
  assert.equal(watchdogDecision(at(T2 * 2, { inVerify: true })).kind, 'none');
  assert.equal(watchdogDecision(at(T2 * 2, { settings: { nudgeAfterMs: 0, reassignAfterMs: 0 } })).kind, 'none');
});

test('watchdog: idle without a report after the idle nudge → reassign (the skipped-report case)', () => {
  const idle = START + 60_000;
  assert.equal(watchdogDecision(at(60_000 + IDLE_NO_REPORT_MS - 1, { idleSince: idle, idleNudged: true })).kind, 'none');
  assert.deepEqual(watchdogDecision(at(60_000 + IDLE_NO_REPORT_MS, { idleSince: idle, idleNudged: true })), { kind: 'reassign', why: 'no-report' });
  assert.equal(watchdogDecision(at(T1, { idleSince: idle })).kind, 'none', 'no T1 typing into an idle composer; the idle nudge owns that');
});

test('watchdog: paid spend cap → stop, then kill after the grace (never before a report is judged)', () => {
  const cap = { spentUsd: 0.051, capUsd: 0.05 };
  assert.equal(watchdogDecision(at(60_000, { spentUsd: 0.01, capUsd: 0.05 })).kind, 'none');
  assert.equal(watchdogDecision(at(60_000, cap)).kind, 'budget-stop');
  assert.equal(watchdogDecision(at(60_000, { ...cap, budgetStopAt: START + 60_000 })).kind, 'none');
  assert.equal(watchdogDecision(at(60_000 + BUDGET_GRACE_MS, { ...cap, budgetStopAt: START + 60_000 })).kind, 'budget-kill');
  assert.equal(watchdogDecision(at(60_000 + BUDGET_GRACE_MS, { ...cap, budgetStopAt: START + 60_000, hasReport: true })).kind, 'none');
  assert.equal(watchdogDecision(at(60_000 + BUDGET_GRACE_MS, { ...cap, budgetStopAt: -1 })).kind, 'none', 'killed once');
});

test('OpencodeActivity: newest MODEL output (assistant message/part, not a nudge) and summed cost per worktree; missing DB → empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-oc-'));
  const file = path.join(dir, 'opencode.db');
  const origEmit = process.emitWarning; (process as any).emitWarning = () => {};
  const { DatabaseSync } = require('node:sqlite');
  (process as any).emitWarning = origEmit;
  const db = new DatabaseSync(file);
  db.exec(`create table session (id text primary key, parent_id text, directory text not null, time_created integer not null, time_updated integer not null, cost real not null default 0);
    create table message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
    create table part (id text primary key, message_id text not null, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);`);
  const ins = db.prepare('insert into session values (?, ?, ?, ?, ?, ?)');
  ins.run('s1', null, '/wt/a', 1000, 2000, 0.01);
  ins.run('s2', null, '/wt/a/sub', 3000, 3500, 0.02);   // a later attempt, cd'd into a subfolder
  ins.run('s3', 's1', '/wt/a', 1000, 9000, 5);          // a subagent: not counted
  ins.run('s4', null, '/wt/ab', 1000, 9000, 1);         // a different worktree sharing the prefix
  ins.run('s5', null, '/wt/a', 10, 20, 1);              // before the task started
  db.prepare('insert into message values (?, ?, ?, ?, ?)').run('m1', 's2', 3000, 4200, '{"role":"assistant"}');
  db.prepare('insert into message values (?, ?, ?, ?, ?)').run('m2', 's2', 6000, 6000, '{"role":"user"}'); // Kora's nudge: not progress
  db.prepare('insert into part values (?, ?, ?, ?, ?, ?)').run('p1', 'm1', 's2', 3000, 4500, '{"type":"text"}'); // still streaming
  db.close();
  const r = new OpencodeActivity(file).read([{ dir: '/wt/a', sinceMs: 900 + 60_000 }, { dir: '/wt/none', sinceMs: 0 }], 5000);
  assert.deepEqual(r.get('/wt/a'), { lastAt: 4500, costUsd: 0.03 });
  assert.equal(r.has('/wt/none'), false);
  assert.equal(new OpencodeActivity(path.join(dir, 'nope.db')).read([{ dir: '/wt/a', sinceMs: 0 }]).size, 0);
});

test('koragentStallStep: escalate first, wait out the grace, respawn only after it', () => {
  const { koragentStallStep, KORAGENT_ESCALATE_GRACE_MS } = require('./swarm-watchdog') as typeof import('./swarm-watchdog');
  assert.equal(koragentStallStep({ now: 1000, escalatedAt: null }), 'escalate');
  assert.equal(koragentStallStep({ now: 1000 + KORAGENT_ESCALATE_GRACE_MS - 1, escalatedAt: 1000 }), 'wait');
  assert.equal(koragentStallStep({ now: 1000 + KORAGENT_ESCALATE_GRACE_MS, escalatedAt: 1000 }), 'respawn');
});

test('OpencodeActivity.readSteps: the newest assistant text/reasoning/tool part per worktree, mapped to a step; missing DB → null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-oc-step-'));
  const file = path.join(dir, 'opencode.db');
  const origEmit = process.emitWarning; (process as any).emitWarning = () => {};
  const { DatabaseSync } = require('node:sqlite');
  (process as any).emitWarning = origEmit;
  const db = new DatabaseSync(file);
  db.exec(`create table session (id text primary key, parent_id text, directory text not null, time_created integer not null, time_updated integer not null, cost real not null default 0);
    create table message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null); -- OpenCode's real schema: the role lives in data
    create table part (id text primary key, message_id text not null, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);`);
  db.prepare('insert into session values (?, ?, ?, ?, ?, ?)').run('s1', null, '/wt/a', 1000, 2000, 0);
  db.prepare('insert into message values (?, ?, ?, ?, ?)').run('m1', 's1', 1000, 1000, '{"role":"user"}'); // a user turn: never the step
  db.prepare('insert into message values (?, ?, ?, ?, ?)').run('m2', 's1', 2000, 2000, '{"role":"assistant"}');
  const part = db.prepare('insert into part values (?, ?, ?, ?, ?, ?)');
  // the user's own text part is newer than the assistant's tool part, but must never be picked (role filter).
  part.run('pu', 'm1', 's1', 9000, 9000, JSON.stringify({ type: 'text', text: 'do the thing' }));
  part.run('p1', 'm2', 's1', 3000, 3000, JSON.stringify({ type: 'step-start' }));
  part.run('p2', 'm2', 's1', 4000, 4000, JSON.stringify({ type: 'tool', tool: 'read', state: { input: { filePath: '/x/notes.md' } } }));
  db.close();
  const r = new OpencodeActivity(file).readSteps([{ dir: '/wt/a', sinceMs: 900 }, { dir: '/wt/none', sinceMs: 0 }], 10_000);
  assert.deepEqual(r.get('/wt/a'), { text: 'reading notes.md', at: 4000, kind: 'read' });
  assert.equal(r.get('/wt/none'), null, 'no session for this worktree: a null step, not an error');
  assert.equal(new OpencodeActivity(path.join(dir, 'nope.db')).readSteps([{ dir: '/wt/a', sinceMs: 0 }]).size, 0);
});

test('OpencodeActivity.readSteps: Chat workers sharing one folder are told apart by the report path in their own prompt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-oc-step-chat-'));
  const file = path.join(dir, 'opencode.db');
  const origEmit = process.emitWarning; (process as any).emitWarning = () => {};
  const { DatabaseSync } = require('node:sqlite');
  (process as any).emitWarning = origEmit;
  const db = new DatabaseSync(file);
  db.exec(`create table session (id text primary key, parent_id text, directory text not null, time_created integer not null, time_updated integer not null, cost real not null default 0);
    create table message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null); -- OpenCode's real schema: the role lives in data
    create table part (id text primary key, message_id text not null, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);`);
  const sess = db.prepare('insert into session values (?, ?, ?, ?, ?, ?)');
  const msg = db.prepare('insert into message values (?, ?, ?, ?, ?)');
  const part = db.prepare('insert into part values (?, ?, ?, ?, ?, ?)');
  for (const [s, task, tool, at] of [['sA', 's1', { tool: 'webfetch', state: { input: { url: 'https://github.com/x' } } }, 4000], ['sB', 's2', { tool: 'websearch', state: { input: { query: 'go cli' } } }, 5000]] as const) {
    sess.run(s, null, '/chats/general', 1000, 2000, 0);
    msg.run(`${s}u`, s, 1000, 1000, '{"role":"user"}');
    msg.run(`${s}a`, s, 2000, 2000, '{"role":"assistant"}');
    part.run(`${s}pu`, `${s}u`, s, 1000, 1000, JSON.stringify({ type: 'text', text: `REPORT FILE: /chats/general/scratch/${task}/report.md` }));
    part.run(`${s}pt`, `${s}a`, s, at, at, JSON.stringify({ type: 'tool', ...tool }));
  }
  db.close();
  const r = new OpencodeActivity(file).readSteps([
    { dir: '/chats/general', sinceMs: 900, match: '/scratch/s1/', key: 'task:s1' },
    { dir: '/chats/general', sinceMs: 900, match: '/scratch/s2/', key: 'task:s2' },
  ], 10_000);
  assert.equal(r.get('task:s1')?.kind, 'fetch');
  assert.equal(r.get('task:s2')?.kind, 'search', 'the newer session (sB) must not leak into s1 or vice versa');
});
