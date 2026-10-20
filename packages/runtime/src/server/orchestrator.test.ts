// Integration (Phase 0 proof): promote a pane → it becomes the orchestrator; spawn a worker → a human steers the
// worker with a raw pane.write → the runtime emits pane.steered AND injects the note into the orchestrator, while
// an orchestrator-origin agent.prompt does NOT. Agent-agnostic: the worker here is declared 'codex'.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from './daemon';
import { KoraClient } from '../protocol/client';
import { readControlToken } from './control-auth';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-orch-'));
const sock = path.join(home, 's.sock');
process.env.KORA_HOME = home; process.env.KORA_SOCKET_PATH = sock;
process.env.KORA_AUTO_INGEST = '0'; process.env.KORA_AUTO_SETUP = '0';
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ worktrees: 'never', autoAnswer: { trustFolder: false, mcpFound: false, readOutsideWorktree: false } }));

// An idle, Claude-shaped agent that echoes each line it receives (works ~0.8s, then returns to the idle box).
const idle = path.join(home, 'fake-idle.sh');
fs.writeFileSync(idle, `#!/bin/sh
printf '\\033]0;✳ fake\\007'
box() { printf '\\n────────────────────────────────\\n❯ \\n────────────────────────────────\\n'; }
box
while IFS= read -r line; do
  printf '\\033]0;⠋ thinking\\007'
  printf '\\n⏺ got: %s\\n  ⏸ Crunching (esc to interrupt)\\n' "$line"
  sleep 0.8
  printf '\\033]0;✳ fake\\007'
  printf '\\033[2J\\033[H⏺ got: %s\\n' "$line"
  box
done
`, { mode: 0o755 });

const until = async (fn: () => boolean | Promise<boolean>, ms: number) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return fn(); };

let handle: any;
// The test owns this daemon: its client holds the throwaway home's control token, as a person's terminal would, also
// when the run starts inside a Kora agent pane (the agent marker withholds the env-derived token).
async function client(): Promise<KoraClient> { const c = new KoraClient(sock); c.control = readControlToken(path.dirname(sock)) ?? readControlToken(home) ?? undefined; await c.connect(3000); return c; }

// macOS assesses every freshly written executable on its first exec; under the parallel suite that queue reaches
// 5–20 s (measured). Exec each fake once, untimed (stdin closed → the script ends), before anything is timed.
function warm(file: string, env?: NodeJS.ProcessEnv) { spawnSync(file, [], { input: '', stdio: ['pipe', 'ignore', 'ignore'], timeout: 120_000, env }); }
test.before(async () => { warm(idle); handle = await createServer({ socketPath: sock, restore: false }); });
test.after(async () => { try { await handle.close(); } catch { /* ok */ } });

// POSIX fixture: an extensionless #! fake claude put first on a ':'-joined PATH (the launcher shim is a sh script).
test('agent.spawn with a prompt types it as soon as the agent is idle (the spawn path is its own pending prompt)', { skip: process.platform === 'win32' }, async () => {
  // A fake `claude` on PATH: the idle box, then "got: <line>" for every submitted line.
  const bin = path.join(home, 'bin'); fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(idle, path.join(bin, 'claude')); fs.chmodSync(path.join(bin, 'claude'), 0o755);
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
  // Warm the fake and the kora launcher shim that fronts it (both are new files on first exec).
  const { ensureShims, shimsDir } = require('../enforce/shims');
  ensureShims(); warm(path.join(bin, 'claude'));
  for (const f of fs.readdirSync(shimsDir())) { const full = path.join(shimsDir(), f); if (f === 'claude' && (fs.statSync(full).mode & 0o111)) warm(full, { ...process.env, PATH: `${shimsDir()}:${process.env.PATH}` }); }
  const c = await client();
  try {
    const p = await c.call('agent.spawn', { agent: 'claude', cwd: home, name: 'sp', prompt: 'hello from spawn' });
    // Before the fix this took the full 120 s wait timeout ("not idle after 120000ms (state=idle)") because the
    // prompt's own wait-for-idle refused an idle pane whose promptPending flag it had itself set.
    const typed = await until(async () => /got: hello from spawn/.test((await c.call('pane.read', { paneId: p.id, source: 'scrollback' })).text), 15000);
    assert.ok(typed, 'the initial prompt was typed and submitted within 15 s');
    assert.ok(await until(() => handle.runtime.panes.get(p.id)?.promptPending === false, 10000), 'promptPending is released once the prompt has gone in');
    await c.call('pane.kill', { paneId: p.id });
  } finally { process.env.PATH = oldPath; c.close(); }
});

test('agent.promote marks the pane an orchestrator', async () => {
  const c = await client();
  const p = await c.call('pane.spawn', { command: idle, args: [], cwd: home, agent: 'claude', name: 'boss', enforce: false });
  await c.call('agent.wait', { paneId: p.id, until: 'idle', timeoutMs: 6000 });
  await c.call('agent.promote', { paneId: p.id });
  const info = await c.call('pane.get', { paneId: p.id });
  assert.equal(info.role, 'orchestrator');
  await c.call('pane.kill', { paneId: p.id });
  c.close();
});

test('human steer of a worker → pane.steered + note to the orchestrator; agent.prompt does NOT steer', async () => {
  const c = await client();
  const steers: any[] = [];
  await c.call('events.subscribe', {});
  c.on('pane.steered', (e: any) => steers.push(e));

  // Orchestrator (claude) — promote and let it settle back to idle so the steer note flushes immediately.
  const boss = await c.call('pane.spawn', { command: idle, args: [], cwd: home, agent: 'claude', name: 'boss2', enforce: false });
  await c.call('agent.wait', { paneId: boss.id, until: 'idle', timeoutMs: 6000 });
  await c.call('agent.promote', { paneId: boss.id });
  await c.call('agent.wait', { paneId: boss.id, until: 'idle', timeoutMs: 10000, afterChange: true });

  // Worker (codex) owned by the orchestrator — the agent type is deliberately NOT the same as the orchestrator's.
  const worker = await c.call('pane.spawn', { command: idle, args: [], cwd: home, agent: 'codex', name: 'w1', enforce: false });
  const wp = handle.runtime.panes.get(worker.id);
  wp.role = 'worker'; wp.orchestratorId = boss.id; wp.account = 'work2';
  await c.call('agent.wait', { paneId: worker.id, until: 'idle', timeoutMs: 6000 });

  // The human grabs the wheel: types a redirect straight into the worker pane (a raw pane.write = human origin).
  await c.call('pane.write', { paneId: worker.id, text: 'please use the existing Limiter class instead\r' });

  assert.ok(await until(() => steers.length >= 1, 5000), 'a pane.steered notification should fire');
  assert.equal(steers[0].paneId, worker.id);
  assert.equal(steers[0].orchestratorId, boss.id);
  assert.equal(steers[0].origin, 'human');
  assert.match(steers[0].text, /Limiter/);

  const winfo = await c.call('pane.get', { paneId: worker.id });
  assert.equal(typeof winfo.steeredAt, 'number', 'the worker records when it was steered');

  // The orchestrator was actually told: its screen shows the injected steer note.
  assert.ok(await until(async () => /steered worker/.test((await c.call('pane.read', { paneId: boss.id, source: 'scrollback', lines: 60 })).text), 12000),
    'the orchestrator pane should receive the steer note');

  // Control: an ORCHESTRATOR-origin prompt to the worker must NOT be treated as a human steer.
  const before = steers.length;
  await c.call('agent.prompt', { paneId: worker.id, text: 'orchestrator says: continue with the plan', submit: true, waitIdle: true, timeoutMs: 6000 });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(steers.length, before, 'agent.prompt (orchestrator origin) must not emit pane.steered');

  await c.call('pane.kill', { paneId: worker.id });
  await c.call('pane.kill', { paneId: boss.id });
  c.close();
});

test('fleet.get roster + fleet.set plan/cap + mergeVerify wiring', async () => {
  const c = await client();
  const boss = await c.call('pane.spawn', { command: idle, args: [], cwd: home, agent: 'claude', name: 'boss3', enforce: false });
  await c.call('agent.promote', { paneId: boss.id });

  const w1 = await c.call('pane.spawn', { command: idle, args: [], cwd: home, agent: 'claude', name: 'wa', enforce: false });
  const w2 = await c.call('pane.spawn', { command: idle, args: [], cwd: home, agent: 'codex', name: 'wb', enforce: false });
  for (const [w, acct] of [[w1, 'main'], [w2, 'work2']] as const) { const wp = handle.runtime.panes.get(w.id); wp.role = 'worker'; wp.orchestratorId = boss.id; wp.account = acct; }

  const f = await c.call('fleet.get', { orchestratorId: boss.id });
  assert.equal(f.roster.length, 2, 'roster lists both workers');
  const codex = f.roster.find((r: any) => r.paneId === w2.id);
  assert.ok(codex, 'codex worker is in the roster');
  assert.equal(codex.agent, 'codex'); assert.equal(codex.account, 'work2');

  await c.call('fleet.set', { orchestratorId: boss.id, plan: 'add rate limiting to every endpoint' });
  const f2 = await c.call('fleet.get', { orchestratorId: boss.id });
  assert.match(f2.plan, /rate limiting/);

  // mergeVerify is wired through the daemon → runtime → graph/cross-worktree module (no worktrees here → empty, no throw).
  const v = await c.call('worktree.mergeVerify', { paneIds: [w1.id, w2.id] });
  assert.ok(Array.isArray(v.pairs) && Array.isArray(v.order), 'mergeVerify returns a report shape');

  for (const p of [w1, w2, boss]) await c.call('pane.kill', { paneId: p.id });
  c.close();
});
