// The Antigravity SessionDriver — drives Google's `agy` CLI (Antigravity 1.3) in print mode and maps its NDJSON stream
// into ChatEvents. Shape = CodexDriver: no persistent process, one child per user turn, the conversation id captured
// from the first `init` event and passed back with `--conversation` so the next turn resumes the same conversation.
//
//   agy --print=<prompt> --model=<id> [--effort=<e>] [--conversation=<id>] <posture flags>
//       --output-format=stream-json --print-timeout=0          (cwd = the thread's folder, stdin closed)
//
// Stream (recorded live with agy 1.3.3, fixtures/agy/*.ndjson):
//   {"event":"init","conversation_id":C,"init":{model,cwd,tools,permission_mode}}
//   {"event":"step_update","step_update":{conversation_id,step_index,state:ACTIVE|DONE|ERROR,step_type,…}}
//       step_type agent_response: text_delta (streamed), usage {input,output,thinking,cache_read,total} on DONE
//       step_type tool: tool_name, tool_info {name, parameters, output | error {type,message}}
//       step_type user_input / system_message: nothing to show
//   {"event":"result","result":{conversation_id,status:SUCCESS|ERROR,response,usage,error?,denied_actions?}}
//   `result.usage` is CUMULATIVE over the whole conversation (a resumed turn reports every earlier turn too), so the
//   turn's usage is summed from its own agent_response steps, and the context meter reads the last step's input.
//
// Print mode cannot ask the user anything: a tool that needs a permission the posture does not grant is auto-denied
// (the step ends ERROR "user denied permission…" and the result lists `denied_actions`). So the composer only offers
// postures that never wait: Read only (agy default, edits + commands denied), Accept edits (`--mode accept-edits`,
// commands denied) and Full access (`--dangerously-skip-permissions`). Nothing here ever parks an approval card.
//
// The pure helpers below carry all the stream knowledge (unit-tested against the recorded fixtures); the class is thin
// child-process wiring around them.
import { spawn, type ChildProcess } from 'node:child_process';
import type {
  ChatEvent, UnsequencedChatEvent, ThreadId, TurnId, RequestId, ApprovalAnswer, UserInputAnswers, ModelChoice,
  ToolKind, ToolStatus, FileChange, RuntimeMode, PromptAttachment, TokenUsage, TurnUsage,
} from '../events';
import { newTurnId } from '../events';
import type { SessionDriver, DriverCapabilities, SessionStartInput, SendTurnInput, TurnHandle, DriverDeps, SessionPrep } from '../session-driver';
import type { AgentId } from '../../protocol/types';
import { withBrowserGuard, wrapReadDeny } from '../os-sandbox';
import { engineSpawnEnv, engineSpawnProblem, resolveEngineBinaryAsync } from '../../detect/engine-binary';
import { isBlobsCwd } from '../../blobs/home';
import { log } from '../../server/log';
import { RATE_LIMIT_RE } from './engine-common';
import { trackChild } from '../../server/children';
import { CallTracker, logCost } from '../../util/cost-log';
import { catalogContextWindow } from '../../ledger/prices';
import { killChild } from '../../util/kill-child';
import { inTerminal } from '../../util/platform-copy';

// ═══════════════════════════════════════════════════════════════════════════════
// PURE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

const str = (v: unknown): string => (v == null ? '' : String(v));
const num = (v: unknown): number | undefined => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) ? n : undefined; };

/**
 * `agy` flags for the thread's posture. Print mode cannot ask, so nothing here waits for an answer:
 *   full-access / auto   → --dangerously-skip-permissions   (every tool runs)
 *   auto-accept-edits    → --mode accept-edits              (file edits run; commands are denied)
 *   approval-required    → (agy's default request-review)    (reads run; edits and commands are denied)
 *   plan turn            → --mode plan                       (whatever the posture: a plan turn changes nothing)
 */
export function agyPermissionArgs(mode: RuntimeMode | undefined, interaction?: 'default' | 'plan'): string[] {
  if (interaction === 'plan') return ['--mode=plan'];
  if (mode === 'full-access' || mode === 'auto') return ['--dangerously-skip-permissions'];
  if (mode === 'auto-accept-edits') return ['--mode=accept-edits'];
  return [];
}

/** What a posture cannot do through print mode, said once per session (null = nothing is skipped). */
export function agyPostureNotice(mode: RuntimeMode | undefined): string | null {
  if (mode === 'full-access' || mode === 'auto') return null;
  if (mode === 'auto-accept-edits') return 'Antigravity cannot ask for approval when Kora drives it, so with Accept edits it edits files but skips shell commands. Switch to Full access to let it run commands.';
  return 'Antigravity cannot ask for approval when Kora drives it, so in Read only it reads and answers but skips edits and commands. Switch to Accept edits or Full access to let it change things.';
}

/** The context window (agy does not report it): the price catalog's, else per model family. Unknown ids get no maximum (the meter shows tokens only). */
export function agyContextWindow(model: string | null | undefined): number | undefined {
  const m = str(model).toLowerCase();
  const listed = catalogContextWindow(m.replace(/-(minimal|low|medium|high|xhigh|max|thinking)$/, ''));
  if (listed) return listed;
  if (m.startsWith('gemini-')) return 1_048_576;
  if (m.startsWith('claude-')) return 200_000;
  if (m.startsWith('gpt-oss')) return 131_072;
  return undefined;
}

export function agyToolKind(name: string): ToolKind {
  if (name === 'run_command' || name === 'send_command_input' || name === 'command_status') return 'command_execution';
  if (/^(write_to_file|replace_file_content|multi_replace_file_content|sed_file|notebook_edit)$/.test(name)) return 'file_change';
  if (/^(view_file|list_dir|find_by_name|grep_search)$/.test(name)) return 'file_read';
  if (name === 'search_web' || name === 'read_url_content') return 'web_search';
  if (name === 'call_mcp_tool') return 'mcp_tool_call';
  return 'dynamic_tool_call';
}

function toolPath(p: any): string {
  return str(p?.TargetFile ?? p?.AbsolutePath ?? p?.FilePath ?? p?.Path ?? p?.DirectoryPath ?? p?.SearchPath ?? p?.SearchDirectory ?? '');
}

/** A short title for a tool row. */
export function agyToolTitle(name: string, params: any): string {
  const kind = agyToolKind(name);
  if (name === 'run_command') { const c = str(params?.CommandLine ?? params?.Command).split('\n')[0]!.slice(0, 80); return c ? `$ ${c}` : 'run command'; }
  const p = toolPath(params);
  if (kind === 'file_change') return p ? `edit ${p}` : 'file change';
  if (name === 'view_file') return p ? `read ${p}` : 'read file';
  if (name === 'list_dir') return p ? `list ${p}` : 'list folder';
  if (name === 'grep_search') { const q = str(params?.Query ?? params?.Pattern); return q ? `search "${q.slice(0, 60)}"` : 'search'; }
  if (name === 'find_by_name') { const q = str(params?.Pattern ?? params?.Query); return q ? `find ${q.slice(0, 60)}` : 'find files'; }
  if (name === 'search_web') { const q = str(params?.query ?? params?.Query); return q ? `web: ${q.slice(0, 60)}` : 'web search'; }
  if (name === 'read_url_content') { const u = str(params?.Url ?? params?.url); return u ? `fetch ${u.slice(0, 80)}` : 'fetch page'; }
  return name || 'tool';
}

/** Per-turn mapper state: which tool rows were opened, what streamed, the turn's own usage. */
export interface AgyTurnState {
  conversationId: string | null;
  openTools: Set<string>;
  textStreamed: boolean;
  /** Sums over this turn's agent_response steps (the result's usage is conversation-wide). */
  input: number; output: number; thinking: number; cacheRead: number; steps: number;
  /** The last step's request (input + output): what the model sees next — the context meter. */
  lastContext: number | null;
  /** The run's terminal result (status, error text, denied tools), once seen. */
  result: { ok: boolean; error?: string; denied: string[] } | null;
  /** Each step's request (fresh input, cache reads, output — which already includes thinking), for the cost log; the driver drains it. */
  calls: { in: number; cr: number; cc: number; out: number }[];
}
export const newAgyTurnState = (conversationId: string | null = null): AgyTurnState => ({
  conversationId, openTools: new Set(), textStreamed: false, input: 0, output: 0, thinking: 0, cacheRead: 0, steps: 0, lastContext: null, result: null, calls: [],
});

/** The turn's usage from its own steps (cache reads are reported separately from fresh input, the Codex convention). */
export function agyTurnUsage(st: AgyTurnState): TurnUsage | undefined {
  if (!st.steps) return undefined;
  return {
    usageStatus: 'complete', inputTokens: Math.max(0, st.input - st.cacheRead), outputTokens: st.output,
    ...(st.cacheRead ? { cachedInputTokens: st.cacheRead } : {}), ...(st.thinking ? { reasoningTokens: st.thinking } : {}),
  };
}

/** Models agy answered on in this daemon. Offline, agy cannot load its model list and calls every model unknown: for a
 *  model that worked, that is a network blip to retry, not a removal. */
const agyModelsWorked = new Set<string>();
export const agyModelWorkedForTests = (model: string): void => { agyModelsWorked.add(model); };

/** A calm, one-paragraph sentence for an agy failure (the CLI's raw text is often a multi-line dump). */
export function agyErrorMessage(raw: string, model?: string | null): string {
  const text = str(raw).replace(/^error:\s*/i, '').trim();
  const first = text.split('\n')[0]!.trim();
  if (model && agyModelsWorked.has(model) && /invalid model selection|not recognized as a known model/i.test(text)) {
    return 'Antigravity could not load its model list, usually a network connection problem. Send again once you are back online.';
  }
  if (/invalid model selection|not recognized as a known model/i.test(text)) {
    return `Antigravity does not offer the model ${model ? `"${model}"` : 'you picked'} any more. Pick another Antigravity model and send again.`;
  }
  if (/not (?:signed|logged) in|sign[- ]?in required|unauthenticated|login required|no credentials|oauth token|re-?authenticate|401\b/i.test(text)) {
    return `Antigravity is not signed in. Run \`agy\` ${inTerminal()} once and sign in with your Google account, then send again.`;
  }
  if (RATE_LIMIT_RE.test(text)) return `Antigravity hit a usage limit: ${first}`;
  return first ? `Antigravity stopped: ${first.slice(0, 400)}` : 'Antigravity stopped without saying why.';
}

/** Map ONE parsed agy event → ChatEvents. Fails soft: an unknown shape yields nothing, never a throw. */
export function mapAgyEvent(evt: any, st: AgyTurnState, turnId?: TurnId): UnsequencedChatEvent[] {
  const withTurn = <T extends UnsequencedChatEvent>(e: T): T => (turnId ? ({ ...e, turnId } as T) : e);
  const out: UnsequencedChatEvent[] = [];
  try {
    const kind = str(evt?.event);
    if (kind === 'init') {
      const id = str(evt.conversation_id);
      if (id) st.conversationId = id;
      return id ? [{ type: 'thread.started', providerThreadId: id }] : [];
    }
    if (kind === 'step_update') {
      const s = evt.step_update ?? {};
      const conv = str(s.conversation_id) || st.conversationId || 'agy';
      const idx = str(s.step_index);
      const state = str(s.state);
      const type = str(s.step_type);
      if (type === 'agent_response') {
        const delta = s.text_delta;
        if (typeof delta === 'string' && delta) {
          st.textStreamed = true;
          out.push(withTurn({ type: 'content.delta', itemId: `agy:${conv}:${idx}:text`, stream: 'assistant_text', delta }));
        }
        const thinking = s.thinking_delta ?? s.thought_delta;
        if (typeof thinking === 'string' && thinking) out.push(withTurn({ type: 'content.delta', itemId: `agy:${conv}:${idx}:thinking`, stream: 'reasoning_text', delta: thinking }));
        const u = s.usage;
        if (u && typeof u === 'object') {
          const input = num(u.input_tokens) ?? 0, output = num(u.output_tokens) ?? 0;
          st.steps++; st.input += input; st.output += output;
          st.thinking += num(u.thinking_tokens) ?? 0; st.cacheRead += num(u.cache_read_tokens) ?? 0;
          const cr = num(u.cache_read_tokens) ?? 0;
          // output_tokens already include thinking (live 2026-10-19: total = input + output, thinking 182 of output 185)
          if (input + output > 0) st.calls.push({ in: Math.max(0, input - cr), cr, cc: 0, out: output });
          st.lastContext = input + output;
        }
        return out;
      }
      if (type === 'tool') {
        const info = s.tool_info ?? {};
        const name = str(s.tool_name ?? info.name);
        const params = info.parameters ?? {};
        const itemId = `agy:${conv}:${idx}`;
        const toolKind = agyToolKind(name);
        if (!st.openTools.has(itemId)) {
          st.openTools.add(itemId);
          out.push(withTurn({ type: 'tool.started', itemId, toolKind, toolName: name, title: agyToolTitle(name, params), input: params }));
        }
        if (state === 'DONE' || state === 'ERROR') {
          const errText = info.error ? str(info.error.message ?? info.error) : '';
          const status: ToolStatus = state === 'ERROR' ? (/denied permission|permission check failed/i.test(errText) ? 'declined' : 'failed') : 'completed';
          const output = state === 'ERROR' ? errText.split('\nDo not attempt')[0]!.trim() : info.output != null ? str(info.output) : undefined;
          const file = toolPath(params);
          const changedFiles: FileChange[] | undefined = toolKind === 'file_change' && status === 'completed' && file ? [{ path: file, additions: 0, deletions: 0 }] : undefined;
          out.push(withTurn({
            type: 'tool.result', itemId, status, ...(output ? { output } : {}),
            ...(toolKind === 'command_execution' ? { outputStream: 'command_output' as const } : {}), ...(changedFiles ? { changedFiles } : {}),
          }));
        }
        return out;
      }
      return out; // user_input, system_message, anything new: nothing to show
    }
    if (kind === 'result') {
      const r = evt.result ?? {};
      if (r.conversation_id) st.conversationId = str(r.conversation_id);
      const ok = str(r.status).toUpperCase() === 'SUCCESS';
      const denied = Array.isArray(r.denied_actions) ? r.denied_actions.map((a: any) => str(a?.display_name ?? a?.action)).filter(Boolean) : [];
      st.result = { ok, denied, ...(ok ? {} : { error: str(r.error ?? r.response ?? 'error') }) };
      // A run that streamed nothing but still has an answer (seen when a turn is all tool calls and a short reply).
      if (ok && !st.textStreamed && typeof r.response === 'string' && r.response.trim()) {
        out.push(withTurn({ type: 'content.delta', itemId: `agy:${st.conversationId ?? 'agy'}:result`, stream: 'assistant_text', delta: r.response }));
        st.textStreamed = true;
      }
      return out;
    }
    return out;
  } catch {
    return [{ type: 'runtime.warning', message: `unmappable Antigravity event: ${str(evt?.event)}` }];
  }
}

/** Split a stdout buffer into complete JSON events + the trailing partial line. */
export function drainAgyLines(buf: string): { events: any[]; rest: string } {
  const events: any[] = [];
  const parts = buf.split('\n');
  const rest = parts.pop() ?? '';
  for (const line of parts) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    try { events.push(JSON.parse(t)); } catch { /* not an event */ }
  }
  return { events, rest };
}

/** The argv of one turn. `=` forms: the prompt / ids are values, never read as flags. */
export function agyTurnArgs(o: { prompt: string; model?: string | null; effort?: string | null; conversationId?: string | null; mode?: RuntimeMode; interaction?: 'default' | 'plan' }): string[] {
  return [
    `--print=${o.prompt}`,
    ...(o.model ? [`--model=${o.model}`] : []),
    ...(o.effort ? [`--effort=${o.effort}`] : []),
    ...(o.conversationId ? [`--conversation=${o.conversationId}`] : []),
    ...agyPermissionArgs(o.mode, o.interaction),
    '--output-format=stream-json', '--print-timeout=0',
  ];
}

/** Kora's one rule agy has no flag for: no harness subagents (Codex gets `--disable multi_agent`). Rides the first turn. */
export const AGY_FIRST_TURN_RULE = '[Kora] Do the work yourself: do not use invoke_subagent, define_subagent, manage_subagents or browser_subagent. Open code by line range, not whole files: view only the lines you need (the graph block gives file:line), because every line you open is re-billed on every later call.';

// ═══════════════════════════════════════════════════════════════════════════════
// THE DRIVER
// ═══════════════════════════════════════════════════════════════════════════════

export type AgySpawnFn = (command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess;

export interface AgyDriverOptions {
  /** No `init` event this long after the spawn = agy is stuck starting (sign-in prompt, update, network). */
  startTimeoutMs?: number;
  /** No output at all this long mid-turn = agy stopped responding. */
  idleTimeoutMs?: number;
}

interface State {
  threadId: ThreadId;
  /** The cost log (savings meter): one row per model step. */
  callTracker?: CallTracker;
  input: SessionStartInput;
  conversationId: string | null;
  model: ModelChoice | null;
  prep: SessionPrep | null;
  prepared: boolean;
  firstTurnSent: boolean;
  currentTurnId: TurnId | null;
  child: ChildProcess | null;
  buf: string;
  st: AgyTurnState;
  settled: boolean;
  stopped: boolean;
  noticed: RuntimeMode | 'unset' | null;
  watch: ReturnType<typeof setInterval> | null;
  lastOutputAt: number;
  sawInit: boolean;
  stderrTail: string;
  interaction: 'default' | 'plan';
  /** Stop was pressed: the exit settles the turn as interrupted whatever code agy exits with. */
  interrupting: boolean;
}

export class AntigravityDriver implements SessionDriver {
  readonly agent: AgentId = 'antigravity';
  readonly capabilities: DriverCapabilities = { modelSwitch: 'restart-only', promptlessContinuation: false, conversationRollback: false, manualCompaction: false, canSpawnWorkers: false, reportsToolStart: true };
  private sessions = new Map<ThreadId, State>();
  private listeners = new Set<(e: ChatEvent) => void>();
  private binResolver: (name: string) => Promise<string | null>;

  constructor(private deps: DriverDeps, private spawnFn: AgySpawnFn = defaultSpawn, private opts: AgyDriverOptions = {}, resolveBin?: (name: string) => Promise<string | null>) {
    this.binResolver = resolveBin ?? (spawnFn === defaultSpawn ? resolveEngineBinaryAsync : async (n: string) => n);
  }

  streamEvents(onEvent: (e: ChatEvent) => void): () => void { this.listeners.add(onEvent); return () => this.listeners.delete(onEvent); }
  hasSession(threadId: ThreadId): boolean { const s = this.sessions.get(threadId); return !!s && !s.stopped; }
  private emit(threadId: ThreadId, ev: UnsequencedChatEvent): void {
    const full = { seq: 0, at: Date.now(), ...ev, threadId } as ChatEvent;
    for (const l of this.listeners) { try { l(full); } catch { /* isolate a bad listener */ } }
  }

  async startSession(input: SessionStartInput): Promise<{ threadId: ThreadId; resume?: unknown }> {
    const existing = this.sessions.get(input.threadId);
    if (existing) return { threadId: input.threadId, resume: existing.conversationId ?? undefined };
    // The resume cursor lands on argv: only a plain conversation id (agy uses UUIDs).
    const conversationId = typeof input.resume === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/.test(input.resume) ? input.resume : null;
    this.sessions.set(input.threadId, {
      threadId: input.threadId, input, conversationId, model: input.model ?? null, prep: null, prepared: false, firstTurnSent: !!conversationId,
      currentTurnId: null, child: null, buf: '', st: newAgyTurnState(conversationId), settled: false, stopped: false, noticed: null,
      watch: null, lastOutputAt: 0, sawInit: false, stderrTail: '', interaction: 'default', interrupting: false,
    });
    this.emit(input.threadId, { type: 'session.started' });
    if (conversationId) this.emit(input.threadId, { type: 'thread.started', providerThreadId: conversationId });
    this.emit(input.threadId, { type: 'session.state', state: 'ready' });
    return { threadId: input.threadId, resume: conversationId ?? undefined };
  }

  async sendTurn(input: SendTurnInput): Promise<TurnHandle> {
    const state = this.sessions.get(input.threadId);
    if (!state) throw new Error(`no live session for thread ${input.threadId}`);
    if (state.child) this.abortCurrent(state); // one turn at a time: the running one ends as interrupted first
    let text = input.text ?? '';
    // Per-prompt graph injection, the Codex lane's way: agy has no prompt hook Kora drives, so the driver is the one
    // injection owner (prep env carries KORA_INJECT_OWNER=driver for anything else that looks). The assistant lane has no graph.
    if (text && input.origin !== 'kora-notice' && !isBlobsCwd(state.input.cwd)) {
      try {
        const { injectForPrompt } = require('../../graph/prompt-inject') as typeof import('../../graph/prompt-inject');
        const inj = await injectForPrompt({
          prompt: text, cwd: state.input.cwd, sessionId: input.threadId, lane: 'antigravity-chat',
          ...(this.deps.graphStatus ? { graph: { status: (c: string) => this.deps.graphStatus!(c), callTool: (n: any, a: Record<string, unknown>, o: { cwd: string; fresh?: boolean }) => this.deps.graphCall(n, a, o), ...(this.deps.graphBugLocalize ? { bugLocalize: (pr: string, root: string, gen: string) => this.deps.graphBugLocalize!(pr, root, gen) } : {}) } } : {}),
        });
        if (inj) text = `${inj}\n\n${text}`;
      } catch { /* injection is best-effort */ }
    }
    if (input.koraNotice) text = text ? `${input.koraNotice}\n\n${text}` : input.koraNotice;
    const files = (input.attachments ?? []).map((a: PromptAttachment) => `Attached file: ${a.name ?? a.path} at ${a.path}${a.mimeType ? ` (${a.mimeType})` : ''}`).join('\n');
    if (files) text = text ? `${text}\n\n${files}` : files;
    if (!state.firstTurnSent) { text = `${AGY_FIRST_TURN_RULE}\n\n${text}`; state.firstTurnSent = true; }
    if (input.model?.model) { const changed = input.model.model !== state.model?.model; state.model = input.model; if (changed) this.emit(input.threadId, { type: 'model.rerouted', to: input.model.model, reason: 'per-turn override (restart)' }); }
    state.interaction = input.interactionMode === 'plan' ? 'plan' : 'default';

    const turnId: TurnId = newTurnId();
    state.currentTurnId = turnId; state.buf = ''; state.st = newAgyTurnState(state.conversationId); state.settled = false;
    state.sawInit = false; state.stderrTail = ''; state.interrupting = false;
    const model = state.model?.model ?? state.input.model?.model ?? null;
    this.emit(input.threadId, { type: 'turn.started', turnId, ...(model ? { model } : {}) });
    if (!text.trim()) { this.fail(state, 'Antigravity needs a message to start a turn.'); return { threadId: input.threadId, turnId }; }

    // The pane-equivalent preparation once per session: the AGENTS.md rulebook block (only in a trusted folder —
    // prepareChatSession passes noRepoWrites otherwise), the KORA_* identity and the PATH shims.
    if (!state.prepared && this.deps.prepareSession) {
      state.prepared = true;
      try { state.prep = await this.deps.prepareSession(state.input); log(`chat ${state.threadId}: antigravity session prepared — ${state.prep.notes.join('; ')}`); }
      catch (e: any) { log(`chat ${state.threadId}: antigravity prepare failed: ${e?.message ?? e}`); }
    }
    const binary = await this.binResolver('agy');
    if (state.currentTurnId !== turnId || state.stopped) return { threadId: input.threadId, turnId };
    if (!binary) { this.fail(state, engineSpawnProblem('antigravity', { code: 'ENOENT' })!); return { threadId: input.threadId, turnId }; }
    this.spawnTurn(state, text, binary);
    return { threadId: input.threadId, turnId };
  }

  private fail(state: State, message: string, opts: { quiet?: boolean } = {}): void {
    this.stopWatch(state);
    if (state.settled) return;
    state.settled = true;
    const turnId = state.currentTurnId;
    if (!opts.quiet) this.emit(state.threadId, { type: 'runtime.error', errorClass: 'provider', message });
    if (turnId) this.emit(state.threadId, { type: 'turn.settled', turnId, state: 'failed', errorMessage: message });
    state.currentTurnId = null;
    this.emit(state.threadId, { type: 'session.state', state: 'ready' });
  }

  private spawnTurn(state: State, prompt: string, binary: string): void {
    const mode = state.input.runtimeMode;
    const notice = state.interaction === 'plan' ? null : agyPostureNotice(mode);
    if (notice && state.noticed !== (mode ?? 'unset')) { state.noticed = mode ?? 'unset'; this.emit(state.threadId, { type: 'runtime.warning', message: notice }); }
    const args = agyTurnArgs({
      prompt, model: state.model?.model ?? state.input.model?.model, effort: state.model?.effort ?? state.input.model?.effort,
      conversationId: state.conversationId, mode, interaction: state.interaction,
    });
    const env = withBrowserGuard(engineSpawnEnv({ ...process.env, ...this.deps.spawnEnv(state.threadId, state.input.account), ...(state.prep?.env ?? {}) }, binary));
    let child: ChildProcess;
    try { child = this.spawnFn(binary, args, { cwd: state.input.cwd, env }); }
    catch (e: any) { return this.fail(state, engineSpawnProblem('antigravity', e) ?? `Could not start Antigravity: ${e?.message ?? e}`); }
    state.child = child;
    this.emit(state.threadId, { type: 'session.state', state: 'running' });
    this.startWatch(state);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => this.onStdout(state, child, c));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (c: string) => { state.stderrTail = (state.stderrTail + c).slice(-4000); state.lastOutputAt = Date.now(); });
    child.on('error', (e: any) => { if (state.child === child) this.fail(state, engineSpawnProblem('antigravity', e) ?? `Antigravity process error: ${e?.message ?? e}`); });
    child.on('close', (code, signal) => this.onExit(state, child, code, signal));
  }

  private onStdout(state: State, child: ChildProcess, chunk: string): void {
    if (state.child !== child) return; // a stopped turn's late output
    state.lastOutputAt = Date.now();
    state.buf += chunk;
    const { events, rest } = drainAgyLines(state.buf);
    state.buf = rest;
    for (const evt of events) {
      if (state.settled) break;
      if (evt?.event === 'init') state.sawInit = true;
      const before = state.st.conversationId;
      const mapped = mapAgyEvent(evt, state.st, state.currentTurnId ?? undefined);
      if (state.st.calls.length) {
        state.callTracker ??= new CallTracker(state.firstTurnSent);
        const model = state.model?.model ?? state.input.model?.model ?? null;
        for (const c of state.st.calls.splice(0)) logCost({ ...state.callTracker.record({ model, ...c }, Date.now(), state.threadId), h: 'agy' });
      }
      const id = state.st.conversationId;
      if (id && id !== state.conversationId) {
        // agy starts a NEW conversation when the stored id is unknown to it (warning on stderr, not an error).
        if (state.conversationId && before === state.conversationId) this.emit(state.threadId, { type: 'runtime.warning', message: 'Antigravity could not find the earlier conversation, so this turn started a new one.' });
        state.conversationId = id;
      }
      for (const m of mapped) this.emit(state.threadId, m);
      try { (require('../../graph/inject-carry') as typeof import('../../graph/inject-carry')).noteTouchedFromEvents(state.threadId, state.input.cwd, mapped); } catch { /* recall memory is best effort */ }
      if (evt?.event === 'step_update' && evt.step_update?.usage && state.st.lastContext != null) this.emitContext(state);
    }
  }

  private emitContext(state: State): void {
    const used = state.st.lastContext;
    if (used == null) return;
    const max = agyContextWindow(state.model?.model ?? state.input.model?.model);
    const usage: TokenUsage = { usedTokens: used, ...(max ? { maxTokens: max } : {}), source: 'estimate' };
    this.emit(state.threadId, { type: 'thread.token-usage', usage, ...(state.currentTurnId ? { turnId: state.currentTurnId } : {}) });
  }

  private onExit(state: State, child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (state.child !== child) return;
    if (state.buf.trim()) this.onStdout(state, child, '\n');
    state.child = null;
    this.stopWatch(state);
    if (state.stopped || state.settled) return;
    const turnId = state.currentTurnId;
    const interrupted = state.interrupting || signal === 'SIGTERM' || signal === 'SIGKILL';
    const r = state.st.result;
    const modelId = state.model?.model ?? state.input.model?.model ?? null;
    if (interrupted) {
      state.settled = true;
      if (turnId) this.emit(state.threadId, { type: 'turn.settled', turnId, state: 'interrupted' });
    } else if (r && !r.ok) {
      const message = agyErrorMessage(r.error ?? '', modelId);
      if (RATE_LIMIT_RE.test(r.error ?? '')) this.emit(state.threadId, { type: 'usage.rate-limit', message, ...(turnId ? { turnId } : {}) });
      return this.fail(state, message);
    } else if (!r && code !== 0) {
      const tail = state.stderrTail.split('\n').map((l) => l.trim()).filter((l) => l && !/^warning:/i.test(l)).join('\n');
      return this.fail(state, tail ? agyErrorMessage(tail, modelId) : `Antigravity exited (code ${code ?? 'null'}) without an answer.`);
    } else {
      state.settled = true;
      if (modelId) agyModelsWorked.add(modelId);
      if (r?.denied.length) {
        const what = [...new Set(r.denied)].join(', ');
        this.emit(state.threadId, { type: 'runtime.warning', message: `Antigravity skipped ${what}: it needs a permission it cannot ask for here. Switch the permission level to let it.` });
      }
      const usage = agyTurnUsage(state.st);
      if (turnId) this.emit(state.threadId, { type: 'turn.settled', turnId, state: 'completed', ...(usage ? { usage } : {}) });
    }
    state.currentTurnId = null;
    this.emit(state.threadId, { type: 'session.state', state: 'ready' });
    log(`chat ${state.threadId}: antigravity turn ended (${modelId ?? 'default model'}, code ${code}${signal ? `, ${signal}` : ''})`);
  }

  // A stuck agy (waiting on a sign-in, an update, a dead network) must not hang the thread: no `init` in time, or no
  // output at all for a long stretch, stops the child and fails the turn in words.
  private startWatch(state: State): void {
    this.stopWatch(state);
    const started = Date.now();
    state.lastOutputAt = started;
    const startMs = this.opts.startTimeoutMs ?? 120_000;
    const idleMs = this.opts.idleTimeoutMs ?? 20 * 60_000;
    state.watch = setInterval(() => {
      if (!state.child || state.settled || state.stopped) return this.stopWatch(state);
      const now = Date.now();
      let why: string | null = null;
      if (!state.sawInit && now - started >= startMs) why = `Antigravity did not start within ${Math.round(startMs / 1000)} s. Run \`agy\` ${inTerminal()} once to check it is signed in and up to date, then send again.`;
      else if (now - state.lastOutputAt >= idleMs) why = `Antigravity stopped responding (nothing for ${Math.round(idleMs / 60_000)} min), so Kora ended the turn.`;
      if (!why) return;
      const child = state.child;
      this.fail(state, why);
      killHard(child);
    }, Math.max(50, Math.min(5_000, Math.floor(Math.min(startMs, idleMs) / 4))));
    state.watch.unref?.();
  }
  private stopWatch(state: State): void { if (state.watch) { clearInterval(state.watch); state.watch = null; } }

  /** Settle the running turn as interrupted now and stop its child (its late output and exit are ignored). */
  private abortCurrent(state: State): void {
    const child = state.child;
    state.child = null;
    this.stopWatch(state);
    if (!state.settled && state.currentTurnId) { state.settled = true; this.emit(state.threadId, { type: 'turn.settled', turnId: state.currentTurnId, state: 'interrupted' }); }
    state.currentTurnId = null;
    if (child) killHard(child);
  }

  async interruptTurn(threadId: ThreadId, _turnId?: TurnId): Promise<void> {
    const state = this.sessions.get(threadId);
    const child = state?.child;
    if (!state || !child) return;
    state.interrupting = true;
    try { killChild(child); setTimeout(() => { try { if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL'); } catch { /* gone */ } }, 2000).unref?.(); }
    catch (e: any) { this.emit(threadId, { type: 'runtime.warning', message: `interrupt failed: ${e?.message ?? e}` }); }
  }

  async respondToApproval(_t: ThreadId, _r: RequestId, _d: ApprovalAnswer): Promise<void> { /* print mode never asks */ }
  async respondToUserInput(_t: ThreadId, _r: RequestId, _a: UserInputAnswers): Promise<void> { /* print mode never asks */ }

  /** The next turn's child picks the new posture up; nothing running needs it. */
  async setPermissionMode(threadId: ThreadId, mode: RuntimeMode): Promise<void> {
    const s = this.sessions.get(threadId); if (!s) return;
    s.input = { ...s.input, runtimeMode: mode };
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
    if (s.child) { killHard(s.child); s.child = null; }
    this.emit(threadId, { type: 'session.exited', recoverable: true });
    this.emit(threadId, { type: 'session.state', state: 'stopped' });
    this.sessions.delete(threadId);
  }
}

function killHard(child: ChildProcess): void {
  try { killChild(child); setTimeout(() => { try { if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL'); } catch { /* gone */ } }, 2000).unref?.(); } catch { /* gone */ }
}

function defaultSpawn(command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcess {
  // No tool hooks on this lane: the CLI runs under an OS read-deny for credential paths (session/os-sandbox.ts).
  const w = wrapReadDeny('antigravity', command, args);
  return trackChild(spawn(w.command, w.args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: w.windowsVerbatimArguments }), 'chat antigravity');
}
