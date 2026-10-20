// Koragent as a swarm worker backend (swarm.workerBackend = 'koragent'): the binary resolver, the TaskSpec Kora writes
// for each attempt, the report's `.md` rendering (the five sections kora_wait reads today), and the pure mappings
// from Koragent's events to Kora's pane / worker state. SwarmService (swarm.ts) owns the lifecycle; this file is pure
// helpers plus two small fs writes, so the contract is unit-testable without a pane.
//
// Contract: protocol/koragent.ts. Names: koragent/docs/koragent/NAMES.md (frozen).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentState, SwarmAttempt, SwarmSupplyProviderId } from '../protocol/types';
import type { RuntimeMode } from '../session/events';
import { MANAGED_PATHS } from './worktree';
import type { Budget, GraphPacket, GraphPacketSymbol, ModelRoute, SessionState, TaskReport, TaskSpec } from '../protocol/koragent';

// ── binary ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type KoragentSource = 'env' | 'koragent-home' | 'path';
export interface KoragentBinary { path: string | null; source: KoragentSource | null }

interface ResolveDeps { env?: NodeJS.ProcessEnv; home?: string; isExecutable?: (p: string) => boolean }

function isExecutableFile(p: string): boolean {
  try { if (!fs.statSync(p).isFile()) return false; fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

/** Search order: $KORAGENT_BIN, then $KORAGENT_HOME/bin/koragent (default ~/.koragent/bin/koragent), then PATH. */
export function koragentCandidates(deps: ResolveDeps = {}): { path: string; source: KoragentSource }[] {
  const env = deps.env ?? process.env;
  const home = deps.home ?? os.homedir();
  const out: { path: string; source: KoragentSource }[] = [];
  const explicit = env.KORAGENT_BIN?.trim();
  if (explicit) out.push({ path: explicit.startsWith('~/') ? path.join(home, explicit.slice(2)) : explicit, source: 'env' });
  const kHome = env.KORAGENT_HOME?.trim() || path.join(home, '.koragent');
  out.push({ path: path.join(kHome, 'bin', 'koragent'), source: 'koragent-home' });
  for (const dir of (env.PATH ?? '').split(path.delimiter)) if (dir && path.isAbsolute(dir)) out.push({ path: path.join(dir, 'koragent'), source: 'path' });
  return out;
}

/** The Koragent binary, or `{path: null}` (`kora swarm install --backend koragent` puts one in place). Never throws. */
export function resolveKoragentBinary(deps: ResolveDeps = {}): KoragentBinary {
  const ok = deps.isExecutable ?? isExecutableFile;
  for (const c of koragentCandidates(deps)) { try { if (ok(c.path)) return c; } catch { /* next */ } }
  return { path: null, source: null };
}

export const KORAGENT_NOT_INSTALLED = 'Koragent is not installed (swarm.workerBackend is "koragent"): set KORAGENT_BIN, or install one into ~/.koragent/bin/koragent with kora swarm install --backend koragent --from <binary>';

/** The binary a `kora agent spawn koragent` pane runs (same order as the swarm backend); throws KORAGENT_NOT_INSTALLED. */
export function requireKoragentBinary(deps: ResolveDeps = {}): string {
  const p = resolveKoragentBinary(deps).path;
  if (!p) throw new Error(KORAGENT_NOT_INSTALLED.replace(' (swarm.workerBackend is "koragent")', ''));
  return p;
}

// ── TaskSpec ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** RuntimeMode (the leader thread's posture) → TaskSpec.permission. */
export function koragentPermission(mode: RuntimeMode | undefined): TaskSpec['permission'] {
  if (mode === 'full-access' || mode === 'auto') return 'full';
  if (mode === 'auto-accept-edits') return 'auto-edits';
  return 'supervised';
}

const DECL_RE = /^\s*■\s+(\S+)\s+(.+?)\s+@\s+(\S+?):(\d+)(?:\s+—\s+(.*))?$/;

/** The X1 packet ({text, files} from buildSwarmContextPacket) as a structured GraphPacket; undefined when empty. */
export function graphPacketFrom(packet: { text: string; files: string[] } | null | undefined): GraphPacket | undefined {
  const text = packet?.text?.trim() ?? '';
  if (!text) return undefined;
  const symbols: GraphPacketSymbol[] = [];
  const notes: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || /^##\s/.test(line) || /^\(resolved from the code graph/.test(line)) continue;
    const m = DECL_RE.exec(line);
    if (m) symbols.push({ kind: m[1].toLowerCase(), name: m[2].trim(), file: m[3], line: Number(m[4]), ...(m[5] ? { signature: m[5].trim() } : {}) });
    else notes.push(line);
  }
  return { v: 1, source: 'kora', symbols, files: [...(packet?.files ?? [])], notes, text };
}

export interface TaskSpecInput {
  taskId: string;
  goal: string;
  /** A failover / foreman-retry note appended to the goal (the digest of what went wrong). */
  continuation?: string | null;
  packet?: { text: string; files: string[] } | null;
  check?: string | null;
  checkTimeoutMs?: number;
  budget?: Budget;
  /** Model ids, best first (Kora's Thompson-sampled ranking). */
  route: string[];
  worktree: { path: string; mainRoot: string; branch: string };
  runtimeMode?: RuntimeMode;
  /** The report's `.md` path (what kora_wait reads); the JSON goes next to it. */
  reportMdPath: string;
  orchestratorId: string;
  verify?: { maxFixRounds: number; escalateAfter: number };
}

/** `<dir>/sN.md` → `<dir>/sN.json` (TaskSpec.report.path). */
export function reportJsonPath(reportMdPath: string): string { return reportMdPath.replace(/\.md$/, '') + '.json'; }
/** `<dir>/sN.md` → `<dir>/sN.task.json` (the spec file of the current attempt). */
export function taskSpecPath(reportMdPath: string): string { return reportMdPath.replace(/\.md$/, '') + '.task.json'; }

export function buildTaskSpec(i: TaskSpecInput): TaskSpec {
  const goal = [i.goal.trim(), i.continuation?.trim() ? `---\n${i.continuation.trim()}` : ''].filter(Boolean).join('\n\n');
  const context = graphPacketFrom(i.packet);
  const route: ModelRoute[] = [...new Set(i.route.filter(Boolean))].map((model) => ({ model }));
  const acceptance: TaskSpec['acceptance'] = {};
  if (i.check?.trim()) acceptance.check = i.check.trim();
  if (i.checkTimeoutMs && i.check?.trim()) acceptance.checkTimeoutMs = i.checkTimeoutMs;
  const spec: TaskSpec = {
    v: 1, taskId: i.taskId, goal,
    ...(context ? { context } : {}),
    acceptance,
    budget: { ...(i.budget ?? {}) },
    route,
    worktree: { ...i.worktree },
    permission: koragentPermission(i.runtimeMode),
    report: { path: reportJsonPath(i.reportMdPath) },
    parent: { kind: 'kora', orchestratorId: i.orchestratorId, ...(i.orchestratorId.startsWith('chat:') ? {} : { paneId: i.orchestratorId }) },
    ...(i.verify ? { verify: { ...i.verify } } : {}),
    managedFiles: [...MANAGED_PATHS],
  };
  return spec;
}

/** Write the spec (0600: it names the user's paths) atomically; returns its path. */
export function writeTaskSpec(file: string, spec: TaskSpec): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(spec, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

// ── report ───────────────────────────────────────────────────────────────────────────────────────────────────────

const STATUS_WORD: Record<TaskReport['status'], string> = { done: 'done', partial: 'partial', budget: 'partial', blocked: 'blocked', failed: 'blocked' };

/** A TaskReport as the markdown kora_wait reads: ## Status / Changes / Check / Findings / Blockers (swarm-skill.ts). */
export function renderTaskReport(r: TaskReport): string {
  const word = STATUS_WORD[r.status] ?? 'blocked';
  const qual = r.status === 'budget' ? ' (budget reached)' : r.status === 'failed' ? ' (failed)' : '';
  const out: string[] = ['## Status', `${word}${qual} — ${(r.summary || '').trim() || 'no summary'}`];
  const models = (r.attempts ?? []).map((a) => `${a.model} ${a.outcome}`).join(', ');
  const u = r.usage;
  if (models || u) out.push(`(${[models ? `models: ${models}` : '', u ? `${u.steps} steps, $${Number(u.costUsd || 0).toFixed(4)}` : ''].filter(Boolean).join(' · ')})`);
  out.push('', '## Changes');
  if (!r.changes?.length) out.push('none');
  else for (const c of r.changes) out.push(`- ${c.path} (+${c.added} −${c.removed})${c.note ? ` — ${c.note}` : ''}`);
  out.push('', '## Check');
  if (!r.check) out.push('not run');
  else out.push(`\`${r.check.command}\` → exit ${r.check.exitCode} (run by the harness)`, '```', (r.check.outputTail || '').trimEnd(), '```');
  out.push('', '## Findings');
  if (!r.findings?.length) out.push('none');
  else for (const f of r.findings) out.push(`- ${f.text}${f.ref ? ` (${f.ref})` : ''}`);
  out.push('', '## Blockers');
  if (!r.blockers?.length) out.push('none');
  else for (const b of r.blockers) out.push(`- ${b}`);
  return out.join('\n') + '\n';
}

/** A parsed, shape-checked TaskReport (from an event or the JSON file); null when it is not one. */
export function asTaskReport(v: unknown): TaskReport | null {
  const r = v as TaskReport;
  if (!r || typeof r !== 'object' || typeof r.status !== 'string' || !(r.status in STATUS_WORD)) return null;
  return {
    v: 1, taskId: String(r.taskId ?? ''), sessionId: String(r.sessionId ?? ''), status: r.status, summary: String(r.summary ?? ''),
    changes: Array.isArray(r.changes) ? r.changes.filter((c) => c && typeof c.path === 'string').map((c) => ({ path: c.path, added: Number(c.added) || 0, removed: Number(c.removed) || 0, ...(c.note ? { note: String(c.note) } : {}) })) : [],
    check: r.check && typeof r.check === 'object' && typeof r.check.command === 'string' ? { command: r.check.command, exitCode: Number(r.check.exitCode), outputTail: String(r.check.outputTail ?? ''), ranBy: 'harness' } : null,
    findings: Array.isArray(r.findings) ? r.findings.filter((f) => f && typeof f.text === 'string').map((f) => ({ text: f.text, ...(f.ref ? { ref: String(f.ref) } : {}) })) : [],
    blockers: Array.isArray(r.blockers) ? r.blockers.map(String) : [],
    attempts: Array.isArray(r.attempts) ? r.attempts.filter((a) => a && typeof a.model === 'string').map((a) => ({ model: a.model, outcome: a.outcome })) : [],
    usage: r.usage && typeof r.usage === 'object'
      ? { steps: Number(r.usage.steps) || 0, tokens: { ...(r.usage.tokens ?? {}) }, costUsd: Number(r.usage.costUsd) || 0, refCostUsd: Number(r.usage.refCostUsd) || 0, bySource: { ...(r.usage.bySource ?? {}) } }
      : { steps: 0, tokens: {}, costUsd: 0, refCostUsd: 0, bySource: {} },
  };
}

/** The report JSON Koragent wrote at TaskSpec.report.path; null when absent / not a report. Never follows a symlink. */
export function readTaskReportFile(jsonPath: string): TaskReport | null {
  try {
    const st = fs.lstatSync(jsonPath);
    if (!st.isFile() || st.size === 0 || st.size > 4 << 20) return null;
    return asTaskReport(JSON.parse(fs.readFileSync(jsonPath, 'utf8')));
  } catch { return null; }
}

/**
 * Make sure both report files exist: the JSON at TaskSpec.report.path and the `.md` next to it. Koragent writes them;
 * Kora writes whatever is missing from the report it has (the `task.report` event, or the JSON on disk — the file
 * fallback). `freshAfter` (epoch ms): a file older than this predates the report in hand (an earlier round) and is
 * rewritten. A report path that is a symlink is never written through. Returns true when the `.md` is present after.
 */
export function ensureReportFiles(mdPath: string, report: TaskReport | null, opts: { freshAfter?: number } = {}): boolean {
  const json = reportJsonPath(mdPath);
  const stat = (f: string) => { try { return fs.lstatSync(f); } catch { return null; } };
  const present = (f: string) => { const st = stat(f); return !!st && st.isFile() && st.size > 0; };
  const current = (f: string) => { const st = stat(f); return !!st && st.isFile() && st.size > 0 && (opts.freshAfter == null || st.mtimeMs >= opts.freshAfter); };
  const writable = (f: string) => !stat(f)?.isSymbolicLink();
  const r = report ?? readTaskReportFile(json);
  if (!r) return present(mdPath);
  try {
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    if (!current(json) && writable(json)) fs.writeFileSync(json, JSON.stringify(r, null, 2) + '\n');
    if (!current(mdPath) && writable(mdPath)) fs.writeFileSync(mdPath, renderTaskReport(r));
  } catch { /* the leader still gets the screen tail */ }
  return present(mdPath);
}

// ── event → state mappings ─────────────────────────────────────────────────────────────────────────────────────

/** The pane state a SessionState means (authoritative for a Koragent pane); null = no change (still starting). */
export function paneStateFor(s: SessionState): Exclude<AgentState, 'unknown'> | null {
  switch (s) {
    case 'starting': return null;
    case 'working': case 'retrying': return 'working';
    case 'blocked': return 'blocked';
    case 'ready': case 'done': case 'failed': case 'exited': return 'idle';
    default: return null;
  }
}

/** A route.failover reason → the attempt outcome Kora records for the model it left. */
export function failoverOutcome(reason: string): Exclude<SwarmAttempt['outcome'], 'running' | 'ok'> {
  const r = String(reason || '');
  if (/gone|not.?found|404|not a valid model/i.test(r)) return 'model-gone';
  if (/401|auth|unauthori[sz]ed|api.?key/i.test(r)) return 'auth-failed';
  if (/crash/i.test(r)) return 'crashed';
  return 'rate-limited';
}

/** The env var that carries each provider's key. OPENCODE_API_KEY is Zen's (an external contract Koragent keeps). */
const KEY_ENV: Partial<Record<SwarmSupplyProviderId, string>> = { zen: 'OPENCODE_API_KEY', openrouter: 'OPENROUTER_API_KEY', cerebras: 'CEREBRAS_API_KEY' };

/**
 * A Koragent pane's env: the keys of the providers on its route (nothing else — the pane starts from the isolated
 * allowlist), plus Kora's non-secret task identity. No OPENCODE_* config vars: the TaskSpec carries the config.
 */
export function koragentPaneEnv(input: {
  taskId: string; reportMdPath: string; providers: SwarmSupplyProviderId[]; apiKey: (p: SwarmSupplyProviderId) => string | null;
  /** The route's model ids: a local one (ollama/…, lmstudio/…) needs its server declared (KORAGENT_CONFIG_CONTENT). */
  route?: string[];
  /** A local server's base URL (config swarm.local.<p>.baseUrl). */
  localBaseUrl?: (p: 'ollama' | 'lmstudio') => string;
}): Record<string, string> {
  const env: Record<string, string> = { KORA_REPORT: input.reportMdPath, KORA_SWARM_TASK_ID: input.taskId };
  // The code graph the daemon indexes into: a non-default store (KORAGRAPH_DB / KORAGRAPH_HOME) must reach the worker,
  // or its graph tools and injection read a different store that never indexed this repo (bench5x: "not-indexed").
  for (const k of ['KORAGRAPH_DB', 'KORAGRAPH_HOME'] as const) if (process.env[k]) env[k] = process.env[k]!;
  // Local model servers: Koragent (like OpenCode) knows Ollama / LM Studio only as an OpenAI-compatible provider block
  // with a base URL. The TaskSpec has no field for it (the contract carries model ids only), so the block rides in
  // KORAGENT_CONFIG_CONTENT — the only config env Kora sets, and only when a local model is on the route. No key.
  const local = (input.route ?? []).filter((m) => /^(ollama|lmstudio)\//.test(m));
  if (local.length) {
    const { localProviderConfig } = require('./swarm-opencode') as typeof import('./swarm-opencode');
    const provider: Record<string, any> = {};
    for (const m of local) {
      const p = m.slice(0, m.indexOf('/')) as 'ollama' | 'lmstudio';
      const base = input.localBaseUrl?.(p) ?? (p === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:1234');
      const block = localProviderConfig(p, base, m)[p] as any;
      provider[p] = provider[p] ? { ...provider[p], models: { ...provider[p].models, ...block.models } } : block;
    }
    env.KORAGENT_CONFIG_CONTENT = JSON.stringify({ provider });
  }
  for (const p of new Set(input.providers)) {
    const v = KEY_ENV[p];
    if (!v) continue;
    let key: string | null = null;
    try { key = input.apiKey(p); } catch { key = null; }
    if (key) env[v] = key;
  }
  return env;
}

/** macOS caps a unix socket path at 104 bytes (sun_path), Linux at 108; Koragent refuses a longer one. */
const SUN_PATH_MAX = process.platform === 'darwin' ? 104 : 108;

/**
 * `~/.kora/panes/<paneId>.sock` (NAMES.md). A KORA_HOME deep enough to push that past the unix-socket limit (found
 * live: an isolated home under a long scratch dir; Koragent then exits "path is too long") falls back to a short
 * per-home dir under the OS temp dir: `<tmp>/kora-<hash of home>/<paneId>.sock` (the caller makes it 0700).
 */
export function paneSocketPath(koraHomeDir: string, paneId: string): string {
  const p = path.join(koraHomeDir, 'panes', `${paneId}.sock`);
  if (Buffer.byteLength(p) < SUN_PATH_MAX) return p;
  const h = require('node:crypto').createHash('sha256').update(path.resolve(koraHomeDir)).digest('hex').slice(0, 10);
  // oxlint-disable-next-line kora/no-posix-only-paths -- Koragent listens on unix sockets only (Windows pipe naming is open, docs/windows/PORT.md); /tmp is the short-path fallback
  for (const base of [os.tmpdir(), '/tmp']) {
    const q = path.join(base, `kora-${h}`, `${paneId}.sock`);
    if (Buffer.byteLength(q) < SUN_PATH_MAX) return q;
  }
  return p;
}

/**
 * Make `dir` (a pane socket folder) and refuse it unless it is ours: a real folder (not a symlink), owned by this user,
 * closed to group/other (2026-10-15 audit #8). `mkdirSync({mode})` neither checks nor tightens a folder that already
 * exists, and the /tmp fallback above has a predictable name: another local user could make it first and answer for
 * Koragent. Throws when the folder is someone else's.
 */
export function ensurePrivateSocketDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return;
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a plain folder: refusing it for a pane socket`);
  if (st.uid !== process.getuid()) throw new Error(`${dir} belongs to another user: refusing it for a pane socket`);
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

// ── what a retry / respawn brief says about a Koragent attempt (D21) ─────────────────────────────────────────────

/** How many recent events a task keeps for the brief. */
export const RECENT_EVENTS = 10;

/** One event as a brief line, or null when it says nothing a successor needs (progress ticks, acks, the handshake). */
export function recentEventLine(e: { type: string; [k: string]: any }): string | null {
  const cut = (x: unknown, n = 160) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  switch (e.type) {
    case 'tool.start': return `${cut(e.tool, 40)}: ${cut(e.title)}`;
    case 'tool.end': return e.status && e.status !== 'completed' ? `  → ${cut(e.status, 40)}${e.exitCode != null ? ` (exit ${e.exitCode})` : ''}` : null;
    case 'session.state': return e.state === 'blocked' || e.state === 'failed' || e.state === 'retrying' ? `${e.state}: ${cut(e.blockedOn || e.reason || '')}` : null;
    case 'permission.request': return `waited on permission: ${cut(e.tool, 40)} — ${cut(e.summary)}`;
    case 'route.failover': return `model ${cut(e.from, 60)} → ${cut(e.to, 60)} (${cut(e.reason, 80)})`;
    case 'task.check': return e.exitCode != null ? `check ${cut(e.command, 80)} → exit ${e.exitCode}` : null;
    case 'error': return `error: ${cut(e.message)}`;
    default: return null;
  }
}

/**
 * The digest of a Koragent attempt for the next worker: its last report (status, summary, blockers, changes) and its
 * last events. Never the pane's screen: that is the TUI's chrome (HUD, footer, composer), not facts.
 */
export function koragentDigest(kg: { report: TaskReport | null; recent?: string[] } | null): string {
  const parts: string[] = [];
  const r = kg?.report;
  if (r) {
    parts.push(`last report: status ${r.status}${r.summary ? ` — ${r.summary.replace(/\s+/g, ' ').slice(0, 400)}` : ''}`);
    if (r.changes.length) parts.push(`changes: ${r.changes.slice(0, 12).map((c) => c.path).join(', ')}`);
    if (r.check) parts.push(`check \`${r.check.command}\` → exit ${r.check.exitCode}`);
    for (const b of r.blockers.slice(0, 5)) parts.push(`blocker: ${b.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  const recent = (kg?.recent ?? []).slice(-RECENT_EVENTS);
  if (recent.length) parts.push(`last events:\n${recent.map((l) => `- ${l}`).join('\n')}`);
  return parts.length ? `previous worker (koragent):\n${parts.join('\n')}` : '';
}
