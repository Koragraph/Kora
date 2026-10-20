// The Codex SessionDriver — drives the `codex` CLI (`codex exec --json …`) and normalizes its JSONL
// event stream into ChatEvents (§01 §3). The Codex analogue of claude-driver.ts.
//
// SHAPE (differs from Claude's long-lived query):
//   - Codex has NO persistent session process. Each user turn is ONE `codex exec` child:
//       first turn  : codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check "<PROMPT>"
//       follow-ups  : codex exec resume <thread_id> --json … "<PROMPT>"     (multi-turn via the captured thread_id)
//     run with cwd = the thread's cwd. Codex prints JSONL to stdout, one event per line; we read it
//     line-by-line, JSON.parse each non-empty line, and map to ChatEvents via the PURE `mapCodexEvent`.
//   - Interrupt = kill the spawned child (SIGTERM → SIGKILL).
//   - The Codex `thread_id` (from the first turn's `thread.started`) is stored per session for resume.
//
// The pure `mapCodexEvent` below carries all the JSONL-shape knowledge (unit-tested; no spawn); the class
// is thin child-process wiring around it.
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type {
  ChatEvent, UnsequencedChatEvent, ThreadId, TurnId, RequestId, ItemId,
  ApprovalAnswer, UserInputAnswers, ModelChoice, ToolKind, ToolStatus, FileChange, RuntimeMode, PromptAttachment,
} from '../events';
import { newTurnId } from '../events';
import type {
  SessionDriver, DriverCapabilities, SessionStartInput, SendTurnInput, TurnHandle, DriverDeps,
} from '../session-driver';
import type { AgentId } from '../../protocol/types';
import { agentCommand } from '../../detect/agents';
import { wrapReadDeny } from '../os-sandbox';
import { engineSpawnEnv, engineSpawnProblem, resolveEngineBinaryAsync } from '../../detect/engine-binary';
import { adapterFor } from '../../detect/agent-adapter';
import { ParkedApprovals, askVia } from '../../blobs/apps/approval';
import { proxyPaneId } from './claude-driver';
import { isBlobsCwd } from '../../blobs/home';
import { log } from '../../server/log';
import { parseUsageLimitMessage } from '../usage';
import { codexHomeDir, findCodexRollout, readCodexRolloutUsage } from './codex-rollout';
import { trackChild } from '../../server/children';
import { terminateChild } from './engine-common';
import { killChild } from '../../util/kill-child';
import { CODEX_PLAN_NOTE } from '../plan-mode';
import { codexSavingsArgs } from './codex-savings';
import { CallTracker, logCost } from '../../util/cost-log';

// ═══════════════════════════════════════════════════════════════════════════════
// PURE HELPERS (no spawn, no I/O) — the JSONL→event knowledge, unit-tested.
// ═══════════════════════════════════════════════════════════════════════════════

/** Context threaded through the mapper: the driver-assigned turn id + which item ids have already
 *  streamed incremental deltas (so `item.completed` for those doesn't re-emit the whole text). */
export interface CodexMapCtx {
  turnId?: TurnId;
  streamedItems?: Set<string>;
  /** Tool items whose tool.started went out at item.started (a long command is then visibly running, not silent). */
  startedTools?: Set<string>;
  /** Error texts already surfaced this turn: Codex reports one failure as `error` AND `turn.failed` (same text). */
  errorsSeen?: Set<string>;
  /** One-per-turn notes already shown (the first "Reconnecting… n/5" of a turn; the rest only repeat it). */
  turnNotes?: Set<string>;
}

/** The ChatEvents a Codex usage-limit refusal adds: a rate-limit notice (with the reset time it names) and a sparse
 *  limits report the daemon's usage view merges. Empty when `message` is not a usage-limit refusal. */
export function codexLimitEvents(message: string): UnsequencedChatEvent[] {
  const limit = parseUsageLimitMessage(message);
  if (!limit) return [];
  return [
    { type: 'usage.rate-limit', message, ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}) },
    { type: 'usage.limits', report: { provider: 'codex', windows: [], limited: true, ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}) } },
  ];
}

const num = (v: unknown): number | undefined => { const n = Number(v); return v != null && v !== '' && isFinite(n) ? n : undefined; };
const str = (v: unknown): string => (v == null ? '' : String(v));

/** Classify a Codex item type into the kora ToolKind for the inline card. */
export function codexToolKind(itemType: string): ToolKind {
  if (itemType === 'command_execution') return 'command_execution';
  if (itemType === 'file_change' || itemType === 'patch' || itemType === 'apply_patch') return 'file_change';
  if (itemType === 'file_read') return 'file_read';
  if (itemType === 'web_search') return 'web_search';
  if (itemType === 'mcp_tool_call') return 'mcp_tool_call';
  return 'dynamic_tool_call';
}

/** A short title for a tool card from a Codex item. */
function toolTitle(item: any): string {
  const cmd = item?.command ?? item?.cmd;
  if (cmd) return `$ ${str(Array.isArray(cmd) ? cmd.join(' ') : cmd).split('\n')[0].slice(0, 80)}`;
  const type = str(item?.type);
  // an MCP call names its tool (`kora_spawn`), not the item type ("Mcp_tool_call" in the transcript)
  if (type === 'mcp_tool_call' && item?.tool) return str(item.tool);
  if (type === 'file_change' || type === 'patch' || type === 'apply_patch') {
    const first = firstChangedPath(item);
    return first ? `edit ${first}` : 'file change';
  }
  return type || 'tool';
}

function firstChangedPath(item: any): string | undefined {
  const changes = item?.changes ?? item?.files;
  if (Array.isArray(changes) && changes.length) return str(changes[0]?.path ?? changes[0]?.file ?? changes[0]);
  if (changes && typeof changes === 'object') { const k = Object.keys(changes)[0]; return k || undefined; }
  return item?.path ? str(item.path) : undefined;
}

/** Pull FileChange[] off a Codex file_change / patch item, when present. */
function changedFilesFromItem(item: any): FileChange[] | undefined {
  const raw = item?.changes ?? item?.files;
  const out: FileChange[] = [];
  if (Array.isArray(raw)) {
    for (const c of raw) {
      const path = str(c?.path ?? c?.file ?? c);
      if (!path) continue;
      out.push({ path, additions: num(c?.additions ?? c?.added) ?? 0, deletions: num(c?.deletions ?? c?.removed) ?? 0, ...(c?.patch ? { patch: str(c.patch) } : {}) });
    }
  } else if (raw && typeof raw === 'object') {
    for (const [path, c] of Object.entries<any>(raw)) {
      out.push({ path, additions: num(c?.additions ?? c?.added) ?? 0, deletions: num(c?.deletions ?? c?.removed) ?? 0, ...(c?.patch ? { patch: str(c.patch) } : {}) });
    }
  }
  return out.length ? out : undefined;
}

const CODEX_TOOL_ITEMS: ReadonlySet<string> = new Set(['command_execution', 'file_change', 'patch', 'apply_patch', 'file_read', 'web_search', 'mcp_tool_call']);
function isCodexToolItem(itemType: string): boolean { return CODEX_TOOL_ITEMS.has(itemType); }

function commandOutput(item: any): string | undefined {
  const o = item?.aggregated_output ?? item?.output ?? item?.stdout ?? item?.result;
  return o == null ? undefined : str(o);
}

/** Map ONE parsed Codex JSONL event → zero-or-more ChatEvents (no seq/envelope; the manager stamps those).
 *  The single place Codex JSONL shapes are read; fails soft (a bad shape yields a runtime.warning, never a throw). */
export function mapCodexEvent(evt: any, ctx: CodexMapCtx = {}): UnsequencedChatEvent[] {
  const out: UnsequencedChatEvent[] = [];
  const turnId = ctx.turnId;
  const withTurn = <T extends UnsequencedChatEvent>(e: T): T => (turnId ? ({ ...e, turnId } as T) : e);
  try {
    switch (str(evt?.type)) {
      case 'thread.started':
        // Capture the thread id for resume; the driver also reads providerThreadId off this event.
        return [{ type: 'thread.started', ...(evt.thread_id ? { providerThreadId: str(evt.thread_id) } : {}) }];

      case 'turn.started':
        return [withTurn({ type: 'turn.started', turnId: str(turnId ?? 'turn') })];

      case 'item.started':
      case 'item.updated':
      case 'item.delta': {
        // Incremental streaming text, when Codex emits it. Only agent_message / reasoning carry deltas we render.
        const item = evt.item ?? evt;
        const itemType = str(item?.type);
        const id = str(item?.id ?? evt?.item_id ?? '');
        // A tool starts here (a `cargo test` can run for minutes): say so now, the result follows at item.completed.
        if (str(evt?.type) === 'item.started' && id && isCodexToolItem(itemType)) {
          if (ctx.startedTools?.has(id)) return out;
          ctx.startedTools?.add(id);
          return [withTurn({ type: 'tool.started', itemId: id, toolKind: codexToolKind(itemType), toolName: str(item?.tool_name ?? item?.tool ?? itemType), title: toolTitle(item), input: item })];
        }
        // A `delta`-style event carries only the new chunk; an `updated` carries the running full text — we
        // render deltas from explicit delta fields to avoid re-emitting the whole buffer each update.
        const delta = evt?.delta?.text ?? evt?.delta ?? (str(evt?.type) === 'item.delta' ? item?.text : undefined);
        if (delta == null || delta === '') return out;
        if (itemType === 'reasoning') { if (id) ctx.streamedItems?.add(id); return [withTurn({ type: 'content.delta', itemId: id || `${turnId}:reasoning`, stream: 'reasoning_text', delta: str(delta) })]; }
        if (itemType === 'agent_message' || itemType === 'assistant_message' || itemType === '') {
          if (id) ctx.streamedItems?.add(id);
          return [withTurn({ type: 'content.delta', itemId: id || `${turnId}:text`, stream: 'assistant_text', delta: str(delta) })];
        }
        return out;
      }

      case 'item.completed': {
        const item = evt.item ?? {};
        const itemType = str(item?.type);
        const id = str(item?.id ?? `${turnId}:item`);
        if (itemType === 'agent_message' || itemType === 'assistant_message') {
          if (ctx.streamedItems?.has(id)) return out; // already streamed via deltas — don't double-emit
          const text = str(item?.text ?? item?.message ?? '');
          if (!text) return out;
          return [withTurn({ type: 'content.delta', itemId: id, stream: 'assistant_text', delta: text })];
        }
        if (itemType === 'reasoning') {
          if (ctx.streamedItems?.has(id)) return out;
          const text = str(item?.text ?? item?.summary ?? '');
          if (!text) return out;
          return [withTurn({ type: 'content.delta', itemId: id, stream: 'reasoning_text', delta: text })];
        }
        // Tool-shaped items → the result (plus its start when item.started did not already send one).
        if (isCodexToolItem(itemType)) {
          const kind = codexToolKind(itemType);
          if (!ctx.startedTools?.delete(id)) out.push(withTurn({ type: 'tool.started', itemId: id, toolKind: kind, toolName: str(item?.tool_name ?? item?.tool ?? itemType), title: toolTitle(item), input: item }));
          const exit = num(item?.exit_code);
          const status: ToolStatus = item?.status === 'declined' ? 'declined' : (exit != null && exit !== 0) || item?.status === 'failed' || item?.error ? 'failed' : 'completed';
          const output = commandOutput(item);
          const changedFiles = kind === 'file_change' ? changedFilesFromItem(item) : undefined;
          out.push(withTurn({ type: 'tool.result', itemId: id, status, ...(output !== undefined ? { output } : {}), ...(changedFiles ? { changedFiles } : {}) }));
          return out;
        }
        // Unknown item type: ignore (robustness — tolerate new Codex item kinds).
        return out;
      }

      case 'turn.completed': {
        // `usage` is the WHOLE turn summed over its model requests (input includes cached input) — a cost figure,
        // not how full the context is. Context occupancy comes from the rollout's token_count (see the driver).
        const u = evt.usage ?? {};
        const inputTokens = num(u.input_tokens);
        const outputTokens = num(u.output_tokens);
        const cached = num(u.cached_input_tokens);
        const reasoning = num(u.reasoning_output_tokens);
        const any = inputTokens !== undefined || outputTokens !== undefined;
        out.push({
          type: 'turn.settled', turnId: str(turnId ?? 'turn'), state: 'completed',
          ...(any ? { usage: {
            usageStatus: 'complete' as const,
            ...(inputTokens !== undefined ? { inputTokens: Math.max(0, inputTokens - (cached ?? 0)) } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
            ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
            ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
          } } : {}),
        });
        return out;
      }

      // One failure arrives twice — `{"type":"error","message":M}` then `{"type":"turn.failed","error":{"message":M}}`
      // (live, codex-cli 0.155, usage-limited account). `error` surfaces it; `turn.failed` settles the turn; the same
      // text is never shown twice. A usage limit also becomes a rate-limit notice with its reset time.
      case 'error': {
        const message = str(evt?.message ?? evt?.error?.message ?? evt?.error ?? 'codex error');
        // "Reconnecting... 2/5 (stream disconnected …)" is Codex retrying, not a failure: a warning, the turn goes on —
        // said once per turn (Codex retries 5× per transport, twice: ten rows read "Received 9 updates").
        if (/^reconnecting\b/i.test(message)) {
          // A 401 is not a dropped stream: Codex is signed out and its ten retries only delayed the answer (~17 s,
          // night 2026-10-04). Fail now with the reason; the driver stops the process (see onStdout).
          if (/\b401 Unauthorized\b/.test(message)) {
            const reason = message.replace(/^reconnecting[^(]*\(/i, '').replace(/\)\s*$/, '').trim() || message;
            if (ctx.errorsSeen?.has(reason)) return out;
            ctx.errorsSeen?.add(reason);
            return [{ type: 'runtime.error', errorClass: 'provider', message: reason }];
          }
          if (ctx.turnNotes?.has('reconnecting')) return out;
          ctx.turnNotes?.add('reconnecting');
          return [{ type: 'runtime.warning', message }];
        }
        if (ctx.errorsSeen?.has(message)) return out;
        ctx.errorsSeen?.add(message);
        out.push({ type: 'runtime.error', errorClass: 'provider', message });
        out.push(...codexLimitEvents(message));
        return out;
      }

      case 'turn.failed': {
        const message = str(evt?.error?.message ?? evt?.message ?? evt?.error ?? 'codex turn failed');
        out.push({ type: 'turn.settled', turnId: str(turnId ?? 'turn'), state: 'failed', errorMessage: message });
        if (!ctx.errorsSeen?.has(message)) {
          ctx.errorsSeen?.add(message);
          out.push({ type: 'runtime.error', errorClass: 'provider', message });
          out.push(...codexLimitEvents(message));
        }
        return out;
      }

      default:
        return out; // unknown top-level event — ignore
    }
  } catch {
    return [{ type: 'runtime.warning', message: `unmappable codex event: ${str(evt?.type)}` }];
  }
}

/** Split a stdout buffer into complete JSON events + a trailing remainder (the incomplete last line). */
export function drainLines(buf: string): { events: any[]; rest: string } {
  const events: any[] = [];
  const parts = buf.split('\n');
  const rest = parts.pop() ?? '';
  for (const line of parts) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { events.push(JSON.parse(trimmed)); } catch { /* skip malformed line */ }
  }
  return { events, rest };
}

/**
 * `codex exec` flags for the thread's permission posture. `codex exec` cannot ask for an approval mid-turn, so the
 * postures that would ask map to a Codex SANDBOX instead of to the bypass (before, every Codex turn ran with
 * `--dangerously-bypass-approvals-and-sandbox` whatever the composer showed):
 *   full-access / auto   → --dangerously-bypass-approvals-and-sandbox
 *   auto-accept-edits    → sandbox workspace-write (edits in the thread's cwd; shell sandboxed, no network)
 *   approval-required    → sandbox read-only (it can read and answer; it cannot edit or run writes)
 * `-c` overrides, not `--sandbox`: `codex exec resume` rejects `--sandbox` (codex-cli 0.155) but takes `-c`.
 */
export function codexPermissionArgs(mode: RuntimeMode | undefined, opts: { blob?: boolean } = {}): string[] {
  // A blob is a coworker, not a repo agent: Auto = the workspace-write sandbox (its own folder) WITH network, because web
  // research needs it; live web search is on for every blob posture except Supervised's read-only sandbox.
  if (opts.blob) {
    if (mode === 'full-access') return [...adapterFor('codex').skipPermissionArgs(), '-c', 'web_search="live"'];
    if (mode === 'approval-required') return ['-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"'];
    return ['-c', 'approval_policy="never"', '-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=true', '-c', 'web_search="live"'];
  }
  if (mode === 'full-access' || mode === 'auto') return adapterFor('codex').skipPermissionArgs();
  const sandbox = mode === 'auto-accept-edits' ? 'workspace-write' : 'read-only';
  return ['-c', 'approval_policy="never"', '-c', `sandbox_mode="${sandbox}"`];
}

/** Image types Codex accepts on `-i`; any other image (SVG, HEIC, …) goes in the prompt as a path. */
const CODEX_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const isCodexImage = (a: PromptAttachment) => CODEX_IMAGE_MIME_TYPES.has(a.mimeType ?? '');

/** `codex exec -i <path>…`: every supported image attachment, in order. */
export function codexAttachmentImageArgs(attachments: PromptAttachment[]): string[] {
  const images = attachments.filter(isCodexImage).map((a) => a.path);
  return images.length ? ['-i', ...images] : [];
}

/** Non-image attachments ride in the prompt as `Attached file: <name> at <path> (<mime>)` lines — Codex
 *  (unlike Claude) has no document content block, so this is the only way it learns the path to `Read`. */
export function codexAttachmentPromptLines(attachments: PromptAttachment[]): string {
  return attachments
    .filter((a) => !isCodexImage(a))
    .map((a) => `Attached file: ${a.name ?? a.path} at ${a.path}${a.mimeType ? ` (${a.mimeType})` : ''}`)
    .join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE DRIVER (thin child-process wiring around the pure mapper above).
// ═══════════════════════════════════════════════════════════════════════════════

/** Injectable spawn, so tests drive the driver without a real `codex` binary (defaults to node's spawn). */
export type SpawnFn = (command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess;

interface CodexSessionState {
  threadId: ThreadId;
  input: SessionStartInput;
  /** When the user last sent this thread a message (not a Kora notice); wait_for returns early on a newer one. */
  lastUserAt?: number;
  codexThreadId: string | null; // the Codex thread_id, captured on the first turn → used for `exec resume`
  playbookSent?: boolean;       // orchestrator: the fleet playbook rides in the first turn's prompt (codex exec has no system-prompt hook)
  currentTurnId: TurnId | null;
  child: ChildProcess | null;
  stdoutBuf: string;
  streamedItems: Set<string>;
  startedTools?: Set<string>;
  sawTurnCompleted: boolean;
  /** Error texts surfaced this turn (see mapCodexEvent `error` / `turn.failed`). */
  errorsSeen: Set<string>;
  /** One-per-turn notes already shown (mapCodexEvent `turnNotes`). */
  turnNotes?: Set<string>;
  /** The turn already failed on a signed-out 401 and the process is being stopped: ignore what it still prints. */
  aborted?: boolean;
  /** The rollout file of `codexThreadId` once found (context + rate limits are read from it after each turn). */
  rolloutPath?: string | null;
  model: ModelChoice | null;
  stopped: boolean;
  /** The read-only-sandbox notice was shown for this session (once). */
  readOnlyNoticed?: boolean;
  /** Plan mode (the composer's Plan toggle): this turn runs read-only and is told to end with the plan. */
  planMode?: boolean;
  /** The cost log (savings meter): the model requests already logged end at `costLoggedTo` (ms; starts at session start
   *  so a resumed rollout's older requests are never logged twice). */
  callTracker: CallTracker;
  costLoggedTo: number;
  /** This turn's one-time caller-key file for the fleet bridge (control-auth.ts writeCallerKeyFile), until it is read or the turn ends. */
  callerKeyFile?: string;
}

export class CodexDriver implements SessionDriver {
  readonly agent: AgentId = 'codex';
  readonly capabilities: DriverCapabilities = {
    modelSwitch: 'restart-only',
    promptlessContinuation: false,
    conversationRollback: true,
    manualCompaction: false,
    canSpawnWorkers: false,
    reportsToolStart: true,
  };

  private sessions = new Map<ThreadId, CodexSessionState>();
  private listeners = new Set<(e: ChatEvent) => void>();
  /** Yes/no questions a blob's connected-app tools park (outbound actions); answered through `respondToApproval`. */
  private appAsks = new ParkedApprovals();

  /** Finds the `codex` CLI. The daemon's PATH is bare, so a plain `spawn('codex')` died with ENOENT (detect/engine-binary.ts).
   *  A test that injects its own spawn keeps the bare name unless it injects a resolver too. */
  private binResolver: (name: string) => Promise<string | null>;
  constructor(private deps: DriverDeps, private spawnFn: SpawnFn = defaultSpawn, resolveBin?: (name: string) => Promise<string | null>) {
    this.binResolver = resolveBin ?? (spawnFn === defaultSpawn ? resolveEngineBinaryAsync : async (n: string) => n);
  }

  streamEvents(onEvent: (e: ChatEvent) => void): () => void {
    this.listeners.add(onEvent);
    return () => this.listeners.delete(onEvent);
  }
  hasSession(threadId: ThreadId): boolean { const s = this.sessions.get(threadId); return !!s && !s.stopped; }

  private emit(threadId: ThreadId, ev: UnsequencedChatEvent): void {
    const full = { seq: 0, at: Date.now(), ...ev, threadId } as ChatEvent;
    for (const l of this.listeners) { try { l(full); } catch { /* isolate a bad listener */ } }
  }
  private emitMany(threadId: ThreadId, evs: UnsequencedChatEvent[]): void { for (const e of evs) this.emit(threadId, e); }

  async startSession(input: SessionStartInput): Promise<{ threadId: ThreadId; resume?: unknown }> {
    const existing = this.sessions.get(input.threadId);
    if (existing) return { threadId: input.threadId, resume: existing.codexThreadId ?? undefined };
    // Codex has no persistent process; startSession just registers the session and (if resuming) the thread id.
    // The resume cursor is read back from the thread's meta.json and lands on argv: only a plain id (never a `-`flag).
    const codexThreadId = typeof input.resume === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.resume) ? input.resume : null;
    const state: CodexSessionState = {
      threadId: input.threadId, input, codexThreadId, currentTurnId: null, child: null,
      stdoutBuf: '', streamedItems: new Set(), sawTurnCompleted: false, errorsSeen: new Set(), model: input.model ?? null, stopped: false,
      callTracker: new CallTracker(!!codexThreadId), costLoggedTo: Date.now(),
    };
    this.sessions.set(input.threadId, state);
    this.emit(input.threadId, { type: 'session.started' });
    if (codexThreadId) this.emit(input.threadId, { type: 'thread.started', providerThreadId: codexThreadId });
    this.emit(input.threadId, { type: 'session.state', state: 'ready' });
    return { threadId: input.threadId, resume: codexThreadId ?? undefined };
  }

  async sendTurn(input: SendTurnInput): Promise<TurnHandle> {
    const state = this.sessions.get(input.threadId);
    if (!state) throw new Error(`no live session for thread ${input.threadId}`);
    if (state.child) { // Codex runs one turn at a time; interrupt the in-flight turn before starting a new one.
      await this.interruptTurn(input.threadId).catch(() => {});
    }
    if (input.origin !== 'kora-notice') state.lastUserAt = Date.now();
    // Codex has no promptless continuation — a turn needs prompt text.
    let text = input.text ?? '';
    // Per-prompt graph injection, same as the Claude chat lane: Codex has no UserPromptSubmit hook, so without this
    // a code-repo Codex thread ran with ZERO declarations injected (measured: inject.jsonl had no codex-chat rows).
    // Best-effort and bounded; never blocks a turn. The assistant lane has no graph at all — skip it there.
    if (text && !isBlobsCwd(state.input.cwd)) {
      try {
        const { injectForPrompt } = require('../../graph/prompt-inject') as typeof import('../../graph/prompt-inject');
        const inj = await injectForPrompt({
          prompt: text, cwd: state.input.cwd, sessionId: input.threadId, lane: 'codex-chat',
          ...(this.deps.graphStatus ? { graph: { status: (c: string) => this.deps.graphStatus!(c), callTool: (n: any, a: Record<string, unknown>, o: { cwd: string; fresh?: boolean }) => this.deps.graphCall(n, a, o) } } : {}),
        });
        if (inj) text = `${inj}\n\n${text}`;
      } catch { /* injection is best-effort */ }
    }
    // A pending notice / a blob's per-turn memory context rides ahead of the user's text, agent-only (the Claude driver does the same).
    if (input.origin !== 'kora-notice' && !input.continuation) state.planMode = input.interactionMode === 'plan';
    if (state.planMode) text = `${CODEX_PLAN_NOTE}\n\n${text}`;
    if (input.koraNotice) text = text ? `${input.koraNotice}\n\n${text}` : input.koraNotice;
    if (input.model?.model) { const changed = input.model.model !== state.model?.model; state.model = input.model; if (changed) this.emit(input.threadId, { type: 'model.rerouted', to: input.model.model, reason: 'per-turn override (restart)' }); }

    // Non-image attachments have no content-block equivalent on the `codex exec` CLI — fold them into the
    // prompt as path references; images go on argv instead (see spawnTurn).
    const fileLines = input.attachments?.length ? codexAttachmentPromptLines(input.attachments) : '';
    if (fileLines) text = text ? `${text}\n\n${fileLines}` : fileLines;

    const turnId: TurnId = newTurnId();
    state.currentTurnId = turnId;
    state.streamedItems = new Set();
    state.startedTools = new Set();
    state.sawTurnCompleted = false;
    state.errorsSeen = new Set();
    state.turnNotes = new Set();
    state.aborted = false;
    state.stdoutBuf = '';

    const binary = await this.binResolver(agentCommand('codex'));
    if (!binary) {
      const msg = engineSpawnProblem('codex', { code: 'ENOENT' })!;
      this.emit(state.threadId, { type: 'runtime.error', errorClass: 'provider', message: msg });
      this.emit(state.threadId, { type: 'turn.settled', turnId, state: 'failed', errorMessage: msg });
      state.currentTurnId = null;
      this.emit(state.threadId, { type: 'session.state', state: 'ready' });
      return { threadId: input.threadId, turnId };
    }
    // Token levers (tool-output cap, earlier auto-compact, unused features off). Best effort: a failure here is no savings, not a failed turn.
    const savings = await codexSavingsArgs(binary ?? agentCommand('codex'), { probe: this.spawnFn === defaultSpawn }).catch(() => [] as string[]);
    this.spawnTurn(state, text, input.attachments ?? [], binary, savings);
    return { threadId: input.threadId, turnId };
  }

  /**
   * An ORCHESTRATOR thread: Codex has no in-process tool hook, so the fleet tools come from `kora mcp --fleet`
   * declared as an MCP server on the command line (`-c mcp_servers.kora_fleet.*`), which drives the runtime
   * over its pane socket. The bridge learns who it is from env (orchestrator id = the same `chat:<threadId>`
   * the Claude driver uses, so the daemon's fleet panel / notes route identically).
   */
  private fleetBridge(state: CodexSessionState): { args: string[]; env: Record<string, string> } {
    if (!state.input.isOrchestrator || state.input.helpersOff || !this.deps.socketPath || !this.deps.binPath) return { args: [], env: {} };
    const model = state.model?.model ?? state.input.model?.model;
    const effort = state.model?.effort ?? state.input.model?.effort;
    // Identity on argv: Codex starts MCP servers with a scrubbed environment, so env alone never reached the bridge.
    const spec = { command: process.execPath, args: [this.deps.binPath, 'mcp', '--fleet',
      '--orchestrator', proxyPaneId(state.threadId), '--socket', this.deps.socketPath, '--agent', 'codex',
      // The proof of that identity (server/control-auth.ts callerKey): without it the daemon scopes the bridge to no fleet.
      // Only a one-time 0600 file's PATH rides argv (the key itself would show in `ps -ww`); the bridge reads + deletes it.
      ...(() => { const f = this.callerKeyFile(state); return f ? ['--caller-key-file', f] : []; })(),
      // Without --agent-mode the bridge never offers kora_spawn agent:"swarm" — a Codex leader on the assistant lane
      // (agentMode is always 'swarm' there) got the plain-orchestrator toolset and no swarm alias.
      ...(state.input.agentMode ? ['--agent-mode', state.input.agentMode] : []),
      ...(state.input.runtimeMode ? ['--runtime-mode', state.input.runtimeMode] : []),
      ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []),
      ...(state.input.account ? ['--account', state.input.account] : []),
      '--kora-home', (require('../../protocol/types') as typeof import('../../protocol/types')).koraHome()] };
    return {
      args: ['-c', `mcp_servers.kora_fleet.command=${JSON.stringify(spec.command)}`, '-c', `mcp_servers.kora_fleet.args=${JSON.stringify(spec.args)}`],
      env: {
        KORA_SOCKET_PATH: this.deps.socketPath,
        KORA_ORCHESTRATOR_ID: proxyPaneId(state.threadId),
        KORA_ORCHESTRATOR_AGENT: 'codex',
        ...(state.input.runtimeMode ? { KORA_RUNTIME_MODE: state.input.runtimeMode } : {}),
        ...(model ? { KORA_ORCHESTRATOR_MODEL: model } : {}),
        ...(effort ? { KORA_ORCHESTRATOR_EFFORT: effort } : {}),
        ...(state.input.account ? { KORA_ACCOUNT: state.input.account } : {}),
      },
    };
  }

  /** A fresh one-time caller-key file for this turn's bridge (the last one, if the bridge never read it, is removed). */
  private callerKeyFile(state: CodexSessionState): string | null {
    this.dropCallerKeyFile(state);
    try {
      const { writeCallerKeyFile } = require('../../server/control-auth') as typeof import('../../server/control-auth');
      state.callerKeyFile = writeCallerKeyFile(proxyPaneId(state.threadId), (require('../../protocol/types') as typeof import('../../protocol/types')).koraHome()) ?? undefined;
    } catch { state.callerKeyFile = undefined; }
    return state.callerKeyFile ?? null;
  }

  private dropCallerKeyFile(state: CodexSessionState): void {
    if (state.callerKeyFile) { try { fs.unlinkSync(state.callerKeyFile); } catch { /* the bridge took it */ } }
    state.callerKeyFile = undefined;
  }

  /** `kora_blobs`: the blob's tools for this turn. The token is per turn (its closures emit on the current turn) and is revoked when the process ends. */
  private blobsBridge(state: CodexSessionState): { args: string[] } | null {
    const blobs = this.deps.blobs;
    if (!blobs?.mcpIssue || !this.deps.socketPath || !this.deps.binPath) return null;
    let b: ReturnType<NonNullable<DriverDeps['blobs']>['byCwd']> = null;
    try { b = blobs.byCwd(state.input.cwd); } catch { b = null; }
    if (!b) return null;
    const { blobsMcpSpec, codexBlobsMcpArgs } = require('../../blobs/mcp-wire') as typeof import('../../blobs/mcp-wire');
    const threadId = state.threadId;
    const turn = () => (state.currentTurnId ? { turnId: state.currentTurnId } : {});
    blobs.mcpRevoke?.(threadId);
    const token = blobs.mcpIssue({
      blobId: b.id, threadId, agent: 'codex', cwd: state.input.cwd,
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
    return { args: codexBlobsMcpArgs(blobsMcpSpec({ binPath: this.deps.binPath, socketPath: this.deps.socketPath, blobId: b.id, token, threadId, agent: 'codex' })) };
  }

  /** Build argv and spawn `codex exec [resume <id>] --json … "<prompt>"`; wire stdout/exit → ChatEvents. */
  private spawnTurn(state: CodexSessionState, prompt: string, attachments: PromptAttachment[] = [], binary?: string, savings: string[] = []): void {
    const command = binary ?? agentCommand('codex');
    const mode = state.input.runtimeMode;
    let isBlob = false;
    try { isBlob = !!this.deps.blobs?.byCwd(state.input.cwd); } catch { isBlob = false; }
    // Plan mode: `codex exec` has no plan mode of its own, so a plan turn runs in the read-only sandbox (plan-mode.ts).
    const bypass = state.planMode ? codexPermissionArgs('approval-required') : codexPermissionArgs(mode, { blob: isBlob });
    if (!state.planMode && mode !== 'full-access' && mode !== 'auto' && mode !== 'auto-accept-edits' && !state.readOnlyNoticed) {
      state.readOnlyNoticed = true;
      this.emit(state.threadId, { type: 'runtime.warning', message: 'Codex cannot ask for approvals, so in Supervised mode it runs in a read-only sandbox. Switch to Auto-accept edits or Full access to let it edit.' });
    }
    const bridge = this.fleetBridge(state);
    // A blob's tools (self tools, and Kora's team tools for the Chief) over MCP: identity + token on argv.
    const blobMcp = isBlob ? this.blobsBridge(state) : null;
    if (blobMcp) bridge.args.push(...blobMcp.args);
    // The user's extensions (Settings › Extensions) as `-c mcp_servers.<name>.*`; remote-server secrets travel in env.
    const extensions = (require('../../extensions') as typeof import('../../extensions')).codexSessionWiring({ ...state.input, threadId: state.threadId }, this.deps.isFolderTrusted);
    bridge.args.push(...extensions.args);
    Object.assign(bridge.env, extensions.env);
    // Forward the composer's model + reasoning-effort selection to a regular exec turn. Codex takes the
    // model via `--model` and the reasoning level via `-c model_reasoning_effort=<level>` (minimal|low|
    // medium|high — the values config.ts's codexCapabilities advertises). Both are omitted when unset so
    // Codex falls back to the user's ~/.codex/config.toml defaults. The orchestrator path forwards these
    // through the fleet bridge instead, so this only augments non-orchestrator turns.
    const selModel = state.model?.model ?? state.input.model?.model;
    const selEffort = state.model?.effort ?? state.input.model?.effort;
    // The lead's own model always rides argv (the fleet bridge only carries it as the workers' default — a fleet-wired
    // lead used to run on Codex's config default whatever the composer showed).
    const modelArgs = [
      ...(selModel ? [`--model=${selModel}`] : []), // `=`: a model id is never mistaken for the next flag
      ...(selEffort ? ['-c', `model_reasoning_effort=${JSON.stringify(selEffort)}`] : []),
    ];
    // Codex's sandboxes confine writes, not reads, so the attachment folder needs no `--add-dir` (which
    // `codex exec resume` would reject anyway).
    const imageArgs = codexAttachmentImageArgs(attachments);
    // Kora's rule: no harness-native subagents — Codex delegates through the kora fleet bridge or not at all.
    const flags = [...bypass, '--json', '--skip-git-repo-check', '--disable', 'multi_agent', ...savings, ...modelArgs, ...imageArgs, ...bridge.args];
    // The orchestrator playbook (the same text the Claude driver appends to its system prompt) goes in front of
    // the first orchestrator turn — the resumed thread keeps it from then on.
    if (state.input.isOrchestrator && !state.playbookSent) {
      const playbook = this.deps.appendSystemPrompt(state.input);
      if (playbook) { prompt = `${playbook}\n\n---\n\n${prompt}`; }
      state.playbookSent = true;
    }
    // `--` ends option parsing: the prompt is user text (or a lead's text for a worker, or a repo file it quoted), and
    // as a bare positional one that began with `-` was parsed as FLAGS — `-c sandbox_mode="danger-full-access"` or
    // `--dangerously-bypass-approvals-and-sandbox` escaped the read-only sandbox Supervised mode promises — and a
    // prompt of `review` / `resume` / `fork` ran that subcommand instead.
    const args = state.codexThreadId
      ? ['exec', 'resume', state.codexThreadId, ...flags, '--', prompt]
      : ['exec', ...flags, '--', prompt];
    const env = engineSpawnEnv({ ...process.env, ...this.deps.spawnEnv(state.threadId, state.input.account), ...bridge.env }, binary);
    if (state.input.isOrchestrator) log(`chat ${state.threadId}: codex orchestrator turn — fleet bridge ${bridge.args.length ? 'ON' : `OFF (socketPath=${this.deps.socketPath ?? '∅'} binPath=${this.deps.binPath ?? '∅'})`}`);

    let child: ChildProcess;
    try { child = this.spawnFn(command, args, { cwd: state.input.cwd, env }); }
    catch (e: any) {
      const human = engineSpawnProblem('codex', e) ?? `failed to start codex: ${e?.message ?? e}`;
      this.emit(state.threadId, { type: 'runtime.error', errorClass: 'provider', message: human });
      if (state.currentTurnId) this.emit(state.threadId, { type: 'turn.settled', turnId: state.currentTurnId, state: 'failed', errorMessage: human });
      state.currentTurnId = null;
      return;
    }
    state.child = child;
    this.emit(state.threadId, { type: 'session.state', state: 'running' });

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.onStdout(state, chunk));
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (e: any) => {
      const human = engineSpawnProblem('codex', e);
      this.emit(state.threadId, { type: 'runtime.error', errorClass: 'provider', message: human ?? `codex process error: ${e?.message ?? e}` });
      // A child that never started has no exit to settle the turn: settle it here, in words (was a raw `spawn codex ENOENT`).
      if (human && state.currentTurnId && !state.sawTurnCompleted) {
        state.sawTurnCompleted = true;
        this.emit(state.threadId, { type: 'turn.settled', turnId: state.currentTurnId, state: 'failed', errorMessage: human });
      }
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => this.onExit(state, code, signal, () => stderr));
  }

  /** Feed a stdout chunk through the line-splitter + mapper, emitting each event and capturing the thread id. */
  private onStdout(state: CodexSessionState, chunk: string): void {
    state.stdoutBuf += chunk;
    const { events, rest } = drainLines(state.stdoutBuf);
    state.stdoutBuf = rest;
    for (const evt of events) {
      if (str(evt?.type) === 'thread.started' && evt.thread_id) { // capture for resume
        if (state.codexThreadId !== str(evt.thread_id)) state.rolloutPath = null;
        state.codexThreadId = str(evt.thread_id);
      }
      // A failed turn is settled by its own event — the exit must not settle it a second time.
      if (str(evt?.type) === 'turn.completed' || str(evt?.type) === 'turn.failed') state.sawTurnCompleted = true;
      if (state.aborted) continue;
      const mapped = mapCodexEvent(evt, { turnId: state.currentTurnId ?? undefined, streamedItems: state.streamedItems, startedTools: state.startedTools ?? (state.startedTools = new Set()), errorsSeen: state.errorsSeen, turnNotes: state.turnNotes ?? (state.turnNotes = new Set()) });
      this.emitMany(state.threadId, mapped);
      try { (require('../../graph/inject-carry') as typeof import('../../graph/inject-carry')).noteTouchedFromEvents(state.threadId, state.input.cwd, mapped); } catch { /* recall memory is best effort */ }
      // Signed out (a 401 behind "Reconnecting…"): settle the turn now and stop Codex instead of sitting through its
      // retries. onExit then has nothing left to settle.
      const auth = mapped.find((e): e is Extract<UnsequencedChatEvent, { type: 'runtime.error' }> => e.type === 'runtime.error' && /\b401 Unauthorized\b/.test(e.message));
      if (auth && state.currentTurnId && !state.sawTurnCompleted) {
        state.aborted = true;
        state.sawTurnCompleted = true;
        this.emit(state.threadId, { type: 'turn.settled', turnId: state.currentTurnId, state: 'failed', errorMessage: auth.message });
        try { if (state.child) killChild(state.child); } catch { /* already gone */ }
      }
    }
  }

  /** The child exited. Flush any trailing line; if turn.completed was never seen, settle failed + runtime.error. */
  private onExit(state: CodexSessionState, code: number | null, signal: NodeJS.Signals | null, stderr: () => string): void {
    // flush a final unterminated line
    if (state.stdoutBuf.trim()) { this.onStdout(state, '\n'); }
    const wasChild = state.child;
    state.child = null;
    this.deps.blobs?.mcpRevoke?.(state.threadId);
    this.dropCallerKeyFile(state);
    this.appAsks.cancelThread(state.threadId);
    if (state.stopped) return; // deliberate stop already settled

    const interrupted = signal === 'SIGTERM' || signal === 'SIGKILL';
    const turnId = state.currentTurnId;
    if (state.currentTurnId && !state.sawTurnCompleted) {
      if (interrupted) {
        this.emit(state.threadId, { type: 'turn.settled', turnId: state.currentTurnId, state: 'interrupted' });
      } else {
        // An `error` event already said why (e.g. a usage limit): settle with that text instead of a second,
        // vaguer "codex exited" row.
        const said = [...state.errorsSeen].pop();
        const msg = said ?? `codex exited (code ${code ?? 'null'})${stderr().trim() ? `: ${stderr().trim().slice(0, 400)}` : ''}`;
        this.emit(state.threadId, { type: 'turn.settled', turnId: state.currentTurnId, state: 'failed', errorMessage: msg });
        if (!said) this.emit(state.threadId, { type: 'runtime.error', errorClass: 'provider', message: msg });
      }
    }
    state.currentTurnId = null;
    void wasChild;
    this.emit(state.threadId, { type: 'session.state', state: 'ready' });
    if (!interrupted) void this.reportRolloutUsage(state, turnId);
  }

  /**
   * After a turn: how full the context is and the account's rate limits, from the thread's rollout (`codex exec
   * --json` prints neither). Best-effort; a missing file or event emits nothing.
   */
  private async reportRolloutUsage(state: CodexSessionState, turnId: TurnId | null): Promise<void> {
    if (!state.codexThreadId || state.stopped) return;
    try {
      if (!state.rolloutPath) {
        const env = this.deps.spawnEnv(state.threadId, state.input.account ?? null) as Record<string, string | undefined>;
        state.rolloutPath = await findCodexRollout(codexHomeDir({ ...process.env, ...env }), state.codexThreadId);
      }
      if (!state.rolloutPath) return;
      const { context, limits, requests } = await readCodexRolloutUsage(state.rolloutPath, state.costLoggedTo);
      for (const r of requests) {
        if (r.ts <= state.costLoggedTo) continue;
        state.costLoggedTo = r.ts;
        logCost({ ...state.callTracker.record({ model: r.model ?? state.model?.model ?? null, in: r.in, cr: r.cr, cc: r.cc, out: r.out }, r.ts, state.threadId), h: 'codex' });
      }
      if (state.stopped) return;
      if (context) this.emit(state.threadId, { type: 'thread.token-usage', usage: context, ...(turnId ? { turnId } : {}) });
      if (limits) this.emit(state.threadId, { type: 'usage.limits', report: limits });
    } catch { /* usage is a nicety; never fail a turn over it */ }
  }

  async interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void> {
    this.appAsks.cancelThread(threadId); // an app action waiting for its OK is denied when the turn is stopped
    const state = this.sessions.get(threadId);
    if (!state?.child) return;
    // Meant for a turn that already ended: stopping now would kill the NEXT turn (a worker's queued steer).
    if (turnId && state.currentTurnId && state.currentTurnId !== turnId) return;
    const child = state.child;
    terminateChild(child); // SIGTERM, then SIGKILL if it is still running 2 s later
  }

  async respondToApproval(threadId: ThreadId, requestId: RequestId, decision: ApprovalAnswer): Promise<void> {
    if (this.appAsks.respond(threadId, requestId, decision)) return; // a connected-app action waiting for its OK
    // `codex exec` runs with approvals bypassed (--dangerously-bypass-approvals-and-sandbox), so no inline
    // approval is ever opened. Nothing to resolve; no-op.
  }

  async respondToUserInput(_threadId: ThreadId, _requestId: RequestId, _answers: UserInputAnswers): Promise<void> {
    // `codex exec` is non-interactive and asks no structured questions mid-turn. No-op.
  }

  /** The next `codex exec` turn (one child per turn) picks the new posture up; nothing is running to update. */
  async setPermissionMode(threadId: ThreadId, mode: RuntimeMode): Promise<void> {
    const state = this.sessions.get(threadId);
    if (!state) return;
    state.input = { ...state.input, runtimeMode: mode };
    if (mode !== 'approval-required') state.readOnlyNoticed = false;
  }

  async setModel(threadId: ThreadId, model: ModelChoice): Promise<void> {
    // restart-only: the next `codex exec` picks up the new model. Record it and let clients know.
    const state = this.sessions.get(threadId);
    if (!state) return;
    state.model = model;
    this.emit(threadId, { type: 'model.rerouted', to: model.model, reason: 'setModel (applies next turn)' });
  }

  async stopSession(threadId: ThreadId): Promise<void> {
    const state = this.sessions.get(threadId);
    if (!state) return;
    state.stopped = true;
    this.appAsks.cancelThread(threadId);
    this.deps.blobs?.mcpRevoke?.(threadId);
    if (state.child) { terminateChild(state.child); state.child = null; }
    this.emit(threadId, { type: 'session.exited', recoverable: true });
    this.emit(threadId, { type: 'session.state', state: 'stopped' });
    this.sessions.delete(threadId);
  }
}

function defaultSpawn(command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcess {
  // No tool hooks on this lane: the CLI runs under an OS read-deny for credential paths (session/os-sandbox.ts).
  const w = wrapReadDeny('codex', command, args);
  return trackChild(spawn(w.command, w.args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: w.windowsVerbatimArguments }), 'chat codex');
}
