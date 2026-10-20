#!/usr/bin/env node
'use strict';
// Per-lane injection canary: for a known code-shaped prompt on an INDEXED repo, every product lane must actually
// hand the agent graph declarations (injectedDecls > 0) inside the hook budget. Zero injection where the graph has an
// answer is a HARD FAILURE, not silence — the two largest savings bugs in this product's history (fresh:true on dirty
// repos; the desktop chat lane never running injection at all) were both silent kills of exactly this path.
//
//   npm run build && node scripts/e2e-inject-canary.js [--repo <indexed repo>] [--symbol <a camelCase symbol in it>] [--json]
//
// Lanes (each one PASS/FAIL/SKIP line; exit 1 on any FAIL):
//   cli-hook        `kora hook prompt` in-process (headless `claude -p`, `kora bench`, a pane without a server)
//   pane-socket     the same hook routed through the LIVE runtime socket (`graph.tool`, channel hook) when one is up
//   fleet-worker    the hook from a linked worktree of the repo (worker cwd → main-root graph)
//   orchestrator    the hook with an orchestrator identity
//   dirty-tree      the hook after uncommitted edits to indexed source files (the fresh:true regime)
//   desktop-chat    ClaudeDriver.sendTurn (SDK chat lane) with a fake query — the message pushed to the SDK carries the header
//   bounded-read-chat  the same ClaudeDriver's PreToolUse hook turns a whole-file Read of a long file into a window + outline
//                   (hint = this prompt's injection when its file is long enough) and lets the second Read through whole
//   bounded-read-pane  `kora hook pre-tool` does the same for a pane (state carried by `kora hook prompt`)
//   opencode-chat   OpenCodeDriver.sendTurn with a fake spawn — the `opencode run` prompt carries the header
//   codex-chat      CodexDriver.sendTurn with a fake spawn — the prompt handed to `codex exec` carries the header
//   mcp             `kora mcp` answers tools/call explore with ranked declarations (no prompt hook by design)
// No real agent tokens are spent. Real graph, real store, real hook processes.
// Run from inside a Kora chat, the lane's KORA_INJECT_OWNER=driver makes every hook lane stand down (no telemetry).
delete process.env.KORA_INJECT_OWNER;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'kora.js');
const argv = process.argv.slice(2);
const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const JSON_OUT = argv.includes('--json');
const BUDGET_MS = Number(process.env.KORA_INJECT_TIMEOUT_MS) > 0 ? Number(process.env.KORA_INJECT_TIMEOUT_MS) : 7000;
const results = [];
function line(lane, status, ms, note) { results.push({ lane, status, ms, note }); if (!JSON_OUT) console.log(`${status.padEnd(4)} ${lane.padEnd(14)} ${String(ms == null ? '' : ms + 'ms').padStart(7)}  ${note || ''}`); }

// ---- pick an indexed repo + a prompt whose top declaration we know ----
const { injectLogPath, readInjectLog, INJECT_HEADER } = require(path.join(ROOT, 'dist', 'graph', 'prompt-inject.js'));
const { createGraphService } = require(path.join(ROOT, 'dist', 'graph', 'index.js'));
function pickRepo() {
  const cand = [get('--repo'), process.env.KORA_CANARY_REPO, ROOT].filter(Boolean).map((p) => path.resolve(p));
  return cand;
}
async function firstIndexed(cands) {
  const g = createGraphService();
  for (const c of cands) { try { const st = await g.status(c); if (st && st.indexed && st.nodes > 100) return { cwd: c, st }; } catch { /* next */ } }
  return null;
}
// A symbol that exists in the repo: take one from the graph itself (search_code for a common name), so the canary is
// repo-agnostic. For the kora repo itself, `injectForPrompt` is the natural subject.
// A real declaration row (`  src/x.js: METHOD name:12`), not the name echoed back by a miss: search_code's miss header
// ("NO DECLARATION NAMED \"injectForPrompt\" …") contains the name too, so on any repo but kora itself the canary picked
// a symbol that does not exist and failed every lane with symbol-absent.
const declares = (text, sym) => !/NO DECLARATION NAMED/.test(text) && new RegExp(`[:,]\\s*[A-Z_]+ ${sym}:\\d+`).test(text);
async function pickSymbol(g, cwd) {
  const prefer = [get('--symbol'), 'injectForPrompt', 'resolveSymbol', 'createGraphService', 'ensureRepoFresh'].filter(Boolean);
  for (const s of prefer) { try { const r = await g.callTool('search_code', { query: s }, { cwd, fresh: false }); if (r && r.text && declares(r.text, s)) return s; } catch { /* next */ } }
  return null;
}
const promptFor = (sym) => `How does ${sym} decide what to do, and what does it call? file:line please.`;

function runHook(cwd, sessionId, prompt, env = {}) {
  const input = JSON.stringify({ session_id: sessionId, cwd, prompt, hook_event_name: 'UserPromptSubmit' });
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [BIN, 'hook', 'prompt'], { cwd, input, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 30000 });
  const ms = Date.now() - t0;
  let ctx = '';
  try { for (const l of (r.stdout || '').split('\n')) { if (!l.trim()) continue; const o = JSON.parse(l); ctx = o?.hookSpecificOutput?.additionalContext || ctx; } } catch { /* partial */ }
  const rec = readInjectLog(injectLogPath(), { since: t0 - 2000 }).filter((x) => x.sessionId === sessionId).pop() || null;
  return { ms, ctx, rec, stderr: r.stderr || '' };
}
function judgeHook(lane, h, extra) {
  const decls = h.rec ? h.rec.decls : (h.ctx.match(/^\s*■/gm) || []).length;
  const ok = decls > 0 && h.ctx.includes(INJECT_HEADER) && h.ms <= BUDGET_MS + 2000;
  const laneOk = !extra?.lane || (h.rec && h.rec.lane === extra.lane);
  line(lane, ok && laneOk ? 'PASS' : 'FAIL', h.ms, `${decls} decl(s), reason=${h.rec ? h.rec.reason : 'no-telemetry'}, lane=${h.rec ? h.rec.lane : '?'}${h.rec && h.rec.exploreMs != null ? `, explore ${h.rec.exploreMs}ms` : ''}${!laneOk ? ` (expected lane ${extra.lane})` : ''}${extra?.note ? ' ' + extra.note : ''}`);
  return ok && laneOk;
}

// A tracked source file long enough to be bounded (> 300 lines): the injection's own top-hit file when it qualifies (so the
// window is chosen from the injected declaration), else the first long one.
const SRC_RE = /\.(js|mjs|cjs|ts|tsx|jsx|py|go|rb|java|rs)$/;
function lineCount(p) { try { return fs.readFileSync(p, 'utf8').split('\n').length; } catch { return 0; } }
function pickLongFile(cwd, prefer) {
  const ok = (rel) => { const n = lineCount(path.join(cwd, rel)); return n > 320 && n < 6000; };
  if (prefer && ok(prefer)) return { rel: prefer, fromInjection: true };
  const ls = spawnSync('git', ['ls-files'], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  for (const rel of (ls.stdout || '').split('\n').filter((f) => SRC_RE.test(f) && !/\.test\./.test(f)).slice(0, 400)) if (ok(rel)) return { rel, fromInjection: false };
  return null;
}
function topHitFile(text) { const m = /■\s+\S+\s+\S+\s+@\s+(\S+?):\d+/.exec(text || ''); return m ? m[1] : null; }

(async () => {
  const picked = await firstIndexed(pickRepo());
  if (!picked) { line('setup', 'FAIL', null, 'no indexed repo among candidates (pass --repo <indexed repo>)'); finish(); return; }
  const cwd = picked.cwd; const g = createGraphService();
  const sym = await pickSymbol(g, cwd);
  if (!sym) { line('setup', 'FAIL', null, `no known symbol found in ${cwd}`); finish(); return; }
  if (!JSON_OUT) console.log(`repo ${cwd} (${picked.st.nodes} nodes) · subject ${sym} · budget ${BUDGET_MS}ms\n`);
  const sid = (lane) => `canary-${lane}-${process.pid}-${Date.now()}`;

  // 1. cli-hook
  judgeHook('cli-hook', runHook(cwd, sid('cli'), promptFor(sym), { KORA_PANE_ID: '', KORA_SOCKET_PATH: path.join(os.tmpdir(), 'kora-no-such.sock') }), { lane: 'cli' });

  // 2. pane-socket (live runtime)
  const sock = process.env.KORA_SOCKET_PATH || path.join(process.env.KORA_HOME || path.join(os.homedir(), '.kora'), 'kora.sock');
  let sockUp = false; try { sockUp = fs.statSync(sock).isSocket(); } catch { /* down */ }
  if (sockUp) judgeHook('pane-socket', runHook(cwd, sid('pane'), promptFor(sym), { KORA_PANE_ID: 'canary-pane', KORA_SOCKET_PATH: sock }), { lane: 'pane', note: `via ${sock}` });
  else line('pane-socket', 'SKIP', null, `no runtime socket at ${sock}`);

  // 3. fleet-worker: a linked worktree under $KORA_HOME/worktrees/<repo>/canary-*
  const home = process.env.KORA_HOME || path.join(os.homedir(), '.kora');
  const wtDir = path.join(home, 'worktrees', path.basename(cwd), `canary-${process.pid}`);
  let wtOk = false;
  try {
    fs.mkdirSync(path.dirname(wtDir), { recursive: true });
    execFileSync('git', ['worktree', 'add', '-q', '--detach', wtDir, 'HEAD'], { cwd, stdio: 'pipe' });
    wtOk = true;
    judgeHook('fleet-worker', runHook(wtDir, sid('wt'), promptFor(sym), { KORA_PANE_ID: 'canary-worker', KORA_SOCKET_PATH: path.join(os.tmpdir(), 'kora-no-such.sock') }), { lane: 'fleet-worker', note: `cwd ${wtDir}` });
  } catch (e) { line('fleet-worker', 'FAIL', null, `worktree setup failed: ${String(e.message).slice(0, 120)}`); }
  finally { if (wtOk) { try { execFileSync('git', ['worktree', 'remove', '--force', wtDir], { cwd, stdio: 'pipe' }); } catch { try { fs.rmSync(wtDir, { recursive: true, force: true }); execFileSync('git', ['worktree', 'prune'], { cwd, stdio: 'pipe' }); } catch { /* best effort */ } } } }

  // 4. orchestrator identity
  judgeHook('orchestrator', runHook(cwd, sid('orch'), promptFor(sym), { KORA_ORCHESTRATOR_ID: 'canary-orch', KORA_SOCKET_PATH: path.join(os.tmpdir(), 'kora-no-such.sock') }), { lane: 'orchestrator' });

  // 5. dirty tree: uncommitted edits to indexed source files; the hook must still inject (fresh:false) inside budget
  {
    const ls = spawnSync('git', ['ls-files', '--', 'src/*.ts', 'src/*.js', '*.js', '*.ts'], { cwd, encoding: 'utf8' });
    const files = (ls.stdout || '').split('\n').filter((f) => f && !/\.test\./.test(f)).slice(0, 6);
    const backup = new Map();
    try {
      for (const f of files) { const p = path.join(cwd, f); backup.set(p, fs.readFileSync(p)); fs.appendFileSync(p, `\n// canary dirty ${Date.now()}\n`); }
      const h = runHook(cwd, sid('dirty'), promptFor(sym), { KORA_SOCKET_PATH: path.join(os.tmpdir(), 'kora-no-such.sock') });
      judgeHook('dirty-tree', h, { note: `${files.length} files dirtied` });
    } finally { for (const [p, b] of backup) fs.writeFileSync(p, b); }
  }

  // 6. desktop-chat: ClaudeDriver with a fake SDK query — the pushed user message must carry the injection header
  try {
    const { ClaudeDriver } = require(path.join(ROOT, 'dist', 'session', 'drivers', 'claude-driver.js'));
    const pushed = [];
    let waiting = null;
    const iterator = { next() { return new Promise((r) => { waiting = r; }); }, async return() { return { value: undefined, done: true }; }, [Symbol.asyncIterator]() { return this; }, interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {} };
    const queryFn = (params) => { const p = params.prompt; if (p && typeof p[Symbol.asyncIterator] === 'function') { (async () => { for await (const m of p) pushed.push(m); })().catch(() => {}); } return iterator; };
    const deps = { graphCall: (n, a, o) => g.callTool(n, a, { ...o, cwd: o.cwd }), graphStatus: (c) => g.status(c), spawnWorker: async () => ({ id: 'x', agent: 'claude', account: null }), spawnEnv: () => ({}), appendSystemPrompt: () => undefined };
    const driver = new ClaudeDriver(deps, queryFn);
    const threadId = sid('desktop');
    await driver.startSession({ threadId, agent: 'claude', cwd, account: null });
    const t0 = Date.now();
    await driver.sendTurn({ threadId, text: promptFor(sym) });
    await new Promise((r) => setTimeout(r, 50));
    const ms = Date.now() - t0;
    const msg = pushed.find((m) => m && m.type === 'user');
    const text = typeof msg?.message?.content === 'string' ? msg.message.content : JSON.stringify(msg?.message?.content || '');
    const rec = readInjectLog(injectLogPath(), { since: t0 - 2000 }).filter((x) => x.sessionId === threadId).pop() || null;
    const decls = (text.match(/^\s*■/gm) || []).length;
    const ok = text.startsWith(INJECT_HEADER) && decls > 0 && rec && rec.lane === 'desktop-chat';
    line('desktop-chat', ok ? 'PASS' : 'FAIL', ms, `${decls} decl(s) in the SDK user message, telemetry ${rec ? rec.lane + '/' + rec.reason : 'missing'}${!pushed.length ? ' (no message reached the SDK stream)' : ''}`);
    try { await driver.stopSession?.(threadId); } catch { /* fine */ }
  } catch (e) { line('desktop-chat', 'FAIL', null, `driver error: ${String(e.stack || e).slice(0, 200)}`); }


  // 6b/6c. bounded Read (the cost plan's biggest lever): the driver's in-process hook and the pane's `kora hook pre-tool`.
  // Cost telemetry stays off (KORA_COST_LOG=0): a canary must not write rows into the user's real cost log.
  const prevCostLog = process.env.KORA_COST_LOG; process.env.KORA_COST_LOG = '0';
  let boundedPick = null; let injectedText = '';
  try {
    const dctx = { cwd, sid: sid('bound') };
    // what the injection says for the prompt (the hook lane's text is the same declarations the driver would prepend)
    const h0 = runHook(cwd, dctx.sid + '-inj', promptFor(sym), { KORA_PANE_ID: '', KORA_SOCKET_PATH: path.join(os.tmpdir(), 'kora-no-such.sock') });
    injectedText = h0.ctx || '';
    boundedPick = pickLongFile(cwd, topHitFile(injectedText));
  } catch { /* handled below */ }
  if (!boundedPick) { line('bounded-read-chat', 'SKIP', null, 'no tracked source file over 320 lines in this repo'); line('bounded-read-pane', 'SKIP', null, 'no tracked source file over 320 lines in this repo'); }
  else {
    const abs = path.join(cwd, boundedPick.rel); const total = lineCount(abs) - (fs.readFileSync(abs, 'utf8').endsWith('\n') ? 1 : 0);
    const judgeBound = (lane, ms, r1, r2, extra) => {
      const u = r1 && r1.updatedInput; const note = r1 && r1.additionalContext || '';
      const ok = !!u && u.file_path === abs && Number.isInteger(u.offset) && Number.isInteger(u.limit) && u.limit >= 100 && u.limit <= 250 && u.offset >= 1 && u.offset + u.limit - 1 <= total
        && /bounded to lines \d+-\d+ of \d+/.test(note) && !(r2 && r2.updatedInput);
      line(lane, ok ? 'PASS' : 'FAIL', ms, ok
        ? `${boundedPick.rel}: lines ${u.offset}-${u.offset + u.limit - 1} of ${total}${boundedPick.fromInjection ? ' (window from the injected declaration)' : ' (head window)'}, outline ${/Outline/.test(note) ? 'present' : 'absent'}, second Read untouched${extra || ''}`
        : `no bounded window for ${boundedPick.rel}: first=${JSON.stringify(r1 || null).slice(0, 220)} second=${JSON.stringify(r2 || null).slice(0, 120)}`);
    };
    // 6b. chat lane: ClaudeDriver (fake query) + its PreToolUse hook
    try {
      process.env.KORA_BOUNDED_READS = 'on';
      const { ClaudeDriver } = require(path.join(ROOT, 'dist', 'session', 'drivers', 'claude-driver.js'));
      let opts = null; let waiting = null;
      const iterator = { next() { return new Promise((r) => { waiting = r; }); }, async return() { return { value: undefined, done: true }; }, [Symbol.asyncIterator]() { return this; }, interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {} };
      const queryFn = (params) => { opts = params.options; const p = params.prompt; if (p && typeof p[Symbol.asyncIterator] === 'function') (async () => { for await (const m of p) void m; })().catch(() => {}); return iterator; };
      const deps = { graphCall: (n, a, o) => g.callTool(n, a, o), graphStatus: (c) => g.status(c), spawnWorker: async () => ({ id: 'x', agent: 'claude', account: null }), spawnEnv: () => ({}), appendSystemPrompt: () => undefined, isFolderTrusted: () => true };
      const driver = new ClaudeDriver(deps, queryFn);
      const threadId = sid('boundchat');
      await driver.startSession({ threadId, agent: 'claude', cwd, account: null });
      await driver.sendTurn({ threadId, text: promptFor(sym) });
      const entry = (opts.hooks.PreToolUse || []).find((e) => typeof e.matcher === 'string' && e.matcher.startsWith('Read|'));
      const hook = entry && entry.hooks[0];
      if (!hook) line('bounded-read-chat', 'FAIL', null, 'the driver installed no bounded-Read PreToolUse hook');
      else {
        const t0 = Date.now();
        const a = await hook({ tool_name: 'Read', tool_input: { file_path: abs }, cwd, tool_use_id: 'canary-1' }, 'canary-1');
        const ms = Date.now() - t0;
        const b = await hook({ tool_name: 'Read', tool_input: { file_path: abs }, cwd, tool_use_id: 'canary-2' }, 'canary-2');
        judgeBound('bounded-read-chat', ms, a.hookSpecificOutput, b.hookSpecificOutput, ms > 1500 ? ' (SLOW: budget is 1000 ms)' : '');
      }
      try { await driver.stopSession?.(threadId); } catch { /* fine */ }
    } catch (e) { line('bounded-read-chat', 'FAIL', null, `driver error: ${String(e.stack || e).slice(0, 200)}`); }
    // 6c. pane: `kora hook prompt` records the turn + injection, `kora hook pre-tool` rewrites the Read, the second one passes
    try {
      const sidb = sid('boundpane');
      const env = { KORA_BOUNDED_READS: 'on', KORA_COST_LOG: '0', KORA_PANE_ID: '', KORA_INJECT_OWNER: '', KORA_SOCKET_PATH: path.join(os.tmpdir(), 'kora-no-such.sock') };
      const pre = () => {
        const t0 = Date.now();
        const r = spawnSync(process.execPath, [BIN, 'hook', 'pre-tool'], { cwd, input: JSON.stringify({ session_id: sidb, cwd, tool_name: 'Read', tool_input: { file_path: abs }, hook_event_name: 'PreToolUse' }), encoding: 'utf8', env: { ...process.env, ...env }, timeout: 30000 });
        let o = null; try { o = JSON.parse((r.stdout || '').trim().split('\n').filter(Boolean).pop() || 'null'); } catch { /* none */ }
        return { ms: Date.now() - t0, out: o && o.hookSpecificOutput };
      };
      runHook(cwd, sidb, promptFor(sym), env);
      const a = pre(); const b = pre();
      judgeBound('bounded-read-pane', a.ms, a.out, b.out);
      const base = require(path.join(ROOT, 'dist', 'cli', 'commands', 'hook.js')).markerBase({ session_id: sidb });
      for (const f of fs.readdirSync(path.dirname(base))) if (f.startsWith(path.basename(base))) { try { fs.rmSync(path.join(path.dirname(base), f), { force: true }); } catch { /* fine */ } }
    } catch (e) { line('bounded-read-pane', 'FAIL', null, `hook error: ${String(e.stack || e).slice(0, 200)}`); }
    delete process.env.KORA_BOUNDED_READS;
  }
  if (prevCostLog === undefined) delete process.env.KORA_COST_LOG; else process.env.KORA_COST_LOG = prevCostLog;

  // 7. codex-chat: CodexDriver with a fake spawn — the prompt passed to `codex exec` must carry the header
  try {
    const { CodexDriver } = require(path.join(ROOT, 'dist', 'session', 'drivers', 'codex-driver.js'));
    const { EventEmitter } = require('node:events');
    const calls = [];
    const spawnFn = (command, args, opts) => { calls.push({ command, args, opts }); const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stdout.setEncoding = () => {}; c.stderr = new EventEmitter(); c.stderr.setEncoding = () => {}; c.kill = () => { c.killed = true; setImmediate(() => c.emit('close', 0, null)); }; c.pid = 4242; return c; };
    const deps = { graphCall: (n, a, o) => g.callTool(n, a, o), graphStatus: (c) => g.status(c), spawnWorker: async () => ({ id: 'x', agent: 'codex', account: null }), spawnEnv: () => ({}), appendSystemPrompt: () => undefined };
    const driver = new CodexDriver(deps, spawnFn);
    const threadId = sid('codex');
    await driver.startSession({ threadId, agent: 'codex', cwd, account: null });
    const t0 = Date.now();
    await driver.sendTurn({ threadId, text: promptFor(sym) });
    const ms = Date.now() - t0;
    const call = calls[0];
    const promptArg = call ? call.args[call.args.length - 1] : '';
    const decls = (String(promptArg).match(/^\s*■/gm) || []).length;
    const rec = readInjectLog(injectLogPath(), { since: t0 - 2000 }).filter((x) => x.sessionId === threadId).pop() || null;
    const ok = String(promptArg).startsWith(INJECT_HEADER) && decls > 0 && rec && rec.lane === 'codex-chat';
    line('codex-chat', ok ? 'PASS' : 'FAIL', ms, `${decls} decl(s) in the codex exec prompt, telemetry ${rec ? rec.lane + '/' + rec.reason : 'missing'}${!call ? ' (codex was never spawned)' : ''}`);
    try { await driver.stopSession?.(threadId); } catch { /* fine */ }
  } catch (e) { line('codex-chat', 'FAIL', null, `driver error: ${String(e.stack || e).slice(0, 200)}`); }

  // 7b. opencode-chat: OpenCodeDriver with a fake spawn — the prompt after `--` must carry the header
  try {
    const { OpenCodeDriver } = require(path.join(ROOT, 'dist', 'session', 'drivers', 'opencode-driver.js'));
    const { EventEmitter } = require('node:events');
    const calls = [];
    const spawnFn = (command, args, opts) => { calls.push({ command, args, opts }); const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stdout.setEncoding = () => {}; c.stderr = new EventEmitter(); c.stderr.setEncoding = () => {}; c.kill = () => { c.killed = true; setImmediate(() => c.emit('close', 0, null)); }; c.pid = 4243; return c; };
    const deps = { graphCall: (n, a, o) => g.callTool(n, a, o), graphStatus: (c) => g.status(c), spawnWorker: async () => ({ id: 'x', agent: 'opencode', account: null }), spawnEnv: () => ({}), appendSystemPrompt: () => undefined,
      opencode: { binary: () => '/bin/opencode', pickModel: () => 'opencode/big-pickle', env: () => ({}), markCooling: () => {} } };
    const driver = new OpenCodeDriver(deps, spawnFn);
    const threadId = sid('opencode');
    await driver.startSession({ threadId, agent: 'opencode', cwd, account: null });
    const t0 = Date.now();
    await driver.sendTurn({ threadId, text: promptFor(sym) });
    const ms = Date.now() - t0;
    const call = calls[0];
    const promptArg = call ? call.args[call.args.length - 1] : '';
    const decls = (String(promptArg).match(/^\s*■/gm) || []).length;
    const rec = readInjectLog(injectLogPath(), { since: t0 - 2000 }).filter((x) => x.sessionId === threadId).pop() || null;
    const ok = String(promptArg).startsWith(INJECT_HEADER) && decls > 0 && rec && rec.lane === 'opencode-chat';
    line('opencode-chat', ok ? 'PASS' : 'FAIL', ms, `${decls} decl(s) in the opencode run prompt, telemetry ${rec ? rec.lane + '/' + rec.reason : 'missing'}${!call ? ' (opencode was never spawned)' : ''}`);
    try { await driver.stopSession?.(threadId); } catch { /* fine */ }
  } catch (e) { line('opencode-chat', 'FAIL', null, `driver error: ${String(e.stack || e).slice(0, 200)}`); }

  // 8. mcp: tools/call explore over stdio
  await new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [BIN, 'mcp'], { cwd, env: { ...process.env, KORA_SOCKET_PATH: path.join(os.tmpdir(), 'kora-no-such.sock') }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = ''; let done = false;
    const finishMcp = (status, note) => { if (done) return; done = true; line('mcp', status, Date.now() - t0, note); try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); };
    const timer = setTimeout(() => finishMcp('FAIL', 'no tools/call reply within 20s'), 20000);
    child.stdout.on('data', (d) => {
      buf += d.toString(); let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue;
        let o; try { o = JSON.parse(l); } catch { continue; }
        if (o.id === 1) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'explore', arguments: { query: sym } } }) + '\n');
        if (o.id === 2) { clearTimeout(timer); const text = (o.result?.content || []).map((c) => c.text || '').join('\n'); const hits = (text.match(/^\s*■/gm) || []).length; finishMcp(hits > 0 && text.includes(sym) ? 'PASS' : 'FAIL', `${hits} ■ hit(s) for ${sym}`); }
      }
    });
    child.on('exit', () => finishMcp('FAIL', 'mcp server exited early'));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'canary', version: '0' } } }) + '\n');
  });
  finish();
})().catch((e) => { line('canary', 'FAIL', null, String(e.stack || e).slice(0, 300)); finish(); });

function finish() {
  const failed = results.filter((r) => r.status === 'FAIL');
  if (JSON_OUT) console.log(JSON.stringify({ ok: !failed.length, results }, null, 2));
  else console.log(`\n${failed.length ? 'CANARY FAIL' : 'CANARY PASS'}: ${results.filter((r) => r.status === 'PASS').length} pass, ${failed.length} fail, ${results.filter((r) => r.status === 'SKIP').length} skip`);
  process.exit(failed.length ? 1 : 0);
}
