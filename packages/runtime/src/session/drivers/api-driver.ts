// The API-endpoint SessionDriver (Phase 7): a blob on any OpenAI- or Anthropic-compatible HTTP endpoint (OpenRouter,
// DeepSeek, Fireworks, Mistral, Groq, LM Studio, Ollama, a custom URL). No CLI, no process: each turn streams a chat
// completion and runs a small built-in agent loop (./api-agent-loop) with the blob's tools:
//   the blob's own tools (recall/remember/edit_soul/set_model/attach_output, + team tools for the Chief) via deps.blobs.toolSpecs,
//   run_shell / read_file / write_file / list_dir confined to the blob workspace, web_fetch.
// Posture is Kora's own (engine-common postureVerdict): Supervised asks before editing or running, Auto is free in the folders,
// outbound shell always asks, Full access allows. `run_shell` is a policy, NOT a sandbox: it filters outbound commands and
// paths it can see in the command line, like the Claude blob policy.
// Keys come from the daemon SecretStore; 401/402/429/5xx become calm messages and the rate-limit card.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AgentId } from '../../protocol/types';
import type { ApprovalAnswer, PromptAttachment, ItemId, ModelChoice, RequestId, RuntimeMode, ThreadId, ToolKind, TurnId, TurnUsage, UserInputAnswers } from '../events';
import { newTurnId } from '../events';
import type { DriverCapabilities, DriverDeps, SendTurnInput, SessionDriver, SessionStartInput, TurnHandle } from '../session-driver';
import { toJsonSchema } from '../fleet-tools';
import { blobHome } from '../../blobs/home';
import { engineSpawnEnv } from '../../detect/engine-binary';
import { koraHome } from '../../protocol/types';
import { log } from '../../server/log';
import { wrapReadDeny } from '../os-sandbox';
import { ApiError, listApiModels, type ApiEndpoint, type FetchFn } from './api-providers';
import { runAgentLoop, trimHistory, type ChatMsg, type ToolCall, type ToolDef, type ToolOutcome } from './api-agent-loop';
import { ApprovalGate, EventBus, blobAskVia, confine, postureVerdict, truncate, within, type ActionClass } from './engine-common';
import { killChild } from '../../util/kill-child';
import { thisComputer } from '../../util/platform-copy';

export interface ApiDriverOptions {
  endpoint: ApiEndpoint;
  /** The endpoint as Settings > Engines has it NOW: an edit (base URL, default model) applies on the next turn of a live thread. */
  getEndpoint?(): ApiEndpoint | null;
  /** The key for an endpoint id (daemon SecretStore). */
  getKey(endpointId: string): Promise<string | null>;
  fetch?: FetchFn;
  /** Where conversations are kept so a daemon restart resumes them. Default <KORA_HOME>/api-sessions. */
  stateDir?: string;
  maxSteps?: number;
  /** Max wall time of one run_shell (ms). */
  shellTimeoutMs?: number;
  /** The shell used by run_shell (tests). */
  shell?: string;
}

interface TState {
  threadId: ThreadId;
  input: SessionStartInput;
  model: ModelChoice | null;
  history: ChatMsg[];
  turn: { turnId: TurnId; ctl: AbortController; settled: boolean } | null;
  lastUserAt?: number;
  readRoots: Set<string>;
  shells: Set<ReturnType<typeof spawn>>;
  stopped: boolean;
}

const SHELL_OUTPUT_CAP = 20_000;
const FETCH_CAP = 30_000;

// ── pure helpers (exported for tests) ──────────────────────────────────────────────────────────────────────────────────
export function builtinToolDefs(): ToolDef[] {
  const o = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
  return [
    { name: 'run_shell', description: 'Run a shell command in your workspace folder (documents, scripts, converters). Output is returned. Do not use it to send data out; commands that do will ask the user first.', parameters: o({ command: { type: 'string' }, timeout_sec: { type: 'number', description: 'default 120, max 600' } }, ['command']) },
    { name: 'read_file', description: 'Read a text file (absolute path, or relative to your workspace).', parameters: o({ path: { type: 'string' }, offset: { type: 'number', description: 'first line, 1-based' }, limit: { type: 'number', description: 'max lines' } }, ['path']) },
    { name: 'write_file', description: 'Write (create or overwrite) a text file in your workspace.', parameters: o({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']) },
    { name: 'list_dir', description: 'List a folder (default: your workspace).', parameters: o({ path: { type: 'string' } }, []) },
    { name: 'web_fetch', description: 'Fetch a web page or API URL (GET, http/https) and return its text.', parameters: o({ url: { type: 'string' } }, ['url']) },
  ];
}
const BUILTIN = new Set(builtinToolDefs().map((t) => t.name));

/** Absolute-looking path tokens in a command line (the ones a policy can judge). */
export function pathsInCommand(cmd: string, cwd: string): string[] {
  const out: string[] = [];
  // Windows also: drive paths (C:\x, C:/x) and backslash forms of ~\ and ..\ (cmd.exe / Git bash both take them).
  const re = process.platform === 'win32'
    ? /(?:^|[\s=:'"(])([A-Za-z]:[\\/][^\s'";|&<>)]*|~[\\/][^\s'";|&<>)]*|[\\/][^\s'";|&<>)]*|(?:\.\.[\\/])+[^\s'";|&<>)]*|\.\.)(?=$|[\s'";|&<>)])/g
    : /(?:^|[\s=:'"(])(~\/[^\s'";|&<>)]*|\/[^\s'";|&<>)]*|(?:\.\.\/)+[^\s'";|&<>)]*|\.\.)(?=$|[\s'";|&<>)])/g;
  for (const m of cmd.matchAll(re)) {
    let t = m[1]!;
    if (t.startsWith('~')) t = path.join(os.homedir(), t.slice(1));
    out.push(path.isAbsolute(t) ? t : path.resolve(cwd, t));
  }
  // oxlint-disable-next-line kora/no-posix-only-paths -- a shell's /dev/null token (Git bash too); path.isAbsolute keeps it unresolved on Windows
  return [...new Set(out)].filter((p) => p !== '/' && p !== '/dev/null');
}

const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.local|0\.0\.0\.0|\[::1?\]|\[?fe80:.*|\[?f[cd][0-9a-f]{2}:.*)$/i;
export function privateHost(hostname: string): boolean {
  if (PRIVATE_HOST.test(hostname)) return true;
  const m = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || a === 0;
}

/** Every assistant tool call must be followed by its result, or the next request is rejected by the API. */
export function repairHistory(h: ChatMsg[]): ChatMsg[] {
  const out: ChatMsg[] = [];
  for (let i = 0; i < h.length; i++) {
    const m = h[i]!;
    if (m.role === 'tool') continue; // tool messages are re-emitted right after their assistant message below (orphans dropped)
    out.push(m);
    if (m.role !== 'assistant' || !m.toolCalls.length) continue;
    const results = new Map<string, ChatMsg>();
    for (let j = i + 1; j < h.length && h[j]!.role === 'tool'; j++) results.set((h[j] as any).callId, h[j]!);
    for (const c of m.toolCalls) out.push(results.get(c.id) ?? { role: 'tool', callId: c.id, name: c.name, text: 'Interrupted before this tool ran.', isError: true });
  }
  return out;
}

function stripHtml(s: string): string {
  return s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

export class ApiDriver implements SessionDriver {
  readonly agent: AgentId;
  readonly capabilities: DriverCapabilities = { modelSwitch: 'in-session', promptlessContinuation: false, conversationRollback: false, manualCompaction: false, canSpawnWorkers: false };
  private sessions = new Map<ThreadId, TState>();
  private bus = new EventBus();
  private gate = new ApprovalGate(this.bus);
  private fetchFn: FetchFn;
  private modelCache: { at: number; ids: string[] } | null = null;

  constructor(private deps: DriverDeps, private o: ApiDriverOptions) {
    this.agent = o.endpoint.agentId as AgentId;
    this.fetchFn = o.fetch ?? ((u, i) => fetch(u, i));
  }

  private endpoint(): ApiEndpoint { return this.o.getEndpoint?.() ?? this.o.endpoint; }

  streamEvents(onEvent: (e: import('../events').ChatEvent) => void): () => void { return this.bus.subscribe(onEvent); }
  hasSession(threadId: ThreadId): boolean { const s = this.sessions.get(threadId); return !!s && !s.stopped; }
  history(threadId: ThreadId): ChatMsg[] { return this.sessions.get(threadId)?.history ?? []; }

  private file(threadId: string): string { return path.join(this.o.stateDir ?? path.join(koraHome(), 'api-sessions'), `${threadId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120)}.json`); }
  private load(threadId: string): ChatMsg[] {
    try { const j = JSON.parse(fs.readFileSync(this.file(threadId), 'utf8')); return Array.isArray(j?.history) ? repairHistory(j.history) : []; } catch { return []; }
  }
  private save(s: TState): void {
    try { const f = this.file(s.threadId); fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); fs.writeFileSync(f + '.tmp', JSON.stringify({ v: 1, history: s.history }), { mode: 0o600 }); fs.renameSync(f + '.tmp', f); } catch (e: any) { log(`api session save failed: ${e?.message ?? e}`); }
  }

  async startSession(input: SessionStartInput): Promise<{ threadId: ThreadId; resume?: unknown }> {
    const existing = this.sessions.get(input.threadId);
    if (existing) { existing.input = { ...existing.input, ...input }; return { threadId: input.threadId, resume: `api:${input.threadId}` }; }
    const history = input.resume ? this.load(input.threadId) : [];
    this.sessions.set(input.threadId, { threadId: input.threadId, input, model: input.model ?? null, history, turn: null, readRoots: new Set(), shells: new Set(), stopped: false });
    this.bus.emit(input.threadId, { type: 'session.started' });
    if (history.length) this.bus.emit(input.threadId, { type: 'thread.started', providerThreadId: `api:${input.threadId}` });
    this.bus.emit(input.threadId, { type: 'session.state', state: 'ready' });
    return { threadId: input.threadId, resume: `api:${input.threadId}` };
  }

  async sendTurn(input: SendTurnInput): Promise<TurnHandle> {
    const s = this.sessions.get(input.threadId);
    if (!s) throw new Error(`no live session for thread ${input.threadId}`);
    if (s.turn) await this.interruptTurn(input.threadId).catch(() => {});
    if (input.origin !== 'kora-notice') s.lastUserAt = Date.now();
    if (input.model?.model && input.model.model !== s.model?.model) { s.model = input.model; this.bus.emit(input.threadId, { type: 'model.rerouted', to: input.model.model, reason: 'per-turn override' }); }
    let text = input.text ?? '';
    if (input.koraNotice) text = text ? `${input.koraNotice}\n\n${text}` : input.koraNotice;
    const files = (input.attachments ?? []).map((a: PromptAttachment) => { s.readRoots.add(path.dirname(a.path)); return `Attached file: ${a.name ?? a.path} at ${a.path}${a.mimeType ? ` (${a.mimeType})` : ''}`; }).join('\n');
    if (files) text = text ? `${text}\n\n${files}` : files;
    const turnId = newTurnId();
    const turn = { turnId, ctl: new AbortController(), settled: false };
    s.turn = turn;
    this.bus.emit(input.threadId, { type: 'turn.started', turnId, ...(s.model?.model ? { model: s.model.model } : {}) });
    void this.runTurn(s, turn, text);
    return { threadId: input.threadId, turnId };
  }

  private async resolveModel(s: TState, key: string | null): Promise<string> {
    const ep = this.endpoint();
    // "default" is the picker's placeholder before the endpoint's models are listed: use the endpoint's default / first model
    const picked = (s.model?.model && s.model.model !== 'default' ? s.model.model : '') || ep.defaultModel;
    if (picked) return picked;
    if (!this.modelCache || Date.now() - this.modelCache.at > 60_000) this.modelCache = { at: Date.now(), ids: (await listApiModels(ep, key, this.fetchFn)).map((m) => m.id) };
    const first = this.modelCache.ids[0];
    if (!first) throw new ApiError('client', `${ep.label} lists no models. Pick one in the model picker or type its name in Settings > Engines.`);
    return first;
  }

  private async runTurn(s: TState, turn: NonNullable<TState['turn']>, text: string): Promise<void> {
    const ep = this.endpoint(); const tid = s.threadId; const turnId = turn.turnId;
    const itemIds = { msg: `msg_${turnId}`, think: `think_${turnId}` };
    try {
      const key = await this.o.getKey(ep.id).catch(() => null);
      if (ep.requiresKey && !key) throw new ApiError('auth', `${ep.label} needs an API key. Add one in Settings > Engines.`);
      const model = await this.resolveModel(s, key);
      s.history.push({ role: 'user', text });
      let system = ''; try { system = this.deps.appendSystemPrompt(s.input) ?? ''; } catch { /* optional */ }
      const tools = this.tools(s);
      this.bus.emit(tid, { type: 'session.state', state: 'running' });
      const r = await runAgentLoop({
        ep, key, model, system, history: s.history, tools: tools.defs, fetch: this.fetchFn, signal: turn.ctl.signal, maxSteps: this.o.maxSteps ?? 25,
        onText: (d) => this.bus.emit(tid, { type: 'content.delta', itemId: itemIds.msg, stream: 'assistant_text', delta: d, turnId }),
        onReasoning: (d) => this.bus.emit(tid, { type: 'content.delta', itemId: itemIds.think, stream: 'reasoning_text', delta: d, turnId }),
        onToolStart: (c) => this.toolStarted(s, turn, c),
        onToolResult: (c, out) => this.toolResult(s, turn, c, out),
        onUsage: (u) => this.bus.emit(tid, { type: 'thread.token-usage', usage: { usedTokens: u.input + u.output, inputTokens: u.input, outputTokens: u.output, ...(u.cached ? { cachedInputTokens: u.cached } : {}), ...(ep.contextWindow ? { maxTokens: ep.contextWindow } : {}), source: 'estimate' } }),
        run: (c) => this.runTool(s, turn, tools.byName, c),
      });
      s.history = trimHistory(s.history);
      turn.settled = true;
      const usage: TurnUsage | undefined = r.usage.input || r.usage.output ? { usageStatus: 'complete', inputTokens: r.usage.input, outputTokens: r.usage.output, ...(r.usage.cached ? { cachedInputTokens: r.usage.cached } : {}) } : undefined;
      if (r.finish === 'max-steps') this.bus.emit(tid, { type: 'runtime.warning', message: 'Stopped after many tool steps in one turn. Say "continue" to let it keep going.' });
      this.bus.emit(tid, { type: 'turn.settled', turnId, state: 'completed', stopReason: r.finish, ...(usage ? { usage } : {}) });
    } catch (e: any) {
      s.history = repairHistory(s.history);
      if (!turn.settled) this.failTurn(s, turn, e);
    } finally {
      this.save(s);
      this.gate.cancelAll(tid);
      for (const sh of s.shells) { try { killChild(sh, 'SIGKILL'); } catch { /* gone */ } }
      s.shells.clear();
      if (s.turn === turn) s.turn = null;
      this.bus.emit(tid, { type: 'session.state', state: 'ready' });
    }
  }

  private failTurn(s: TState, turn: NonNullable<TState['turn']>, e: any): void {
    turn.settled = true;
    const tid = s.threadId; const turnId = turn.turnId;
    if (turn.ctl.signal.aborted || (e instanceof ApiError && e.kind === 'aborted')) { this.bus.emit(tid, { type: 'turn.settled', turnId, state: 'interrupted' }); return; }
    const err = e instanceof ApiError ? e : new ApiError('client', String(e?.message ?? e).slice(0, 300));
    if (err.kind === 'rate_limit' || err.kind === 'credit') this.bus.emit(tid, { type: 'usage.rate-limit', message: err.message, ...(err.retryAfterMs ? { resetsAt: Date.now() + err.retryAfterMs } : {}), turnId });
    this.bus.emit(tid, { type: 'runtime.error', errorClass: err.kind === 'network' ? 'transport' : 'provider', message: err.message });
    this.bus.emit(tid, { type: 'turn.settled', turnId, state: 'failed', errorMessage: err.message });
    log(`chat ${tid}: ${this.agent} turn failed (${err.kind}${err.status ? ` ${err.status}` : ''})`);
  }

  // ── tools ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  private blob(s: TState) { try { return this.deps.blobs?.byCwd(s.input.cwd) ?? null; } catch { return null; } }
  private roots(s: TState): string[] { const b = this.blob(s); return [s.input.cwd, ...(b ? [b.workspace, blobHome(b.id)] : [])]; }

  private tools(s: TState): { defs: ToolDef[]; byName: Map<string, (a: Record<string, unknown>) => Promise<ToolOutcome>> } {
    const byName = new Map<string, (a: Record<string, unknown>) => Promise<ToolOutcome>>();
    const defs = builtinToolDefs();
    const b = this.blob(s);
    if (b && this.deps.blobs) {
      const turnRef = () => (s.turn ? { turnId: s.turn.turnId } : {});
      const specs = this.deps.blobs.toolSpecs({
        blobId: b.id, threadId: s.threadId, agent: this.agent, cwd: s.input.cwd,
        emitCard: (card) => this.bus.emit(s.threadId, { type: 'blob.card', card, ...turnRef() }),
        fullAccess: () => s.input.runtimeMode === 'full-access',
        userMessageSince: (since: number) => (s.lastUserAt ?? 0) > since,
        askApproval: blobAskVia(this.gate, s.threadId, () => s.turn?.turnId),
        attachOutput: (p, caption) => {
          const itemId: ItemId = `attach_${s.threadId}_${Date.now().toString(36)}`;
          this.bus.emit(s.threadId, { type: 'tool.started', itemId, toolKind: 'file_change', toolName: 'attach_output', title: caption ? `${caption} - ${path.basename(p)}` : `attach ${path.basename(p)}`, input: { file_path: p }, ...turnRef() });
          this.bus.emit(s.threadId, { type: 'tool.result', itemId, status: 'completed', changedFiles: [{ path: p, additions: 0, deletions: 0 }], ...turnRef() });
        },
      });
      for (const sp of specs) {
        if (BUILTIN.has(sp.name)) continue; // a blob tool never shadows the workspace tools
        defs.push({ name: sp.name, description: sp.description, parameters: toJsonSchema(sp.params) });
        byName.set(sp.name, async (a) => { const r = await sp.handler(a); return { text: r.text, ...(r.isError ? { isError: true } : {}) }; });
      }
    }
    byName.set('run_shell', (a) => this.runShell(s, a)); byName.set('read_file', (a) => this.readFile(s, a));
    byName.set('write_file', (a) => this.writeFile(s, a)); byName.set('list_dir', (a) => this.listDir(s, a));
    byName.set('web_fetch', (a) => this.webFetch(s, a));
    return { defs, byName };
  }

  private async runTool(s: TState, turn: NonNullable<TState['turn']>, byName: Map<string, (a: Record<string, unknown>) => Promise<ToolOutcome>>, c: ToolCall): Promise<ToolOutcome> {
    const fn = byName.get(c.name);
    if (!fn) return { text: `No tool named "${c.name}".`, isError: true };
    void turn;
    return fn(c.args);
  }

  private toolKind(name: string): ToolKind {
    return name === 'run_shell' ? 'command_execution' : name === 'write_file' ? 'file_change' : name === 'read_file' || name === 'list_dir' ? 'file_read' : name === 'web_fetch' ? 'web_search' : 'mcp_tool_call';
  }
  private toolStarted(s: TState, turn: NonNullable<TState['turn']>, c: ToolCall): void {
    const a = c.args as any;
    const title = c.name === 'run_shell' ? `$ ${String(a.command ?? '').split('\n')[0]!.slice(0, 80)}` : a.path || a.url ? `${c.name} ${String(a.path ?? a.url).slice(0, 80)}` : c.name;
    this.bus.emit(s.threadId, { type: 'tool.started', itemId: `api_${turn.turnId}_${c.id}`, toolKind: this.toolKind(c.name), toolName: c.name, title, input: c.args, turnId: turn.turnId });
  }
  private toolResult(s: TState, turn: NonNullable<TState['turn']>, c: ToolCall, out: ToolOutcome): void {
    const path_ = c.name === 'write_file' && !out.isError ? String((c.args as any).path ?? '') : '';
    this.bus.emit(s.threadId, {
      type: 'tool.result', itemId: `api_${turn.turnId}_${c.id}`, status: out.isError ? 'failed' : 'completed', output: truncate(out.text, 8000), turnId: turn.turnId,
      ...(path_ ? { changedFiles: [{ path: this.abs(s, path_), additions: 0, deletions: 0 }] } : {}),
    });
  }

  private abs(s: TState, p: string): string { return path.isAbsolute(p) ? p : path.join(s.input.cwd, p); }

  /** Judge one action under the thread's posture; asks the user when the verdict says so. Returns null when allowed. */
  private async gateAction(s: TState, action: ActionClass, a: { title: string; command?: string; paths?: string[]; kind: 'command_execution_approval' | 'file_change_approval' | 'file_read_approval' | 'unknown'; args?: unknown }): Promise<string | null> {
    const roots = this.roots(s);
    const v = postureVerdict({ mode: s.input.runtimeMode, action, cwd: s.input.cwd, ...(a.command !== undefined ? { command: a.command } : {}), ...(a.paths ? { paths: a.paths } : {}), inBounds: (p) => within(p, [...roots, ...s.readRoots]) });
    if (v.decision === 'allow') return null;
    if (v.decision === 'deny') return v.reason;
    if (!s.turn) return 'no active turn';
    const d: ApprovalAnswer = await this.gate.ask(s.threadId, { title: a.title, detail: v.reason, kind: a.kind, args: a.args, turnId: s.turn.turnId });
    return d === 'accept' || d === 'acceptForSession' || d === 'acceptAlways' ? null : 'The user declined.';
  }

  private async runShell(s: TState, a: Record<string, unknown>): Promise<ToolOutcome> {
    const command = String(a.command ?? '').trim();
    if (!command) return { text: 'command is required', isError: true };
    const declined = await this.gateAction(s, 'execute', { title: `Run ${command.slice(0, 80)}?`, command, paths: pathsInCommand(command, s.input.cwd), kind: 'command_execution_approval', args: { command } });
    if (declined) return { text: `Not run: ${declined}`, isError: true };
    const secret = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;
    const env = engineSpawnEnv(Object.fromEntries(Object.entries(process.env).filter(([k]) => !secret.test(k))));
    const timeout = Math.min(600, Math.max(1, Number(a.timeout_sec) || 120)) * 1000;
    return new Promise<ToolOutcome>((resolve) => {
      // Under the credential read-deny, like the fenced engines' own shells (deep audit 2026-10-13): the posture check
      // reads the command's text, the fence holds whatever the line builds at run time.
      const fenced = wrapReadDeny('check', this.o.shell ?? '/bin/sh', ['-c', command]);
      const child = spawn(fenced.command, fenced.args, { cwd: s.input.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: fenced.windowsVerbatimArguments });
      s.shells.add(child);
      let out = ''; let timedOut = false;
      const take = (c: Buffer) => { out += c.toString(); if (out.length > SHELL_OUTPUT_CAP * 2) out = out.slice(-SHELL_OUTPUT_CAP * 2); };
      child.stdout?.on('data', take); child.stderr?.on('data', take);
      const t = setTimeout(() => { timedOut = true; try { killChild(child, 'SIGKILL'); } catch { /* gone */ } }, Math.min(timeout, this.o.shellTimeoutMs ?? timeout));
      const end = (code: number | null, sig: string | null) => { clearTimeout(t); s.shells.delete(child); const body = truncate(out.trim(), SHELL_OUTPUT_CAP); resolve(timedOut ? { text: `${body}\n[timed out]`, isError: true } : code === 0 ? { text: body || '(no output)' } : { text: `${body}\n[exit ${code ?? sig}]`, isError: true }); };
      child.on('close', end);
      child.on('error', (e: any) => end(127, String(e?.message ?? e)));
    });
  }

  private async readFile(s: TState, a: Record<string, unknown>): Promise<ToolOutcome> {
    let abs: string;
    try { abs = path.resolve(this.abs(s, String(a.path ?? ''))); } catch (e: any) { return { text: e.message, isError: true }; }
    const declined = await this.gateAction(s, 'read', { title: `Read ${abs}?`, paths: [abs], kind: 'file_read_approval', args: { path: abs } });
    if (declined) return { text: `Not read: ${declined}`, isError: true };
    try {
      const text = fs.readFileSync(abs, 'utf8');
      const off = Math.max(1, Number(a.offset) || 1); const lim = Number(a.limit) || 0;
      const body = off === 1 && !lim ? text : text.split('\n').slice(off - 1, lim ? off - 1 + lim : undefined).join('\n');
      return { text: truncate(body, 100_000) };
    } catch (e: any) { return { text: `cannot read ${a.path}: ${e?.code ?? e?.message}`, isError: true }; }
  }

  private async writeFile(s: TState, a: Record<string, unknown>): Promise<ToolOutcome> {
    const abs = path.resolve(this.abs(s, String(a.path ?? '')));
    if (typeof a.content !== 'string') return { text: 'content is required', isError: true };
    // Writes never leave the blob's folders, whatever the posture (Full access included): this is the document path.
    if (s.input.runtimeMode !== 'full-access') { try { confine(abs, [...this.roots(s)]); } catch (e: any) { return { text: e.message, isError: true }; } }
    const declined = await this.gateAction(s, 'edit', { title: `Write ${path.basename(abs)}?`, paths: [abs], kind: 'file_change_approval', args: { path: abs } });
    if (declined) return { text: `Not written: ${declined}`, isError: true };
    try { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, a.content); return { text: `Wrote ${a.content.length} characters to ${abs}` }; }
    catch (e: any) { return { text: `cannot write ${a.path}: ${e?.code ?? e?.message}`, isError: true }; }
  }

  private async listDir(s: TState, a: Record<string, unknown>): Promise<ToolOutcome> {
    const abs = path.resolve(a.path ? this.abs(s, String(a.path)) : s.input.cwd);
    const declined = await this.gateAction(s, 'read', { title: `List ${abs}?`, paths: [abs], kind: 'file_read_approval', args: { path: abs } });
    if (declined) return { text: `Not listed: ${declined}`, isError: true };
    try { return { text: fs.readdirSync(abs, { withFileTypes: true }).map((d) => d.name + (d.isDirectory() ? '/' : '')).sort().join('\n') || '(empty)' }; }
    catch (e: any) { return { text: `cannot list ${a.path ?? abs}: ${e?.code ?? e?.message}`, isError: true }; }
  }

  private async webFetch(s: TState, a: Record<string, unknown>): Promise<ToolOutcome> {
    let u: URL;
    try { u = new URL(String(a.url ?? '')); } catch { return { text: 'url is not valid', isError: true }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { text: 'only http and https URLs can be fetched', isError: true };
    if (privateHost(u.hostname) && s.input.runtimeMode !== 'full-access') return { text: `that address is on ${thisComputer()} or its local network; fetching it needs Full access`, isError: true };
    try {
      const res = await this.fetchFn(u.toString(), { method: 'GET', headers: { 'user-agent': 'Kora/1 (+blob web_fetch)', accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' }, signal: AbortSignal.any([s.turn?.ctl.signal ?? new AbortController().signal, AbortSignal.timeout(20_000)]) });
      try { if (res.url && privateHost(new URL(res.url).hostname) && s.input.runtimeMode !== 'full-access') return { text: 'the page redirected to a local address; not followed', isError: true }; } catch { /* odd url */ }
      const ct = res.headers.get('content-type') ?? '';
      const raw = (await res.text()).slice(0, 400_000);
      const text = /html/i.test(ct) ? stripHtml(raw) : raw;
      return { text: `HTTP ${res.status}\n${truncate(text, FETCH_CAP)}`, ...(res.ok ? {} : { isError: true }) };
    } catch (e: any) { return { text: `fetch failed: ${String(e?.message ?? e).slice(0, 200)}`, isError: true }; }
  }

  // ── SessionDriver: control surface ─────────────────────────────────────────────────────────────────────────────────
  async interruptTurn(threadId: ThreadId, _turnId?: TurnId): Promise<void> {
    const s = this.sessions.get(threadId);
    if (!s?.turn) return;
    s.turn.ctl.abort();
    this.gate.cancelAll(threadId);
    for (const sh of s.shells) { try { killChild(sh, 'SIGKILL'); } catch { /* gone */ } }
  }
  async respondToApproval(threadId: ThreadId, requestId: RequestId, decision: ApprovalAnswer): Promise<void> { this.gate.respond(threadId, requestId, decision); }
  async respondToUserInput(_t: ThreadId, _r: RequestId, _a: UserInputAnswers): Promise<void> { /* no question tool on this engine */ }
  async setPermissionMode(threadId: ThreadId, mode: RuntimeMode): Promise<void> { const s = this.sessions.get(threadId); if (s) s.input = { ...s.input, runtimeMode: mode }; }
  async setModel(threadId: ThreadId, model: ModelChoice): Promise<void> {
    const s = this.sessions.get(threadId); if (!s) return;
    s.model = model;
    this.bus.emit(threadId, { type: 'model.rerouted', to: model.model, reason: 'setModel' });
  }
  async stopSession(threadId: ThreadId): Promise<void> {
    const s = this.sessions.get(threadId); if (!s) return;
    s.stopped = true;
    await this.interruptTurn(threadId);
    this.save(s);
    this.bus.emit(threadId, { type: 'session.exited', recoverable: true });
    this.bus.emit(threadId, { type: 'session.state', state: 'stopped' });
    this.sessions.delete(threadId);
  }
}
