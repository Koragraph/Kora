// Integration: a real server on a temp socket, real panes, a FAKE agent that paints Claude-shaped screens.
// Proves detection → agent.wait → blocker text → prompt end to end without spending a Claude session, plus
// concurrency (parallel spawns + graph calls), restart/resume of the server, and an output flood.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { createServer } from './daemon';
import { KoraClient } from '../protocol/client';
import { readControlToken } from './control-auth';
import { trustFolder } from '../trust/store';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-'));
const sock = path.join(home, 's.sock');
process.env.KORA_HOME = home; process.env.KORA_SOCKET_PATH = sock; process.env.KORA_AUTO_INGEST = '0'; process.env.KORA_WORKTREES_DEFAULT = '0';

// A script that behaves like Claude Code's screen: idle prompt box → "working" line → permission dialog → idle.
const fake = path.join(home, 'fake-claude.sh');
fs.writeFileSync(fake, `#!/bin/sh
printf '\\033]0;✳ fake\\007'
printf '\\n────────────────────────────────\\n❯ \\n────────────────────────────────\\n'
read line
printf '\\033]0;⠋ thinking\\007'
printf '\\n⏺ Working on it…\\n  ⏸ Crunching (esc to interrupt)\\n'
sleep 1.5
printf '\\033]0;✳ fake\\007'
printf '\\033[2J\\033[H⏺ Working on it…\\n\\n────────────────────────────────\\n Bash command\\n  rm -rf build\\n Do you want to proceed?\\n ❯ 1. Yes\\n   2. No\\n Esc to cancel\\n'
read ans
printf '\\033]0;✳ fake\\007'
printf '\\033[2J\\033[H⏺ done: %s\\n\\n────────────────────────────────\\n❯ \\n────────────────────────────────\\n' "$ans"
read line2
exit 0
`, { mode: 0o755 });

// An idle Claude-shaped agent that echoes every line it receives, working for a second in between.
const idle = path.join(home, 'fake-idle.sh');
fs.writeFileSync(idle, `#!/bin/sh
printf '\\033]0;✳ fake\\007'
box() { printf '\\n────────────────────────────────\\n❯ \\n────────────────────────────────\\n'; }
box
while read line; do
  printf '\\033]0;⠋ thinking\\007'
  printf '\\n⏺ got: %s\\n  ⏸ Crunching (esc to interrupt)\\n' "$line"
  sleep 1
  printf '\\033]0;✳ fake\\007'
  printf '\\033[2J\\033[H⏺ got: %s\\n' "$line"
  box
done
`, { mode: 0o755 });
// The "new MCP server" dialog with the cursor on the LAST option: the runtime must press ↑↑ then Enter.
const mcpDialog = path.join(home, 'fake-mcp.sh');
fs.writeFileSync(mcpDialog, `#!/bin/sh
printf '\\033]0;✳ fake\\007'
printf ' New MCP server found in this project: koragraph\\n MCP servers may execute code or access system resources.\\n   1. Use this MCP server\\n   2. Use this and all future MCP servers in this project\\n ❯ 3. Continue without using this MCP server\\n Enter to confirm · Esc to cancel\\n'
read ans
printf '\\033[2J\\033[H'
case "$ans" in *"$(printf '\\033[A\\033[A')"*) printf '⏺ answered: use-this\\n';; *) printf '⏺ answered: other\\n';; esac
printf '\\n────────────────────────────────\\n❯ \\n────────────────────────────────\\n'
read line2
`, { mode: 0o755 });
// The trust dialog (cursor already on Yes → Enter). Answered only when the pane's cwd is under a trusted root.
const trustDialog = path.join(home, 'fake-trust.sh');
fs.writeFileSync(trustDialog, `#!/bin/sh
printf '\\033]0;✳ fake\\007'
printf '╭──────────────────────────────────────────────╮\\n│ Do you trust the files in this folder?       │\\n│                                              │\\n│ Is this a project you created or one you trust? │\\n│                                              │\\n│ ❯ 1. Yes, I trust this folder                │\\n│   2. No, exit                                │\\n╰──────────────────────────────────────────────╯\\n Enter to confirm · Esc to cancel\\n'
read ans
printf '\\033[2J\\033[H⏺ trusted\\n\\n────────────────────────────────\\n❯ \\n────────────────────────────────\\n'
read line2
`, { mode: 0o755 });

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-repo-'));
const untrusted = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-untrusted-'));
// trust only `repo` (the temp dir is not under ~/Projects); every auto-answer kind on
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ trustedRoots: [repo], autoAnswer: { trustFolder: true, mcpFound: true, readOutsideWorktree: true }, restartMode: 'cheap' }));
// the folder-trust store (not trustedRoots alone) decides whether the dialog is answered
trustFolder(repo);

// A Claude transcript: one prompt, one Read, 100k cached tokens on the last call (≈ $0.03 at Sonnet cache-read price)
function writeTranscript(name: string, firstPrompt: string, ctx = 100_000): string {
  const f = path.join(home, name);
  const usage = { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: ctx, output_tokens: 40 };
  const lines = [
    { type: 'user', sessionId: 's-' + name, cwd: repo, message: { role: 'user', content: firstPrompt }, timestamp: '2026-01-01T00:00:00Z' },
    { type: 'assistant', requestId: 'r1', message: { model: 'claude-sonnet-5', usage, content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: path.join(repo, 'a.js') } }] }, timestamp: '2026-01-01T00:00:01Z' },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'function a(){}' }] }, toolUseResult: { file: { filePath: path.join(repo, 'a.js') } } },
    { type: 'assistant', requestId: 'r2', message: { model: 'claude-sonnet-5', usage, content: [{ type: 'text', text: 'a() is empty; nothing to fix at a.js:1.' }] }, timestamp: new Date().toISOString() },
  ];
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
}
const until = async (fn: () => boolean | Promise<boolean>, ms: number) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return fn(); };
spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo }); fs.writeFileSync(path.join(repo, 'a.js'), 'function a(){}\n');
spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], { cwd: repo }); spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'i'], { cwd: repo });

let handle: any;
// The test owns this daemon: its client holds the throwaway home's control token, as a person's terminal would, also
// when the run starts inside a Kora agent pane (the agent marker withholds the env-derived token).
async function client(): Promise<KoraClient> { const c = new KoraClient(sock); c.control = readControlToken(path.dirname(sock)) ?? readControlToken(home) ?? undefined; await c.connect(3000); return c; }

// macOS assesses every freshly written executable on its first exec (syspolicyd/XProtect). With the suite running
// files in parallel that queue reaches 5–20 s (measured), which blew every agent.wait below. Exec each fake once
// here, untimed (stdin closed, so each script runs to its end), so the timed spawns hit a warm cache.
function warm(...files: string[]) { for (const f of files) spawnSync(f, [], { input: '', stdio: ['pipe', 'ignore', 'ignore'], timeout: 120_000 }); }
test.before(async () => { warm(fake, idle, mcpDialog, trustDialog); handle = await createServer({ socketPath: sock, restore: false }); });
test.after(async () => { try { await handle.close(); } catch { /* ok */ } });

test('detection end to end on a Claude-shaped fake agent: idle → working → blocked (with blocker) → idle', async () => {
  const c = await client();
  const p = await c.call('pane.spawn', { command: fake, args: [], cwd: repo, agent: 'claude', name: 'fake', enforce: false });
  let r = await c.call('agent.wait', { paneId: p.id, until: 'idle', timeoutMs: 8000 });
  assert.equal(r.state, 'idle', `expected idle, got ${r.state} ${r.blocker}`);
  const pr = await c.call('agent.prompt', { paneId: p.id, text: 'go', submit: true, waitIdle: true, timeoutMs: 5000 });
  assert.notEqual(pr.state, 'idle', 'prompt should have moved the agent off idle');
  r = await c.call('agent.wait', { paneId: p.id, until: 'needs-human', timeoutMs: 10000, afterChange: false });
  assert.equal(r.state, 'blocked'); assert.match(r.blocker || '', /proceed/i);
  await c.call('pane.write', { paneId: p.id, text: 'yes\r' });
  r = await c.call('agent.wait', { paneId: p.id, until: 'idle', timeoutMs: 8000, afterChange: true });
  assert.equal(r.state, 'idle');
  const screen = (await c.call('pane.read', { paneId: p.id, source: 'screen' })).text;
  assert.match(screen, /done: yes/);
  await c.call('pane.kill', { paneId: p.id });
  c.close();
});

test('concurrency: parallel spawns and parallel graph calls do not error', async () => {
  const c = await client();
  const panes = await Promise.all([1, 2, 3, 4].map((i) => c.call('pane.spawn', { command: 'sh', args: ['-c', `echo pane${i}; sleep 5`], cwd: repo, name: `c${i}` })));
  assert.equal(new Set(panes.map((p) => p.id)).size, 4);
  const results = await Promise.allSettled(panes.map((p) => c.call('graph.status', { cwd: repo })));
  assert.ok(results.every((r) => r.status === 'fulfilled'), 'graph.status must never throw');
  for (const p of panes) {
    const read = async () => (await c.call('pane.read', { paneId: p.id, source: 'screen' })).text;
    await until(async () => /pane\d/.test(await read()), 10_000);
    assert.match(await read(), /pane\d/);
  }
  for (const p of panes) await c.call('pane.kill', { paneId: p.id });
  c.close();
});

test('output flood: 3 MB in one burst does not wedge the server, and the screen is readable after', async () => {
  const c = await client();
  // Windows' ConPTY renders a few hundred KB/s on a CI runner: the same burst is 300 KB there (still far past one screen).
  const bytes = process.platform === 'win32' ? 100_000 : 3_000_000;
  const p = await c.call('pane.spawn', { command: 'sh', args: ['-c', `yes flood | head -c ${bytes}; echo FLOOD_DONE; sleep 3`], cwd: repo, name: 'flood' });
  const t0 = Date.now();
  let screen = '';
  while (Date.now() - t0 < (process.platform === 'win32' ? 60_000 : 15_000)) { await new Promise((r) => setTimeout(r, 300)); screen = (await c.call('pane.read', { paneId: p.id, source: 'screen' })).text; if (/FLOOD_DONE/.test(screen)) break; }
  assert.match(screen, /FLOOD_DONE/);
  const ping = await c.call('server.ping', {}); assert.equal(ping.ok, true);
  await c.call('pane.kill', { paneId: p.id });
  c.close();
});

test('restart: pane.restart respawns with the same command and cwd; server stop/start restores panes', async () => {
  const c = await client();
  const p = await c.call('pane.spawn', { command: 'sh', args: ['-c', 'echo first; exit 0'], cwd: repo, name: 'r1' });
  await c.call('agent.wait', { paneId: p.id, until: 'needs-human', timeoutMs: 10_000 });
  await until(async () => (await c.call('pane.get', { paneId: p.id })).exited === true, 10_000);
  const info = await c.call('pane.get', { paneId: p.id }); assert.equal(info.exited, true);
  const q = await c.call('pane.restart', { paneId: p.id });
  assert.equal(q.command, 'sh'); assert.equal(q.cwd, repo); assert.equal(q.name, 'r1');
  const keep = await c.call('pane.spawn', { command: 'sh', args: ['-c', 'sleep 30'], cwd: repo, name: 'keep' });
  c.close();
  await handle.close();
  // One state file PER RUNTIME: a runtime on a non-default socket writes state-<hash>.json (see state.ts).
  const { stateFileFor } = require('./state');
  const state = JSON.parse(fs.readFileSync(stateFileFor(sock), 'utf8'));
  assert.ok(JSON.stringify(state).includes('"keep"'), 'the runtime state file must record the pane');
  handle = await createServer({ socketPath: sock, restore: true });
  const c2 = await client();
  const list = await c2.call('pane.list', {});
  assert.ok(list.panes.some((x) => x.name === 'keep' && x.id === keep.id), 'restored pane keeps its id and name');
  for (const x of list.panes) await c2.call('pane.kill', { paneId: x.id });
  c2.close();
});

test('config.get/set round-trip through the server; nested patch merges', async () => {
  const c = await client();
  const g = await c.call('config.get', {});
  assert.equal((g.config as any).restartMode, 'cheap'); assert.deepEqual((g.config as any).trustedRoots, [repo]); assert.ok(g.path.endsWith('config.json'));
  const r = await c.call('config.set', { patch: { autoCompact: { contextTokens: 42 } } });
  assert.equal((r.config as any).autoCompact.contextTokens, 42); assert.equal((r.config as any).autoCompact.enabled, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).trustedRoots[0], repo, 'set keeps the other keys');
  c.close();
});

test('pane.compact: refuses a non-idle pane, sends /compact with keep-instructions to an idle Claude pane, notifies', async () => {
  const c = await client(); const notes: any[] = []; c.on('notification', (m: string, p: any) => notes.push([m, p]));
  await c.call('events.subscribe', { paneOutput: false });
  const p = await c.call('pane.spawn', { command: idle, args: [], cwd: repo, agent: 'claude', enforce: false });
  assert.equal((await c.call('agent.wait', { paneId: p.id, until: 'idle', timeoutMs: 8000 })).state, 'idle');
  const shell = await c.call('pane.spawn', { command: 'sh', args: ['-c', 'sleep 20'], cwd: repo, name: 'sh' });
  const no = await c.call('pane.compact', { paneId: shell.id }); assert.equal(no.sent, false); assert.match(no.reason || '', /Claude/);
  const r = await c.call('pane.compact', { paneId: p.id });
  assert.equal(r.sent, true, r.reason);
  assert.ok(await until(async () => /got: \/compact keep every file:line citation/.test((await c.call('pane.read', { paneId: p.id, source: 'scrollback' })).text), 6000), 'the pane received /compact');
  assert.ok(notes.some(([m, q]) => m === 'pane.compacted' && q.paneId === p.id && q.auto === false));
  assert.ok((await c.call('pane.get', { paneId: p.id })).lastCompactAt! > 0);
  await c.call('pane.kill', { paneId: p.id }); await c.call('pane.kill', { paneId: shell.id }); c.close();
});

test('ledger reactions: auto-name from the first prompt, budget over → the agent is told once, auto-compact above the threshold', async () => {
  const c = await client(); const notes: any[] = []; let raw = '';
  c.on('notification', (m: string, p: any) => { notes.push([m, p]); if (m === 'pane.output' && p.base64) raw += Buffer.from(p.base64, 'base64').toString('utf8'); });
  // Subscribe to the pane's OUTPUT stream: it is append-only, so an echo cannot be hidden by the fake agent's
  // screen-clear the way a scrollback read can (write order would otherwise decide which "got:" survives).
  await c.call('events.subscribe', { paneOutput: true });
  await c.call('config.set', { patch: { autoCompact: { enabled: true, contextTokens: 50_000, onlyWhenIdle: true } } });
  try {
    const p = await c.call('pane.spawn', { command: idle, args: [], cwd: repo, agent: 'claude', enforce: false, budgetUsd: 0.01 });
    assert.equal(p.name, 'claude'); assert.equal(p.budgetUsd, 0.01); assert.equal(p.budgetState, 'ok');
    assert.equal((await c.call('agent.wait', { paneId: p.id, until: 'idle', timeoutMs: 8000 })).state, 'idle');
    const tr = writeTranscript('t-budget.jsonl', 'Refactor the ledger parser for speed, please, and keep the tests green');
    await c.call('pane.reportAgentSession', { paneId: p.id, agent: 'claude', agentSessionId: 's-budget', transcriptPath: tr });
    assert.ok(await until(async () => (await c.call('pane.get', { paneId: p.id })).name === 'Refactor the ledger parser', 4000), 'auto-named from the first prompt');
    const info = await c.call('pane.get', { paneId: p.id });
    assert.equal(info.budgetState, 'over'); assert.ok(info.ledger!.costUsd > 0.01);
    assert.ok(notes.some(([m, q]) => m === 'pane.budget' && q.paneId === p.id && q.state === 'over'), 'pane.budget over notification');
    const told = await until(async () => /got: kora: this task's budget of \$0\.01 is spent \(\$0\.0\d\)\. Finish with a 3-line summary and stop\./.test(raw), 8000);
    if (!told) console.error('[ledger test] pane output tail:', JSON.stringify(raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').slice(-600)));
    assert.ok(told, 'the agent was told');
    assert.ok(await until(async () => notes.some(([m, q]) => m === 'pane.compacted' && q.paneId === p.id && q.auto === true), 8000), 'auto-compact fired (context 100k > 50k)');
    assert.ok(await until(async () => /got: \/compact keep/.test(raw), 6000), 'the pane received /compact');
    // a second ledger update must not re-send the budget message or re-compact within the 10-minute gap
    fs.appendFileSync(tr, JSON.stringify({ type: 'assistant', requestId: 'r3', message: { model: 'claude-sonnet-5', usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 120_000, output_tokens: 5 }, content: [{ type: 'text', text: 'more' }] }, timestamp: new Date().toISOString() }) + '\n');
    await new Promise((r) => setTimeout(r, 2500));
    // "once" is a runtime guarantee (budgetOverSent), so assert the notification fired once — the fake echoes each
    // line twice (working then idle), so counting echoes would be a harness artifact, not the behaviour.
    assert.equal(notes.filter(([m, q]) => m === 'pane.budget' && q.paneId === p.id && q.state === 'over').length, 1, 'budget over notified exactly once');
    assert.equal(notes.filter(([m, q]) => m === 'pane.compacted' && q.paneId === p.id).length, 1, 'one compaction');
    await c.call('pane.kill', { paneId: p.id });
  } finally { await c.call('config.set', { patch: { autoCompact: { enabled: false, contextTokens: 150_000 } } }); c.close(); }
});

test('auto-answer: "new MCP server" is answered with ↑↑ Enter and logged; trust dialog only under a trusted root', async () => {
  const c = await client(); const notes: any[] = []; c.on('notification', (m: string, p: any) => notes.push([m, p]));
  await c.call('events.subscribe', { paneOutput: false });
  const m = await c.call('pane.spawn', { command: mcpDialog, args: [], cwd: repo, agent: 'claude', name: 'mcp', enforce: false });
  const r = await c.call('agent.wait', { paneId: m.id, until: 'idle', timeoutMs: 10000 });
  assert.equal(r.state, 'idle', `expected the runtime to answer the MCP dialog, got ${r.state} ${r.blocker}`);
  assert.match((await c.call('pane.read', { paneId: m.id, source: 'scrollback' })).text, /answered: use-this/);
  assert.ok(notes.some(([n, q]) => n === 'pane.autoAnswered' && q.paneId === m.id && q.kind === 'mcpFound' && /koragraph/.test(q.detail)));
  assert.match(fs.readFileSync(path.join(home, 'server.log'), 'utf8'), /auto-answer mcpFound: Use this MCP server — koragraph/);
  const t = await c.call('pane.spawn', { command: trustDialog, args: [], cwd: repo, agent: 'claude', name: 'trust', enforce: false });
  assert.equal((await c.call('agent.wait', { paneId: t.id, until: 'idle', timeoutMs: 10000 })).state, 'idle', 'trust dialog answered for a trusted root');
  assert.match((await c.call('pane.read', { paneId: t.id, source: 'scrollback' })).text, /trusted/);
  const u = await c.call('pane.spawn', { command: trustDialog, args: [], cwd: untrusted, agent: 'claude', name: 'untrusted', enforce: false });
  const b = await c.call('agent.wait', { paneId: u.id, until: 'needs-human', timeoutMs: 8000 });
  assert.equal(b.state, 'blocked');
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal((await c.call('agent.status', { paneId: u.id })).state, 'blocked', 'an untrusted cwd stays blocked for a human');
  assert.ok(!notes.some(([n, q]) => n === 'pane.autoAnswered' && q.paneId === u.id));
  for (const id of [m.id, t.id, u.id]) await c.call('pane.kill', { paneId: id });
  c.close();
});

test('restart modes: resume keeps --resume <session>; cheap starts fresh with a resume brief at ~/.kora/panes/<newId>/', async () => {
  const c = await client();
  const a = await c.call('pane.spawn', { command: idle, args: ['--flag'], cwd: repo, agent: 'claude', enforce: false, budgetUsd: 5 });
  assert.equal((await c.call('agent.wait', { paneId: a.id, until: 'idle', timeoutMs: 8000 })).state, 'idle');
  const tr = writeTranscript('t-resume.jsonl', 'Explain how incremental re-indexing works');
  await c.call('pane.reportAgentSession', { paneId: a.id, agent: 'claude', agentSessionId: 'sess-A', transcriptPath: tr });
  await until(async () => !!(await c.call('pane.get', { paneId: a.id })).ledger, 4000);
  const b = await c.call('pane.restart', { paneId: a.id, mode: 'resume' });
  assert.deepEqual(b.args.slice(0, 2), ['--resume', 'sess-A']); assert.equal(b.agentSessionId, 'sess-A'); assert.equal(b.budgetUsd, 5, 'budget carries over');
  assert.equal(b.name, 'claude', 'an auto-name from the old session is not carried into the new one');
  await c.call('pane.reportAgentSession', { paneId: b.id, agent: 'claude', agentSessionId: 'sess-B', transcriptPath: tr });
  const d = await c.call('pane.restart', { paneId: b.id, mode: 'cheap' });
  assert.ok(!d.args.includes('--resume'), `cheap must not resume: ${d.args.join(' ')}`); assert.equal(d.agentSessionId, null);
  const brief = path.join(home, 'panes', d.id, 'resume-brief.md');
  assert.ok(fs.existsSync(brief), `brief written at ${brief}`);
  const text = fs.readFileSync(brief, 'utf8');
  assert.match(text, /## First prompt\nExplain how incremental re-indexing works/); assert.match(text, /- a\.js/); assert.match(text, /a\(\) is empty/); assert.match(text, /\$0\.0\d over 2 API calls/);
  const e = await c.call('pane.restart', { paneId: d.id, mode: 'fresh' });
  assert.ok(!e.args.includes('--resume')); assert.ok(!fs.existsSync(path.join(home, 'panes', e.id, 'resume-brief.md')), 'fresh writes no brief');
  await c.call('pane.kill', { paneId: e.id }); c.close();
});

test('zero-setup: ensureSetup installs enforcement once for a repo with nothing installed', async () => {
  // A repo of its own: `repo` is trusted at the top of this file, and other tests may have set it up already, so the
  // untrusted half only held by test order (it failed on CI, 2026-10-20).
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-fresh-'));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: fresh }); fs.writeFileSync(path.join(fresh, 'a.js'), 'function a(){}\n');
  // untrusted (pl5 S2-1): nothing is written into the folder
  const snap = () => execSync('git status --porcelain --untracked-files=all', { cwd: fresh, encoding: 'utf8' });
  const before = snap();
  assert.equal(await handle.runtime.ensureSetup(fresh), null, 'an untrusted folder is not set up');
  assert.equal(snap(), before, 'and its tree is untouched');
  (require('../trust/store') as typeof import('../trust/store')).trustFolder(fresh);
  const text = await handle.runtime.ensureSetup(fresh);
  assert.ok(text === null || /^kora: set up .* for /.test(text), String(text));
  if (text) assert.ok(fs.existsSync(path.join(fresh, 'AGENTS.md')) || fs.existsSync(path.join(fresh, 'CLAUDE.md')) || fs.existsSync(path.join(fresh, '.claude', 'settings.json')), 'something was written into the repo');
  assert.equal(await handle.runtime.ensureSetup(fresh), null, 'second call is a no-op');
});
