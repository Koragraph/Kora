// Pure parser for `opencode run --format json` (opencode 1.18.x): one JSON event per stdout line. Shapes captured
// live 2026-10-08 (fixtures in opencode-driver.test.ts):
//   {"type":"step_start","sessionID":"ses_…","part":{"type":"step-start"}}
//   {"type":"text","part":{"id","type":"text","text":"hi there"}}                        (whole text, not streamed)
//   {"type":"tool_use","part":{"type":"tool","tool":"write","callID","state":{"status":"completed","input":{…},"output":"…"}}}
//   {"type":"step_finish","part":{"reason":"stop"|"tool-calls","tokens":{"total","input","output","reasoning","cache":{"read","write"}},"cost":0}}
//   {"type":"error","error":{"name":"APIError","data":{"message","statusCode":429,"isRetryable":true}}}
// Everything is read defensively: an unknown event is ignored, never a throw.
import type { UnsequencedChatEvent, ToolKind, ToolStatus, TurnUsage, FileChange } from '../events';

// Same pattern as server/swarm.ts RATE_LIMIT_RE (not imported: that module pulls in the whole swarm service).
const RATE_LIMIT_RE = /429|rate.?limit|too many requests|Free limit reached|Free usage exceeded|FreeUsageLimitError|resource.?exhausted/i;

export interface OpencodeTurnState {
  sessionId: string | null;
  usage: { input: number; output: number; cached: number; reasoning: number; any: boolean };
  /** Each finished step's tokens (one model request), for the cost log; the driver drains it. */
  calls: { in: number; cr: number; cc: number; out: number }[];
  errors: Set<string>;
  /** A rate-limit / "endpoint unavailable" error was seen this turn: the model should cool down. */
  rateLimited: boolean;
  sawText: boolean;
  finished: boolean;
  lastTotal: number;
  texts: string[];
  /** Tool calls already announced by a pending/running `tool_use` (their completed event sends only the result). */
  startedTools: Set<string>;
}

export function newOpencodeTurnState(): OpencodeTurnState {
  return { sessionId: null, usage: { input: 0, output: 0, cached: 0, reasoning: 0, any: false }, calls: [], errors: new Set(), rateLimited: false, sawText: false, finished: false, lastTotal: 0, texts: [], startedTools: new Set() };
}

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const str = (v: unknown): string => (v == null ? '' : String(v));

export function opencodeToolKind(tool: string): ToolKind {
  const t = tool.toLowerCase();
  if (t === 'bash' || t === 'shell') return 'command_execution';
  if (['write', 'edit', 'multiedit', 'patch', 'apply_patch'].includes(t)) return 'file_change';
  if (['read', 'glob', 'grep', 'list', 'ls'].includes(t)) return 'file_read';
  if (t === 'webfetch' || t === 'websearch' || t === 'codesearch') return 'web_search';
  if (t.includes('_') && !t.startsWith('apply')) return 'mcp_tool_call';
  return 'dynamic_tool_call';
}

function toolTitle(tool: string, input: any, title?: string): string {
  const cmd = input?.command;
  if (cmd) return `$ ${str(cmd).split('\n')[0].slice(0, 80)}`;
  const p = input?.filePath ?? input?.path ?? input?.url ?? input?.pattern ?? input?.query;
  if (p) return `${tool} ${str(p).slice(0, 80)}`;
  return title ? str(title).slice(0, 80) : tool;
}

/** A calm sentence for an OpenCode API error. */
export function describeOpencodeError(err: any): { message: string; rateLimited: boolean; status: number | null } {
  const d = err?.data ?? err ?? {};
  const status = Number.isFinite(Number(d.statusCode)) ? Number(d.statusCode) : null;
  const raw = str(d.message ?? err?.message ?? err?.name ?? 'OpenCode error');
  const body = str(d.responseBody);
  const rateLimited = status === 429 || RATE_LIMIT_RE.test(raw) || RATE_LIMIT_RE.test(body) || /endpoint is unavailable|overloaded/i.test(raw);
  if (rateLimited) return { message: 'This free model is rate-limited or busy right now. Try again in a few minutes, or switch the blob to another model.', rateLimited: true, status };
  if (status === 401 || status === 403) return { message: `The model provider refused the request (HTTP ${status}). Check the provider key in Settings.`, rateLimited: false, status };
  return { message: raw.length > 300 ? raw.slice(0, 300) + '…' : raw, rateLimited: false, status };
}

/** Map ONE parsed event. `ctx.turnId` rides on every event; `st` is mutated (usage, session id, errors). */
export function mapOpencodeEvent(evt: any, st: OpencodeTurnState, turnId?: string): UnsequencedChatEvent[] {
  const out: UnsequencedChatEvent[] = [];
  const withTurn = <T extends UnsequencedChatEvent>(e: T): T => (turnId ? ({ ...e, turnId } as T) : e);
  try {
    if (typeof evt?.sessionID === 'string' && !st.sessionId) { st.sessionId = evt.sessionID; out.push({ type: 'thread.started', providerThreadId: evt.sessionID }); }
    const part = evt?.part ?? {};
    switch (str(evt?.type)) {
      case 'text': {
        const text = str(part.text);
        if (!text) return out;
        st.sawText = true; st.texts.push(text);
        out.push(withTurn({ type: 'content.delta', itemId: str(part.id) || `${turnId}:text:${st.texts.length}`, stream: 'assistant_text', delta: st.texts.length > 1 ? `\n\n${text}` : text }));
        return out;
      }
      case 'reasoning': {
        const text = str(part.text);
        if (text) out.push(withTurn({ type: 'content.delta', itemId: str(part.id) || `${turnId}:reasoning`, stream: 'reasoning_text', delta: text }));
        return out;
      }
      case 'tool_use': {
        const tool = str(part.tool) || 'tool';
        const state = part.state ?? {};
        const itemId = str(part.callID || part.id) || `${turnId}:tool:${tool}`;
        const kind = opencodeToolKind(tool);
        // A call still running (pending/running) is announced now, so a long command reads as running, not silent;
        // today's `run --format json` reports only finished calls, which then carry their own start.
        const running = state.status === 'pending' || state.status === 'running';
        if (!st.startedTools.has(itemId)) out.push(withTurn({ type: 'tool.started', itemId, toolKind: kind, toolName: tool, title: toolTitle(tool, state.input, state.title), input: state.input }));
        if (running) { st.startedTools.add(itemId); return out; }
        st.startedTools.delete(itemId);
        const status: ToolStatus = state.status === 'error' || state.status === 'failed' ? 'failed' : 'completed';
        const filePath = str(state.input?.filePath ?? state.input?.path);
        const changed: FileChange[] | undefined = kind === 'file_change' && filePath ? [{ path: filePath, additions: 0, deletions: 0 }] : undefined;
        const output = state.output != null ? str(state.output) : state.error != null ? str(state.error) : undefined;
        out.push(withTurn({ type: 'tool.result', itemId, status, ...(output !== undefined ? { output } : {}), ...(changed ? { changedFiles: changed } : {}) }));
        return out;
      }
      case 'step_finish': {
        const t = part.tokens ?? {};
        st.usage.any = true;
        st.usage.input += num(t.input); st.usage.output += num(t.output); st.usage.reasoning += num(t.reasoning); st.usage.cached += num(t.cache?.read);
        // OpenCode's `input` is fresh input (cache reads and writes are separate); reasoning is billed as output.
        if (num(t.input) + num(t.output) + num(t.cache?.read) > 0) st.calls.push({ in: num(t.input), cr: num(t.cache?.read), cc: num(t.cache?.write), out: num(t.output) + num(t.reasoning) });
        const total = num(t.total);
        if (total > 0) { st.lastTotal = total; out.push(withTurn({ type: 'thread.token-usage', usage: { usedTokens: total, source: 'estimate', inputTokens: num(t.input), outputTokens: num(t.output), cachedInputTokens: num(t.cache?.read) } })); }
        if (str(part.reason) !== 'tool-calls') st.finished = true;
        return out;
      }
      case 'error': {
        const d = describeOpencodeError(evt.error);
        if (st.errors.has(d.message)) return out;
        st.errors.add(d.message);
        if (d.rateLimited) {
          st.rateLimited = true;
          out.push(withTurn({ type: 'usage.rate-limit', message: d.message }));
        }
        out.push(withTurn({ type: 'runtime.error', errorClass: 'provider', message: d.message }));
        return out;
      }
      default:
        return out; // step_start and anything new
    }
  } catch {
    return [{ type: 'runtime.warning', message: `unmappable opencode event: ${str(evt?.type)}` }];
  }
}

export function opencodeTurnUsage(st: OpencodeTurnState): TurnUsage | undefined {
  if (!st.usage.any) return undefined;
  return { usageStatus: 'complete', inputTokens: st.usage.input, outputTokens: st.usage.output, cachedInputTokens: st.usage.cached, ...(st.usage.reasoning ? { reasoningTokens: st.usage.reasoning } : {}) };
}

/** Split stdout into complete JSON events + the unterminated remainder. */
export function drainOpencodeLines(buf: string): { events: any[]; rest: string } {
  const events: any[] = [];
  const parts = buf.split('\n');
  const rest = parts.pop() ?? '';
  for (const line of parts) { const t = line.trim(); if (!t) continue; try { events.push(JSON.parse(t)); } catch { /* skip */ } }
  return { events, rest };
}

/** The assistant text of a whole `--format json` stdout (the one-shot callers), plus whether it failed on a rate limit. */
export function opencodeOutputText(stdout: string): { text: string; error: string | null; rateLimited: boolean } {
  const st = newOpencodeTurnState();
  const { events } = drainOpencodeLines(stdout.endsWith('\n') ? stdout : stdout + '\n');
  let error: string | null = null;
  for (const e of events) {
    const mapped = mapOpencodeEvent(e, st);
    const err = mapped.find((m) => m.type === 'runtime.error') as { message: string } | undefined;
    if (err) error = err.message;
  }
  return { text: st.texts.join('\n\n').trim(), error, rateLimited: st.rateLimited };
}
