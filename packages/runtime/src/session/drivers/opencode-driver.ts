// The OpenCode SessionDriver - OpenCode (free Zen/OpenRouter models) as a CHAT engine for blobs, so a machine with no
// paid CLI still has working blobs (docs/bots/ARCH.md D5, ruling 6). Shape = CodexDriver: no persistent process, one
// `opencode run --format json` child per turn, the session id captured from the first event and passed back with `-s`.
//
//   opencode run --pure --format json [-s ses_…] -m provider/model [--auto] -- "<prompt>"     (cwd = the thread's folder)
//
// Events are parsed by the PURE ./opencode-parse (fixtures in opencode-driver.test.ts). Permissions cannot be asked
// mid-turn (`run` auto-rejects "ask"), so a posture is an OPENCODE_PERMISSION policy; project config is always off.
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ChatEvent, UnsequencedChatEvent, ThreadId, TurnId, RequestId, ItemId, ApprovalAnswer, UserInputAnswers, ModelChoice, RuntimeMode, PromptAttachment,
} from '../events';
import { newTurnId } from '../events';
import type { SessionDriver, DriverCapabilities, SessionStartInput, SendTurnInput, TurnHandle, DriverDeps } from '../session-driver';
import type { AgentId } from '../../protocol/types';
import { blobHome } from '../../blobs/home';
import { ParkedApprovals, askVia } from '../../blobs/apps/approval';
import { wrapReadDeny } from '../os-sandbox';
import { OPENCODE_PATTERN_KILL_DENY } from '../sensitive-guard';
import { OPENCODE_GRAPH_READ_ALLOW } from '../plan-mode';
import { engineSpawnEnv, engineSpawnProblem } from '../../detect/engine-binary';
import { log } from '../../server/log';
import { currentSize, opencodeLogPath, rateLimitMessage, readAppended, scanOpencodeLog, stderrLooksRateLimited } from './opencode-limits';
import { drainOpencodeLines, mapOpencodeEvent, newOpencodeTurnState, opencodeTurnUsage, type OpencodeTurnState } from './opencode-parse';
import { trackChild } from '../../server/children';
import { terminateChild } from './engine-common';
import { proxyPaneId } from './claude-driver';
import { CallTracker, logCost } from '../../util/cost-log';
import { catalogContextWindow } from '../../ledger/prices';
import { isBlobsCwd } from '../../blobs/home';

/** Shell patterns a blob on Auto never runs unattended: they send data out or act outside the folder. */
export const OPENCODE_BASH_DENY = [...OPENCODE_PATTERN_KILL_DENY, 'curl *', 'wget *', 'ssh *', 'scp *', 'sftp *', 'rsync *', 'nc *', 'git push*', 'gh *', 'npm publish*', 'pnpm publish*', 'open *', 'osascript *', 'sudo *', 'rm -rf /*', 'rm -rf ~*'];

/**
 * OPENCODE_PERMISSION for a posture (later keys win in opencode, so the catch-all comes first).
 *   approval-required -> read-only: read/search tools only, nothing that writes or runs
 *   auto-accept-edits / auto -> edits + reads + shell inside the folder; external directories and outbound shell denied
 *   full-access -> everything (the run also passes --auto)
 */
export function opencodePermissionEnv(mode: RuntimeMode | undefined, o: { blobHome?: string; plan?: boolean } = {}): Record<string, string> {
  let permission: Record<string, unknown>;
  // A plan turn is read-only whatever the posture (env permission is merged AFTER the plan agent's own rules, so a
  // Full access `*: allow` would otherwise un-deny its edits): reads, and shell only for the read-only graph queries.
  if (o.plan) permission = { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', webfetch: 'allow', websearch: 'allow', question: 'deny', bash: { '*': 'deny', ...Object.fromEntries(OPENCODE_GRAPH_READ_ALLOW.map((p) => [p, 'allow'])) } };
  else if (mode === 'full-access') permission = { '*': 'allow', bash: { '*': 'allow', ...Object.fromEntries(OPENCODE_PATTERN_KILL_DENY.map((p) => [p, 'deny'])) }, question: 'deny' };
  else if (mode === 'approval-required' || mode === undefined) permission = { '*': 'ask', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', webfetch: 'allow', websearch: 'allow', question: 'deny' };
  else {
    permission = {
      edit: 'allow', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', webfetch: 'allow', websearch: 'allow', question: 'deny',
      bash: { '*': 'allow', ...Object.fromEntries(OPENCODE_BASH_DENY.map((p) => [p, 'deny'])) },
      external_directory: o.blobHome ? { [`${o.blobHome}/**`]: 'allow' } : 'deny',
    };
  }
  return { OPENCODE_PERMISSION: JSON.stringify(permission) };
}

/** Free models keep a rate limit for at least this long (the swarm's floor, server/swarm.ts cooldownUntil). */
export const OPENCODE_LIMIT_COOLDOWN_MS = 15 * 60_000;

/** OpenCode: the `kora_fleet` entry (`kora mcp --fleet`) merged into the per-run OPENCODE_CONFIG_CONTENT. */
export function withOpencodeFleetMcp(configContent: string | undefined, spec: { command: string; args: string[] }): string {
  let cfg: Record<string, any> = {};
  try { const p = configContent ? JSON.parse(configContent) : {}; if (p && typeof p === 'object') cfg = p; } catch { cfg = {}; }
  cfg.mcp = { ...(cfg.mcp && typeof cfg.mcp === 'object' ? cfg.mcp : {}), kora_fleet: { type: 'local', command: [spec.command, ...spec.args], enabled: true } };
  return JSON.stringify(cfg);
}

export interface OpencodeDriverOptions {
  /** opencode's own log file (default: the XDG data dir). Tests point it at a temp file. */
  logPath?: string;
  /** How often the rate-limit watchdog looks (ms). */
  pollMs?: number;
  /** A rate limit counts once the turn made no progress for this long after it was seen (ms). */
  graceMs?: number;
}

export type OpencodeSpawnFn = (command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess;

interface State {
  threadId: ThreadId;
  lastUserAt?: number;
  input: SessionStartInput;
  sessionId: string | null;
  playbookSent: boolean;
  model: ModelChoice | null;
  currentTurnId: TurnId | null;
  child: ChildProcess | null;
  buf: string;
  st: OpencodeTurnState;
  usedModel: string | null;
  settled: boolean;
  stopped: boolean;
  readOnlyNoticed?: boolean;
  /** Plan mode (the composer's Plan toggle): turns run OpenCode's built-in `plan` agent. */
  planMode?: boolean;
  /** The cost log (savings meter): one row per finished step. */
  callTracker: CallTracker;
  /** When this turn's child started, and the last time it produced text / a tool / a finished step. */
  spawnedAt: number;
  lastProgressAt: number;
  /** A rate limit was seen (stdout error, stderr or opencode's log) at this time and the turn has not moved since. */
  limitSeenAt: number | null;
  limitEmitted: boolean;
  watch: ReturnType<typeof setInterval> | null;
  logOffset: number;
  stderrTail: string;
  /** This turn's one-time caller-key file for the fleet bridge, until it is read or the turn ends. */
  callerKeyFile?: string | undefined;
}

export class OpenCodeDriver implements SessionDriver {
  readonly agent: AgentId = 'opencode';
  readonly capabilities: DriverCapabilities = { modelSwitch: 'restart-only', promptlessContinuation: false, conversationRollback: false, manualCompaction: false, canSpawnWorkers: false, reportsToolStart: false }; // `run --format json` reports finished calls only
  private sessions = new Map<ThreadId, State>();
  private listeners = new Set<(e: ChatEvent) => void>();
  /** Yes/no questions a blob's connected-app tools park (outbound actions); answered through `respondToApproval`. */
  private appAsks = new ParkedApprovals();

  constructor(private deps: DriverDeps, private spawnFn: OpencodeSpawnFn = defaultSpawn, private opts: OpencodeDriverOptions = {}) {}

  streamEvents(onEvent: (e: ChatEvent) => void): () => void { this.listeners.add(onEvent); return () => this.listeners.delete(onEvent); }
  hasSession(threadId: ThreadId): boolean { const s = this.sessions.get(threadId); return !!s && !s.stopped; }

  private emit(threadId: ThreadId, ev: UnsequencedChatEvent): void {
    const full = { seq: 0, at: Date.now(), ...ev, threadId } as ChatEvent;
    for (const l of this.listeners) { try { l(full); } catch { /* isolate a bad listener */ } }
  }

  async startSession(input: SessionStartInput): Promise<{ threadId: ThreadId; resume?: unknown }> {
    const existing = this.sessions.get(input.threadId);
    if (existing) return { threadId: input.threadId, resume: existing.sessionId ?? undefined };
    // The resume cursor lands on argv: only a plain session id.
    const sessionId = typeof input.resume === 'string' && /^ses_[A-Za-z0-9]{6,64}$/.test(input.resume) ? input.resume : null;
    this.sessions.set(input.threadId, {
      threadId: input.threadId, input, sessionId, playbookSent: false, model: input.model ?? null, currentTurnId: null, child: null, buf: '',
      st: newOpencodeTurnState(), usedModel: null, settled: false, stopped: false,
      spawnedAt: 0, lastProgressAt: 0, limitSeenAt: null, limitEmitted: false, watch: null, logOffset: 0, stderrTail: '',
      callTracker: new CallTracker(!!sessionId),
    });
    this.emit(input.threadId, { type: 'session.started' });
    if (sessionId) this.emit(input.threadId, { type: 'thread.started', providerThreadId: sessionId });
    this.emit(input.threadId, { type: 'session.state', state: 'ready' });
    return { threadId: input.threadId, resume: sessionId ?? undefined };
  }

  async sendTurn(input: SendTurnInput): Promise<TurnHandle> {
    const state = this.sessions.get(input.threadId);
    if (!state) throw new Error(`no live session for thread ${input.threadId}`);
    if (state.child) await this.interruptTurn(input.threadId).catch(() => {});
    if (input.origin !== 'kora-notice') state.lastUserAt = Date.now();
    if (input.origin !== 'kora-notice' && !input.continuation) state.planMode = input.interactionMode === 'plan';
    let text = input.text ?? '';
    // Per-prompt graph injection, as in the Claude and Codex lanes (`opencode run` has no prompt hook). Best-effort and
    // bounded; never on a blob (no graph there) or a Kora notice.
    if (text && input.origin !== 'kora-notice' && !text.trim().startsWith('/') && !isBlobsCwd(state.input.cwd)) {
      try {
        const { injectForPrompt } = require('../../graph/prompt-inject') as typeof import('../../graph/prompt-inject');
        const inj = await injectForPrompt({
          prompt: text, cwd: state.input.cwd, sessionId: input.threadId, lane: 'opencode-chat',
          ...(this.deps.graphStatus ? { graph: { status: (c: string) => this.deps.graphStatus!(c), callTool: (n: any, a: Record<string, unknown>, o: { cwd: string; fresh?: boolean }) => this.deps.graphCall(n, a, o) } } : {}),
        });
        if (inj) text = `${inj}\n\n${text}`;
      } catch { /* injection is best-effort */ }
    }
    if (input.koraNotice) text = text ? `${input.koraNotice}\n\n${text}` : input.koraNotice;
    const files = (input.attachments ?? []).map((a: PromptAttachment) => `Attached file: ${a.name ?? a.path} at ${a.path}${a.mimeType ? ` (${a.mimeType})` : ''}`).join('\n');
    if (files) text = text ? `${text}\n\n${files}` : files;
    if (!state.playbookSent) { // `opencode run` has no system-prompt hook: the blob prompt rides in front of the first turn
      const pb = this.deps.appendSystemPrompt(state.input);
      if (pb) text = `${pb}\n\n---\n\n${text}`;
      state.playbookSent = true;
    }
    if (input.model?.model) { const changed = input.model.model !== state.model?.model; state.model = input.model; if (changed) this.emit(input.threadId, { type: 'model.rerouted', to: input.model.model, reason: 'per-turn override (restart)' }); }
    const turnId: TurnId = newTurnId();
    state.currentTurnId = turnId; state.buf = ''; state.st = newOpencodeTurnState(); state.settled = false;
    this.emit(input.threadId, { type: 'turn.started', turnId, ...(state.model?.model ? { model: state.model.model } : {}) });
    this.spawnTurn(state, text);
    return { threadId: input.threadId, turnId };
  }

  private fail(state: State, message: string): void {
    this.stopWatch(state);
    this.deps.blobs?.mcpRevoke?.(state.threadId);
    this.dropCallerKeyFile(state);
    if (state.settled) return;
    state.settled = true;
    const turnId = state.currentTurnId;
    this.emit(state.threadId, { type: 'runtime.error', errorClass: 'provider', message });
    if (turnId) this.emit(state.threadId, { type: 'turn.settled', turnId, state: 'failed', errorMessage: message });
    state.currentTurnId = null;
    this.emit(state.threadId, { type: 'session.state', state: 'ready' });
  }

  private spawnTurn(state: State, prompt: string): void {
    const oc = this.deps.opencode;
    const binary = oc?.binary() ?? null;
    if (!binary) return this.fail(state, 'OpenCode is not installed. Open Settings and enable free workers, or pick another engine for this blob.');
    const model = state.model?.model ?? oc?.pickModel() ?? null;
    if (!model) return this.fail(state, 'No free model is available right now (all rate-limited or not set up). Try again in a few minutes, or pick another engine.');
    state.usedModel = model;
    const mode = state.input.runtimeMode;
    if (mode === 'approval-required' && !state.readOnlyNoticed) {
      state.readOnlyNoticed = true;
      this.emit(state.threadId, { type: 'runtime.warning', message: 'OpenCode cannot ask for approvals, so in Supervised mode it can read and search but not edit or run commands. Switch to Auto or Full access to let it work.' });
    }
    let bh: string | undefined;
    let blobId: string | null = null;
    try { const b = this.deps.blobs?.byCwd(state.input.cwd); if (b) { bh = blobHome(b.id); blobId = b.id; } } catch { /* not a blob */ }
    // Effort is the model's own variant (`opencode models --verbose` lists them); only for the model it was picked with.
    const variant = state.model?.model === model ? state.model.effort : undefined;
    // `--` ends option parsing: the prompt is user text and must never be read as flags.
    const args = ['run', '--pure', '--format', 'json', ...(state.sessionId ? ['-s', state.sessionId] : []), '-m', model, ...(variant ? ['--variant', variant] : []), ...(state.planMode ? ['--agent', 'plan'] : mode === 'full-access' ? ['--auto'] : []), '--', prompt];
    const env: NodeJS.ProcessEnv = engineSpawnEnv({
      ...process.env, ...(oc ? oc.env(model) : {}), ...opencodePermissionEnv(mode, { blobHome: bh, ...(state.planMode ? { plan: true } : {}) }),
      // `opencode run` works in $PWD, not in the folder it was spawned in: spawn() sets the cwd but leaves the daemon's own
      // PWD in the environment, so every tool ran in the folder the daemon was started from (seen live: a Plan turn read
      // the daemon's checkout instead of the project).
      PWD: state.input.cwd,
      // Project config is always off for a blob (it writes files in its own cwd); web search tool on.
      OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_ENABLE_EXA: '1',
    }, binary);
    // The user's extensions (Settings › Extensions); Kora's own entries merged below win on a name clash.
    env.OPENCODE_CONFIG_CONTENT = (require('../../extensions') as typeof import('../../extensions')).opencodeSessionConfig(env.OPENCODE_CONFIG_CONTENT, { ...state.input, threadId: state.threadId }, this.deps.isFolderTrusted);
    if (env.OPENCODE_CONFIG_CONTENT === undefined) delete env.OPENCODE_CONFIG_CONTENT;
    // The blob's tools over MCP (`kora_blobs`): merged into the per-run config; the token is revoked when the turn ends.
    const blobs = this.deps.blobs;
    if (blobId && blobs?.mcpIssue && this.deps.socketPath && this.deps.binPath) {
      try {
        const { blobsMcpSpec, withOpencodeBlobsMcp } = require('../../blobs/mcp-wire') as typeof import('../../blobs/mcp-wire');
        const threadId = state.threadId;
        const turn = () => (state.currentTurnId ? { turnId: state.currentTurnId } : {});
        blobs.mcpRevoke?.(threadId);
        const token = blobs.mcpIssue({
          blobId, threadId, agent: 'opencode', cwd: state.input.cwd,
          emitCard: (card) => this.emit(threadId, { type: 'blob.card', card, ...turn() }),
          fullAccess: () => state.input.runtimeMode === 'full-access',
          userMessageSince: (since: number) => (state.lastUserAt ?? 0) > since,
          askApproval: askVia(this.appAsks, threadId, (ev) => this.emit(threadId, ev as UnsequencedChatEvent), turn),
          attachOutput: (p, caption) => {
            const itemId: ItemId = `attach_${threadId}_${Date.now().toString(36)}`;
            this.emit(threadId, { type: 'tool.started', itemId, toolKind: 'file_change', toolName: 'attach_output', title: caption ? `${caption} - ${path.basename(p)}` : `attach ${path.basename(p)}`, input: { file_path: p }, ...turn() });
            this.emit(threadId, { type: 'tool.result', itemId, status: 'completed', changedFiles: [{ path: p, additions: 0, deletions: 0 }], ...turn() });
          },
        });
        env.OPENCODE_CONFIG_CONTENT = withOpencodeBlobsMcp(env.OPENCODE_CONFIG_CONTENT, blobsMcpSpec({ binPath: this.deps.binPath, socketPath: this.deps.socketPath, blobId, token, threadId, agent: 'opencode' }));
      } catch (e: any) { log(`chat ${state.threadId}: blob tools unavailable on opencode: ${e?.message ?? e}`); }
    }
    // An orchestrator thread's fleet tools (`kora mcp --fleet`), the way CodexDriver wires them: identity + a one-time
    // caller-key file path on argv (the MCP server's environment is not the turn's).
    if (state.input.isOrchestrator && !state.input.helpersOff && this.deps.socketPath && this.deps.binPath) {
      try {
        const kh = (require('../../protocol/types') as typeof import('../../protocol/types')).koraHome();
        this.dropCallerKeyFile(state);
        state.callerKeyFile = (require('../../server/control-auth') as typeof import('../../server/control-auth')).writeCallerKeyFile(proxyPaneId(state.threadId), kh) ?? undefined;
        const effort = state.model?.effort ?? state.input.model?.effort;
        env.OPENCODE_CONFIG_CONTENT = withOpencodeFleetMcp(env.OPENCODE_CONFIG_CONTENT, { command: process.execPath, args: [this.deps.binPath, 'mcp', '--fleet',
          '--orchestrator', proxyPaneId(state.threadId), '--socket', this.deps.socketPath, '--agent', 'opencode',
          ...(state.callerKeyFile ? ['--caller-key-file', state.callerKeyFile] : []),
          ...(state.input.agentMode ? ['--agent-mode', state.input.agentMode] : []),
          ...(state.input.runtimeMode ? ['--runtime-mode', state.input.runtimeMode] : []),
          '--model', model, ...(effort ? ['--effort', effort] : []),
          ...(state.input.account ? ['--account', state.input.account] : []),
          '--kora-home', kh] });
      } catch (e: any) { log(`chat ${state.threadId}: fleet tools unavailable on opencode: ${e?.message ?? e}`); }
    }
    let child: ChildProcess;
    try { child = this.spawnFn(binary, args, { cwd: state.input.cwd, env }); }
    catch (e: any) { return this.fail(state, engineSpawnProblem('opencode', e) ?? `failed to start opencode: ${e?.message ?? e}`); }
    state.child = child;
    this.emit(state.threadId, { type: 'session.state', state: 'running' });
    this.startWatch(state);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => this.onStdout(state, c));
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (c: string) => {
      stderr = (stderr + c).slice(-2000);
      if (state.limitSeenAt === null && stderrLooksRateLimited(c)) state.limitSeenAt = Date.now();
    });
    child.on('error', (e: any) => this.fail(state, engineSpawnProblem('opencode', e) ?? `opencode process error: ${e?.message ?? e}`));
    child.on('close', (code, signal) => this.onExit(state, code, signal, stderr));
  }

  private onStdout(state: State, chunk: string): void {
    state.buf += chunk;
    const { events, rest } = drainOpencodeLines(state.buf);
    state.buf = rest;
    for (const evt of events) {
      const had = state.st.sessionId;
      const mapped = mapOpencodeEvent(evt, state.st, state.currentTurnId ?? undefined);
      for (const c of state.st.calls.splice(0)) logCost({ ...state.callTracker.record({ model: state.usedModel, ...c }, Date.now(), state.threadId), h: 'opencode' });
      if (!had && state.st.sessionId) state.sessionId = state.st.sessionId;
      const kind = String(evt?.type ?? '');
      if (kind === 'text' || kind === 'reasoning' || kind === 'tool_use' || kind === 'step_finish') {
        state.lastProgressAt = Date.now();
        if (state.limitSeenAt !== null && state.lastProgressAt > state.limitSeenAt) state.limitSeenAt = null; // it recovered
      }
      if (state.st.rateLimited && state.limitSeenAt === null && kind === 'error') state.limitSeenAt = Date.now();
      // The rate-limit event goes out once, WITH its reset time, from `reportLimit` - never twice.
      for (const m of mapped) {
        if (m.type === 'usage.rate-limit') continue;
        // OpenCode reports no window: the price catalog's limit for the model, when it lists one (ledger/prices.ts).
        if (m.type === 'thread.token-usage' && m.usage.maxTokens === undefined) { const max = catalogContextWindow(state.usedModel); if (max) { this.emit(state.threadId, { ...m, usage: { ...m.usage, maxTokens: max } }); continue; } }
        this.emit(state.threadId, m);
      }
    }
  }

  private onExit(state: State, code: number | null, signal: NodeJS.Signals | null, stderr: string): void {
    if (state.buf.trim()) this.onStdout(state, '\n');
    state.child = null;
    this.stopWatch(state);
    this.deps.blobs?.mcpRevoke?.(state.threadId);
    this.dropCallerKeyFile(state);
    this.appAsks.cancelThread(state.threadId);
    if (state.stopped || state.settled) return;
    const turnId = state.currentTurnId;
    const interrupted = signal === 'SIGTERM' || signal === 'SIGKILL';
    if (state.st.rateLimited && !interrupted) this.reportLimit(state);
    if (turnId) {
      state.settled = true;
      if (interrupted) this.emit(state.threadId, { type: 'turn.settled', turnId, state: 'interrupted' });
      else if (state.st.errors.size || (code !== 0 && !state.st.finished)) {
        const said = state.st.rateLimited ? rateLimitMessage(state.usedModel) : [...state.st.errors].pop() ?? `opencode exited (code ${code ?? 'null'})${stderr.trim() ? `: ${stderr.trim().slice(-300)}` : ''}`;
        if (!state.st.errors.size || state.st.rateLimited) this.emit(state.threadId, { type: 'runtime.error', errorClass: 'provider', message: said });
        this.emit(state.threadId, { type: 'turn.settled', turnId, state: 'failed', errorMessage: said });
      } else {
        const usage = opencodeTurnUsage(state.st);
        this.emit(state.threadId, { type: 'turn.settled', turnId, state: 'completed', ...(usage ? { usage } : {}) });
      }
    }
    state.currentTurnId = null;
    this.emit(state.threadId, { type: 'session.state', state: 'ready' });
    log(`chat ${state.threadId}: opencode turn ended (${state.usedModel}, code ${code})`);
  }

  // ── rate-limit watchdog ──────────────────────────────────────────────────────────────────────────────────────────
  // OpenCode retries a 429 forever and prints nothing: look at stderr, the JSON error events and its log file, and once
  // the turn has made no progress for `graceMs` after a limit was seen, kill the child and say so (<= ~20 s end to end).
  private startWatch(state: State): void {
    this.stopWatch(state);
    const logPath = this.opts.logPath ?? opencodeLogPath();
    state.spawnedAt = Date.now(); state.lastProgressAt = state.spawnedAt; state.limitSeenAt = null; state.limitEmitted = false;
    state.logOffset = currentSize(logPath);
    const grace = this.opts.graceMs ?? 8_000;
    state.watch = setInterval(() => {
      if (!state.child || state.settled || state.stopped) return this.stopWatch(state);
      const r = readAppended(logPath, state.logOffset);
      state.logOffset = r.offset;
      if (r.text && state.limitSeenAt === null) {
        const hits = scanOpencodeLog(r.text, { model: state.usedModel, sessionId: state.sessionId, since: state.spawnedAt - 2_000 });
        if (hits.length && hits[hits.length - 1]!.at >= state.lastProgressAt - 2_000) state.limitSeenAt = Date.now();
      }
      if (state.limitSeenAt !== null && Date.now() - Math.max(state.limitSeenAt, state.lastProgressAt) >= grace) this.giveUp(state);
    }, this.opts.pollMs ?? 2_000);
    state.watch.unref?.();
  }

  private dropCallerKeyFile(state: State): void {
    if (state.callerKeyFile) { try { fs.unlinkSync(state.callerKeyFile); } catch { /* the bridge took it */ } }
    state.callerKeyFile = undefined;
  }

  private stopWatch(state: State): void { if (state.watch) { clearInterval(state.watch); state.watch = null; } }

  /** The model is rate-limited: cool it, tell the thread (card with "Continue on a free model"), stop the child, fail the turn. */
  private giveUp(state: State): void {
    this.stopWatch(state);
    if (state.settled) return;
    this.reportLimit(state);
    const message = rateLimitMessage(state.usedModel);
    const child = state.child;
    this.fail(state, message); // settles first: the child's own exit is then ignored
    terminateChild(child);
    log(`chat ${state.threadId}: opencode ${state.usedModel} rate-limited, gave up after ${Math.round((Date.now() - state.spawnedAt) / 1000)}s`);
  }

  private reportLimit(state: State): void {
    if (state.limitEmitted) return;
    state.limitEmitted = true;
    if (state.usedModel) { try { this.deps.opencode?.markCooling(state.usedModel, 'rate-limited'); } catch { /* advisory */ } }
    this.emit(state.threadId, { type: 'usage.rate-limit', message: rateLimitMessage(state.usedModel), resetsAt: Date.now() + OPENCODE_LIMIT_COOLDOWN_MS, ...(state.currentTurnId ? { turnId: state.currentTurnId } : {}) });
  }

  async interruptTurn(threadId: ThreadId, _turnId?: TurnId): Promise<void> {
    this.appAsks.cancelThread(threadId); // an app action waiting for its OK is denied when the turn is stopped
    const child = this.sessions.get(threadId)?.child;
    if (!child) return;
    terminateChild(child);
  }

  async respondToApproval(t: ThreadId, r: RequestId, d: ApprovalAnswer): Promise<void> {
    this.appAsks.respond(t, r, d); // `opencode run` never asks itself; only a connected-app action can be waiting for an OK
  }
  async respondToUserInput(_t: ThreadId, _r: RequestId, _a: UserInputAnswers): Promise<void> { /* questions are denied in run mode */ }

  async setPermissionMode(threadId: ThreadId, mode: RuntimeMode): Promise<void> {
    const s = this.sessions.get(threadId); if (!s) return;
    s.input = { ...s.input, runtimeMode: mode };
    if (mode !== 'approval-required') s.readOnlyNoticed = false;
  }
  async setModel(threadId: ThreadId, model: ModelChoice): Promise<void> {
    const s = this.sessions.get(threadId); if (!s) return;
    s.model = model;
    this.emit(threadId, { type: 'model.rerouted', to: model.model, reason: 'setModel (applies next turn)' });
  }
  async stopSession(threadId: ThreadId): Promise<void> {
    const s = this.sessions.get(threadId); if (!s) return;
    s.stopped = true;
    this.stopWatch(s);
    this.appAsks.cancelThread(threadId);
    this.deps.blobs?.mcpRevoke?.(threadId);
    this.dropCallerKeyFile(s);
    if (s.child) { terminateChild(s.child); s.child = null; }
    this.emit(threadId, { type: 'session.exited', recoverable: true });
    this.emit(threadId, { type: 'session.state', state: 'stopped' });
    this.sessions.delete(threadId);
  }
}

function defaultSpawn(command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcess {
  // No tool hooks on this lane: the CLI runs under an OS read-deny for credential paths (session/os-sandbox.ts).
  const w = wrapReadDeny('opencode', command, args);
  return trackChild(spawn(w.command, w.args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: w.windowsVerbatimArguments }), 'chat opencode');
}
