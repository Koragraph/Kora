import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, markerBase, graphReady, isIdentifierPattern, SWITCH_OVER } from './hook';
import { setDenyGraphForTests } from '../../enforce/deny-answer';

function io() { let out = ''; let err = ''; return { out: (s: string) => { out += s; }, err: (s: string) => { err += s; }, get stdout() { return out; }, get stderr() { return err; } }; }
process.env.KORA_ASSUME_GRAPH = '1'; // the deny tests describe an INDEXED repo; the temp repos below have no store row
function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-hook-'));
  fs.mkdirSync(path.join(dir, '.git')); // enough for repo-identity; no graph, no practice store needed
  return dir;
}
async function pre(sessionId: string, cwd: string, tool: string, tool_input: unknown) {
  const o = io();
  const code = await run(['pre-tool', '--stdin-json', JSON.stringify({ session_id: sessionId, cwd, tool_name: tool, tool_input })], o);
  assert.equal(code, 0, 'hooks always exit 0');
  return o.stdout ? JSON.parse(o.stdout).hookSpecificOutput : null;
}
function sweep(sessionId: string) {
  const base = markerBase({ session_id: sessionId });
  for (const suffix of ['-graphused', '-soft', '-redirects', '-laws', '-turn', '-injected-turn', '-graph-state']) fs.rmSync(base + suffix, { force: true });
}

test('isIdentifierPattern: one code identifier (optionally \\b-wrapped / decl-prefixed) yes; text, regex, kebab, plain words no', () => {
  for (const p of ['createWorktree', '\\bcreateWorktree\\b', 'parse_transcript', 'config.grepCap', 'config\\.grepCap', 'function\\s+createWorktree', 'def parse_transcript', 'class MergeResult', 'MergeResult', 'FOO_BAR']) assert.equal(isIdentifierPattern(p), true, p);
  for (const p of ['foo bar', 'error: failed', 'my-config-key', 'database', 'TODO', '\\.ts$', 'src/server', 'foo|bar', '[Cc]reate', 'x', 'abc', '"quoted"', '', undefined, 42, 'foo_', '.bar']) assert.equal(isIdentifierPattern(p as any), false, String(p));
});

test('pre-tool: a cold Grep for a code identifier is denied once, then relents once, then silent; Glob is never denied', async () => {
  const sid = `t-${process.pid}-${Date.now()}`; const cwd = repo(); sweep(sid);
  delete process.env.KORAGRAPH_NUDGE_MAX_REDIRECTS;
  const g0 = await pre(sid, cwd, 'Glob', { pattern: '**/*.ts' });
  assert.equal(g0, null, 'Glob passes even cold');
  const d1 = await pre(sid, cwd, 'Grep', { pattern: 'createWorktree' });
  assert.equal(d1.permissionDecision, 'deny');
  assert.match(d1.permissionDecisionReason, /kora graph explore/);
  assert.match(d1.permissionDecisionReason, /denied once/);
  const d2 = await pre(sid, cwd, 'Grep', { pattern: '\\bparse_transcript\\b' });
  assert.equal(d2.permissionDecision, undefined, 'relented after one deny');
  assert.match(d2.additionalContext, /now allowed as a fallback/);
  const d3 = await pre(sid, cwd, 'Grep', { pattern: 'createWorktree' });
  assert.equal(d3, null, 'silent after the relent notice');
  assert.equal(await pre(sid, cwd, 'Glob', { pattern: 'src/**' }), null);
  sweep(sid); fs.rmSync(cwd, { recursive: true, force: true });
});

test('pre-tool: a text-shaped Grep pattern passes untouched and does not spend the redirect', async () => {
  const sid = `t-${process.pid}-${Date.now()}-s`; const cwd = repo(); sweep(sid);
  delete process.env.KORAGRAPH_NUDGE_MAX_REDIRECTS;
  for (const pattern of ['foo bar', 'error: failed', 'my-config-key', 'database', '\\.ts$', 'src/server', 'foo|bar']) {
    assert.equal(await pre(sid, cwd, 'Grep', { pattern }), null, `"${pattern}" is a text search: no deny, no nudge`);
  }
  const d = await pre(sid, cwd, 'Grep', { pattern: 'createWorktree' });
  assert.equal(d.permissionDecision, 'deny', 'the identifier redirect is still unspent');
  sweep(sid); fs.rmSync(cwd, { recursive: true, force: true });
});

test('pre-tool: a Grep in the turn whose prompt got graph declarations injected is allowed; the next turn is cold again', async () => {
  const sid = `t-${process.pid}-${Date.now()}-i`; const cwd = repo(); sweep(sid);
  delete process.env.KORAGRAPH_NUDGE_MAX_REDIRECTS;
  const base = markerBase({ session_id: sid });
  fs.writeFileSync(`${base}-turn`, '3'); fs.writeFileSync(`${base}-injected-turn`, '3'); // what prompt() writes when injectForPrompt fires
  assert.equal(await pre(sid, cwd, 'Grep', { pattern: 'createWorktree' }), null, 'graph context already in the prompt');
  fs.writeFileSync(`${base}-turn`, '4');
  const d = await pre(sid, cwd, 'Grep', { pattern: 'createWorktree' });
  assert.equal(d.permissionDecision, 'deny', 'a later turn without an injection is cold');
  sweep(sid); fs.rmSync(cwd, { recursive: true, force: true });
});

test('pre-tool: a cold Bash rg/grep for a code identifier is redirected like a Grep (one budget for both); text and file searches pass', async () => {
  const sid = `t-${process.pid}-${Date.now()}-r`; const cwd = repo(); sweep(sid);
  delete process.env.KORAGRAPH_NUDGE_MAX_REDIRECTS;
  fs.mkdirSync(path.join(cwd, 'src')); fs.writeFileSync(path.join(cwd, 'src', 'a.ts'), 'x\n');
  for (const command of ['rg -n "retry|backoff" src', 'rg -n createWorktree src/a.ts', 'rg -n createWorktree src; sed -n 1,5p src/a.ts']) {
    const r = await pre(sid, cwd, 'Bash', { command });
    assert.equal(r?.permissionDecision, undefined, `${command}: not one identifier search over the tree`);
  }
  const d = await pre(sid, cwd, 'Bash', { command: 'cd src && rg -n createWorktree . | head' });
  assert.equal(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /kora graph explore/);
  const g = await pre(sid, cwd, 'Grep', { pattern: 'createWorktree' });
  assert.equal(g?.permissionDecision, undefined, 'the Bash deny spent the one redirect');
  sweep(sid); fs.rmSync(cwd, { recursive: true, force: true });
});

test('pre-tool: a `kora graph` Bash call or an mcp__kora__ tool marks the graph used → Grep passes', async () => {
  const sid = `t-${process.pid}-${Date.now()}-b`; const cwd = repo(); sweep(sid);
  assert.equal(await pre(sid, cwd, 'Bash', { command: 'kora graph explore "hello"' }), null);
  assert.equal(await pre(sid, cwd, 'Grep', { pattern: 'hello' }), null, 'no deny once the graph was consulted');
  const sid2 = `${sid}-mcp`; sweep(sid2);
  assert.equal(await pre(sid2, cwd, 'mcp__kora__explore', { query: 'hello' }), null);
  assert.equal(await pre(sid2, cwd, 'Glob', { pattern: '*' }), null);
  sweep(sid); sweep(sid2); fs.rmSync(cwd, { recursive: true, force: true });
});

test('pre-tool: Bash grep and Read of source are nudged once, never blocked', async () => {
  const sid = `t-${process.pid}-${Date.now()}-c`; const cwd = repo(); sweep(sid);
  const n1 = await pre(sid, cwd, 'Bash', { command: 'grep -rn foo src' });
  assert.equal(n1.permissionDecision, undefined);
  assert.match(n1.additionalContext, /kora graph explore/);
  const n2 = await pre(sid, cwd, 'Read', { file_path: '/x/y.ts' });
  assert.equal(n2, null, 'nudge shown once per agent');
  sweep(sid); fs.rmSync(cwd, { recursive: true, force: true });
});

test('post-tool / stop / unknown event: exit 0 and nothing on stdout', async () => {
  const o = io();
  assert.equal(await run(['post-tool', '--stdin-json', JSON.stringify({ session_id: 'x', tool_name: 'Bash', tool_input: { command: 'kora graph overview' } })], o), 0);
  assert.equal(await run(['stop', '--stdin-json', '{"session_id":"x"}'], o), 0);
  assert.equal(await run(['nope', '--stdin-json', 'not json'], o), 0);
  assert.equal(o.stdout, '');
  sweep('x');
});

test('pre-tool: with NO graph for the repo, a cold identifier Grep is never denied (kora then stays out of the way)', async () => {
  const sid = `t-${process.pid}-${Date.now()}-noidx`; const cwd = repo(); sweep(sid);
  const prev = process.env.KORA_ASSUME_GRAPH; process.env.KORA_ASSUME_GRAPH = '0';
  try {
    assert.equal(graphReady(cwd), false);
    assert.equal(await pre(sid, cwd, 'Grep', { pattern: 'resolveProjectScope' }), null, 'no deny, no nudge');
  } finally { process.env.KORA_ASSUME_GRAPH = prev; }
  sweep(sid); fs.rmSync(cwd, { recursive: true, force: true });
});

// ---- the switch-over moment: a session briefed "not indexed yet" is told once when the index lands ----
const SWITCH_RE = /kora: the code graph for this repository is ready now \(\d+ nodes, \d+ edges\)/g;
async function hook(event: string, input: any) {
  const o = io();
  const code = await run([event, '--stdin-json', JSON.stringify(input)], o);
  assert.equal(code, 0, 'hooks always exit 0');
  assert.equal(o.stderr, '', 'nothing on stderr');
  return o.stdout ? JSON.parse(o.stdout) : null; // stdout carries only the hook JSON
}
function graphState(sid: string) { try { return fs.readFileSync(`${markerBase({ session_id: sid })}-graph-state`, 'utf8'); } catch { return null; } }
// An indexed checkout whose store row is really this checkout (status: indexed && !staleForCheckout): the repo named by
// KORA_TEST_INDEXED_REPO, then kora's own root. None indexed → the test skips (a user store is not a build prerequisite).
const INDEXED_CANDIDATES = [process.env.KORA_TEST_INDEXED_REPO, path.resolve(__dirname, '..', '..', '..')].filter((p): p is string => !!p);
const haveStore = fs.existsSync(process.env.KORAGRAPH_DB || `${process.env.HOME}/.koragraph/graph.db`);
async function pickIndexedRepo(): Promise<{ cwd: string; nodes: number; edges: number } | null> {
  if (!haveStore) return null;
  const { createGraphService } = require('../../graph/index'); const g = createGraphService();
  for (const cwd of INDEXED_CANDIDATES) {
    if (!fs.existsSync(cwd)) continue;
    try { const st = await g.status(cwd); if (st.indexed && !st.staleForCheckout && st.nodes > 0) return { cwd, nodes: st.nodes, edges: st.edges }; } catch { /* next */ }
  }
  return null;
}

test('session-start in an un-indexed repo records `unindexed` in the graph-state marker; the brief says grep/Read are right', async () => {
  const sid = `t-${process.pid}-${Date.now()}-gs`; const cwd = repo(); sweep(sid);
  const out = await hook('session-start', { session_id: sid, cwd, transcript_path: '/tmp/x.jsonl' });
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(out.hookSpecificOutput.additionalContext, /not indexed yet/);
  assert.equal(graphState(sid), 'unindexed');
  // /compact and /clear reset the per-session markers, then re-record the state
  fs.writeFileSync(`${markerBase({ session_id: sid })}-graph-state`, 'indexed');
  await hook('session-start', { session_id: sid, cwd, source: 'compact' });
  assert.equal(graphState(sid), 'unindexed', 'rewritten from the current status after /compact');
  await hook('session-end', { session_id: sid, hook_event_name: 'SessionEnd' });
  assert.equal(graphState(sid), null, 'swept with the other per-session markers at SessionEnd');
  sweep(sid); fs.rmSync(cwd, { recursive: true, force: true });
});

test('prompt: marker `unindexed` and still no graph → no switch-over text, marker untouched', async () => {
  const sid = `t-${process.pid}-${Date.now()}-gs0`; const cwd = repo(); sweep(sid);
  fs.writeFileSync(`${markerBase({ session_id: sid })}-graph-state`, 'unindexed');
  for (const p of ['hello there', 'how does createWorktree pick a branch name for the agent?']) {
    const out = await hook('prompt', { session_id: sid, cwd, prompt: p });
    const ctx = out?.hookSpecificOutput?.additionalContext || '';
    assert.ok(!SWITCH_RE.test(ctx), `no switch-over while the repo has no graph: ${ctx.slice(0, 120)}`); SWITCH_RE.lastIndex = 0;
    assert.ok(!/Graph, for this prompt/.test(ctx), 'and no injection either — kora stays out of the way here');
  }
  assert.equal(graphState(sid), 'unindexed');
  sweep(sid); fs.rmSync(cwd, { recursive: true, force: true });
});

test('prompt: marker `unindexed` and the graph now ready → the switch-over section exactly once across two prompts, marker → indexed', async (t) => {
  const idx = await pickIndexedRepo();
  if (!idx) { t.skip('no indexed checkout of its own in the user store'); return; }
  const sid = `t-${process.pid}-${Date.now()}-gs1`; sweep(sid);
  fs.writeFileSync(`${markerBase({ session_id: sid })}-graph-state`, 'unindexed');
  const o1 = await hook('prompt', { session_id: sid, cwd: idx.cwd, prompt: 'thanks, that is all for now' });
  const ctx1 = o1?.hookSpecificOutput?.additionalContext || '';
  assert.equal(o1?.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
  assert.equal((ctx1.match(SWITCH_RE) || []).length, 1, `switch-over announced once: ${ctx1.slice(0, 200)}`);
  assert.ok(ctx1.startsWith(SWITCH_OVER(idx.nodes, idx.edges).slice(0, 60)), 'it is the FIRST section, with the live node/edge counts');
  assert.match(ctx1, /kora graph explore "<symbol or phrase>"/); assert.match(ctx1, /neighbours X --direction in/); assert.match(ctx1, /search_code X/);
  assert.equal(graphState(sid), 'indexed');
  const o2 = await hook('prompt', { session_id: sid, cwd: idx.cwd, prompt: 'thanks, that is all for now' });
  const ctx2 = o2?.hookSpecificOutput?.additionalContext || '';
  assert.equal((ctx2.match(SWITCH_RE) || []).length, 0, 'never a second time in the same session');
  sweep(sid);
});

test('kora mcp --fleet: identity comes from argv first, env second', () => {
  const { fleetBridgeOptions } = require('./mcp');
  const o = fleetBridgeOptions(['--fleet', '--orchestrator', 'chat:t1', '--socket', '/tmp/s.sock', '--agent', 'codex', '--runtime-mode', 'full-access', '--model', 'm', '--effort', 'high'], { KORA_ORCHESTRATOR_ID: 'chat:env' });
  assert.equal(o.orchestratorId, 'chat:t1'); assert.equal(o.socketPath, '/tmp/s.sock'); assert.equal(o.agent, 'codex'); assert.equal(o.runtimeMode, 'full-access'); assert.equal(o.model, 'm'); assert.equal(o.effort, 'high'); assert.equal(o.account, undefined);
  assert.equal(fleetBridgeOptions(['--fleet'], { KORA_ORCHESTRATOR_ID: 'chat:env' }).orchestratorId, 'chat:env');
  assert.equal(fleetBridgeOptions(['--fleet', '--orchestrator', '--socket', '/x'], {}).orchestratorId, undefined);
  // The caller key never rides argv (ps shows it): only a key FILE path does; a raw key comes from env alone.
  assert.equal(fleetBridgeOptions(['--fleet', '--caller-key', 'k'], {}).callerKey, undefined);
  assert.equal(fleetBridgeOptions(['--fleet', '--caller-key-file', '/k/run/f'], {}).callerKeyFile, '/k/run/f');
  assert.equal(fleetBridgeOptions(['--fleet'], { KORA_CALLER_KEY: 'k' }).callerKey, 'k');
});

test('a session launched by the previous runtime (its env marker set, ours not) makes every kora hook stand down', async () => {
  const { foreignSession } = await import('./hook');
  const OLD_ENV = 'NH' + 'ANDS_ENV';
  assert.equal(foreignSession({ [OLD_ENV]: '1' }), true);
  assert.equal(foreignSession({ [OLD_ENV]: '1', KORA_ENV: '1' }), false, 'a kora session inherits the marker from its launcher: still ours');
  assert.equal(foreignSession({}), false);
});

test('pre-tool: a worker pane is denied a credential read (audit 2026-10-13 S2-1); the SDK chat lane is left to its own guard', async () => {
  const sid = `sens-${process.pid}-${Date.now()}`; const cwd = repo(); sweep(sid);
  const ssh = path.join(os.homedir(), '.ssh', 'id_fix1_canary');
  const d = await pre(sid, cwd, 'Read', { file_path: ssh });
  assert.equal(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /credentials stay off limits/);
  const b = await pre(sid, cwd, 'Bash', { command: 'cat ~/.ssh/id_rsa' });
  assert.equal(b.permissionDecision, 'deny');
  const ok = await pre(sid, cwd, 'Read', { file_path: path.join(cwd, 'src/a.ts') });
  assert.ok(!ok || ok.permissionDecision !== 'deny', 'ordinary files pass');
  process.env.KORA_INJECT_OWNER = 'driver';
  try { const x = await pre(sid, cwd, 'Read', { file_path: ssh }); assert.ok(!x || x.permissionDecision !== 'deny', 'chat lane: not double-guarded'); }
  finally { delete process.env.KORA_INJECT_OWNER; }
  process.env.KORA_ALLOW_SENSITIVE_PATHS = '1';
  try { const y = await pre(sid, cwd, 'Read', { file_path: ssh }); assert.ok(!y || y.permissionDecision !== 'deny', 'override'); }
  finally { delete process.env.KORA_ALLOW_SENSITIVE_PATHS; }
  sweep(sid);
});

// ── bounded Read for a pane (graph/read-window.ts; the chat lane has its own in-process hook) ──────────────────────
async function promptHook(sessionId: string, cwd: string, text: string) {
  const o = io(); await run(['prompt', '--stdin-json', JSON.stringify({ session_id: sessionId, cwd, prompt: text })], o); return o.stdout;
}
function bigFile(cwd: string, name = 'big.ts', lines = 700): string {
  const f = path.join(cwd, name); fs.writeFileSync(f, Array.from({ length: lines }, (_, i) => `// line ${i + 1}`).join('\n') + '\n'); return f;
}
test('pre-tool: bounded Read (pane) - a whole-file Read of a long code file gets offset/limit + an outline notice; the second Read passes', async () => {
  const sid = `t-${process.pid}-${Date.now()}-b`; const cwd = repo(); const f = bigFile(cwd);
  process.env.KORA_BOUNDED_READS = 'on'; delete process.env.KORA_INJECT_OWNER; process.env.KORA_INJECT_LOG = '0'; process.env.KORA_PROMPT_INJECT = '0';
  try {
    await promptHook(sid, cwd, 'how does the parser behave');
    const first = await pre(sid, cwd, 'Read', { file_path: f });
    assert.ok(first, 'bounded');
    assert.equal(first.updatedInput.file_path, f);
    assert.equal(first.updatedInput.offset, 1); assert.equal(first.updatedInput.limit, 250);
    assert.match(first.additionalContext, /bounded to lines 1-250 of 700/);
    assert.doesNotMatch(first.additionalContext ?? '', /no offset\/limit/, 'the old big-read nudge stays quiet');
    const second = await pre(sid, cwd, 'Read', { file_path: f });
    assert.equal(second?.updatedInput, undefined, 'the second Read of the same path is untouched');
    // a ranged Read, a small file and a prompt that names the file are all left alone
    const g = bigFile(cwd, 'other.ts');
    assert.equal((await pre(sid, cwd, 'Read', { file_path: g, offset: 10, limit: 20 }))?.updatedInput, undefined);
    const small = bigFile(cwd, 'small.ts', 100);
    assert.equal((await pre(sid, cwd, 'Read', { file_path: small }))?.updatedInput, undefined);
    await promptHook(sid, cwd, 'please show the whole of third.ts');
    const third = bigFile(cwd, 'third.ts');
    assert.equal((await pre(sid, cwd, 'Read', { file_path: third }))?.updatedInput, undefined, 'the user asked for the whole thing');
  } finally { delete process.env.KORA_BOUNDED_READS; delete process.env.KORA_PROMPT_INJECT; sweep(sid); fs.rmSync(path.join(path.dirname(markerBase({ session_id: sid })), path.basename(markerBase({ session_id: sid })) + '-readwin'), { force: true }); fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('pre-tool: bounded Read is off by default-unset env + setting off, and never runs inside a chat session (the driver owns it)', async () => {
  const sid = `t-${process.pid}-${Date.now()}-o`; const cwd = repo(); const f = bigFile(cwd);
  try {
    process.env.KORA_BOUNDED_READS = 'off';
    assert.equal((await pre(sid, cwd, 'Read', { file_path: f }))?.updatedInput, undefined);
    process.env.KORA_BOUNDED_READS = 'on'; process.env.KORA_INJECT_OWNER = 'driver';
    assert.equal((await pre(sid, cwd, 'Read', { file_path: f }))?.updatedInput, undefined, 'chat lane: the in-process hook does it');
    delete process.env.KORA_INJECT_OWNER; process.env.KORA_BOUNDED_READS = 'shadow';
    assert.equal((await pre(sid, cwd, 'Read', { file_path: f }))?.updatedInput, undefined, 'shadow mode rewrites nothing');
  } finally { delete process.env.KORA_BOUNDED_READS; delete process.env.KORA_INJECT_OWNER; sweep(sid); fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('post-tool: a graph lookup in Bash feeds the next bounded window (pane)', async () => {
  const sid = `t-${process.pid}-${Date.now()}-p`; const cwd = repo(); const f = bigFile(cwd, 'big.ts', 900);
  process.env.KORA_BOUNDED_READS = 'on'; delete process.env.KORA_INJECT_OWNER; process.env.KORA_PROMPT_INJECT = '0';
  try {
    await promptHook(sid, cwd, 'where is the thing handled');
    const o = io();
    await run(['post-tool', '--stdin-json', JSON.stringify({ session_id: sid, cwd, tool_name: 'Bash', tool_input: { command: 'kora graph explore "thing"' }, tool_response: { stdout: '1 match(es)\n■ FUNCTION thing @ big.ts:500 — thing()\n' } })], o);
    const r = await pre(sid, cwd, 'Read', { file_path: f });
    assert.ok(r.updatedInput.offset <= 500 && r.updatedInput.offset + r.updatedInput.limit - 1 >= 500, JSON.stringify(r.updatedInput));
  } finally { delete process.env.KORA_BOUNDED_READS; delete process.env.KORA_PROMPT_INJECT; sweep(sid); fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('pre-tool: the one-time identifier deny carries the graph answer (declaration + callers); shadow/off and no-exact-declaration keep the plain redirect', async () => {
  const texts: Record<string, string> = {
    search_code: '1 match(es)\n  src/pricing.js: METHOD applyDiscount:5',
    neighbours: 'METHOD applyDiscount @ src/pricing.js:L5\n  in   ← CALLS ←  METHOD placeOrder @ src/checkout.js:L5 (line 14)',
  };
  setDenyGraphForTests(async (n) => texts[n] ?? null);
  const prev = process.env.KORA_DENY_ANSWER; delete process.env.KORAGRAPH_NUDGE_MAX_REDIRECTS;
  try {
    const cwd = repo();
    for (const [mode, withAnswer] of [['on', true], ['shadow', false], ['off', false]] as const) {
      process.env.KORA_DENY_ANSWER = mode;
      const sid = `t-ans-${mode}-${process.pid}-${Date.now()}`; sweep(sid);
      const d = await pre(sid, cwd, 'Grep', { pattern: 'applyDiscount' });
      assert.equal(d.permissionDecision, 'deny', mode);
      if (withAnswer) {
        assert.match(d.permissionDecisionReason, /METHOD applyDiscount — src\/pricing\.js:5/); assert.match(d.permissionDecisionReason, /src\/checkout\.js: placeOrder:14/);
        assert.doesNotMatch(d.permissionDecisionReason, /kora graph explore/);
      } else assert.match(d.permissionDecisionReason, /kora graph explore/);
      // a Bash rg is the same search, in the same lane
      const sidB = `${sid}-b`; sweep(sidB);
      const b = await pre(sidB, cwd, 'Bash', { command: 'rg -n applyDiscount src' });
      assert.equal(b.permissionDecision, 'deny'); assert.equal(/src\/pricing\.js:5/.test(b.permissionDecisionReason), withAnswer, `bash ${mode}`);
      // the redirect still fires once only
      const again = await pre(sid, cwd, 'Grep', { pattern: 'applyDiscount' });
      assert.notEqual(again?.permissionDecision, 'deny', `relents ${mode}`);
    }
    process.env.KORA_DENY_ANSWER = 'on';
    const sid2 = `t-ans-none-${process.pid}-${Date.now()}`; sweep(sid2);
    const none = await pre(sid2, cwd, 'Grep', { pattern: 'unknownThing' });
    assert.equal(none.permissionDecision, 'deny'); assert.match(none.permissionDecisionReason, /kora graph explore/, 'no exact declaration: today\'s message');
    const sid3 = `t-ans-text-${process.pid}-${Date.now()}`; sweep(sid3);
    assert.equal(await pre(sid3, cwd, 'Grep', { pattern: 'out of stock' }), null, 'a text search is never denied, never looked up');
  } finally { setDenyGraphForTests(null); if (prev === undefined) delete process.env.KORA_DENY_ANSWER; else process.env.KORA_DENY_ANSWER = prev; }
});
