#!/usr/bin/env node
'use strict';
// Fresh-machine end-to-end: the out-of-the-box path with NO prior setup and NO real agent.
//
//   npm run build && node scripts/e2e-fresh.js
//
// Everything lives in an isolated temp dir (KORA_HOME, KORAGRAPH_DB, KORAGRAPH_PRACTICE_DB, the server socket),
// so it never touches ~/.kora or ~/.koragraph. It starts the server in-process, opens a plain shell pane in a tiny
// git repo, types `claude` (a fake, Claude-shaped shell script placed on PATH behind the kora shims) and then runs
// the hooks the way Claude Code would. It proves, in order:
//   1. a shell pane + hand-typed `claude` is adopted (agent → claude) via the shim's `hook prelaunch`
//   2. the repo is indexed in the background (graph.indexing shows, then clears; indexed with nodes > 0)
//   3. hooks + rulebook were installed in the repo (.claude/settings.local.json, CLAUDE.md)
//   4. session-start brief names the repo; a code-shaped prompt gets graph declarations; a cold identifier Grep is
//      denied once then relents — and in an UN-indexed repo the same Grep is never denied (no gating below
//      the graph)
//   5. the switch-over moment: a session briefed "not indexed yet" in a second repo is told exactly once, on its next
//      prompt after `kora ingest` lands, that the graph is ready — and the graph routing applies from there
// One PASS/FAIL line per step; exit code 1 on any failure. Set E2E_KEEP=1 to keep the temp dir for inspection.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'kora.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-e2e-'));
const home = path.join(tmp, 'home');
const socketPath = path.join(home, 's.sock');
const repo = path.join(tmp, 'e2e-shop');
const repo2 = path.join(tmp, 'e2e-untouched');
const fakebin = path.join(tmp, 'fakebin');
fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(fakebin, { recursive: true });

// Isolated env for the server AND every child (panes inherit process.env; hooks get it explicitly below).
for (const k of Object.keys(process.env)) if (/^(KORA_|KORAGRAPH_|CLAUDE_CODE_|CLAUDECODE)/.test(k)) delete process.env[k];
Object.assign(process.env, {
  KORA_HOME: home, KORAGRAPH_HOME: path.join(tmp, 'kg'), KORAGRAPH_DB: path.join(tmp, 'graph.db'), KORAGRAPH_PRACTICE_DB: path.join(tmp, 'practice.db'),
  KORA_SOCKET_PATH: socketPath, SHELL: '/bin/sh', PATH: `${fakebin}:${process.env.PATH || '/usr/bin:/bin'}`,
});
const { SUN_PATH_MAX } = require(path.join(ROOT, 'dist', 'graph', 'embedded'));
if (socketPath.length > SUN_PATH_MAX) { console.error(`socket path too long (${socketPath.length} > ${SUN_PATH_MAX}): ${socketPath}`); process.exit(2); }

let failures = 0;
function step(name, ok, detail) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) failures++; return ok; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms = 30_000, every = 100) { const t0 = Date.now(); for (;;) { const v = pred(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(every); } }
function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.com' } }); }
// Async on purpose: the server runs in THIS process, and a hook may RPC it over the socket (prompt injection goes
// through the server when KORA_PANE_ID is set) — a spawnSync here would block the event loop and deadlock that call.
function hook(event, input, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [BIN, 'hook', event, '--stdin-json', JSON.stringify(input)], { cwd: input.cwd, env: { ...process.env, KORA_ENV: '1', KORA_BIN: BIN, KORA_AGENT: 'claude', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { c.kill('SIGKILL'); reject(new Error(`hook ${event} hung > 20 s`)); }, 20_000);
    c.on('error', (e) => { clearTimeout(t); reject(e); });
    c.on('close', (code) => {
      clearTimeout(t);
      if (code !== 0) return reject(new Error(`hook ${event} exited ${code}: ${err}`));
      out = out.trim();
      if (!out) return resolve(null);
      try { resolve(JSON.parse(out)); } catch { reject(new Error(`hook ${event}: stdout is not the hook JSON only: ${out.slice(0, 200)}`)); }
    });
  });
}

// 1. a tiny git repo with three JS modules exporting functions
function makeRepo(dir) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'pricing.js'), `'use strict';\nconst { applyDiscount } = require('./discount');\nconst { formatMoney } = require('./format');\n\nfunction computeTotalPrice(items, discountCode) {\n  const subtotal = items.reduce((sum, it) => sum + it.price * it.qty, 0);\n  return formatMoney(applyDiscount(subtotal, discountCode));\n}\n\nfunction f1(x) { return x + 1; }\n\nmodule.exports = { computeTotalPrice, f1 };\n`);
  fs.writeFileSync(path.join(dir, 'src', 'discount.js'), `'use strict';\nconst RATES = { SAVE10: 0.1, SAVE20: 0.2 };\n\nfunction applyDiscount(amount, code) {\n  const rate = RATES[code] || 0;\n  return amount * (1 - rate);\n}\n\nfunction listDiscountCodes() { return Object.keys(RATES); }\n\nmodule.exports = { applyDiscount, listDiscountCodes };\n`);
  fs.writeFileSync(path.join(dir, 'src', 'format.js'), `'use strict';\n\nfunction formatMoney(n) { return '$' + n.toFixed(2); }\n\nfunction parseMoney(s) { return Number(String(s).replace(/[^0-9.]/g, '')); }\n\nmodule.exports = { formatMoney, parseMoney };\n`);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: path.basename(dir), version: '0.0.0', main: 'src/pricing.js' }, null, 2));
  git(dir, 'init', '-q'); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init');
}

// 2. a fake, Claude-shaped `claude`: OSC title `✳ fake`, a `❯ ` prompt box, echoes every line it reads
function makeFakeClaude() {
  fs.writeFileSync(path.join(fakebin, 'claude'), `#!/bin/sh
printf '\\033]0;✳ fake\\007'
box() { printf '\\n────────────────────────────────\\n❯ \\n────────────────────────────────\\n'; }
box
while read line; do
  printf '\\033]0;⠋ thinking\\007'
  printf '\\n⏺ got: %s\\n' "$line"
  printf '\\033]0;✳ fake\\007'
  box
done
`, { mode: 0o755 });
}

async function main() {
  makeRepo(repo); makeRepo(repo2); makeFakeClaude();
  step('fresh isolated home + tiny git repos', fs.existsSync(path.join(repo, '.git')) && !fs.existsSync(path.join(tmp, 'graph.db')), tmp);

  // 3. the server, in-process; a SHELL pane in the repo; type the PATH export, then `claude`
  const { createServer } = require(path.join(ROOT, 'dist', 'server', 'daemon'));
  const h = await createServer({ socketPath, restore: false });
  const seen = { indexing: false, indexingCleared: false };
  h.runtime.on('notify', (method, params) => {
    if (method !== 'pane.updated' || !params?.graph) return;
    if (params.graph.indexing) seen.indexing = true; else if (seen.indexing) seen.indexingCleared = true;
  });
  try {
    const info0 = await h.runtime.spawnPane({ cwd: repo });
    const id = info0.id;
    const pane = () => h.runtime.requirePane(id).info();
    step('shell pane spawned in the repo', info0.agent !== 'claude' && info0.cwd === repo, `pane ${id}, agent=${info0.agent}, KORA_SHIMS_DIR set=${!!h.runtime.requirePane(id).env?.KORA_SHIMS_DIR}`);

    // A Grep in the un-indexed repo, BEFORE anything is indexed: never denied (no graph, no gating).
    const early = await hook('pre-tool', { session_id: 'e2e-early', cwd: repo2, tool_name: 'Grep', tool_input: { pattern: 'computeTotalPrice' } }, { KORA_PANE_ID: id });
    step('pre-tool Grep in an UN-indexed repo is not denied', early?.hookSpecificOutput?.permissionDecision !== 'deny', JSON.stringify(early));

    const p = h.runtime.requirePane(id);
    p.write(`export PATH=$KORA_SHIMS_DIR:${fakebin}:$PATH\r`);
    await sleep(300);
    p.write('claude\r');

    // 4. adoption → indexing bar → indexed
    const adopted = await until(() => pane().agent === 'claude' ? pane() : null, 30_000, 250);
    step('agent becomes claude (adopted via the shim\'s hook prelaunch)', !!adopted, adopted ? `title=${JSON.stringify(adopted.title)}` : `agent=${pane().agent}, screen=${JSON.stringify(p.read('screen', 'text', 6))}`);
    const indexedInfo = await until(() => { const i = pane(); return i.graph.indexed && i.graph.nodes > 0 && !i.graph.indexing ? i : null; }, 30_000, 250);
    step('graph.indexing appeared, then cleared', seen.indexing && seen.indexingCleared, seen.indexing ? 'progress events observed on pane.updated' : `never saw indexing; graph=${JSON.stringify(pane().graph)}`);
    step('graph.indexed === true with nodes > 0', !!indexedInfo, indexedInfo ? `${indexedInfo.graph.nodes} nodes, ${indexedInfo.graph.edges} edges, root=${indexedInfo.graph.repoRoot}` : `graph=${JSON.stringify(pane().graph)}`);
    step('the store is the isolated one', fs.existsSync(path.join(tmp, 'graph.db')), path.join(tmp, 'graph.db'));

    const settingsFile = path.join(repo, '.claude', 'settings.local.json');
    let events = [];
    try { const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); events = Object.entries(s.hooks || {}).filter(([, v]) => JSON.stringify(v).includes(' hook ')).map(([k]) => k); } catch { /* missing */ }
    step('.claude/settings.local.json has 7 kora hook events', events.length === 7, events.join(','));
    const claudeMd = path.join(repo, 'CLAUDE.md');
    step('CLAUDE.md carries the kora rulebook block', fs.existsSync(claudeMd) && fs.readFileSync(claudeMd, 'utf8').includes('<!-- kora:begin -->'), claudeMd);
    const screen = p.read('scrollback', 'text', 40) || '';
    const pi = pane();
    step('the fake claude is on screen in the pane', /❯/.test(screen) && !pi.exited, `title=${JSON.stringify(pi.title)} exited=${pi.exited} last=${JSON.stringify(screen.trim().split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 200))}`);

    // 5. the hooks, the way Claude Code runs them, against that repo
    const env = { KORA_PANE_ID: id };
    const ss = await hook('session-start', { session_id: 'e2e', cwd: repo, transcript_path: path.join(tmp, 'x.jsonl') }, env);
    const brief = ss?.hookSpecificOutput?.additionalContext || '';
    step('session-start brief mentions the repo', ss?.hookSpecificOutput?.hookEventName === 'SessionStart' && brief.includes(path.basename(repo)), `${brief.length} chars; ${JSON.stringify(brief.split('\n')[0].slice(0, 100))}`);
    step('the brief does not say "not indexed"', !/not indexed yet/.test(brief));
    const pr = await hook('prompt', { session_id: 'e2e', cwd: repo, prompt: 'what does computeTotalPrice do' }, env);
    const ctx = pr?.hookSpecificOutput?.additionalContext || '';
    step('prompt: code-shaped prompt gets graph declarations', ctx.includes('Graph, for this prompt') && ctx.includes('computeTotalPrice'), JSON.stringify(ctx.split('\n').slice(0, 2).join(' | ').slice(0, 160)));
    const grep = (sid, cwd, pattern) => hook('pre-tool', { session_id: sid, cwd, tool_name: 'Grep', tool_input: { pattern } }, env);
    const g0 = await grep('e2e', repo, 'computeTotalPrice');
    step('pre-tool: a Grep in the turn that got declarations injected passes', g0?.hookSpecificOutput?.permissionDecision !== 'deny', JSON.stringify(g0));
    await hook('prompt', { session_id: 'e2e', cwd: repo, prompt: 'thanks, that is all for now' }, env); // a later turn, nothing injected: cold again
    const g1 = await grep('e2e', repo, 'computeTotalPrice');
    step('pre-tool: cold identifier Grep is denied once (graph ready)', g1?.hookSpecificOutput?.permissionDecision === 'deny', (g1?.hookSpecificOutput?.permissionDecisionReason || JSON.stringify(g1) || '').slice(0, 90));
    const g2 = await grep('e2e', repo, 'computeTotalPrice');
    step('pre-tool: the second Grep passes (relent)', g2?.hookSpecificOutput?.permissionDecision !== 'deny', (g2?.hookSpecificOutput?.additionalContext || 'silent').slice(0, 90));
    const g3 = await grep('e2e', repo, 'error: failed');
    step('pre-tool: a text Grep is never denied', g3?.hookSpecificOutput?.permissionDecision !== 'deny');
    const late = await grep('e2e-late', repo2, 'computeTotalPrice');
    step('pre-tool: the other repo (still un-indexed) still passes Grep', late?.hookSpecificOutput?.permissionDecision !== 'deny', JSON.stringify(late));

    // 6. the switch-over moment: a session that started BEFORE its repo was indexed is told once when the index lands
    const sw = await hook('session-start', { session_id: 'e2e-sw', cwd: repo2, transcript_path: path.join(tmp, 'y.jsonl') }, env);
    const swBrief = sw?.hookSpecificOutput?.additionalContext || '';
    step('session-start in the un-indexed repo says grep/Read are the right tools', /not indexed yet/.test(swBrief) && /grep and Read are the right tools/.test(swBrief));
    const p0 = await hook('prompt', { session_id: 'e2e-sw', cwd: repo2, prompt: 'what does computeTotalPrice do' }, env);
    const p0ctx = p0?.hookSpecificOutput?.additionalContext || '';
    step('prompt before the index lands: no switch-over, no injection (no graph yet)', !/graph for this repository is ready now/.test(p0ctx) && !/Graph, for this prompt/.test(p0ctx), JSON.stringify(p0ctx.slice(0, 80)));
    const ing = await new Promise((resolve) => { const c = spawn(process.execPath, [BIN, 'ingest', repo2], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; }); c.on('close', (code) => resolve({ code, out })); });
    step('the second repo gets indexed mid-session (kora ingest)', ing.code === 0, ing.out.trim().split('\n').pop());
    const p1 = await hook('prompt', { session_id: 'e2e-sw', cwd: repo2, prompt: 'thanks, that is all for now' }, env);
    const p1ctx = p1?.hookSpecificOutput?.additionalContext || '';
    const swRe = /kora: the code graph for this repository is ready now \((\d+) nodes, (\d+) edges\)/;
    step('next prompt announces the switch-over once, with the counts', swRe.test(p1ctx) && Number(swRe.exec(p1ctx)[1]) > 0 && /kora graph explore/.test(p1ctx), JSON.stringify(p1ctx.slice(0, 110)));
    const p2 = await hook('prompt', { session_id: 'e2e-sw', cwd: repo2, prompt: 'thanks again, that is all for now' }, env);
    step('the prompt after that does not repeat it', !swRe.test(p2?.hookSpecificOutput?.additionalContext || ''));
    const g4 = await grep('e2e-sw', repo2, 'computeTotalPrice');
    step('and from here the graph routing applies: cold identifier Grep denied', g4?.hookSpecificOutput?.permissionDecision === 'deny');
    for (const sid of ['e2e', 'e2e-early', 'e2e-late', 'e2e-sw']) await hook('session-end', { session_id: sid, cwd: repo, hook_event_name: 'SessionEnd' }, env);
  } finally {
    try { for (const pi of h.runtime.listPanes()) h.runtime.requirePane(pi.id).kill('SIGKILL'); } catch { /* fine */ }
    await h.close();
  }
}

main().then(() => {
  console.log(failures ? `\n${failures} step(s) FAILED — kept ${tmp}` : `\nall steps passed`);
  if (!failures && !process.env.E2E_KEEP) fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}, (e) => { console.error(`FAIL  ${e && e.stack || e}\nkept ${tmp}`); process.exit(1); });
