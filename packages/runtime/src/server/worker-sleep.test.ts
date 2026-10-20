import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkerSleeper, canResumeSession, findCodexSession, readTranscript, rebriefPrompt, resumeArgs, type SleeperHost, type SleeperPane } from './worker-sleep';

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

function repoWithWorktree() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kora-sleep-')));
  const main = path.join(base, 'main');
  fs.mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(main, 'a.txt'), 'a');
  git(main, 'add', '.');
  git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  const wt = path.join(base, 'wt');
  git(main, 'worktree', 'add', '-q', '-b', 'kora/claude-x', wt);
  return { base, main, wt, home: path.join(base, 'home') };
}

function harness(r: ReturnType<typeof repoWithWorktree>, over: Partial<SleeperPane> = {}, sessionOnDisk = true) {
  let now = 1_000_000;
  const killed: string[] = [];
  const spawned: any[] = [];
  const notes: string[] = [];
  const readied: string[] = [];
  const pane: SleeperPane = {
    id: 'p3', agent: 'claude', name: 'refactor', state: 'idle', exited: false, role: 'worker', orchestratorId: 'chat:t1',
    cwd: r.wt, worktree: { path: r.wt, branch: 'kora/claude-x', mainRoot: r.main }, createdAt: now,
    agentSessionId: 'sess-1', agentSessionPath: null, read: () => 'line 1\n⏺ done', ...over,
  };
  const panes: SleeperPane[] = [pane];
  const sl = new WorkerSleeper({
    panes: () => panes,
    report: () => 'final answer: done',
    kill: (id) => { killed.push(id); pane.exited = true; },
    spawn: async (p) => { spawned.push(p); return { id: 'p9' }; },
    ready: async (id) => { readied.push(id); },
    notify: (m) => notes.push(m),
    log: () => {},
  } satisfies SleeperHost, { home: r.home, now: () => now, sleepAfterMs: 600_000, findTranscript: (id) => (sessionOnDisk && id === 'sess-1' ? '/x/sess-1.jsonl' : null) });
  return { sl, pane, panes, killed, spawned, notes, readied, advance: (ms: number) => { now += ms; } };
}

test('an idle worker sleeps after 10 min: edits saved on its branch, folder removed, branch kept, answer recorded', async () => {
  const r = repoWithWorktree();
  const h = harness(r);
  fs.writeFileSync(path.join(r.wt, 'b.txt'), 'work');
  fs.writeFileSync(path.join(r.wt, 'CLAUDE.md'), '<!-- kora block -->'); // Kora's own onboarding file: never committed
  const rec = h.sl.track(h.pane, { prompt: 'refactor it', args: ['--model', 'haiku'] })!;
  await h.sl.tick();
  h.advance(5 * 60_000);
  await h.sl.tick();
  assert.equal(h.sl.load(rec.recordId)!.status, 'awake', 'not yet: 5 min');
  h.advance(6 * 60_000);
  await h.sl.tick();
  const after = h.sl.load(rec.recordId)!;
  assert.equal(after.status, 'asleep');
  assert.deepEqual(h.killed, ['p3']);
  assert.equal(h.pane.sleeping, true, 'Kora closed it: not "the worker exited"');
  assert.equal(after.finalReport, 'final answer: done');
  assert.equal(after.session.id, 'sess-1');
  assert.equal(after.changes!.ahead, 1);
  assert.deepEqual(after.changes!.files, ['b.txt'], 'only the worker\'s own edit — not Kora\'s CLAUDE.md');
  assert.equal(after.changes!.autoCommitted, true);
  assert.equal(fs.existsSync(r.wt), false, 'folder removed');
  assert.equal(after.branchKept, true);
  assert.match(git(r.main, 'branch', '--list', 'kora/claude-x'), /kora\/claude-x/);
  assert.ok(h.notes.includes('worker.slept'));
});

test('a worker that changed nothing: folder AND branch removed', async () => {
  const r = repoWithWorktree();
  const h = harness(r);
  const rec = h.sl.track(h.pane, {})!;
  await h.sl.sleep('p3', 'manual');
  const after = h.sl.load(rec.recordId)!;
  assert.equal(after.branchKept, false);
  assert.equal(git(r.main, 'branch', '--list', 'kora/claude-x'), '');
  assert.equal(fs.existsSync(r.wt), false);
});

test('wake: the folder comes back from the branch, the same session is resumed with the original flags', async () => {
  const r = repoWithWorktree();
  const h = harness(r);
  fs.writeFileSync(path.join(r.wt, 'b.txt'), 'work');
  const rec = h.sl.track(h.pane, { args: ['--model', 'haiku'] })!;
  await h.sl.sleep('p3', 'manual');
  const w = await h.sl.wake(rec.recordId);
  assert.equal(w.paneId, 'p9');
  assert.ok(fs.existsSync(path.join(r.wt, 'b.txt')), 'worktree restored with its saved work');
  assert.deepEqual(h.spawned[0].args, ['--resume', 'sess-1', '--model', 'haiku']);
  assert.equal(h.spawned[0].reuseWorktree.branch, 'kora/claude-x');
  const after = h.sl.load(rec.recordId)!;
  assert.equal(after.status, 'awake');
  assert.equal(after.paneId, 'p9');
  assert.equal(after.wakes, 1);
  // The lead (or a notification) still says p3: it leads to the woken pane.
  assert.deepEqual(after.pastPaneIds, ['p3']);
  assert.equal(h.sl.wokenPaneFor('p3'), 'p9');
  assert.equal(h.sl.findByLastPane(after.orchestratorId, 'p3')?.recordId, rec.recordId);
  assert.equal(h.sl.wokenPaneFor('p9'), null);
});

test('retention: an asleep worker\'s branch goes after N days (settings.json); 0 keeps it', async () => {
  const r = repoWithWorktree();
  const h = harness(r);
  fs.writeFileSync(path.join(r.wt, 'b.txt'), 'work');
  const rec = h.sl.track(h.pane, {})!;
  await h.sl.sleep('p3', 'manual');
  fs.mkdirSync(r.home, { recursive: true });
  fs.writeFileSync(path.join(r.home, 'settings.json'), JSON.stringify({ workerBranchRetentionDays: 0 }));
  h.advance(400 * 86_400_000);
  assert.equal(await h.sl.retention(), 0, '0 = keep forever');
  fs.writeFileSync(path.join(r.home, 'settings.json'), JSON.stringify({ workerBranchRetentionDays: 30 }));
  assert.equal(await h.sl.retention(), 1);
  assert.equal(h.sl.load(rec.recordId)!.branchKept, false);
  assert.equal(git(r.main, 'branch', '--list', 'kora/claude-x'), '');
});

test('a restart re-spawned the worker under a new id in the same worktree: adopted, never slept', async () => {
  const r = repoWithWorktree();
  const h = harness(r);
  const rec = h.sl.track(h.pane, {})!;
  h.pane.id = 'p12'; // same pane object, new id (restored)
  await h.sl.tick();
  assert.equal(h.sl.load(rec.recordId)!.paneId, 'p12');
  assert.equal(h.sl.load(rec.recordId)!.status, 'awake');
  assert.ok(fs.existsSync(r.wt));
});

test('only chat leads\' CLI workers get records (not swarm, not pane orchestrators)', () => {
  const r = repoWithWorktree();
  const h = harness(r);
  assert.equal(h.sl.track({ ...h.pane, swarm: {} }, {}), null);
  assert.equal(h.sl.track({ ...h.pane, orchestratorId: 'p1' }, {}), null);
});

test('resume argv per CLI', () => {
  assert.deepEqual(resumeArgs('claude', 's'), ['--resume', 's']);
  assert.deepEqual(resumeArgs('codex', 's'), ['resume', 's']);
  assert.deepEqual(resumeArgs('claude', null), []);
});

test('readTranscript: Claude Code and Codex session logs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-tr-'));
  const claude = path.join(dir, 'c.jsonl');
  fs.writeFileSync(claude, [
    JSON.stringify({ type: 'user', message: { content: 'Reply pong' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'pong' }] } }),
  ].join('\n'));
  assert.deepEqual(readTranscript(claude).map((e) => [e.role, e.text]), [['user', 'Reply pong'], ['tool', 'Bash {"command":"ls"}'], ['assistant', 'pong']]);
  const codex = path.join(dir, 'x.jsonl');
  fs.writeFileSync(codex, [
    JSON.stringify({ type: 'session_meta', payload: { cwd: '/x' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply alpha' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'alpha' }] } }),
  ].join('\n'));
  assert.deepEqual(readTranscript(codex).map((e) => e.role), ['user', 'tool', 'assistant']);
  assert.deepEqual(readTranscript(null), []);
});

test('findCodexSession: the newest log whose session_meta.cwd is the worker folder', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-cx-'));
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kora-cwd-')));
  const d = new Date();
  const dir = path.join(home, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rollout-a.jsonl'), JSON.stringify({ type: 'session_meta', payload: { session_id: 'other', cwd: '/elsewhere' } }) + '\n');
  fs.writeFileSync(path.join(dir, 'rollout-b.jsonl'), JSON.stringify({ type: 'session_meta', payload: { session_id: 'mine', cwd } }) + '\n');
  assert.equal(findCodexSession(cwd, Date.now() - 60_000, home)?.id, 'mine');
});

// Security sweep 2026-10-04: `load(id)` joined the id into `<home>/workers/<id>.json` unchecked, so
// `/api/workers/wake?recordId=../../evil` read any JSON on disk as a record — and wake() spawns what it names.
test('a record id that is not one safe segment never reaches the disk', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kora-sleep-id-')));
  try {
    const home = path.join(base, 'home');
    fs.mkdirSync(path.join(home, 'workers'), { recursive: true });
    fs.writeFileSync(path.join(base, 'evil.json'), JSON.stringify({ recordId: 'evil', orchestratorId: 'chat:t1', agent: 'claude', args: ['--evil'] }));
    const sl = new WorkerSleeper({ panes: () => [], report: () => '', kill: () => {}, spawn: async () => ({ id: 'p1' }), notify: () => {}, log: () => {} }, { home });
    assert.equal(sl.load('../evil'), null);
    assert.equal(sl.load('w_../../evil'), null);
    assert.equal(sl.load(path.join(base, 'evil')), null);
    fs.writeFileSync(path.join(home, 'workers', 'w_ok1.json'), JSON.stringify({ recordId: 'w_ok1' }));
    assert.equal(sl.load('w_ok1')?.recordId, 'w_ok1');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('wake of a resumable session: resumed, no re-brief, and the pane is settled before the lead types', async () => {
  const r = repoWithWorktree();
  const h = harness(r);
  const rec = h.sl.track(h.pane, { prompt: 'refactor it', args: [] })!;
  await h.sl.sleep('p3', 'manual');
  const w = await h.sl.wake(rec.recordId);
  assert.deepEqual(w, { paneId: 'p9', resumed: true, rebriefed: false });
  assert.equal(h.spawned[0].prompt, undefined);
  assert.deepEqual(h.readied, ['p9']);
});

test('a killed worker (exit 143, never looked at again) keeps the session id it reported while alive', async () => {
  const r = repoWithWorktree();
  const h = harness(r, { agentSessionId: null });
  const rec = h.sl.track(h.pane, { prompt: 'refactor it', args: [] })!;
  assert.equal(h.sl.load(rec.recordId)!.session.id, null);
  h.pane.agentSessionId = 'sess-1'; // the SessionStart hook reported it after the record was made
  await h.sl.tick();
  assert.equal(h.sl.load(rec.recordId)!.session.id, 'sess-1', 'refreshed while alive');
  h.panes.length = 0; // SIGTERM: the pane is gone before the sleeper sees it exit
  await h.sl.tick();
  const after = h.sl.load(rec.recordId)!;
  assert.equal(after.status, 'asleep');
  assert.equal(after.session.id, 'sess-1');
  assert.equal((await h.sl.wake(rec.recordId)).resumed, true);
  assert.deepEqual(h.spawned[0].args.slice(0, 2), ['--resume', 'sess-1']);
});

test('wake with no resumable session starts fresh, re-sends the original brief, and says so', async () => {
  for (const [label, over, onDisk] of [['no session id', { agentSessionId: null }, true], ['id without a transcript', {}, false]] as const) {
    const r = repoWithWorktree();
    const h = harness(r, over, onDisk);
    fs.writeFileSync(path.join(r.wt, 'b.txt'), 'work');
    const rec = h.sl.track(h.pane, { prompt: 'refactor it', args: ['--model', 'haiku'] })!;
    await h.sl.sleep('p3', 'manual');
    const w = await h.sl.wake(rec.recordId);
    assert.deepEqual(w, { paneId: 'p9', resumed: false, rebriefed: true }, label);
    assert.deepEqual(h.spawned[0].args, ['--model', 'haiku'], `${label}: no --resume`);
    assert.match(h.spawned[0].prompt, /could not be resumed[\s\S]*kora\/claude-x[\s\S]*refactor it/, label);
  }
});

test('wake with no resumable session and no brief on record: fresh, nothing to re-send', async () => {
  const r = repoWithWorktree();
  const h = harness(r, { agentSessionId: null });
  const rec = h.sl.track(h.pane, { args: [] })!;
  await h.sl.sleep('p3', 'manual');
  assert.deepEqual(await h.sl.wake(rec.recordId), { paneId: 'p9', resumed: false, rebriefed: false });
  assert.equal(h.spawned[0].prompt, undefined);
});

test('canResumeSession / rebriefPrompt', () => {
  const rec = (agent: string, id: string | null, transcriptPath: string | null = null) => ({ agent, session: { id, transcriptPath } });
  assert.equal(canResumeSession(rec('claude', 'x'), () => null), false);
  assert.equal(canResumeSession(rec('claude', 'x'), () => '/f'), true);
  assert.equal(canResumeSession(rec('claude', null)), false);
  assert.equal(canResumeSession(rec('codex', 'x')), true);
  assert.equal(canResumeSession(rec('gemini', 'x')), false);
  assert.equal(rebriefPrompt({ prompt: null, worktree: null, branchKept: false }), null);
});
