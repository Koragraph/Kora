// The generic ACP SessionDriver (Phase 7): any Agent Client Protocol CLI (Grok CLI, Cursor agent, Kimi, Qwen, a configured Gemini CLI,
// Factory Droid, Hermes, OpenCode-ACP, a custom one) drives a blob. JSON-RPC over stdio, see ./acp-client.
//
//   one driver instance per ENGINE (agentId); one agent process per THREAD, kept alive across turns (./acp-pool)
//   turn   : session/prompt (streamed session/update -> ChatEvents)         cancel : session/cancel
//   resume : session/load on a fresh process. A process that already holds a session and refuses session/load gets
//            exactly ONE replacement process; only if that fails too does the thread start a new session - and then
//            with a visible warning, never silently (the conversation is lost, the user must know).
//   perms  : session/request_permission -> posture (engine-common postureVerdict) -> auto-pick an option or a Kora
//            approval. Auto choices use allow_ONCE so the agent keeps asking and the policy keeps applying.
//   fs/*   : confined to the blob workspace (+ blob home / attachments for reads). terminal/*: spawned in the workspace,
//            outbound commands ask unless Full access.
//   MCP    : the blob's tools reach the agent as an ACP stdio mcpServer (`kora mcp --blobs`, same bridge Codex/OpenCode get).
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AgentId } from '../../protocol/types';
import type {
  ApprovalAnswer, ApprovalKind, PromptAttachment, ItemId, ModelChoice, PlanStep, RequestId, RuntimeMode, ThreadId, ToolKind, TurnId, TurnUsage, UserInputAnswers, FileChange,
} from '../events';
import { newTurnId } from '../events';
import type { DriverCapabilities, DriverDeps, SendTurnInput, SessionDriver, SessionStartInput, TurnHandle } from '../session-driver';
import { blobHome } from '../../blobs/home';
import { blobsMcpSpec, BLOBS_MCP_NAME } from '../../blobs/mcp-wire';
import { engineSpawnEnv, resolveEngineBinary } from '../../detect/engine-binary';
import { log } from '../../server/log';
import { ACP_PROTOCOL_VERSION, AcpConnection, AcpRpcError } from './acp-client';
import { AcpPool, ACP_IDLE_MS_DEFAULT, type AcpChild, type AcpEntry, type AcpHandshake, type AcpSpawnFn, type AcpSpawnSpec } from './acp-pool';
import { ApprovalGate, EventBus, RATE_LIMIT_RE, blobAskVia, confine, postureVerdict, truncate, within, isOutbound, type ActionClass } from './engine-common';
import { trackChild } from '../../server/children';
import { acpFence, wrapReadDeny } from '../os-sandbox';
import { shellCommand, winCommand } from '../../util/win-exec';
import { killChild } from '../../util/kill-child';
import { inTerminal } from '../../util/platform-copy';

// ── engines ──────────────────────────────────────────────────────────────────────────────────────────────────────
export interface AcpEngine {
  /** The driver's agent id: a built-in id (`gemini`, `grok`, `cursor`, `kimi`, `qwen`, `droid`) or `acp-<slug>` for a custom CLI. */
  agentId: string;
  label: string;
  /** Executable name looked up on the widened PATH (see detect/engine-binary), unless `executable` is set. */
  command: string;
  /** Explicit path from Settings > Engines; wins over `command`. */
  executable?: string | null;
  /** argv that puts the CLI in ACP mode. */
  args: string[];
  env?: Record<string, string>;
  /** Per-thread model as launch flags, for CLIs that take one; otherwise session/set_model is used. */
  modelArgs?: (model: string) => string[];
  /** ACP `authenticate` method to use automatically when the agent says auth is required (never one that opens a browser). */
  authMethodId?: string;
  /** What to tell the user when the agent says it is not signed in. */
  loginHint?: string;
}

export interface AcpDriverOptions {
  spawn?: AcpSpawnFn;
  idleMs?: number;
  /** Resolve the engine's executable; null = not installed. Default: engine.executable, else the PATH/installer-dirs search. */
  resolveBinary?(engine: AcpEngine): string | null;
  /** Timeout for initialize / session/new / session/load (ms). */
  setupTimeoutMs?: number;
  /** Terminal output cap per terminal (bytes) when the agent gives none. */
  terminalByteLimit?: number;
  /**
   * Engine health (server/engines.ts). `blocked()` is the reason this engine failed to start earlier (null = fine): while it
   * is set no process is ever spawned for it. `fail(reason)` records a startup failure (auth timeout, unsupported client,
   * crash at start). Only the user's re-check in Settings > Engines clears it.
   */
  health?: { blocked(): string | null; fail(reason: string): void };
}

/** The engine is known not to start: the turn fails once with this message and nothing is spawned. */
export class AcpUnavailable extends Error {
  constructor(message: string) { super(message); this.name = 'AcpUnavailable'; }
}
export const ACP_RECHECK_HINT = "Kora won't try it again until you re-check it in Settings > Engines.";

const DEFAULT_SETUP_TIMEOUT = 45_000;

export function defaultAcpSpawn(spec: AcpSpawnSpec): AcpChild {
  // Under the same read-deny as every other CLI lane (deep A1 D6); a no-op where Seatbelt is unavailable.
  const fence = acpFence(spec.engineId ?? '', spec.command);
  const w = wrapReadDeny(fence.engine, spec.command, spec.args, fence.extraOwn);
  return trackChild(nodeSpawn(w.command, w.args, { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'], windowsVerbatimArguments: w.windowsVerbatimArguments }), `chat ${path.basename(spec.command)} (acp)`) as unknown as AcpChild;
}

// ── pure mapping helpers (exported for tests) ────────────────────────────────────────────────────────────────────
export function acpToolKind(kind: unknown, title?: string): ToolKind {
  switch (kind) {
    case 'execute': return 'command_execution';
    case 'edit': case 'delete': case 'move': return 'file_change';
    case 'read': case 'search': return 'file_read';
    case 'fetch': return 'web_search';
    default: return /kora_blobs|mcp__|mcp:/i.test(title ?? '') ? 'mcp_tool_call' : 'dynamic_tool_call';
  }
}
export function acpActionClass(kind: unknown): ActionClass {
  switch (kind) {
    case 'read': case 'search': case 'think': return 'read';
    case 'edit': case 'delete': case 'move': return 'edit';
    case 'execute': return 'execute';
    case 'fetch': return 'fetch';
    default: return 'other';
  }
}
export function acpApprovalKind(kind: unknown): ApprovalKind {
  switch (acpActionClass(kind)) {
    case 'execute': return 'command_execution_approval';
    case 'edit': return 'file_change_approval';
    case 'read': return 'file_read_approval';
    default: return 'unknown';
  }
}
export function acpPlan(entries: unknown): PlanStep[] {
  if (!Array.isArray(entries)) return [];
  return entries.map((e: any) => ({ step: String(e?.content ?? e?.step ?? ''), status: e?.status === 'completed' ? 'completed' : e?.status === 'in_progress' ? 'inProgress' : 'pending' } as PlanStep)).filter((s) => s.step);
}
/** Text out of ACP tool-call content blocks ({type:'content', content:{type:'text'}} / diff / terminal). */
export function acpContentText(content: unknown): { text: string; files: FileChange[]; terminalIds: string[] } {
  const texts: string[] = []; const files: FileChange[] = []; const terminalIds: string[] = [];
  for (const c of Array.isArray(content) ? content : []) {
    if (c?.type === 'content' && c.content?.type === 'text') texts.push(String(c.content.text ?? ''));
    else if (c?.type === 'diff') {
      const oldL = c.oldText ? String(c.oldText).split('\n').length : 0;
      const newL = String(c.newText ?? '').split('\n').length;
      files.push({ path: String(c.path ?? ''), additions: Math.max(0, newL - (c.oldText ? oldL : 0)), deletions: c.oldText ? Math.max(0, oldL - newL) : 0 });
    } else if (c?.type === 'terminal' && c.terminalId) terminalIds.push(String(c.terminalId));
  }
  return { text: texts.join('\n'), files, terminalIds };
}
function commandOf(raw: any): string | undefined {
  const c = raw?.command ?? raw?.cmd ?? raw?.commandLine;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(String).join(' ');
  return undefined;
}
function pathsOf(tc: any): string[] {
  const out: string[] = [];
  for (const l of Array.isArray(tc?.locations) ? tc.locations : []) if (typeof l?.path === 'string') out.push(l.path);
  for (const k of ['path', 'file_path', 'filePath', 'absolute_path']) if (typeof tc?.rawInput?.[k] === 'string' && path.isAbsolute(tc.rawInput[k])) out.push(tc.rawInput[k]);
  return [...new Set(out)];
}
/** Pick the option for a decision; allow_once is preferred for 'accept' so the agent keeps asking (policy keeps applying). */
export function pickPermissionOption(options: any[], decision: ApprovalAnswer): { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } {
  if (decision === 'cancel') return { outcome: 'cancelled' };
  const by = (...kinds: string[]) => { for (const k of kinds) { const o = options.find((x) => x?.kind === k); if (o) return String(o.optionId); } return null; };
  const id = decision === 'accept' ? by('allow_once', 'allow_always')
    : decision === 'acceptForSession' || decision === 'acceptAlways' ? by('allow_always', 'allow_once')
      : by('reject_once', 'reject_always');
  if (id) return { outcome: 'selected', optionId: id };
  // The agent offered no option of the wanted kind: a decline becomes a cancel; an accept falls back to the first option.
  return decision === 'decline' || !options.length ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: String(options[0].optionId) };
}
export function acpTurnUsage(res: any): TurnUsage | undefined {
  const u = res?.usage ?? res?._meta?.usage;
  if (!u || typeof u !== 'object') return undefined;
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
  const out: TurnUsage = { usageStatus: 'complete' };
  const i = n(u.inputTokens), o = n(u.outputTokens), r = n(u.thoughtTokens), c = n(u.cachedReadTokens);
  if (i !== undefined) out.inputTokens = i; if (o !== undefined) out.outputTokens = o; if (r !== undefined) out.reasoningTokens = r; if (c !== undefined) out.cachedInputTokens = c;
  return i === undefined && o === undefined ? undefined : out;
}

// ── per-thread state ─────────────────────────────────────────────────────────────────────────────────────────────
interface TurnCtx {
  turnId: TurnId;
  settled: boolean;
  cancelled: boolean;
  sawOutput: boolean;
  started: Map<string, { itemId: ItemId; title: string }>;
  grants: Set<string>;
  retried: boolean;
  /** reply to a parked permission request (so an interrupt can cancel it) */
  openPermissions: Set<(o: { outcome: 'cancelled' }) => void>;
}
interface TState {
  threadId: ThreadId;
  input: SessionStartInput;
  /** The ACP session id to resume on a fresh process. Updated whenever a session is created. */
  resume: string | null;
  model: ModelChoice | null;
  turn: TurnCtx | null;
  lastUserAt?: number;
  stopped: boolean;
  readRoots: Set<string>;
  announcedModels?: boolean;
}
interface Terminal { child: ReturnType<typeof nodeSpawn>; out: string; truncated: boolean; limit: number; exit: { exitCode: number | null; signal: string | null } | null; waiters: ((x: { exitCode: number | null; signal: string | null }) => void)[] }

export class AcpDriver implements SessionDriver {
  readonly agent: AgentId;
  readonly capabilities: DriverCapabilities = { modelSwitch: 'restart-only', promptlessContinuation: false, conversationRollback: false, manualCompaction: false, canSpawnWorkers: false, reportsToolStart: true };
  readonly pool: AcpPool;
  private sessions = new Map<ThreadId, TState>();
  private bus = new EventBus();
  private gate = new ApprovalGate(this.bus);

  constructor(private deps: DriverDeps, readonly engine: AcpEngine, private opts: AcpDriverOptions = {}) {
    this.agent = engine.agentId as AgentId;
    this.pool = new AcpPool({
      spawn: opts.spawn ?? defaultAcpSpawn,
      idleMs: opts.idleMs ?? ACP_IDLE_MS_DEFAULT,
      onClosed: (e, reason) => this.onProcessClosed(e, reason),
    });
  }

  streamEvents(onEvent: (e: import('../events').ChatEvent) => void): () => void { return this.bus.subscribe(onEvent); }
  hasSession(threadId: ThreadId): boolean { const s = this.sessions.get(threadId); return !!s && !s.stopped; }
  /** True while a live agent process exists for the thread (tests / doctor). */
  hasProcess(threadId: ThreadId): boolean { return !!this.pool.get(threadId); }
  /** Models the live agent reported in session/new (`models.availableModels`), if any. */
  models(threadId: ThreadId): { current: string | null; available: { id: string; name: string }[] } | null { return this.pool.get(threadId)?.models ?? null; }

  async startSession(input: SessionStartInput): Promise<{ threadId: ThreadId; resume?: unknown }> {
    const resume = typeof input.resume === 'string' && input.resume ? input.resume : null;
    const existing = this.sessions.get(input.threadId);
    if (existing) {
      // A new resume cursor for a thread that already has a session: the next turn loads it (the one-replacement rule applies).
      if (resume && resume !== existing.resume) existing.resume = resume;
      existing.input = { ...existing.input, ...input };
      return { threadId: input.threadId, resume: existing.resume ?? undefined };
    }
    this.sessions.set(input.threadId, { threadId: input.threadId, input, resume, model: input.model ?? null, turn: null, stopped: false, readRoots: new Set() });
    this.bus.emit(input.threadId, { type: 'session.started' });
    if (resume) this.bus.emit(input.threadId, { type: 'thread.started', providerThreadId: resume });
    this.bus.emit(input.threadId, { type: 'session.state', state: 'ready' });
    return { threadId: input.threadId, resume: resume ?? undefined };
  }

  async sendTurn(input: SendTurnInput): Promise<TurnHandle> {
    const state = this.sessions.get(input.threadId);
    if (!state) throw new Error(`no live session for thread ${input.threadId}`);
    if (state.turn) await this.interruptTurn(input.threadId).catch(() => {});
    if (input.origin !== 'kora-notice') state.lastUserAt = Date.now();
    if (input.model?.model && input.model.model !== state.model?.model) { state.model = input.model; this.bus.emit(input.threadId, { type: 'model.rerouted', to: input.model.model, reason: 'per-turn override (restart)' }); }
    let text = input.text ?? '';
    if (input.koraNotice) text = text ? `${input.koraNotice}\n\n${text}` : input.koraNotice;
    const turnId = newTurnId();
    const turn: TurnCtx = { turnId, settled: false, cancelled: false, sawOutput: false, started: new Map(), grants: new Set(), retried: false, openPermissions: new Set() };
    state.turn = turn;
    for (const a of input.attachments ?? []) state.readRoots.add(path.dirname(a.path));
    this.bus.emit(input.threadId, { type: 'turn.started', turnId, ...(state.model?.model ? { model: state.model.model } : {}) });
    void this.runTurn(state, turn, text, input.attachments ?? []);
    return { threadId: input.threadId, turnId };
  }

  // ── a turn ─────────────────────────────────────────────────────────────────────────────────────────────────────
  private async runTurn(state: TState, turn: TurnCtx, text: string, attachments: PromptAttachment[]): Promise<void> {
    let entry: AcpEntry | null = null;
    try {
      // An engine that already failed to start is not started again (no spawn, no handshake): one clear message.
      const blocked = this.opts.health?.blocked();
      if (blocked) throw new AcpUnavailable(`${blocked} ${ACP_RECHECK_HINT}`);
      for (let attempt = 0; ; attempt++) {
        let phase: 'setup' | 'prompt' = 'setup';
        try {
          entry = await this.ensureReady(state, turn);
          phase = 'prompt';
          this.pool.begin(entry);
          this.bus.emit(state.threadId, { type: 'session.state', state: 'running' });
          const blocks = this.promptBlocks(state, entry, text, attachments);
          const res = await entry.conn.request('session/prompt', { sessionId: entry.sessionId, prompt: blocks });
          this.settleFromStop(state, turn, res);
          return;
        } catch (e: any) {
          if (turn.settled) return;
          // Failing to START (handshake, sign-in, session/new, load) is final: the process goes, the engine is marked
          // unavailable with the reason and the turn fails once. Never a second spawn.
          if (phase === 'setup' && !turn.cancelled && !(e instanceof AcpUnavailable) && e?.code !== 'ENOENT') throw this.startFailed(state, e);
          const crashed = !!entry?.closed || /the agent stopped|not running/.test(String(e?.message));
          // A process that died mid-turn before it produced anything (a stale idle process): one fresh start.
          if (phase === 'prompt' && crashed && !turn.sawOutput && !turn.cancelled && attempt === 0) { turn.retried = true; if (entry) this.pool.end(entry); entry = null; continue; }
          throw e;
        }
      }
    } catch (e: any) {
      this.failTurn(state, turn, e);
    } finally {
      if (entry) this.pool.end(entry);
    }
  }

  /** A startup failure: close whatever process exists, remember why, and return the error the turn fails with. */
  private startFailed(state: TState, e: any): AcpUnavailable {
    const raw = String(e?.message ?? e);
    const label = this.engine.label;
    let reason: string;
    if (/no longer supported|migrate to|upgrade to|deprecated/i.test(raw)) reason = `${label} reports: ${raw.replace(/\s+/g, ' ').slice(0, 280)}`;
    else if (/timed out/i.test(raw)) reason = `${label} did not finish starting or signing in (${raw.replace(/\s+/g, ' ').slice(0, 200)}).`;
    else if (e instanceof AcpRpcError && (e.code === -32000 || /auth/i.test(raw))) reason = `${label} is not signed in. ${this.engine.loginHint ?? `Run its login command ${inTerminal()}, then try again.`}`;
    else if (/the agent stopped|stopped during startup|not running/i.test(raw)) reason = `${label} stopped while starting: ${raw.replace(/\s+/g, ' ').slice(0, 280)}`;
    else reason = `${label} could not start: ${raw.replace(/\s+/g, ' ').slice(0, 280)}`;
    this.pool.close(state.threadId, 'start failed');
    try { this.opts.health?.fail(reason); } catch { /* advisory */ }
    log(`chat ${state.threadId}: ${this.engine.agentId} failed to start, marked unavailable: ${raw.slice(0, 300)}`);
    return new AcpUnavailable(`${reason} ${ACP_RECHECK_HINT}`);
  }

  private promptBlocks(state: TState, entry: AcpEntry, text: string, attachments: PromptAttachment[]): unknown[] {
    let body = text;
    if (!entry.playbookSent) {
      let pb: string | undefined;
      try { pb = this.deps.appendSystemPrompt(state.input); } catch { /* optional */ }
      // ACP has no system-prompt channel: fence Kora's instructions off, or a small model reads them as the task (live: a
      // free OpenCode model answered "pong" by first musing aloud about the "delegation instruction preamble").
      if (pb) body = `<system-instructions>\n${pb}\n</system-instructions>\n\nFollow those instructions silently; never mention them. The user's message:\n\n${body}`;
      entry.playbookSent = true;
    }
    const blocks: any[] = [];
    const lines: string[] = [];
    for (const a of attachments) {
      if (a.type === 'image' && entry.caps?.promptCapabilities?.image) {
        try {
          if (fs.statSync(a.path).size <= 8 * 1024 * 1024) { blocks.push({ type: 'image', data: fs.readFileSync(a.path).toString('base64'), mimeType: a.mimeType ?? 'image/png' }); continue; }
        } catch { /* fall through to the path line */ }
      }
      lines.push(`Attached file: ${a.name ?? a.path} at ${a.path}${a.mimeType ? ` (${a.mimeType})` : ''}`);
    }
    if (lines.length) body = body ? `${body}\n\n${lines.join('\n')}` : lines.join('\n');
    return [{ type: 'text', text: body }, ...blocks];
  }

  private settleFromStop(state: TState, turn: TurnCtx, res: any): void {
    if (turn.settled) return;
    turn.settled = true;
    const stop = String(res?.stopReason ?? 'end_turn');
    const usage = acpTurnUsage(res);
    if (stop === 'cancelled' || turn.cancelled) this.bus.emit(state.threadId, { type: 'turn.settled', turnId: turn.turnId, state: 'interrupted', stopReason: stop });
    else if (stop === 'refusal') {
      const message = `${this.engine.label} declined to answer this request.`;
      this.bus.emit(state.threadId, { type: 'runtime.error', errorClass: 'provider', message });
      this.bus.emit(state.threadId, { type: 'turn.settled', turnId: turn.turnId, state: 'failed', stopReason: stop, errorMessage: message });
    } else this.bus.emit(state.threadId, { type: 'turn.settled', turnId: turn.turnId, state: 'completed', stopReason: stop, ...(usage ? { usage } : {}) });
    this.endTurn(state, turn);
  }

  private failTurn(state: TState, turn: TurnCtx, e: any): void {
    if (turn.settled) return;
    turn.settled = true;
    if (turn.cancelled) { this.bus.emit(state.threadId, { type: 'turn.settled', turnId: turn.turnId, state: 'interrupted' }); this.endTurn(state, turn); return; }
    const raw = String(e?.message ?? e);
    let message = raw;
    if (e instanceof AcpUnavailable) message = raw;
    else if (e instanceof AcpRpcError && (e.code === -32000 || /auth/i.test(raw))) message = `${this.engine.label} is not signed in. ${this.engine.loginHint ?? `Run its login command ${inTerminal()}, then try again.`}`;
    else if (e?.code === 'ENOENT' || /ENOENT/.test(raw)) message = `${this.engine.label} isn't installed or Kora can't find it. Open Settings > Engines to install it or point Kora at it.`;
    else if (/the agent stopped/.test(raw)) message = `${this.engine.label} stopped unexpectedly. Send your message again and Kora will restart it and resume the conversation.`;
    if (RATE_LIMIT_RE.test(raw)) this.bus.emit(state.threadId, { type: 'usage.rate-limit', message: `${this.engine.label} is rate-limited or out of quota right now. Try again later or switch the blob to another engine.`, turnId: turn.turnId });
    this.bus.emit(state.threadId, { type: 'runtime.error', errorClass: 'provider', message });
    this.bus.emit(state.threadId, { type: 'turn.settled', turnId: turn.turnId, state: 'failed', errorMessage: message });
    log(`chat ${state.threadId}: ${this.engine.agentId} turn failed: ${raw.slice(0, 300)}`);
    this.endTurn(state, turn);
  }

  private endTurn(state: TState, turn: TurnCtx): void {
    this.gate.cancelAll(state.threadId);
    if (state.turn === turn) state.turn = null;
    this.bus.emit(state.threadId, { type: 'session.state', state: 'ready' });
  }

  // ── process + session setup ──────────────────────────────────────────────────────────────────────────────────────
  private binary(): string | null { return this.opts.resolveBinary ? this.opts.resolveBinary(this.engine) : (this.engine.executable?.trim() || resolveEngineBinary(this.engine.command)); }

  private specFor(state: TState): { spec: AcpSpawnSpec; contract: string } {
    const bin = this.binary();
    if (!bin) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const model = state.model?.model && state.model.model !== 'default' ? state.model.model : '';
    const args = [...this.engine.args, ...(model && this.engine.modelArgs ? this.engine.modelArgs(model) : [])];
    // Never a fake HOME (keychain hazard, CLAUDE.md): the real environment plus the engine's own variables.
    const env = engineSpawnEnv({ ...process.env, ...(this.engine.env ?? {}) }, bin);
    const spec: AcpSpawnSpec = { command: bin, args, env, cwd: state.input.cwd, engineId: this.engine.agentId };
    const approval = state.input.runtimeMode === 'full-access' ? 'full' : state.input.runtimeMode === 'approval-required' || !state.input.runtimeMode ? 'ask' : 'auto';
    return { spec, contract: JSON.stringify({ command: bin, args, cwd: state.input.cwd, model, approval }) };
  }

  private async handshake(conn: AcpConnection, state: TState): Promise<AcpHandshake> {
    conn.setHandlers({ onRequest: (m, p) => this.onAgentRequest(state, conn, m, p), onNotification: (m, p) => this.onAgentNotification(state, conn, m, p) });
    const r = await conn.request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: { name: 'kora', title: 'Kora', version: '1' },
    }, { timeoutMs: this.opts.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT });
    return { caps: r?.agentCapabilities ?? {}, authMethods: Array.isArray(r?.authMethods) ? r.authMethods : [], agentInfo: r?.agentInfo };
  }

  private async ensureReady(state: TState, turn: TurnCtx): Promise<AcpEntry> {
    const { spec, contract } = this.specFor(state);
    const init = (conn: AcpConnection) => this.handshake(conn, state);
    const { entry } = await this.pool.acquire(state.threadId, contract, spec, init);
    const want = state.resume;
    if (entry.sessionId && (!want || want === entry.sessionId)) return entry; // live session reused: no handshake, no session/load
    if (!want) { await this.newSession(state, entry, false); return entry; }
    if (!entry.caps?.loadSession) {
      this.bus.emit(state.threadId, { type: 'runtime.warning', message: `${this.engine.label} cannot resume earlier conversations, so this message starts a new session there. Kora's own history is kept.` });
      await this.newSession(state, entry, false);
      return entry;
    }
    const holdsSession = !!entry.sessionId;
    try { await this.loadSession(state, entry, want); return entry; }
    catch (e1: any) {
      if (turn.cancelled) throw e1;
      if (holdsSession) {
        // The live process refuses to load a session while it holds one: exactly one replacement process.
        const fresh = await this.pool.replace(state.threadId, contract, spec, init, 'session/load refused on a live session');
        try { await this.loadSession(state, fresh, want); return fresh; }
        catch (e2: any) { return this.loadFailed(state, fresh, want, e2); }
      }
      return this.loadFailed(state, entry, want, e1);
    }
  }

  private async loadFailed(state: TState, entry: AcpEntry, want: string, err: any): Promise<AcpEntry> {
    if (entry.closed) throw err;
    this.bus.emit(state.threadId, { type: 'runtime.warning', message: `${this.engine.label} could not reload the earlier session (${String(err?.message ?? err).slice(0, 160)}). Continuing in a new session: it has not seen the earlier messages.` });
    log(`chat ${state.threadId}: ${this.engine.agentId} session/load ${want} failed, starting a new session: ${err?.message ?? err}`);
    await this.newSession(state, entry, true);
    return entry;
  }

  private mcpServersFor(state: TState): unknown[] {
    const blobs = this.deps.blobs;
    if (!blobs?.mcpIssue || !this.deps.socketPath || !this.deps.binPath) return [];
    let blobId: string | null = null;
    try { blobId = blobs.byCwd(state.input.cwd)?.id ?? null; } catch { /* not a blob */ }
    if (!blobId) return [];
    try {
      blobs.mcpRevoke?.(state.threadId); // a fresh process/session gets a fresh token; the old one is dead
      const turnRef = () => (state.turn ? { turnId: state.turn.turnId } : {});
      const token = blobs.mcpIssue({
        blobId, threadId: state.threadId, agent: this.engine.agentId, cwd: state.input.cwd,
        emitCard: (card) => this.bus.emit(state.threadId, { type: 'blob.card', card, ...turnRef() }),
        fullAccess: () => state.input.runtimeMode === 'full-access',
        userMessageSince: (since: number) => (state.lastUserAt ?? 0) > since,
        askApproval: blobAskVia(this.gate, state.threadId, () => state.turn?.turnId),
        attachOutput: (p, caption) => {
          const itemId: ItemId = `attach_${state.threadId}_${Date.now().toString(36)}`;
          this.bus.emit(state.threadId, { type: 'tool.started', itemId, toolKind: 'file_change', toolName: 'attach_output', title: caption ? `${caption} - ${path.basename(p)}` : `attach ${path.basename(p)}`, input: { file_path: p }, ...turnRef() });
          this.bus.emit(state.threadId, { type: 'tool.result', itemId, status: 'completed', changedFiles: [{ path: p, additions: 0, deletions: 0 }], ...turnRef() });
        },
      });
      const spec = blobsMcpSpec({ binPath: this.deps.binPath, socketPath: this.deps.socketPath, blobId, token, threadId: state.threadId, agent: this.engine.agentId });
      return [{ name: BLOBS_MCP_NAME, command: spec.command, args: spec.args, env: [] }];
    } catch (e: any) { log(`chat ${state.threadId}: blob tools unavailable on ${this.engine.agentId}: ${e?.message ?? e}`); return []; }
  }

  private async withAuth<T>(entry: AcpEntry, fn: () => Promise<T>): Promise<T> {
    try { return await fn(); }
    catch (e: any) {
      if (e instanceof AcpRpcError && e.code === -32000 && this.engine.authMethodId && entry.authMethods.some((m: any) => m?.id === this.engine.authMethodId)) {
        await entry.conn.request('authenticate', { methodId: this.engine.authMethodId }, { timeoutMs: this.opts.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT });
        return fn();
      }
      throw e;
    }
  }

  private async newSession(state: TState, entry: AcpEntry, afterFailedLoad: boolean): Promise<void> {
    const params = { cwd: state.input.cwd, mcpServers: this.mcpServersFor(state) };
    const r = await this.withAuth(entry, () => entry.conn.request('session/new', params, { timeoutMs: this.opts.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT }));
    entry.sessionId = String(r?.sessionId ?? '');
    if (!entry.sessionId) throw new Error(`${this.engine.label} did not return a session id`);
    entry.playbookSent = false;
    state.resume = entry.sessionId;
    this.readModels(entry, r);
    this.bus.emit(state.threadId, { type: 'thread.started', providerThreadId: entry.sessionId });
    await this.applyModel(state, entry, r);
    void afterFailedLoad;
  }

  private async loadSession(state: TState, entry: AcpEntry, sessionId: string): Promise<void> {
    entry.ext.loading = true; // the agent replays the whole history as session/update notifications: drop them
    try {
      const params = { sessionId, cwd: state.input.cwd, mcpServers: this.mcpServersFor(state) };
      const r = await this.withAuth(entry, () => entry.conn.request('session/load', params, { timeoutMs: this.opts.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT }));
      entry.sessionId = sessionId;
      entry.playbookSent = true; // the persona prompt is already part of the loaded conversation
      this.readModels(entry, r);
      this.bus.emit(state.threadId, { type: 'thread.started', providerThreadId: sessionId });
      await this.applyModel(state, entry, r);
    } finally { entry.ext.loading = false; }
  }

  private readModels(entry: AcpEntry, r: any): void {
    const m = r?.models;
    if (m && Array.isArray(m.availableModels)) entry.models = { current: m.currentModelId ?? null, available: m.availableModels.map((x: any) => ({ id: String(x.modelId ?? x.id), name: String(x.name ?? x.modelId ?? x.id) })) };
    else {
      const opt = (Array.isArray(r?.configOptions) ? r.configOptions : []).find((o: any) => o?.category === 'model' || o?.id === 'model');
      if (opt && Array.isArray(opt.options)) entry.models = { current: opt.currentValue ?? null, available: opt.options.flatMap((g: any) => (g.options ?? [g])).map((x: any) => ({ id: String(x.value ?? x.id), name: String(x.name ?? x.value ?? x.id) })) };
      entry.ext.modelConfigId = opt?.id;
    }
  }

  private async applyModel(state: TState, entry: AcpEntry, _r: any): Promise<void> {
    const want = state.model?.model;
    // "default" = the agent's own default model (the picker's placeholder before its models are discovered)
    if (!want || want === 'default' || this.engine.modelArgs || !entry.models || entry.models.current === want) return;
    try {
      if (!entry.models.available.some((m) => m.id === want)) throw new Error(`model "${want}" is not offered by ${this.engine.label}`);
      if (entry.ext.modelConfigId) await entry.conn.request('session/set_config_option', { sessionId: entry.sessionId, configId: entry.ext.modelConfigId, value: want }, { timeoutMs: 15_000 });
      else await entry.conn.request('session/set_model', { sessionId: entry.sessionId, modelId: want }, { timeoutMs: 15_000 });
      entry.models.current = want;
    } catch (e: any) { this.bus.emit(state.threadId, { type: 'runtime.warning', message: `Could not switch ${this.engine.label} to ${want}: ${String(e?.message ?? e).slice(0, 160)}. It keeps its current model.` }); }
  }

  private onProcessClosed(e: AcpEntry, reason: string): void {
    for (const t of Object.values((e.ext.terminals ?? {}) as Record<string, Terminal>)) { try { killChild(t.child, 'SIGKILL'); } catch { /* gone */ } }
    const state = this.sessions.get(e.key);
    try { this.deps.blobs?.mcpRevoke?.(e.key); } catch { /* advisory */ }
    if (state && !state.stopped) {
      if (reason !== 'idle' && reason !== 'shutdown' && reason !== 'spawn contract changed' && reason !== 'session/load refused on a live session' && reason !== 'handshake failed') {
        log(`chat ${e.key}: ${this.engine.agentId} process closed (${reason})`);
      }
      // The live session id is only valid for this process: the next turn loads it on a fresh one (state.resume holds it).
    }
  }

  // ── agent -> client: notifications ─────────────────────────────────────────────────────────────────────────────────
  private onAgentNotification(state: TState, conn: AcpConnection, method: string, params: any): void {
    if (method !== 'session/update') return;
    const entry = this.pool.get(state.threadId);
    if (entry && entry.conn !== conn) return; // an old process
    if (entry?.ext.loading) return; // history replay during session/load
    const turn = state.turn;
    if (!turn || turn.settled) return;
    const u = params?.update;
    if (!u || typeof u.sessionUpdate !== 'string') return;
    const tid = state.threadId; const turnId = turn.turnId;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const t = u.content?.type === 'text' ? String(u.content.text ?? '') : '';
        if (t) { turn.sawOutput = true; this.bus.emit(tid, { type: 'content.delta', itemId: `msg_${turnId}`, stream: 'assistant_text', delta: t, turnId }); }
        return;
      }
      case 'agent_thought_chunk': {
        const t = u.content?.type === 'text' ? String(u.content.text ?? '') : '';
        if (t) { turn.sawOutput = true; this.bus.emit(tid, { type: 'content.delta', itemId: `think_${turnId}`, stream: 'reasoning_text', delta: t, turnId }); }
        return;
      }
      case 'plan': { const plan = acpPlan(u.entries); if (plan.length) { turn.sawOutput = true; this.bus.emit(tid, { type: 'turn.plan', plan, turnId }); } return; }
      case 'tool_call': { turn.sawOutput = true; this.toolStarted(state, turn, u); if (u.status === 'completed' || u.status === 'failed') this.toolResult(state, turn, u); return; }
      case 'tool_call_update': {
        turn.sawOutput = true;
        if (!turn.started.has(String(u.toolCallId))) this.toolStarted(state, turn, u);
        if (u.status === 'completed' || u.status === 'failed') this.toolResult(state, turn, u);
        else if (u.rawInput !== undefined || u.title) this.bus.emit(tid, { type: 'tool.updated', itemId: turn.started.get(String(u.toolCallId))!.itemId, ...(u.rawInput !== undefined ? { input: u.rawInput } : {}), turnId });
        return;
      }
      case 'usage_update': {
        const used = Number(u.used), size = Number(u.size);
        if (Number.isFinite(used)) this.bus.emit(tid, { type: 'thread.token-usage', usage: { usedTokens: used, ...(Number.isFinite(size) && size > 0 ? { maxTokens: size } : {}), source: 'provider' } });
        return;
      }
      default: return; // available_commands_update, current_mode_update, config_option_update, user_message_chunk: nothing to show
    }
  }

  private toolStarted(state: TState, turn: TurnCtx, u: any): void {
    const id = String(u.toolCallId ?? '');
    if (!id || turn.started.has(id)) return;
    const itemId: ItemId = `acp_${turn.turnId}_${id}`;
    const title = String(u.title ?? u.kind ?? 'tool');
    turn.started.set(id, { itemId, title });
    this.bus.emit(state.threadId, { type: 'tool.started', itemId, toolKind: acpToolKind(u.kind, title), toolName: String(u.kind ?? 'tool'), title: title.slice(0, 120), ...(u.rawInput !== undefined ? { input: u.rawInput } : {}), turnId: turn.turnId });
  }

  private toolResult(state: TState, turn: TurnCtx, u: any): void {
    const t = turn.started.get(String(u.toolCallId));
    if (!t) return;
    turn.started.delete(String(u.toolCallId));
    const c = acpContentText(u.content);
    let output = c.text;
    const terms = (this.pool.get(state.threadId)?.ext.terminals ?? {}) as Record<string, Terminal>;
    const term = c.terminalIds.map((id) => terms[id]?.out ?? '').filter(Boolean).join('\n');
    if (term) output = output ? `${output}\n${term}` : term;
    if (!output && u.rawOutput !== undefined) output = typeof u.rawOutput === 'string' ? u.rawOutput : JSON.stringify(u.rawOutput);
    this.bus.emit(state.threadId, {
      type: 'tool.result', itemId: t.itemId, status: u.status === 'failed' ? 'failed' : 'completed',
      ...(output ? { output: truncate(output, 8000) } : {}), ...(c.files.length ? { changedFiles: c.files } : {}), turnId: turn.turnId,
    });
  }

  // ── agent -> client: requests ──────────────────────────────────────────────────────────────────────────────────────
  private async onAgentRequest(state: TState, conn: AcpConnection, method: string, p: any): Promise<unknown> {
    switch (method) {
      case 'session/request_permission': return this.onPermission(state, p);
      case 'fs/read_text_file': return this.fsRead(state, p);
      case 'fs/write_text_file': return this.fsWrite(state, p);
      case 'terminal/create': return this.terminalCreate(state, conn, p);
      case 'terminal/output': return this.terminalOutput(state, p);
      case 'terminal/wait_for_exit': return this.terminalWait(state, p);
      case 'terminal/kill': { const t = this.terminal(state, p); try { killChild(t.child, 'SIGKILL'); } catch { /* gone */ } return {}; }
      case 'terminal/release': { const t = this.terminal(state, p); try { killChild(t.child, 'SIGKILL'); } catch { /* gone */ } delete this.pool.get(state.threadId)!.ext.terminals[String(p.terminalId)]; return {}; }
      default: throw new AcpRpcError(-32601, `method not found: ${method}`);
    }
  }

  private inBounds(state: TState): (abs: string) => boolean {
    const roots = [state.input.cwd, ...this.blobRoots(state)];
    return (abs) => within(abs, roots);
  }
  private blobRoots(state: TState): string[] {
    try { const b = this.deps.blobs?.byCwd(state.input.cwd); return b ? [b.workspace, blobHome(b.id)] : []; } catch { return []; }
  }

  private async onPermission(state: TState, p: any): Promise<unknown> {
    const turn = state.turn;
    const tc = p?.toolCall ?? {};
    const options: any[] = Array.isArray(p?.options) ? p.options : [];
    if (!turn || turn.cancelled) return { outcome: { outcome: 'cancelled' } };
    const kind = tc.kind ?? 'other';
    const title = String(tc.title ?? `Allow ${kind}?`);
    const action = acpActionClass(kind);
    const command = commandOf(tc.rawInput) ?? (action === 'execute' ? title : undefined);
    // The blob's own Kora tools (recall, remember, delegate, ...) are guarded by their handlers, like on Claude.
    const own = /kora_blobs/.test(title + ' ' + JSON.stringify(tc.rawInput ?? {}).slice(0, 400) + ' ' + String(tc._meta?.server ?? ''));
    const verdict = own ? { decision: 'allow' as const, reason: 'the blob\'s own tool' } : postureVerdict({ mode: state.input.runtimeMode, action, command, cwd: state.input.cwd, paths: pathsOf(tc), inBounds: this.inBounds(state) });
    if (verdict.decision === 'allow') {
      if (action === 'edit' || action === 'execute') turn.grants.add(action);
      return { outcome: pick(options, 'accept') };
    }
    if (verdict.decision === 'deny') { this.bus.emit(state.threadId, { type: 'runtime.warning', message: verdict.reason }); return { outcome: pick(options, 'decline') }; }
    const decisionP = this.gate.ask(state.threadId, { title, detail: verdict.reason + (command ? `\n${command}` : ''), kind: acpApprovalKind(kind), args: tc.rawInput, turnId: turn.turnId });
    let cancelled = false;
    const cancelP = new Promise<'cancel'>((res) => { turn.openPermissions.add(() => { cancelled = true; res('cancel'); }); });
    const decision = await Promise.race([decisionP, cancelP]);
    if (cancelled) return { outcome: { outcome: 'cancelled' } };
    if (decision === 'accept' || decision === 'acceptForSession' || decision === 'acceptAlways') {
      if (action === 'edit' || action === 'execute') turn.grants.add(action);
      if (action === 'execute' && isOutbound(command)) turn.grants.add('outbound');
    }
    return { outcome: pickPermissionOption(options, decision) };
  }

  private fsRoots(state: TState, write: boolean): string[] {
    const base = [state.input.cwd];
    if (write) return base;
    let team: string[] = [];
    try { const b = this.deps.blobs?.byCwd(state.input.cwd); team = b ? (this.deps.blobs?.readableDirs?.(b.id) ?? []) : []; } catch { /* not a blob */ }
    return [...base, ...this.blobRoots(state), ...state.readRoots, ...team];
  }

  private async fsRead(state: TState, p: any): Promise<unknown> {
    let abs: string;
    try { abs = confine(p?.path, this.fsRoots(state, false)); } catch (e: any) { throw new AcpRpcError(-32602, e.message); }
    let text: string;
    try { text = fs.readFileSync(abs, 'utf8'); } catch (e: any) { throw new AcpRpcError(-32002, `cannot read ${p.path}: ${e?.code ?? e?.message}`); }
    const line = Number.isFinite(Number(p?.line)) && Number(p.line) > 0 ? Number(p.line) : 1;
    const limit = Number.isFinite(Number(p?.limit)) && Number(p.limit) > 0 ? Number(p.limit) : 0;
    if (line === 1 && !limit) return { content: text };
    const lines = text.split('\n').slice(line - 1, limit ? line - 1 + limit : undefined);
    return { content: lines.join('\n') };
  }

  private async fsWrite(state: TState, p: any): Promise<unknown> {
    let abs: string;
    try { abs = confine(p?.path, this.fsRoots(state, true)); } catch (e: any) { throw new AcpRpcError(-32602, e.message); }
    if (typeof p?.content !== 'string') throw new AcpRpcError(-32602, 'content is required');
    // Supervised: a write only lands after the user approved an edit this turn (the agent's permission request).
    if (state.input.runtimeMode === 'approval-required' && !state.turn?.grants.has('edit')) throw new AcpRpcError(-32000, 'writing files needs your approval in Supervised mode');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, p.content);
    return {};
  }

  private terminals(state: TState): Record<string, Terminal> { const e = this.pool.get(state.threadId); if (!e) throw new AcpRpcError(-32000, 'no agent process'); return (e.ext.terminals ??= {}); }
  private terminal(state: TState, p: any): Terminal { const t = this.terminals(state)[String(p?.terminalId)]; if (!t) throw new AcpRpcError(-32602, 'unknown terminal'); return t; }

  private async terminalCreate(state: TState, conn: AcpConnection, p: any): Promise<unknown> {
    const mode = state.input.runtimeMode;
    const turn = state.turn;
    const argv: string[] = Array.isArray(p?.args) ? p.args.map(String) : [];
    const full = [String(p?.command ?? ''), ...argv].join(' ').trim();
    if (!full) throw new AcpRpcError(-32602, 'command is required');
    let cwd = state.input.cwd;
    if (p?.cwd) { try { cwd = confine(p.cwd, [state.input.cwd]); } catch (e: any) { throw new AcpRpcError(-32602, e.message); } }
    // The agent normally asked first; this is the backstop: outbound commands need the user's yes (or Full access), and
    // Supervised mode needs an approved execute this turn.
    if (mode !== 'full-access') {
      const outbound = isOutbound(full);
      const needs = outbound ? !turn?.grants.has('outbound') : mode === 'approval-required' || mode === undefined ? !turn?.grants.has('execute') : false;
      if (needs) {
        if (!turn) throw new AcpRpcError(-32000, 'no active turn');
        const d = await this.gate.ask(state.threadId, { title: `Run ${full.slice(0, 80)}?`, detail: outbound ? 'this command can send data out or act outside the workspace' : 'Supervised mode asks before running commands', kind: 'command_execution_approval', args: { command: full }, turnId: turn.turnId });
        if (d !== 'accept' && d !== 'acceptForSession' && d !== 'acceptAlways') throw new AcpRpcError(-32000, 'the user declined this command');
        turn.grants.add('execute'); if (outbound) turn.grants.add('outbound');
      }
    }
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const e of Array.isArray(p?.env) ? p.env : []) if (e?.name) env[String(e.name)] = String(e.value ?? '');
    const spawnEnv = engineSpawnEnv(env);
    // `sh -c` is Git bash (or cmd.exe) on Windows; a program name goes through PATHEXT / .cmd shims (util/win-exec.ts).
    const w = argv.length || !/\s/.test(String(p.command)) ? winCommand(String(p.command), argv, spawnEnv) : shellCommand(String(p.command), spawnEnv);
    const child = nodeSpawn(w.command, w.args, { cwd, env: spawnEnv, windowsHide: true, windowsVerbatimArguments: w.windowsVerbatimArguments });
    const id = `term_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const t: Terminal = { child, out: '', truncated: false, limit: Number(p?.outputByteLimit) > 0 ? Number(p.outputByteLimit) : this.opts.terminalByteLimit ?? 256 * 1024, exit: null, waiters: [] };
    const take = (c: Buffer | string) => { t.out += String(c); if (Buffer.byteLength(t.out) > t.limit) { t.out = t.out.slice(-t.limit); t.truncated = true; } };
    child.stdout?.on('data', take); child.stderr?.on('data', take);
    const done = (exitCode: number | null, signal: string | null) => { if (t.exit) return; t.exit = { exitCode, signal }; for (const w of t.waiters.splice(0)) w(t.exit); };
    child.on('close', (code, sig) => done(code, sig));
    child.on('error', (e: any) => { take(`${e?.message ?? e}\n`); done(127, null); });
    this.terminals(state)[id] = t;
    void conn;
    return { terminalId: id };
  }

  private terminalOutput(state: TState, p: any): unknown {
    const t = this.terminal(state, p);
    return { output: t.out, truncated: t.truncated, ...(t.exit ? { exitStatus: { exitCode: t.exit.exitCode, signal: t.exit.signal } } : {}) };
  }
  private terminalWait(state: TState, p: any): Promise<unknown> {
    const t = this.terminal(state, p);
    if (t.exit) return Promise.resolve({ exitCode: t.exit.exitCode, signal: t.exit.signal });
    return new Promise((res) => t.waiters.push((x) => res({ exitCode: x.exitCode, signal: x.signal })));
  }

  // ── SessionDriver: control surface ─────────────────────────────────────────────────────────────────────────────────
  async interruptTurn(threadId: ThreadId, _turnId?: TurnId): Promise<void> {
    const s = this.sessions.get(threadId); const turn = s?.turn;
    if (!s || !turn || turn.settled) return;
    turn.cancelled = true;
    for (const f of [...turn.openPermissions]) f({ outcome: 'cancelled' });
    turn.openPermissions.clear();
    this.gate.cancelAll(threadId);
    const entry = this.pool.get(threadId);
    if (entry?.sessionId) entry.conn.notify('session/cancel', { sessionId: entry.sessionId });
    // A well-behaved agent answers the prompt with stopReason "cancelled"; one that does not is cut off after a grace period.
    const t = setTimeout(() => { if (!turn.settled) { this.failTurn(s, turn, new Error('cancelled')); if (entry) this.pool.close(threadId, 'cancel not honoured', entry); } }, 5000);
    t.unref?.();
  }

  async respondToApproval(threadId: ThreadId, requestId: RequestId, decision: ApprovalAnswer): Promise<void> { this.gate.respond(threadId, requestId, decision); }
  async respondToUserInput(_t: ThreadId, _r: RequestId, _a: UserInputAnswers): Promise<void> { /* ACP has no free-form question request in v1 */ }

  async setPermissionMode(threadId: ThreadId, mode: RuntimeMode): Promise<void> {
    const s = this.sessions.get(threadId); if (!s) return;
    s.input = { ...s.input, runtimeMode: mode }; // the posture is applied by Kora per request; the contract change restarts the process next turn
  }
  async setModel(threadId: ThreadId, model: ModelChoice): Promise<void> {
    const s = this.sessions.get(threadId); if (!s) return;
    s.model = model;
    this.bus.emit(threadId, { type: 'model.rerouted', to: model.model, reason: 'setModel (applies next turn, restarts the agent)' });
  }

  async stopSession(threadId: ThreadId): Promise<void> {
    const s = this.sessions.get(threadId); if (!s) return;
    s.stopped = true;
    if (s.turn) { s.turn.cancelled = true; for (const f of [...s.turn.openPermissions]) f({ outcome: 'cancelled' }); }
    this.gate.cancelAll(threadId);
    this.pool.close(threadId, 'session stopped');
    try { this.deps.blobs?.mcpRevoke?.(threadId); } catch { /* advisory */ }
    this.bus.emit(threadId, { type: 'session.exited', recoverable: true });
    this.bus.emit(threadId, { type: 'session.state', state: 'stopped' });
    this.sessions.delete(threadId);
  }

  /** Daemon shutdown: every agent process goes. */
  async shutdown(): Promise<void> { for (const id of [...this.sessions.keys()]) await this.stopSession(id); this.pool.closeAll('shutdown'); }
}

function pick(options: any[], d: ApprovalAnswer) { return pickPermissionOption(options, d); }

// ── live model discovery (Settings > Engines, model picker) ───────────────────────────────────────────────────────────
/**
 * Ask an ACP agent which models it offers: spawn it, initialize, open a throwaway session in a temp folder and read
 * `models` / the model config option, then close it. Never throws: `{ models: [], error }` when the agent does not say.
 */
export async function discoverAcpModels(engine: AcpEngine, o: { spawn?: AcpSpawnFn; binary?: string | null; timeoutMs?: number } = {}): Promise<{ models: { id: string; name: string }[]; current: string | null; error?: string; failed?: boolean }> {
  const bin = o.binary ?? (engine.executable?.trim() || resolveEngineBinary(engine.command));
  if (!bin) return { models: [], current: null, error: `${engine.label} is not installed` };
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-acp-models-'));
  let child: AcpChild | null = null;
  try {
    child = (o.spawn ?? defaultAcpSpawn)({ command: bin, args: engine.args, env: engineSpawnEnv({ ...process.env, ...(engine.env ?? {}) }, bin), cwd, engineId: engine.agentId });
    child.on('error', () => { /* ENOENT / EACCES: the request below fails when stdout ends */ });
    const conn = new AcpConnection(child.stdin, child.stdout);
    conn.setHandlers({ onRequest: async (m) => { throw new AcpRpcError(-32601, `method not found: ${m}`); }, onNotification: () => {} });
    const ms = o.timeoutMs ?? 20_000;
    const init = await conn.request('initialize', { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'kora', version: '1' } }, { timeoutMs: ms });
    const open = () => conn.request('session/new', { cwd, mcpServers: [] }, { timeoutMs: ms });
    let r: any;
    try { r = await open(); }
    catch (e: any) {
      if (e instanceof AcpRpcError && e.code === -32000 && engine.authMethodId && (init?.authMethods ?? []).some((m: any) => m?.id === engine.authMethodId)) { await conn.request('authenticate', { methodId: engine.authMethodId }, { timeoutMs: ms }); r = await open(); }
      else throw e;
    }
    const e = { models: undefined as undefined | { current: string | null; available: { id: string; name: string }[] } };
    const m = r?.models;
    if (m && Array.isArray(m.availableModels)) e.models = { current: m.currentModelId ?? null, available: m.availableModels.map((x: any) => ({ id: String(x.modelId ?? x.id), name: String(x.name ?? x.modelId ?? x.id) })) };
    else {
      const opt = (Array.isArray(r?.configOptions) ? r.configOptions : []).find((x: any) => x?.category === 'model' || x?.id === 'model');
      if (opt && Array.isArray(opt.options)) e.models = { current: opt.currentValue ?? null, available: opt.options.flatMap((g: any) => (g.options ?? [g])).map((x: any) => ({ id: String(x.value ?? x.id), name: String(x.name ?? x.value ?? x.id) })) };
    }
    conn.close('discovery done');
    return e.models ? { models: e.models.available, current: e.models.current } : { models: [], current: null, error: `${engine.label} does not list its models` };
  } catch (e: any) {
    return { models: [], current: null, error: String(e?.message ?? e).slice(0, 200), failed: true };
  } finally {
    // Never leave a long-lived agent behind: TERM now, KILL if it ignores that.
    const c = child;
    try { if (c) killChild(c); } catch { /* gone */ }
    if (c) { const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } }, 2000); t.unref?.(); }
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* temp */ }
  }
}
