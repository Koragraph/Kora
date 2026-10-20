// `kora hook <event>` — invoked by the agent's hook system inside a pane, JSON on stdin.
//
// One entry point for every agent hook event. Contract, in order of how expensive getting it wrong is:
//   1. Every path exits 0 — a hook that fails the user's tool call is worse than one that misses.
//   2. stdout carries ONLY the hook's JSON output (or the plain-text brief for non-Claude agents).
//   3. pre-tool / post-tool / stop never open graph.db for writing (its write lock during an ingest would stall
//      the editor). session-start reads the graph once for the brief; prompt runs ONE read-only explore under a
//      hard 2.5 s deadline (prompt-time injection, config.promptInject).
import fs from 'node:fs';
import path from 'node:path';
import type { IO } from '../main';
import { parseArgs, str } from '../args';
import type { AgentId } from '../../protocol/types';
import { koraHome, quietStdout, socketReachable, withTimeout } from '../../graph/embedded';
import { loadConfig } from '../../config';
import { injectForPrompt, injectedMarker } from '../../graph/prompt-inject';
import { dedupeNotice, loadReadLog, readLogPath, recordFor, saveReadLog } from '../../ledger/read-dedupe';
import { privateTmpDir } from '../../util/safe-path';
import {
  CODE_FILE_RE as READ_CODE_FILE_RE, decideRead, isGraphLookupCommand, newReadWindowState, noteExplore, noteFileTouched, noteInjection, noteOtherAccess, startTurn,
  reviveReadWindowState, toolResponseText, type BoundOutcome, type BoundSkip, type ReadIO, type ReadWindowState,
} from '../../graph/read-window';
import { boundedReadsMode, denyAnswerMode } from '../../util/savings-settings';
import { logCostSync, flushCostLog } from '../../util/cost-log';
import { createBashTrimHooks } from '../../session/bash-trim';
import { bashSearchPattern, identifierOf, isIdentifierPattern } from '../../enforce/search-shape';
import { denyAnswerFor, hookGraphCall } from '../../enforce/deny-answer';

export const summary = 'Internal: agent hook entry point';
export const usage = `Usage: kora hook <event> [--agent X] [--stdin-json '<json>']

Events (Claude Code hook JSON on stdin, hook JSON on stdout):
  prelaunch       (launcher shim)   → the agent is about to start in cwd: hooks + rulebook there, graph warm-up
  session-start   SessionStart      → additionalContext = the session brief (plain text with --agent codex|…)
  prompt          UserPromptSubmit  → graph declarations for a code-shaped prompt
                                      (config.promptInject; once per prompt per session)
  pre-tool        PreToolUse        → a cold Grep / Bash rg|grep for a CODE IDENTIFIER denied ($KORAGRAPH_NUDGE_MAX_REDIRECTS, default 1;
                                      text patterns and Glob always pass; a turn whose prompt got graph declarations passes),
                                      Bash grep/rg/find & Read of source nudged once,
                                      a Read of a file already in context nudged (config.readDedupe; diff-aware)
  post-tool       PostToolUse / PostToolUseFailure → \`kora graph\` in Bash = graph used; read log
  stop            Stop              → the pane goes idle
  session-end     SessionEnd        → per-session markers swept
  opencode-event  (kora-state.js)   → an OpenCode swarm worker's session status (--stdin-json '{"type":…}' from the
                                      plugin) → pane.reportState (working/idle) + swarm.reportEvent
Every path exits 0. Set KORA_TRACE=1 to see errors on stderr.`;

const CODE_FILE_RE = READ_CODE_FILE_RE;
const BASH_EXPLORE_RE = /(^|[\s;|&])(grep|rg|ag|ack|find|cat|less|more|head|tail)\b/;
const GRAPH_CLI_RE = /kora(\.js)?["']?\s+graph\b/;

// One redirect, not two: the second deny of the same identifier search bought nothing measurable (measured on the bench) and
// cost a whole extra tool round-trip — and the agent that grepped twice was usually right that grep was the tool.
export function maxRedirects(): number {
  const v = parseInt(process.env.KORAGRAPH_NUDGE_MAX_REDIRECTS || process.env.KORA_NUDGE_MAX_REDIRECTS || '', 10);
  return Number.isFinite(v) && v >= 0 ? v : 1;
}

// Identifier vs text search: enforce/search-shape.ts (shared with the grep/rg shim).
export { isIdentifierPattern, bashSearchPattern };

export function markerBase(input: any): string {
  const key = `${input.session_id || 'nosession'}-${input.agent_id || 'main'}`;
  return path.join(privateTmpDir(), `kora-nudge-${key.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
}
const GRAPH_USED = (b: string) => `${b}-graphused`;
const SOFT_SHOWN = (b: string) => `${b}-soft`;
const REDIRECTS = (b: string) => `${b}-redirects`;
const TURN = (b: string) => `${b}-turn`;
const INJECTED_TURN = (b: string) => `${b}-injected-turn`; // turn number whose prompt got graph declarations injected
// What the session-start brief told THIS session about the graph: `unindexed` (it was told "grep and Read are the
// right tools") or `indexed`. When the background index lands mid-session, prompt() tells the agent once and flips it.
const GRAPH_STATE = (b: string) => `${b}-graph-state`;
// The bounded-Read window state (graph/read-window.ts): turn, last prompt, injection / explore hints, seen files.
const READWIN = (b: string) => `${b}-readwin`;
export function loadReadWin(base: string): ReadWindowState {
  try { return reviveReadWindowState(JSON.parse(fs.readFileSync(READWIN(base), 'utf8'))); } catch { return newReadWindowState(); }
}
export function saveReadWin(base: string, st: ReadWindowState): void {
  // written aside and renamed: a hook reading at the same moment must never see a half-written (= fresh) state
  const f = READWIN(base); const tmp = `${f}.${process.pid}`;
  try { fs.writeFileSync(tmp, JSON.stringify(st)); fs.renameSync(tmp, f); } catch { try { fs.rmSync(tmp, { force: true }); } catch { /* gone */ } }
}
/**
 * Save only what one Read's decision changed (seen marks, bounded records, counts) onto the state as it is NOW: parallel
 * Reads run their hooks at once, and a plain load -> decide -> save let the last one erase the others' marks, so the next
 * whole Read of such a file was bounded a second time.
 */
function saveReadWinDelta(base: string, before: ReadWindowState, st: ReadWindowState): void {
  const cur = loadReadWin(base);
  for (const p of st.seen) if (!before.seen.includes(p)) noteFileTouched(cur, p);
  const same = (a: { path: string; turn: number; offset: number }, b: { path: string; turn: number; offset: number }) => a.path === b.path && a.turn === b.turn && a.offset === b.offset;
  for (const b of st.bounded) {
    const old = cur.bounded.find((c) => same(c, b));
    if (!old) { if (!before.bounded.some((c) => same(c, b))) cur.bounded.push(b); } else if (b.expanded) old.expanded = true;
  }
  if (cur.bounded.length > 200) cur.bounded.splice(0, cur.bounded.length - 200);
  for (const k of ['considered', 'bounded', 'shadow', 'expanded'] as const) cur.counts[k] += st.counts[k] - before.counts[k];
  for (const [k, v] of Object.entries(st.counts.skipped) as [BoundSkip, number][]) {
    const d = v - (before.counts.skipped[k] ?? 0); if (d) cur.counts.skipped[k] = (cur.counts.skipped[k] ?? 0) + d;
  }
  saveReadWin(base, cur);
}
function exists(f: string) { try { return fs.existsSync(f); } catch { return false; } }
function readText(f: string): string { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; } }
function touch(f: string) { try { fs.writeFileSync(f, ''); } catch { /* best effort */ } }
function readCount(f: string) { try { const n = parseInt(fs.readFileSync(f, 'utf8'), 10); return Number.isFinite(n) ? n : 0; } catch { return 0; } }
function bump(f: string) { const n = readCount(f) + 1; try { fs.writeFileSync(f, String(n)); } catch { /* best effort */ } return n; }

const DENY_REASON = [
  'kora: this pattern is a code identifier, this repository has a code graph, and it has not been consulted yet',
  'this task. Reissue this search through the graph instead: run `kora graph explore "<symbol>"` (Bash) or',
  '`kora graph search_code <symbol>` for locations only.',
  'It searches a resolved graph, not raw text, and usually answers "how does X work / where do I change it" in',
  'one call with ranked declarations, source, callers and callees. This is denied once; a search for TEXT (strings,',
  'config keys, log messages, paths) is never denied — grep is the right tool for those. If another agent',
  'delegated this task to you, you were not told this directly — use the graph yourself.',
].join(' ');
const NUDGE = [
  'kora: this repository has a code graph (shell: `kora graph explore|search_code|blast_radius|neighbours|',
  'file_symbols|overview …`). Before reading source to learn what code does, run',
  '`kora graph explore "<symbol or phrase>"` — it usually answers in one call. Before editing a file run',
  '`kora graph blast_radius --file <path>`. If you were delegated this task, use the graph yourself rather',
  'than falling back to grep. (Shown once per agent.)',
].join(' ');
const RELENT = [
  'kora: the graph has not been consulted this task, but Grep is now allowed as a fallback.',
  'If `kora graph explore` has not answered your question, grep is fine — otherwise it usually',
  'locates code here in fewer steps.',
].join(' ');
// The switch-over moment: a session that started before its repo was indexed is told exactly once that the graph
// is ready and how to use it; from then on the normal routing (injection, the identifier-Grep redirect) applies.
export const SWITCH_OVER = (nodes: number, edges: number) => [
  `kora: the code graph for this repository is ready now (${nodes} nodes, ${edges} edges). From here:`,
  'HOW does X work → `kora graph explore "<symbol or phrase>"`; WHO calls X → `kora graph neighbours X --direction in`;',
  'WHERE is a name → `kora graph search_code X`. A cold search for a code identifier (a search tool, or rg/grep in Bash) is redirected to the graph once;',
  'text greps still pass.',
].join(' ');

function debug(e: unknown) { if (process.env.KORA_TRACE) process.stderr.write(`[kora hook] ${(e as any)?.stack || e}\n`); }

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  return new Promise((resolve) => {
    // Settle exactly once, and — crucially — stop reading stdin before resolving. A hook launched by the shim (e.g.
    // `hook prelaunch` in a headless `claude -p --input-format stream-json` spawn) inherits the session's stdin, a
    // pipe that stays OPEN for the whole session and never sends EOF. Without pausing it here, the 3 s timeout
    // resolves the promise but stdin remains a resumed, listened-to libuv handle, so the hook PROCESS never exits —
    // and the shim, which runs the hook synchronously before exec'ing the real agent, hangs the entire launch.
    let settled = false;
    const done = (v: string) => {
      if (settled) return; settled = true;
      clearTimeout(t);
      try { process.stdin.pause(); process.stdin.removeListener('data', onData); } catch { /* best effort */ }
      resolve(v);
    };
    const onData = (c: Buffer | string) => chunks.push(Buffer.from(c));
    const t = setTimeout(() => done(Buffer.concat(chunks).toString('utf8')), 3000);
    process.stdin.on('data', onData);
    process.stdin.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => done(''));
    process.stdin.resume();
  });
}

function isIdentifierSearch(input: any): boolean {
  if (input.tool_name === 'Grep') return isIdentifierPattern(input.tool_input?.pattern);
  if (input.tool_name === 'Bash') return isIdentifierPattern(bashSearchPattern(input.tool_input?.command, input.cwd || process.cwd()));
  return false;
}
/**
 * Answer-in-deny (enforce/deny-answer.ts): when preTool is about to send the one-time identifier redirect, look the identifier up
 * first (bounded, fails open to null) so the deny text can carry the answer. Mirrors preTool's redirect condition; `shadow` only logs.
 */
async function denyAnswerForRedirect(input: any): Promise<string | null> {
  try {
    const mode = denyAnswerMode(); if (mode === 'off') return null;
    const cwd = input.cwd || process.cwd(); const base = markerBase(input);
    if (usedGraph(input) || exists(GRAPH_USED(base)) || !isIdentifierSearch(input) || injectedThisTurn(base) || !graphReady(cwd) || readCount(REDIRECTS(base)) >= maxRedirects()) return null;
    const symbol = identifierOf(input.tool_name === 'Grep' ? input.tool_input?.pattern : bashSearchPattern(input.tool_input?.command, cwd)); if (!symbol) return null;
    const t0 = Date.now(); const answer = await denyAnswerFor(symbol, hookGraphCall(cwd));
    logCostSync({ k: mode === 'on' ? 'deny-answer' : 'deny-answer-shadow', ts: Date.now(), thread: String(input.session_id || 'pane'), ident: symbol, chars: answer?.length ?? 0, ms: Date.now() - t0, hit: !!answer });
    return mode === 'on' ? answer : null;
  } catch (e) { debug(e); return null; }
}
function usedGraph(input: any): boolean {
  const name = input.tool_name;
  if (typeof name === 'string' && (name.startsWith('mcp__koragraph__') || name.startsWith('mcp__kora__'))) return true;
  if (name === 'Bash') { const cmd = input.tool_input?.command; return typeof cmd === 'string' && GRAPH_CLI_RE.test(cmd); }
  return false;
}
function looksLikeRawRead(input: any): boolean {
  const name = input.tool_name;
  if (name === 'Read') return CODE_FILE_RE.test(String(input.tool_input?.file_path || ''));
  if (name === 'Bash') return BASH_EXPLORE_RE.test(String(input.tool_input?.command || ''));
  return false;
}

// ---- events ----

export async function sessionStart(input: any, agent: AgentId | undefined, io: IO): Promise<void> {
  const cwd = input?.cwd || process.cwd();
  // After /compact or /clear the conversation no longer holds earlier Reads or injected declarations, so every
  // per-session memory the hooks keep ("already in context", "already injected", the graph-cache turn pointers)
  // is now false. Reset them. Claude Code reports the reason in `source`.
  if (input?.source === 'compact' || input?.source === 'clear') {
    try {
      const base = markerBase(input);
      for (const f of [readLogPath(base), TURN(base), INJECTED_TURN(base), GRAPH_STATE(base), READWIN(base)]) { try { fs.rmSync(f, { force: true }); } catch { /* fine */ } }
      try { const { injectedMarker } = require('../../graph/prompt-inject'); fs.rmSync(injectedMarker(input.session_id), { force: true }); } catch { /* fine */ }
    } catch (e) { debug(e); }
  }
  // Tell the daemon which transcript is live FIRST, in parallel with the brief: it used to go last, behind a brief of
  // up to 6 s, on a 1 s budget with no retry — on a busy daemon it was lost and kora_read said "no transcript yet"
  // for a live worker for the rest of its life.
  const reported = reportAgentSession(input, agent);
  const { createGraphService } = require('../../graph/index');
  const graph = createGraphService();
  // Bounded well under Claude Code's hook timeout so a slow/contended graph never hangs the pane; on timeout the
  // agent is told to run the graph itself. The brief is the graph's front door — every pane gets it, fleet included.
  let brief: string = await withTimeout(graph.brief(cwd, agent), 6000, `kora: graph brief timed out — run \`kora graph brief\` for it. Use \`kora graph explore "<query>"\` before grep.`);
  // Remember what this brief said about the graph, so prompt() can announce the switch-over exactly once when the
  // background index lands mid-session. Unknown (status timed out) writes nothing: no announcement is the safe miss.
  try {
    const st: { indexed: boolean; staleForCheckout?: boolean } | null = await withTimeout(graph.status(cwd), 1000, null as { indexed: boolean; staleForCheckout?: boolean } | null);
    if (st) fs.writeFileSync(GRAPH_STATE(markerBase(input)), !st.indexed || st.staleForCheckout ? 'unindexed' : 'indexed');
  } catch (e) { debug(e); }
  // Worktree: the agent must know it is not in the user's checkout, or it will "not find" uncommitted work.
  if (process.env.KORA_WORKTREE && process.env.KORA_MAIN_ROOT) {
    brief = `WORKTREE: you are in ${process.env.KORA_WORKTREE} on branch ${process.env.KORA_BRANCH || '?'}, branched from HEAD of ${process.env.KORA_MAIN_ROOT}. The user's UNCOMMITTED changes are not visible here — if asked about an edit you cannot find, say that and suggest they commit or stash. Your work is merged back with \`kora worktree merge\`.\n\n${brief}`;
  }
  // Cheap resume: the server left a distilled brief of the previous session for this pane (first/last prompt, files
  // touched, last answer). Deliver it once, then remove it so a later plain restart does not replay it.
  try {
    const paneId = process.env.KORA_PANE_ID;
    if (paneId) {
      const f = path.join(koraHome(), 'panes', paneId, 'resume-brief.md');
      if (fs.existsSync(f)) { const r = fs.readFileSync(f, 'utf8').trim(); if (r) brief = `${brief}\n\nRESUMED SESSION — what the previous session in this pane did (continue from here; do not redo it):\n${r}`; fs.rmSync(f); }
    }
  } catch (e) { debug(e); }
  await reported;
  if (!agent || agent === 'claude') io.out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: brief } }));
  else io.out(brief + '\n');
}

/**
 * Tell the runtime the agent's OWN turn state: a prompt was submitted / a tool is running → working; Stop → idle.
 * This is the authoritative half of pane state (the screen scrape is the other, see detect/tracker.ts). Fire and
 * forget: never awaited by the hook's own output, bounded to a few hundred ms, silent on any failure — a hook that
 * slows Claude Code or prints a stack is worse than a missed hint.
 */
function reportState(state: 'working' | 'idle', source: string, attempt = 0): void {
  const paneId = process.env.KORA_PANE_ID;
  if (!paneId || !socketReachable()) return;
  // `idle` (Stop) is the hint that releases a worker: a lost one holds the pane "working" until the tracker's
  // quiet override, and every wait on it with it. The agent is idle by then, so latency is free — give Stop a
  // wider budget and one retry; keep the mid-turn hints tight so they never slow Claude Code down.
  const budget = state === 'idle' ? 1500 : 400;
  try {
    const { KoraClient } = require('../../protocol/client');
    const c = new KoraClient();
    let ok = false;
    const done = () => { try { c.close(); } catch { /* closed */ } if (!ok && state === 'idle' && attempt === 0) { const r = setTimeout(() => reportState(state, source, 1), 250); r.unref(); } };
    const t = setTimeout(done, budget); t.unref();
    c.connect(state === 'idle' ? 1000 : 300).then(() => c.call('pane.reportState', { paneId, state, source }).then(() => { ok = true; }, () => {}).finally(() => { clearTimeout(t); done(); }), () => { clearTimeout(t); done(); });
  } catch (e) { debug(e); }
}

/** Tell the daemon which agent session id (and transcript) is now live in this pane. Bounded, best-effort. */
async function reportAgentSession(input: any, agent: AgentId | undefined): Promise<void> {
  const paneId = process.env.KORA_PANE_ID;
  if (!(paneId && input?.session_id && socketReachable())) return;
  try {
    const { KoraClient } = require('../../protocol/client');
    const params = { paneId, agent: agent || 'claude', agentSessionId: String(input.session_id), transcriptPath: input.transcript_path };
    for (let attempt = 0; attempt < 2; attempt++) {
      const c = new KoraClient();
      const ok = await withTimeout(c.connect(1000).then(() => c.call('pane.reportAgentSession', params)).then(() => true), 2500, false);
      try { c.close(); } catch { /* closed */ }
      if (ok) return;
    }
  } catch (e) { debug(e); }
}

/**
 * Called by the `claude` / `codex` launcher shim just before exec, inside a plain shell pane. The agent is about to
 * run in cwd: make that directory ready the way a spawned pane is — hooks + rulebook installed, graph warming (with
 * the bar in the runtime) — so "I just typed claude here" and "ctrl+b a" end up identical. Bounded: nothing here may
 * make the agent's start feel slow; the server does the work and answers in a few ms, the ingest runs detached.
 */
export async function prelaunch(input: any, agent: AgentId | undefined): Promise<void> {
  const cwd = input?.cwd || process.cwd(); const paneId = process.env.KORA_PANE_ID;
  if (paneId && socketReachable()) {
    try { const { callOnce } = require('../../protocol/client'); await withTimeout(callOnce('pane.prelaunch', { paneId, agent: agent || 'claude', cwd }, undefined, 4000), 4000, null); return; } catch (e) { debug(e); }
  }
  // no server (a bare shell with the shims on PATH): install enforcement here. Never a first index: only the user starts
  // one (the graph chip); a repo the user indexed is caught up by the next code prompt (freshenIndex).
  try {
    const { createEnforcer } = require('../../enforce/enforcer'); const { createGraphService } = require('../../graph/index');
    const graph = createGraphService(); const root = graph.repoRoot(cwd); if (!root) return;
    await withTimeout(createEnforcer({ graph }).install({ agent: (agent || 'claude') as any, cwd: root }), 3000, null);
  } catch (e) { debug(e); }
}

export async function prompt(input: any, io: IO): Promise<void> {
  reportState('working', 'prompt');
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || null;
  const sections: string[] = [];
  const turn = bump(TURN(markerBase(input))); // "turn N" in the read-dedupe / cache pointers
  // Switch-over: this session was briefed "not indexed yet — grep and Read are the right tools". If the index has
  // landed since, say so once (first section, before any injected declarations) and flip the marker. One bounded
  // status read, and only while the marker still says `unindexed`.
  try {
    const gsFile = GRAPH_STATE(markerBase(input));
    if (readText(gsFile) === 'unindexed') {
      const { createGraphService } = require('../../graph/index');
      const st: { indexed: boolean; staleForCheckout?: boolean; nodes: number; edges: number } | null = await withTimeout(createGraphService().status(cwd), 1000, null as any);
      if (st && st.indexed && !st.staleForCheckout) { sections.push(SWITCH_OVER(st.nodes, st.edges)); fs.writeFileSync(gsFile, 'indexed'); }
    }
  } catch (e) { debug(e); }
  // Prompt-time graph injection: answer the structure question before the agent asks the graph (or grep). When it
  // fires, the agent already holds graph context for this turn, so pre-tool lets a Grep through in the same turn
  // (the marker is the turn number; a later turn without an injection is cold again).
  // A chat-lane session (SDK-driven, prepared by Runtime.prepareChatSession) has its prompt injected by the daemon's
  // ClaudeDriver before it reaches Claude; injecting here too would bill the declarations twice.
  let injected: string | null = null;
  if (process.env.KORA_INJECT_OWNER !== 'driver') try {
    const inj = await injectForPrompt({ prompt: String(input.prompt || ''), cwd, sessionId });
    if (inj) { injected = inj; sections.push(inj); try { fs.writeFileSync(INJECTED_TURN(markerBase(input)), String(turn)); } catch { /* best effort */ } }
  } catch (e) { debug(e); }
  // Bounded Read (a pane only: a chat session's own driver holds this state in process): a new turn, and the declarations just injected.
  if (process.env.KORA_INJECT_OWNER !== 'driver' && boundedReadsMode() !== 'off') try {
    const base = markerBase(input); const st = loadReadWin(base);
    startTurn(st, String(input.prompt || '')); noteInjection(st, injected); saveReadWin(base, st);
  } catch (e) { debug(e); }
  if (sections.length) io.out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: sections.join('\n\n') } }));
}

function usedGraphMarkerOnly(_input: any): boolean { return false; }
/**
 * Is there a graph to redirect to? No index yet (the first minute in a repo, or a repo kora does not auto-index),
 * or an index built from another copy of the repo → grep is the right tool and nothing is denied: below the graph,
 * kora must stay out of the way. Synchronous (PreToolUse is sync): one readonly sqlite read, cached 5 s.
 */
let readyCache: { cwd: string; at: number; ready: boolean } | null = null;
export function graphReady(cwd: string): boolean {
  if (process.env.KORA_ASSUME_GRAPH === '1') return true;   // tests: pretend the repo is indexed
  if (process.env.KORA_ASSUME_GRAPH === '0') return false;
  if (readyCache && readyCache.cwd === cwd && Date.now() - readyCache.at < 5000) return readyCache.ready;
  let ready = false;
  try {
    const { gitTopLevel, graphDbPath } = require('../../graph/embedded');
    let root: string | null = gitTopLevel(cwd);
    if (root) { try { const { isLinkedWorktree, mainRoot } = require('../../server/worktree'); if (isLinkedWorktree(root)) root = mainRoot(root) || root; } catch { /* keep */ } }
    const dbFile = graphDbPath();
    if (root && fs.existsSync(dbFile)) {
      const Database = require('better-sqlite3');
      const db = new Database(dbFile, { readonly: true, fileMustExist: true });
      try {
        db.pragma('busy_timeout = 200');
        let real = root; try { real = fs.realpathSync(root); } catch { /* keep */ }
        const row = db.prepare(`SELECT r.full_path, rb.id AS branch_id FROM repositories r JOIN repository_branches rb ON rb.repository_id = r.id WHERE r.full_path IN (?, ?) ORDER BY rb.is_tracked DESC, rb.last_synced_at DESC LIMIT 1`).get(root, real)
          || db.prepare(`SELECT r.full_path, rb.id AS branch_id FROM repositories r JOIN repository_branches rb ON rb.repository_id = r.id WHERE lower(r.name) = lower(?) ORDER BY rb.is_tracked DESC, rb.last_synced_at DESC LIMIT 1`).get(path.basename(root));
        // A name match is THIS repo only when the row's folder is gone (the repo moved). A live folder of the same name is
        // another checkout (two `app` clones): denying a Grep here sent the agent to a graph that then refused it.
        let other = false;
        if (row && row.full_path !== root && row.full_path !== real) { try { other = require('../../graph/embedded').kg('src/services/repo-name.js').sameCheckout(row.full_path, root) === false; } catch { /* keep */ } }
        if (row && !other) {
          const nodes = db.prepare(`SELECT count(*) AS n FROM nodes WHERE repository_branch_id = ? AND approval_status != 'ARCHIVED'`).get(row.branch_id).n as number;
          ready = nodes > 0;
          // A half-built graph is not a graph to redirect to: the latest full index FAILED, or is still running / died
          // with no full index before it ever finished. (The tools refuse in both cases; a deny here bounced the agent.)
          if (ready) {
            try {
              const job = db.prepare(`SELECT id, status FROM ingest_jobs WHERE local_path IN (?, ?) AND coalesce(job_type, 'FULL') != 'INCREMENTAL' ORDER BY id DESC LIMIT 1`).get(row.full_path, real) as { id: number; status: string } | undefined;
              if (job && job.status === 'FAILED') ready = false;
              else if (job && (job.status === 'RUNNING' || job.status === 'PENDING') && !db.prepare(`SELECT 1 FROM ingest_jobs WHERE local_path IN (?, ?) AND coalesce(job_type, 'FULL') != 'INCREMENTAL' AND status IN ('COMPLETE', 'DEGRADED') AND id < ? LIMIT 1`).get(row.full_path, real, job.id)) ready = false;
            } catch { /* older store: keep */ }
          }
          if (ready && row.full_path !== root && row.full_path !== real) { // name-matched: is it really this checkout?
            const sample = db.prepare(`SELECT path FROM files WHERE repository_branch_id = ? ORDER BY random() LIMIT 12`).all(row.branch_id) as { path: string }[];
            const missing = sample.filter((f) => !fs.existsSync(path.join(root!, f.path))).length;
            if (sample.length >= 6 && missing / sample.length > 0.2) ready = false;
          }
        }
      } finally { db.close(); }
    }
  } catch { ready = false; }
  readyCache = { cwd, at: Date.now(), ready };
  return ready;
}
// The UserPromptSubmit hook injected graph declarations for the prompt of the CURRENT turn.
function injectedThisTurn(base: string): boolean { const t = readCount(TURN(base)); return t > 0 && readCount(INJECTED_TURN(base)) === t; }
export function preTool(input: any, io: IO, bound?: BoundOutcome | null, denyAnswer?: string | null): void {
  reportState('working', 'pre-tool');
  const base = markerBase(input);
  const name = input.tool_name;
  const out: Record<string, unknown> = { hookEventName: 'PreToolUse' };
  const context: string[] = [];
  // A pattern kill (`pkill`, `killall`, `kill $(pgrep ...)`) stops other agents' processes: denied here in every mode.
  try {
    const { patternKillVerdict } = require('../../session/sensitive-guard') as typeof import('../../session/sensitive-guard');
    const killWhy = patternKillVerdict(String(name ?? ''), (input.tool_input ?? {}) as Record<string, unknown>);
    if (killWhy) { io.out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: killWhy } })); return; }
  } catch (e) { debug(e); }
  // Keys and credentials stay off limits for worker panes too (audit 2026-10-13 S2-1). The SDK chat lane has its own
  // in-process guard that ASKS outside Full access (it sets KORA_INJECT_OWNER=driver); a pane worker is headless, so deny.
  if (process.env.KORA_INJECT_OWNER !== 'driver') {
    try {
      const { sensitiveOverride, sensitiveVerdict } = require('../../session/sensitive-guard') as typeof import('../../session/sensitive-guard');
      if (!sensitiveOverride()) {
        const v = sensitiveVerdict(String(name ?? ''), (input.tool_input ?? {}) as Record<string, unknown>, input.cwd || process.cwd());
        if (v.sensitive) {
          io.out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Kora blocked this (${v.reason}): keys and credentials stay off limits for agents. Ask the user to do it themselves.` } }));
          return;
        }
      }
    } catch (e) { debug(e); }
  }
  if (usedGraph(input)) {
    touch(GRAPH_USED(base));
    if (name === 'Bash') return; // a kora graph call needs no preflight
  } else if (exists(GRAPH_USED(base))) {
    // fallback regime: pass through
  } else if (isIdentifierSearch(input) && !injectedThisTurn(base) && graphReady(input.cwd || process.cwd())) {
    // Glob is never gated: a file list is not something the graph replaces, and a nudge there would be re-billed
    // on every later turn for nothing. A text-shaped Grep passes through for the same reason (see isIdentifierPattern).
    // A Bash `rg`/`grep` for one identifier is the same search: in Full access (bypassPermissions, Kora's default) Claude
    // Code's own prompt steers the model to Bash for searching, and over 14 days of the chat lane in indexed repos that
    // was 402 Bash searches against 5 Grep-tool calls — the redirect never fired.
    if (readCount(REDIRECTS(base)) < maxRedirects()) {
      bump(REDIRECTS(base));
      io.out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denyAnswer || DENY_REASON } }));
      return;
    }
    if (!exists(SOFT_SHOWN(base))) { touch(SOFT_SHOWN(base)); context.push(RELENT); }
  } else if (looksLikeRawRead(input) && !exists(SOFT_SHOWN(base))) {
    touch(SOFT_SHOWN(base)); context.push(NUDGE);
  }
  // Subagent-for-exploration guard. A delegated "find where X is handled" spawns a second context that re-reads the
  // repo from scratch — measured: the baseline's one Agent call cost more than kora's whole answer. Nudged, not
  // blocked; and if the agent still delegates, it is told to hand the graph to the subagent (a subagent inherits none
  // of the parent's instructions on its own).
  if ((name === 'Task' || name === 'Agent') && !exists(SOFT_SHOWN(base) + '-task')) {
    const desc = `${input.tool_input?.description || ''} ${input.tool_input?.prompt || ''}`.slice(0, 400);
    if (/\b(find|where|how|explore|search|locate|understand|investigate|look for|grep|trace|callers?|usages?)\b/i.test(desc)) {
      touch(SOFT_SHOWN(base) + '-task');
      context.push('kora: this looks like exploration. A subagent is a second context that re-reads the repo from scratch; `kora graph explore "<question>"` answers most of these in one call in THIS context. If you still delegate, put this in the subagent prompt: "Use `kora graph explore/neighbours/search_code` before any grep or Read."');
    }
  }
  // A Read Kora bounded (graph/read-window.ts): the window rides in updatedInput and the outline as context. The dedupe
  // and big-read nudges below would contradict it ("no offset/limit"), so they stay quiet for this call.
  if (bound?.bound) {
    out.updatedInput = bound.bound.updatedInput;
    context.push(bound.bound.additionalContext);
    io.out(JSON.stringify({ hookSpecificOutput: { ...out, additionalContext: context.join('\n\n') } }));
    return;
  }
  // Read dedupe (diff-aware): a file already Read this session is nudged; a changed one gets the changed ranges.
  if (name === 'Read') {
    try {
      const fp = String(input.tool_input?.file_path || '');
      if (fp && loadConfig().readDedupe) { const n = dedupeNotice(fp, input.tool_input || {}, loadReadLog(base)); if (n) context.push(n); }
    } catch (e) { debug(e); }
  }
  // Big-read guard: a whole-file Read of a long source file is the single most expensive routine tool call, and
  // it is re-billed on every later turn. Never blocked — nudged with the exact cheaper move (a range, or
  // file_symbols to find the range). Pure stat + line count, no store.
  if (name === 'Read' && !usedGraphMarkerOnly(input)) {
    try {
      const fp = String(input.tool_input?.file_path || ''); const hasRange = input.tool_input?.offset != null || input.tool_input?.limit != null;
      if (fp && !hasRange && CODE_FILE_RE.test(fp)) {
        const st = fs.statSync(fp);
        if (st.size > 12_000) {
          const lines = fs.readFileSync(fp, 'utf8').split('\n').length; const tok = Math.round(st.size / 4);
          if (lines > 300) context.push(`kora: ${path.basename(fp)} is ${lines} lines (~${tok.toLocaleString()} tokens) and this Read has no offset/limit — the whole file will sit in context for the rest of the session. If you only need one declaration, run \`kora graph file_symbols ${path.relative(input.cwd || process.cwd(), fp)}\` for its line range and Read with offset/limit.`);
        }
      }
    } catch (e) { debug(e); }
  }
  if (context.length) { out.additionalContext = context.join('\n\n'); io.out(JSON.stringify({ hookSpecificOutput: out })); }
}

export function postTool(input: any): void {
  reportState('working', 'post-tool');
  if (usedGraph(input)) touch(GRAPH_USED(markerBase(input)));
  // Bounded Read: a graph lookup's hits are the second-best window hint (a pane; a chat session keeps these in process).
  if (process.env.KORA_INJECT_OWNER !== 'driver' && input.tool_name === 'Bash' && isGraphLookupCommand(input.tool_input?.command) && boundedReadsMode() !== 'off') {
    try { const base = markerBase(input); const st = loadReadWin(base); noteExplore(st, toolResponseText(input.tool_response)); saveReadWin(base, st); } catch (e) { debug(e); }
  }
  // A bounded file printed by a shell command (cat / sed -n / rg …) or a content Grep: the agent paid for it after all,
  // so the bound's credit is dropped — the chat lane does the same in read-bounder.ts.
  if (process.env.KORA_INJECT_OWNER !== 'driver' && (input.tool_name === 'Bash' || input.tool_name === 'Grep') && boundedReadsMode() !== 'off') {
    try {
      const base = markerBase(input); const st = loadReadWin(base); const cwd = input.cwd || process.cwd();
      const hit = noteOtherAccess(st, input.tool_name, input.tool_input || {}, cwd);
      if (hit.length) {
        saveReadWin(base, st);
        const thread = String(input.session_id || 'pane');
        for (const b of hit) logCostSync({ k: 'read-expand', ts: Date.now(), thread, file: path.relative(cwd, b.path).split(path.sep).join('/') });
      }
    } catch (e) { debug(e); }
  }
  if (input.tool_name === 'Read' && input.hook_event_name !== 'PostToolUseFailure') {
    try {
      const fp = String(input.tool_input?.file_path || '');
      if (fp && loadConfig().readDedupe) {
        const base = markerBase(input);
        const content = typeof input.tool_response?.file?.content === 'string' && input.tool_input?.offset == null && input.tool_input?.limit == null ? input.tool_response.file.content : null;
        const rec = recordFor(fp, input.tool_input || {}, readCount(TURN(base)), content);
        if (rec) { const log = loadReadLog(base); log[fp] = rec; saveReadLog(base, log); }
      }
    } catch (e) { debug(e); }
  }
}

/**
 * Bash trim in a Claude pane (fleet workers, `claude` in a Kora terminal): the same PostToolUse hook the chat lane runs in
 * process (session/bash-trim.ts, settings `bashTrim`), its answer printed as the CLI hook's JSON. A chat session's repo hooks
 * stand down (KORA_INJECT_OWNER=driver): the driver already trimmed. Bounded; any doubt leaves the output alone.
 */
export async function paneBashTrim(input: any, io: IO): Promise<void> {
  if (process.env.KORA_INJECT_OWNER === 'driver' || input?.hook_event_name !== 'PostToolUse' || input?.tool_name !== 'Bash') return;
  try {
    const hooks = createBashTrimHooks({ threadId: `pane-${String(input.session_id || 'pane')}` }) as any;
    const fn = hooks?.PostToolUse?.[0]?.hooks?.[0];
    if (typeof fn !== 'function') return;
    const out = await withTimeout<Record<string, any>>(fn(input), 3500, {});
    await withTimeout(flushCostLog(), 500, undefined); // the process exits right after: write the cost row now
    if (out && out.hookSpecificOutput) io.out(JSON.stringify(out));
  } catch (e) { debug(e); }
}

export function sessionEnd(input: any): void {
  if (input?.hook_event_name !== 'SessionEnd') reportState('idle', 'stop');
  if (!input?.session_id) return;
  if (input.hook_event_name === 'SessionEnd') {
    // The nudge markers are per session; sweep them so tmp does not accumulate.
    const base = markerBase({ session_id: input.session_id, agent_id: null });
    for (const f of [GRAPH_USED(base), SOFT_SHOWN(base), SOFT_SHOWN(base) + '-task', REDIRECTS(base), TURN(base), INJECTED_TURN(base), GRAPH_STATE(base), READWIN(base), readLogPath(base), injectedMarker(input.session_id), injectedMarker(input.session_id) + '-shown']) { try { fs.rmSync(f, { force: true }); } catch { /* fine */ } }
  }
}

/**
 * A session the previous runtime launched (its own env marker set, ours not) fires every hook in the repo, kora's
 * included. Stand down there: that runtime already injects, briefs and gates its own sessions.
 */
export function foreignSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['NH' + 'ANDS_ENV'] === '1' && env.KORA_ENV !== '1';
}

/**
 * An OpenCode swarm worker's session status, forwarded by the kora-state plugin (~/.kora/opencode/plugins). Input:
 * `{type: 'session.status'|'session.idle'|'session.error', status?: 'busy'|'idle'|'retry', attempt?, message?, next?}`.
 * Tells the daemon twice, over one connection: `pane.reportState` (the authoritative working/idle hint the tracker
 * already honours — busy and retry are working, idle is idle, an error leaves the state to the idle that follows it)
 * and `swarm.reportEvent` (failover / report bookkeeping). Awaited but bounded: the plugin spawns this detached, so
 * nothing waits on it; it must still never hang.
 */
export async function opencodeEvent(input: any): Promise<void> {
  const paneId = process.env.KORA_PANE_ID;
  const type = input?.type;
  const feed = Array.isArray(input?.items) ? input.items : Array.isArray(input?.feed) ? input.feed : null;
  if (paneId && type === 'feed') {
    if (!feed?.length || !socketReachable()) return;
    try {
      const { KoraClient } = require('../../protocol/client');
      const c = new KoraClient();
      try { await withTimeout((async () => { await c.connect(1000); await c.call('pane.feed', { paneId, items: feed }).catch(debug); })(), 2000, undefined); } finally { c.close(); }
    } catch (e) { debug(e); }
    return;
  }
  if (!paneId || (type !== 'session.status' && type !== 'session.idle' && type !== 'session.error')) return;
  const status = input.status === 'busy' || input.status === 'idle' || input.status === 'retry' ? input.status as 'busy' | 'idle' | 'retry' : undefined;
  const event: import('../../protocol/types').SwarmPaneEvent = { paneId, type };
  if (status) event.status = status;
  if (typeof input.attempt === 'number' && Number.isFinite(input.attempt)) event.attempt = input.attempt;
  if (typeof input.message === 'string' && input.message) event.message = input.message.slice(0, 500);
  if (typeof input.next === 'number' && Number.isFinite(input.next)) event.next = input.next;
  const state: 'working' | 'idle' | null = type === 'session.idle' || status === 'idle' ? 'idle' : status === 'busy' || status === 'retry' ? 'working' : null;
  if (!socketReachable()) return;
  try {
    const { KoraClient } = require('../../protocol/client');
    const c = new KoraClient();
    try {
      await withTimeout((async () => {
        await c.connect(1000);
        if (feed?.length) await c.call('pane.feed', { paneId, items: feed }).catch(debug);
        if (state) await c.call('pane.reportState', { paneId, state, source: 'opencode' }).catch(debug);
        await c.call('swarm.reportEvent', event).catch(debug);
      })(), 2000, undefined);
    } finally { c.close(); }
  } catch (e) { debug(e); }
}

/** The pane-side I/O of a bounded Read: sync file stat (a hook is a short-lived process), the readonly index check, the graph over the socket. */
function paneReadIO(input: any): ReadIO {
  const cwd = input.cwd || process.cwd();
  return {
    stat: async (abs) => {
      try {
        const st = fs.statSync(abs); if (!st.isFile() || st.size > 4 * 1024 * 1024) return null;
        const buf = fs.readFileSync(abs); let lines = 0; for (let i = 0; i < buf.length; i++) if (buf[i] === 10) lines++;
        return { lines: buf.length && buf[buf.length - 1] !== 10 ? lines + 1 : lines, bytes: buf.length };
      } catch { return null; }
    },
    indexed: async () => graphReady(cwd),
    outline: async (rel) => {
      const paneId = process.env.KORA_PANE_ID;
      try {
        if (paneId && socketReachable()) {
          const { callOnce } = require('../../protocol/client');
          const r = await withTimeout(callOnce('graph.tool', { name: 'file_symbols', args: { path: rel }, cwd, paneId, channel: 'hook', fresh: false }, undefined, 1200), 1200, null as any);
          // The daemon was asked; if it did not answer in time (busy, stalled) a second, in-process attempt would only double the wait.
          return r?.text ? String(r.text) : null;
        }
        const { createGraphService } = require('../../graph/index');
        const r = await withTimeout(createGraphService().callTool('file_symbols', { path: rel }, { cwd, fresh: false } as any), 1200, null as any);
        return r?.text ? String(r.text) : null;
      } catch { return null; }
    },
    sensitive: (ti) => {
      try {
        const g = require('../../session/sensitive-guard') as typeof import('../../session/sensitive-guard');
        return !g.sensitiveOverride() && g.sensitiveVerdict('Read', ti, cwd).sensitive;
      } catch { return true; }
    },
  };
}
/**
 * Bounded Read for a pane (docs/research/MASTER-COST-PLAN.md 4.1): decide whether this Read becomes a window. Null (do
 * nothing) in a chat session (its driver owns the hook, in process), when the setting is off, for any other tool, and on any
 * failure or timeout. Edits and writes only mark the file as seen, so a later whole Read of it passes through.
 */
export async function boundForPane(input: any): Promise<BoundOutcome | null> {
  try {
    if (process.env.KORA_INJECT_OWNER === 'driver') return null;
    const mode = boundedReadsMode();
    if (mode === 'off') return null;
    const name = String(input.tool_name || ''); const ti = (input.tool_input || {}) as Record<string, unknown>;
    const cwd = input.cwd || process.cwd(); const base = markerBase(input); const st = loadReadWin(base);
    const before = reviveReadWindowState(JSON.parse(JSON.stringify(st)));
    if (name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit') {
      const fp = String(ti.file_path ?? ti.notebook_path ?? '');
      if (fp) { noteFileTouched(st, path.resolve(cwd, fp)); saveReadWinDelta(base, before, st); }
      return null;
    }
    if (name !== 'Read') return null;
    const res = await withTimeout(decideRead(st, ti, cwd, paneReadIO(input), { mode: mode === 'shadow' ? 'shadow' : 'on' }), 2500, null as BoundOutcome | null);
    saveReadWinDelta(base, before, st);
    if (!res) return null;
    const thread = String(input.session_id || 'pane'); const rel = (p: string) => path.relative(cwd, p).split(path.sep).join('/');
    const expanded = (res as any).expanded; if (expanded) logCostSync({ k: 'read-expand', ts: Date.now(), thread, file: rel(expanded.path) });
    if (res.shadowRecord) { const r = res.shadowRecord; logCostSync({ k: 'read-shadow', ts: Date.now(), thread, file: rel(r.path), offset: r.offset, limit: r.limit, total: r.total, source: r.source, avoided: r.avoidedTokens }); return null; }
    if (res.bound) { const r = res.bound.record; logCostSync({ k: 'read-bound', ts: Date.now(), thread, file: rel(r.path), offset: r.offset, limit: r.limit, total: r.total, source: r.source, avoided: res.bound.avoidedTokens }); }
    return res;
  } catch (e) { debug(e); return null; }
}

export async function run(argv: string[], io: IO): Promise<number> {
  if (foreignSession()) return 0;
  quietStdout();
  const { flags, positional } = parseArgs(argv, ['agent', 'stdin-json']);
  const event = positional[0];
  if (!event || flags.help) { io.out(usage + '\n'); return 0; }
  const agent = (str(flags.agent) || process.env.KORA_AGENT || undefined) as AgentId | undefined;
  try {
    const raw = str(flags['stdin-json']) ?? await readStdin();
    let input: any = {};
    if (raw && raw.trim()) { try { input = JSON.parse(raw); } catch { input = {}; } }
    if (!input.cwd) input.cwd = process.cwd();
    switch (event) {
      case 'prelaunch': await prelaunch(input, agent); break;
      case 'session-start': await sessionStart(input, agent, io); break;
      case 'prompt': await prompt(input, io); break;
      case 'pre-tool': preTool(input, io, ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(String(input.tool_name)) ? await boundForPane(input) : null, ['Grep', 'Bash'].includes(String(input.tool_name)) ? await denyAnswerForRedirect(input) : null); break;
      case 'post-tool': postTool(input); if (agent === 'claude' || !agent) await paneBashTrim(input, io); break;
      case 'stop': case 'session-end': sessionEnd(input); break;
      case 'opencode-event': await opencodeEvent(input); break;
      default: debug(new Error(`unknown hook event "${event}"`));
    }
  } catch (e) { debug(e); }
  return 0;
}
