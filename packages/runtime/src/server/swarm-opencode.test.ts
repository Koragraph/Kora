import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SwarmWorkerMeta } from '../protocol/types';
import { packetReadHints, swarmPaneEnv, swarmPermissionEnv, writeOpencodePlugin } from './swarm-opencode';

const meta = (over: Partial<SwarmWorkerMeta> = {}): SwarmWorkerMeta => ({
  taskId: 's3', provider: 'zen', model: 'opencode/big-pickle', modelLabel: 'big-pickle', phase: 'starting', attempt: 1,
  attempts: [], reportPath: '/tmp/wt/.kora/swarm/s3.md', report: null, supersededBy: null, previousPaneIds: [], verify: null, ...over,
});
const koraHome = () => process.env.KORA_HOME || path.join(os.homedir(), '.kora');

test('swarmPaneEnv: KORA_* swarm keys, OPENCODE_* config, share disabled, no autoupdate', () => {
  const env = swarmPaneEnv(meta(), { apiKey: null, runtimeMode: 'full-access' });
  assert.equal(env.KORA_REPORT, '/tmp/wt/.kora/swarm/s3.md');
  assert.equal(env.KORA_SWARM_TASK_ID, 's3');
  assert.equal(env.KORA_SWARM_MODEL, 'opencode/big-pickle');
  assert.equal(env.KORA_SWARM_PROVIDER, 'zen');
  assert.equal(env.KORA_NODE, process.execPath);
  assert.equal(env.OPENCODE_CONFIG_DIR, path.join(koraHome(), 'opencode'));
  assert.equal(env.OPENCODE_DISABLE_AUTOUPDATE, '1');
  const content = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  assert.equal(content.share, 'disabled');
  assert.equal(content.autoupdate, false);
  assert.ok(env.OPENCODE_PERMISSION);
  assert.equal(env.OPENCODE_API_KEY, undefined, 'Zen without a key: no key var at all');
  for (const v of Object.values(env)) assert.equal(typeof v, 'string');
});

test('swarmPaneEnv: only the worker\'s own provider key; the config references the env var, never the literal key', () => {
  const env = swarmPaneEnv(meta({ provider: 'openrouter', model: 'openrouter/qwen/qwen3-coder:free' }), { apiKey: 'sk-or-secret' });
  assert.equal(env.OPENROUTER_API_KEY, 'sk-or-secret');
  assert.equal(env.CEREBRAS_API_KEY, undefined);
  assert.equal(env.OPENCODE_API_KEY, undefined);
  assert.ok(!env.OPENCODE_CONFIG_CONTENT.includes('sk-or-secret'));
  assert.equal(JSON.parse(env.OPENCODE_CONFIG_CONTENT).provider.openrouter.options.apiKey, '{env:OPENROUTER_API_KEY}');
  const c = swarmPaneEnv(meta({ provider: 'cerebras', model: 'cerebras/gpt-oss-120b' }), { apiKey: 'csk-1' });
  assert.equal(c.CEREBRAS_API_KEY, 'csk-1');
  assert.equal(c.OPENROUTER_API_KEY, undefined);
  const z = swarmPaneEnv(meta(), { apiKey: 'zen-key' });
  assert.equal(z.OPENCODE_API_KEY, 'zen-key');
});

test('swarmPermissionEnv: full access allows all; edit postures allow edits, ask for shell; questions always denied', () => {
  for (const mode of ['full-access', 'auto'] as const) {
    const p = JSON.parse(swarmPermissionEnv(mode, { reportPath: '/r/x/s1.md' }).OPENCODE_PERMISSION);
    assert.equal(p['*'], 'allow');
    assert.equal(p.question, 'deny');
    assert.deepEqual(Object.keys(p)[0], '*', 'catch-all first (later keys win in opencode)');
    assert.equal(p.bash['*'], 'allow');
    assert.equal(p.bash['open *'], 'deny', 'a worker never opens apps/URLs on the user\'s desktop');
    assert.equal(p.bash['osascript *'], 'deny');
    assert.equal(Object.keys(p.bash)[0], '*', 'bash catch-all first so the denies win');
  }
  for (const mode of ['approval-required', 'auto-accept-edits', undefined] as const) {
    const p = JSON.parse(swarmPermissionEnv(mode, { reportPath: '/r/x/s1.md' }).OPENCODE_PERMISSION);
    assert.equal(p.edit, 'allow');
    assert.equal(p.bash['*'], 'ask');
    assert.equal(p.bash['open *'], 'deny');
    assert.equal(p.question, 'deny');
    assert.equal(p['*'], undefined);
    assert.deepEqual(p.external_directory, { '*': 'deny', '/r/x/**': 'allow' }, 'the report directory is always writable; anything else outside is denied, not asked');
    // read-only shell lookups never block an unattended worker; running code still asks
    for (const c of ['ls *', 'cat *', 'node --version', 'git status *']) assert.equal(p.bash[c], 'allow', c);
    assert.equal(p.bash['rm *'], undefined);
    assert.equal(p.bash['open *'], 'deny', 'the desktop deny still wins');
  }
});

test('writeOpencodePlugin: one function export; inert outside a pane; forwards root-session events to kora hook opencode-event', async () => {
  const file = writeOpencodePlugin();
  assert.equal(file, path.join(koraHome(), 'opencode', 'plugins', 'kora-state.js'));
  assert.equal(writeOpencodePlugin(), file, 'idempotent');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-plugin-'));
  const mjs = path.join(dir, 'kora-state.mjs');
  fs.copyFileSync(file, mjs);
  const dynImport = new Function('u', 'return import(u)') as (u: string) => Promise<Record<string, unknown>>;
  const mod = await dynImport(pathToFileURL(mjs).href);
  const exports = Object.values(mod);
  assert.ok(exports.length >= 1 && exports.every((v) => typeof v === 'function'), 'opencode rejects non-function exports');
  const KoraState = mod.KoraState as () => Promise<{ event?: (i: { event: unknown }) => Promise<void> }>;

  const saved = { KORA_NODE: process.env.KORA_NODE, KORA_BIN: process.env.KORA_BIN, KORA_PANE_ID: process.env.KORA_PANE_ID };
  try {
    delete process.env.KORA_PANE_ID;
    assert.deepEqual(await KoraState(), {}, 'no pane → no hooks');

    // A fake `kora` that records its argv, one JSON line per call.
    const log = path.join(dir, 'calls.jsonl');
    const bin = path.join(dir, 'fake-kora.js');
    fs.writeFileSync(bin, `require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
    process.env.KORA_NODE = process.execPath; process.env.KORA_BIN = bin; process.env.KORA_PANE_ID = 'p9';
    const hooks = await KoraState();
    const ev = (type: string, properties: unknown) => hooks.event!({ event: { type, properties } });
    await ev('session.status', { sessionID: 'root', status: { type: 'busy' } });
    await ev('session.status', { sessionID: 'root', status: { type: 'busy' } });            // duplicate: dropped
    await ev('session.status', { sessionID: 'child', status: { type: 'idle' } });           // a subagent: ignored
    await ev('message.updated', { sessionID: 'root' });                                     // not a state event
    await ev('session.status', { sessionID: 'root', status: { type: 'retry', attempt: 2, message: 'Rate limit exceeded', next: 123 } });
    await ev('session.idle', { sessionID: 'root' });
    const deadline = Date.now() + 5000;
    let calls: string[][] = [];
    while (Date.now() < deadline) {
      try { calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { calls = []; }
      if (calls.length >= 3) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 200));
    calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(calls.length, 3, JSON.stringify(calls));
    for (const c of calls) { assert.deepEqual(c.slice(0, 3), ['hook', 'opencode-event', '--stdin-json']); }
    const payloads = calls.map((c) => JSON.parse(c[3]));
    const types = payloads.map((p) => `${p.type}:${p.status ?? ''}`).sort();
    assert.deepEqual(types, ['session.idle:', 'session.status:busy', 'session.status:retry']);
    const retry = payloads.find((p) => p.status === 'retry');
    assert.equal(retry.attempt, 2); assert.equal(retry.next, 123); assert.match(retry.message, /Rate limit/);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('swarmPaneEnv: a local worker gets an OpenAI-compatible provider block at <baseUrl>/v1, and no key', () => {
  const meta = { taskId: 's1', provider: 'ollama', model: 'ollama/qwen3-coder:30b', modelLabel: 'qwen3-coder:30b', phase: 'starting', attempt: 1, attempts: [], reportPath: '/wt/.kora/swarm/s1.md', report: null, supersededBy: null, previousPaneIds: [], verify: null } as SwarmWorkerMeta;
  const env = swarmPaneEnv(meta, { apiKey: null });
  const cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(cfg.provider, { ollama: { npm: '@ai-sdk/openai-compatible', name: 'Ollama (local)', options: { baseURL: 'http://127.0.0.1:11434/v1' }, models: { 'qwen3-coder:30b': { name: 'qwen3-coder:30b', tool_call: true } } } });
  assert.equal(env.KORA_SWARM_PROVIDER, 'ollama');
  assert.ok(!Object.keys(env).some((k) => /API_KEY/.test(k)));
});

// ---- token levers in the plugin (B10) --------------------------------------------------------------------------
async function loadPlugin(env: Record<string, string>, directory: string) {
  const file = writeOpencodePlugin();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-plugin-b10-'));
  const mjs = path.join(dir, 'kora-state.mjs');
  fs.copyFileSync(file, mjs);
  const dynImport = new Function('u', 'return import(u)') as (u: string) => Promise<Record<string, unknown>>;
  const mod = await dynImport(pathToFileURL(mjs).href);
  const saved: Record<string, string | undefined> = {};
  const all = { KORA_NODE: process.execPath, KORA_BIN: '/nonexistent/kora.js', KORA_PANE_ID: 'p1', ...env };
  for (const [k, v] of Object.entries(all)) { saved[k] = process.env[k]; process.env[k] = v; }
  const hooks = await (mod.KoraState as (c: unknown) => Promise<any>)({ directory });
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return hooks;
}
function bigFile(dir: string, name: string, lines: number): string {
  const body: string[] = [];
  for (let i = 1; i <= lines; i++) body.push(i % 40 === 1 ? `export function fn${i}() {` : `  const x${i} = ${i};`);
  const f = path.join(dir, name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body.join('\n') + '\n');
  return f;
}

test('plugin: bounded read (on) windows a big code file, appends the outline, the second read passes whole', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-b10-'));
  const log = path.join(dir, 'bound.jsonl');
  bigFile(dir, 'src/big.ts', 900);
  const hooks = await loadPlugin({ KORA_SWARM_BOUND_READ: 'on', KORA_SWARM_BOUND_LOG: log, KORA_SWARM_READ_HINTS: JSON.stringify({ 'src/big.ts': [441] }) }, dir);
  const out1: any = { args: { filePath: path.join(dir, "src/big.ts") } };
  await hooks['tool.execute.before']({ tool: 'read', sessionID: 's', callID: 'c1' }, out1);
  assert.ok(out1.args.limit >= 100 && out1.args.limit <= 250, JSON.stringify(out1.args));
  assert.ok(out1.args.offset <= 441 && out1.args.offset + out1.args.limit > 441, 'the window contains the hinted declaration');
  const res = { title: 't', output: 'content', metadata: {} };
  await hooks['tool.execute.after']({ tool: 'read', sessionID: 's', callID: 'c1', args: out1.args }, res);
  assert.match(res.output, /bounded to lines \d+-\d+ of 900 in src\/big\.ts/);
  assert.match(res.output, /Outline \(name:line\): .*fn441:441/);
  const out2 = { args: { filePath: path.join(dir, 'src/big.ts') } };
  await hooks['tool.execute.before']({ tool: 'read', sessionID: 's', callID: 'c2' }, out2);
  assert.deepEqual(out2.args, { filePath: path.join(dir, 'src/big.ts') }, 'second read of the same file is untouched');
  const res2 = { title: 't', output: 'whole', metadata: {} };
  await hooks['tool.execute.after']({ tool: 'read', sessionID: 's', callID: 'c2', args: out2.args }, res2);
  assert.equal(res2.output, 'whole');
  const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].total, 900);
});

test('plugin: bounded read passes small files, ranged reads, non-code, outside-worktree and an Edit-seen file; shadow only logs; off does nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-b10-'));
  bigFile(dir, 'small.ts', 280); bigFile(dir, 'big.ts', 700); bigFile(dir, 'big.md', 700); bigFile(dir, 'edited.ts', 700);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-b10-out-')); bigFile(outside, 'o.ts', 700);
  const run = async (hooks: any, args: any, tool = 'read') => { const o = { args: { ...args } }; await hooks['tool.execute.before']({ tool, sessionID: 's', callID: 'c' + Math.random() }, o); return o.args; };
  const on = await loadPlugin({ KORA_SWARM_BOUND_READ: 'on' }, dir);
  for (const f of [path.join(dir, 'small.ts'), path.join(dir, 'big.md'), path.join(outside, 'o.ts'), path.join(dir, 'nope.ts')]) {
    assert.deepEqual(await run(on, { filePath: f }), { filePath: f }, f);
  }
  const ranged = { filePath: path.join(dir, 'big.ts'), offset: 5, limit: 20 };
  assert.deepEqual(await run(on, ranged), ranged);
  await run(on, { filePath: path.join(dir, 'edited.ts') }, 'edit');
  assert.deepEqual(await run(on, { filePath: path.join(dir, 'edited.ts') }), { filePath: path.join(dir, 'edited.ts') }, 'a file already edited is read whole');
  const shadowLog = path.join(dir, 'shadow.jsonl');
  const shadow = await loadPlugin({ KORA_SWARM_BOUND_READ: 'shadow', KORA_SWARM_BOUND_LOG: shadowLog }, dir);
  assert.deepEqual(await run(shadow, { filePath: path.join(dir, 'big.ts') }), { filePath: path.join(dir, 'big.ts') }, 'shadow changes nothing');
  assert.equal(fs.readFileSync(shadowLog, 'utf8').trim().split('\n').length, 1, 'but logs what it would have done');
  const off = await loadPlugin({ KORA_SWARM_BOUND_READ: 'off' }, dir);
  assert.deepEqual(await run(off, { filePath: path.join(dir, 'big.ts') }), { filePath: path.join(dir, 'big.ts') });
});

test('plugin: token ceiling (summed from message.updated, latest per message) blocks exploration tools only', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-b10-'));
  const hooks = await loadPlugin({ KORA_SWARM_BOUND_READ: 'off', KORA_SWARM_TOKEN_CEILING: '1000' }, dir);
  const msg = (id: string, input: number, output: number, cacheRead = 0) => hooks.event({ event: { type: 'message.updated', properties: { info: { id, role: 'assistant', sessionID: 'root', tokens: { input, output, reasoning: 0, cache: { read: cacheRead, write: 0 } } } } } });
  await msg('m1', 300, 100, 50_000);          // cache reads are not counted
  await msg('m1', 400, 100, 50_000);          // the same message again: replaces, not adds
  await hooks['tool.execute.before']({ tool: 'read', sessionID: 's', callID: 'a' }, { args: { filePath: 'x.ts' } });
  await msg('m2', 400, 200);                  // 500 + 600 = 1100 > 1000
  await assert.rejects(hooks['tool.execute.before']({ tool: 'grep', sessionID: 's', callID: 'b' }, { args: {} }), /token budget/);
  await assert.rejects(hooks['tool.execute.before']({ tool: 'read', sessionID: 's', callID: 'c' }, { args: { filePath: 'x.ts' } }), /report/);
  // inside the grace margin (20% of 1000): the edit in hand and a verify run still go through
  for (const tool of ['edit', 'write', 'bash']) await hooks['tool.execute.before']({ tool, sessionID: 's', callID: 'd' }, { args: { filePath: 'x.ts' } });
});

test('plugin: well past the ceiling (grace spent) bash, edit and write stop too, except the report file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-b10g-'));
  const report = path.join(dir, 'report.md');
  const mk = () => loadPlugin({ KORA_SWARM_BOUND_READ: 'off', KORA_SWARM_TOKEN_CEILING: '1000', KORA_REPORT: report }, dir);
  const msg = (h: any, id: string, input: number, output: number) => h.event({ event: { type: 'message.updated', properties: { info: { id, role: 'assistant', sessionID: 'root', tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } } } } } });
  const hooks = await mk();
  await msg(hooks, 'm1', 600, 700); // 1300 > 1000 + 200 grace
  for (const tool of ['bash', 'edit', 'write', 'patch']) {
    await assert.rejects(hooks['tool.execute.before']({ tool, sessionID: 's', callID: tool }, { args: { filePath: 'x.ts', command: 'npm test' } }), /STOP[\s\S]*report/);
  }
  // the report file may still be written; another file or any bash may not
  await hooks['tool.execute.before']({ tool: 'write', sessionID: 's', callID: 'r1' }, { args: { filePath: report } });
  await hooks['tool.execute.before']({ tool: 'edit', sessionID: 's', callID: 'r2' }, { args: { filePath: 'report.md' } });
  await assert.rejects(hooks['tool.execute.before']({ tool: 'write', sessionID: 's', callID: 'r3' }, { args: { filePath: path.join(dir, 'other.md') } }), /STOP/);
  await assert.rejects(hooks['tool.execute.before']({ tool: 'bash', sessionID: 's', callID: 'r4' }, { args: { command: 'echo hi > ' + report } }), /STOP/);
  // inside the margin (1100 <= 1200) nothing is stopped
  const inside = await mk();
  await msg(inside, 'm1', 600, 500);
  await inside['tool.execute.before']({ tool: 'bash', sessionID: 's', callID: 'g' }, { args: { command: 'npm test' } });
});

test('swarmPaneEnv: small_model pinned to the worker model, savings env (mode, ceiling, hints, log)', () => {
  const env = swarmPaneEnv(meta(), { apiKey: null, readHints: { 'src/a.ts': [10, 99] } });
  assert.equal(JSON.parse(env.OPENCODE_CONFIG_CONTENT).small_model, 'opencode/big-pickle');
  assert.ok(['off', 'shadow', 'on'].includes(env.KORA_SWARM_BOUND_READ));
  assert.ok(Number(env.KORA_SWARM_TOKEN_CEILING) > 0);
  assert.deepEqual(JSON.parse(env.KORA_SWARM_READ_HINTS), { 'src/a.ts': [10, 99] });
  assert.match(env.KORA_SWARM_BOUND_LOG, /swarm[\\/]bounded-reads\.jsonl$/);
});

test('packetReadHints: declaration lines from a graph context packet', () => {
  const h = packetReadHints('## Context (from Kora graph)\n■ FUNCTION foo @ src/a.ts:42 — foo()\n  METHOD bar @ ./src/b.ts:7\n■ CLASS Foo @ src/a.ts:300');
  assert.deepEqual(h, { 'src/a.ts': [42, 300], 'src/b.ts': [7] });
  assert.deepEqual(packetReadHints(''), {});
});
