// CP2 live checks for the OpenCode swarm worker — SKIPPED unless KORA_SWARM_LIVE=1 (needs an installed opencode and the
// network). Each test confirms one assumption in docs/swarm/S3-LIVE-CHECKLIST.md that was read from source.
//
//   KORA_SWARM_LIVE=1 [KORA_OPENCODE_BIN=/abs/opencode] [KORA_SWARM_CAPTURE=1] \
//     node --require ./scripts/test-isolate.cjs --test --test-force-exit dist/server/swarm-live.test.js
//
// KORA_SWARM_CAPTURE=1 also writes the screens it sees to manifests/fixtures/opencode/live-<state>.txt (header
// "captured live v<version>") so the synthesized fixtures can be replaced. Everything runs in throwaway git repos
// under the test's temp HOME; the user's ~/.config/opencode is untouched (though opencode still READS it — see C9).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { SwarmWorkerMeta } from '../protocol/types';
import { Pane } from './pane';
import { detect } from '../detect';
import { manifestsDir } from '../detect/manifest';
import { opencodeAdapter } from '../detect/agent-adapter';
import { swarmPaneEnv, writeOpencodePlugin } from './swarm-opencode';
import { swarmWorkerPreamble } from './swarm-skill';

const LIVE = process.env.KORA_SWARM_LIVE === '1';
const MODEL = process.env.KORA_SWARM_LIVE_MODEL || 'opencode/big-pickle';
const realHome = process.env.KORA_TEST_REAL_HOME || os.homedir();
function opencodeBin(): string {
  const cands = [process.env.KORA_OPENCODE_BIN, path.join(realHome, '.kora', 'tools', 'opencode', 'current', 'opencode')].filter(Boolean) as string[];
  const hit = cands.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } });
  if (!hit) throw new Error(`opencode not found (tried ${cands.join(', ')}); set KORA_OPENCODE_BIN`);
  return hit;
}
const opts = { skip: !LIVE && 'set KORA_SWARM_LIVE=1 (needs opencode + network)', timeout: 240_000 };

function scratchRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-oc-live-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  fs.writeFileSync(path.join(dir, 'README.md'), '# scratch\n');
  git('add', '.'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return dir;
}
/** A fake `kora` for the plugin to call: records argv, one JSON line per call. */
function recorder(dir: string): { bin: string; calls: () => string[][] } {
  const log = path.join(dir, 'kora-calls.jsonl');
  const bin = path.join(dir, 'fake-kora.js');
  fs.writeFileSync(bin, `require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
  return { bin, calls: () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } } };
}
function meta(reportPath: string): SwarmWorkerMeta {
  return { taskId: 's1', provider: 'zen', model: MODEL, modelLabel: MODEL.split('/').pop()!, phase: 'starting', attempt: 1, attempts: [], reportPath, report: null, supersededBy: null, previousPaneIds: [], verify: null };
}
function launch(cwd: string, args: string[], env: Record<string, string>): Pane {
  const pane = new Pane({ id: 'live1', workspaceId: 'w', name: 'oc', command: opencodeBin(), args, cwd, agent: 'opencode', env: { ...process.env as Record<string, string>, TERM: 'xterm-256color', ...env }, cols: 140, rows: 40 });
  pane.spawn();
  return pane;
}
const version = () => { try { return execFileSync(opencodeBin(), ['--version'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } };
function capture(name: string, screen: string): void {
  if (process.env.KORA_SWARM_CAPTURE !== '1') return;
  const file = path.join(manifestsDir(), 'fixtures', 'opencode', `live-${name}.txt`);
  fs.writeFileSync(file, `# captured live v${version()} (swarm-live.test.ts)\n# expect: ${name}\n---8<---\n${screen}\n`);
}
async function until<T>(what: string, ms: number, fn: () => T | null | undefined | false): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 250)); }
}
const screenOf = (p: Pane) => p.detectionSnapshot().screen;

test('C1 Zen works with no key: `opencode models opencode` lists cost-0 models', opts, () => {
  const out = execFileSync(opencodeBin(), ['models', 'opencode'], { encoding: 'utf8', env: { ...process.env, OPENCODE_API_KEY: '' } });
  assert.match(out, /opencode\/big-pickle/);
});

test('C2–C6 --auto + --prompt auto-submit + plugin discovery + share disabled + report at $KORA_REPORT', opts, async () => {
  const repo = scratchRepo();
  const reportPath = path.join(repo, '.kora', 'swarm', 's1.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  writeOpencodePlugin();
  const rec = recorder(repo);
  const env = { ...swarmPaneEnv(meta(reportPath), { apiKey: null, runtimeMode: 'full-access' }), KORA_PANE_ID: 'live1', KORA_BIN: rec.bin };
  const task = 'Create hello.txt containing exactly the word PONG. Check: `cat hello.txt` prints PONG.';
  const prompt = `${swarmWorkerPreamble({ reportPath, taskId: 's1' })}\n${task}`;
  const pane = launch(repo, [...opencodeAdapter.modelArgs(MODEL), ...opencodeAdapter.skipPermissionArgs(), '--prompt', prompt], env);
  const seen = new Set<string>();
  const t = setInterval(() => {
    const d = detect(pane.detectionSnapshot(), 'opencode');
    if (d.matched && !seen.has(d.state)) { seen.add(d.state); capture(d.state === 'working' ? `working-${d.ruleId}` : d.state, screenOf(pane)); }
  }, 300);
  try {
    // C4: --prompt submits by itself (no keystrokes from us) and the worker writes $KORA_REPORT.
    await until('report written to $KORA_REPORT', 180_000, () => fs.existsSync(reportPath) && fs.readFileSync(reportPath, 'utf8').trim().length > 0);
    assert.equal(fs.readFileSync(path.join(repo, 'hello.txt'), 'utf8').trim(), 'PONG');
    const report = fs.readFileSync(reportPath, 'utf8');
    assert.match(report, /Status/i, 'report follows the preamble format');
    try { await until('idle after the report', 60_000, () => detect(pane.detectionSnapshot(), 'opencode').state === 'idle'); } catch (e) {
      capture('idle-miss', screenOf(pane));
      throw new Error(`${(e as Error).message}; detect=${JSON.stringify(detect(pane.detectionSnapshot(), 'opencode'))}\n${screenOf(pane).split('\n').slice(-12).join('\n')}`);
    }
    // C2: --auto accepted (the TUI started and never showed a permission dialog under full access).
    assert.ok(!seen.has('blocked'), 'no dialog under --auto + OPENCODE_PERMISSION *:allow');
    assert.ok(seen.has('working'), 'the esc-interrupt footer was seen while busy');
    // C5: plugin discovered from OPENCODE_CONFIG_DIR/plugins and calling `kora hook opencode-event`.
    const calls = await until('plugin calls', 10_000, () => { const c = rec.calls(); return c.some((x) => x[1] === 'opencode-event' && /session\.idle|"status":"idle"/.test(x[3] ?? '')) && c; });
    const payloads = calls.filter((c) => c[1] === 'opencode-event').map((c) => JSON.parse(c[3]));
    assert.ok(payloads.some((p) => p.type === 'session.status' && p.status === 'busy'), JSON.stringify(payloads));
    // C6: share disabled — no share link on screen.
    assert.doesNotMatch(screenOf(pane), /opncd\.ai\/s\/|opencode\.ai\/s\//);
  } finally { clearInterval(t); pane.dispose(); }
});

test('C7 permission dialog: "Allow once" is the default selection (Enter allows) and autoAnswer handles an edit', opts, async () => {
  const repo = scratchRepo();
  const reportPath = path.join(repo, '.kora', 'swarm', 's2.md');
  const env = {
    ...swarmPaneEnv(meta(reportPath), { apiKey: null, runtimeMode: 'approval-required' }),
    OPENCODE_PERMISSION: JSON.stringify({ edit: 'ask', bash: 'ask', question: 'deny' }), // force the edit dialog
    KORA_PANE_ID: 'live2', KORA_BIN: recorder(repo).bin,
  };
  const pane = launch(repo, [...opencodeAdapter.modelArgs(MODEL), '--prompt', 'Create a file named edit-me.txt containing OK. Do nothing else.'], env);
  try {
    const screen = await until('permission dialog', 150_000, () => { const s = screenOf(pane); return detect({ screen: s, oscTitle: '', oscProgress: '' }, 'opencode').ruleId === 'permission_required' && s; });
    capture('permission', screen);
    const plan = opencodeAdapter.autoAnswer({ screen, cwd: repo, mainRoot: repo, trustedRoots: [], allowEdits: true, policy: { trustFolder: false, mcpFound: false, readOutsideWorktree: false } });
    assert.ok(plan, `autoAnswer should accept an edit dialog:\n${screen}`);
    for (const k of plan!.keys) pane.write(k);
    await until('edit applied after Enter', 60_000, () => fs.existsSync(path.join(repo, 'edit-me.txt')));
  } finally { pane.dispose(); }
});

test('C8 a worktree opencode.json (kora MCP entry, like enforcer.prepare writes) does not break the swarm env', opts, async () => {
  const repo = scratchRepo();
  fs.writeFileSync(path.join(repo, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { kora: { type: 'local', command: [process.execPath, '-e', 'setInterval(()=>{},1e6)'], enabled: true } } }, null, 2));
  const reportPath = path.join(repo, '.kora', 'swarm', 's3.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const env = { ...swarmPaneEnv(meta(reportPath), { apiKey: null, runtimeMode: 'full-access' }), KORA_PANE_ID: 'live3', KORA_BIN: recorder(repo).bin };
  const prompt = `${swarmWorkerPreamble({ reportPath, taskId: 's3' })}\nReport the first line of README.md.`;
  const pane = launch(repo, [...opencodeAdapter.modelArgs(MODEL), '--auto', '--prompt', prompt], env);
  try {
    await until('report written with a project opencode.json present', 180_000, () => fs.existsSync(reportPath));
    assert.match(fs.readFileSync(reportPath, 'utf8'), /scratch/);
  } finally { pane.dispose(); }
});

// C10 (kora_wait returns the report) needs S2's SwarmService + fleet tools; it lives with S2's CP1/CP2 e2e. Recipe in
// docs/swarm/S3-LIVE-CHECKLIST.md.
test('C10 kora_wait returns $KORA_REPORT (after S2 lands)', { skip: 'needs S2 SwarmService.spawn / kora_wait; see S3-LIVE-CHECKLIST.md C10' }, () => {});
