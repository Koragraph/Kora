// A small agent loop over a streaming chat endpoint: stream a completion, run the tool calls it asks for, feed the
// results back, repeat until the model answers without a tool call. Two wire dialects (OpenAI chat completions with
// tool calling, Anthropic messages with tool_use), one neutral message model. No Kora types here - the driver wires the
// tools, approvals and events around it - so it is tested against a fake HTTP server.
import { ApiError, authHeaders, chatUrl, classifyHttp, networkError, type ApiEndpoint, type FetchFn } from './api-providers';

export interface ToolDef { name: string; description: string; parameters: Record<string, unknown> }
export interface ToolCall { id: string; name: string; args: Record<string, unknown>; /** arguments were not valid JSON */ badArgs?: string }
export type ChatMsg =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[] }
  | { role: 'tool'; callId: string; name: string; text: string; isError?: boolean };

export interface Usage { input: number; output: number; cached: number }
export interface StreamResult { text: string; toolCalls: ToolCall[]; finish: 'stop' | 'tool_calls' | 'length' | 'other'; usage: Usage | null }
export interface StreamHooks { onText?(d: string): void; onReasoning?(d: string): void }

// ── SSE ──────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Yield the parsed JSON of every `data:` line of an SSE body ('[DONE]' ends it). */
export async function* sseJson(body: ReadableStream<Uint8Array> | null, signal?: AbortSignal): AsyncGenerator<any> {
  if (!body) return;
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      if (signal?.aborted) throw new ApiError('aborted', 'Cancelled.');
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const d = line.slice(5).trim();
        if (!d) continue;
        if (d === '[DONE]') return;
        try { yield JSON.parse(d); } catch { /* keep-alive / partial junk */ }
      }
    }
    const tail = buf.trim();
    if (tail.startsWith('data:') && tail.slice(5).trim() !== '[DONE]') { try { yield JSON.parse(tail.slice(5).trim()); } catch { /* ignore */ } }
  } finally { try { reader.releaseLock(); } catch { /* released */ } }
}

function parseArgs(raw: string): { args: Record<string, unknown>; bad?: string } {
  if (!raw.trim()) return { args: {} };
  try { const v = JSON.parse(raw); return v && typeof v === 'object' && !Array.isArray(v) ? { args: v } : { args: {}, bad: 'arguments must be a JSON object' }; }
  catch { return { args: {}, bad: 'arguments were not valid JSON' }; }
}

async function open(ep: ApiEndpoint, key: string | null, body: unknown, f: FetchFn, signal?: AbortSignal): Promise<Response> {
  let res: Response;
  try { res = await f(chatUrl(ep), { method: 'POST', headers: { ...authHeaders(ep, key), 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(body), ...(signal ? { signal } : {}) }); }
  catch (e) { throw networkError(ep, e); }
  if (!res.ok) throw classifyHttp(ep, res.status, await res.text().catch(() => ''), res.headers);
  return res;
}

// ── OpenAI-compatible ────────────────────────────────────────────────────────────────────────────────────────────
export function toOpenAiMessages(system: string, msgs: ChatMsg[]): unknown[] {
  const out: any[] = system ? [{ role: 'system', content: system }] : [];
  for (const m of msgs) {
    if (m.role === 'user') out.push({ role: 'user', content: m.text });
    else if (m.role === 'assistant') out.push({ role: 'assistant', content: m.text || null, ...(m.toolCalls.length ? { tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } })) } : {}) });
    else out.push({ role: 'tool', tool_call_id: m.callId, content: m.text });
  }
  return out;
}

export async function streamOpenAi(o: { ep: ApiEndpoint; key: string | null; model: string; system: string; messages: ChatMsg[]; tools: ToolDef[]; fetch: FetchFn; signal?: AbortSignal; maxTokens?: number } & StreamHooks): Promise<StreamResult> {
  const body: Record<string, unknown> = {
    model: o.model, stream: true, stream_options: { include_usage: true }, messages: toOpenAiMessages(o.system, o.messages),
    ...(o.tools.length ? { tools: o.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
    ...(o.maxTokens ? { max_tokens: o.maxTokens } : {}),
  };
  const res = await open(o.ep, o.key, body, o.fetch, o.signal);
  let text = ''; let finish: StreamResult['finish'] = 'other'; let usage: Usage | null = null;
  const calls = new Map<number, { id: string; name: string; args: string }>();
  try {
    for await (const j of sseJson(res.body, o.signal)) {
      if (j?.error) throw midStream(o.ep, j.error);
      if (j?.usage) usage = { input: Number(j.usage.prompt_tokens ?? 0), output: Number(j.usage.completion_tokens ?? 0), cached: Number(j.usage.prompt_tokens_details?.cached_tokens ?? 0) };
      const ch = j?.choices?.[0];
      if (!ch) continue;
      const d = ch.delta ?? {};
      if (typeof d.content === 'string' && d.content) { text += d.content; o.onText?.(d.content); }
      const r = d.reasoning_content ?? d.reasoning;
      if (typeof r === 'string' && r) o.onReasoning?.(r);
      for (const tc of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
        const idx = Number(tc.index ?? 0);
        const cur = calls.get(idx) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = String(tc.id);
        if (tc.function?.name) cur.name += String(tc.function.name);
        if (typeof tc.function?.arguments === 'string') cur.args += tc.function.arguments;
        calls.set(idx, cur);
      }
      if (ch.finish_reason) finish = ch.finish_reason === 'tool_calls' || ch.finish_reason === 'function_call' ? 'tool_calls' : ch.finish_reason === 'stop' ? 'stop' : ch.finish_reason === 'length' ? 'length' : 'other';
    }
  } catch (e) { throw e instanceof ApiError ? e : (e as any)?.name === 'AbortError' ? new ApiError('aborted', 'Cancelled.') : networkError(o.ep, e); }
  const toolCalls: ToolCall[] = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([i, c]) => ({ id: c.id || `call_${i}`, name: c.name, ...parseArgsInto(c.args) })).filter((t) => t.name);
  if (toolCalls.length && finish !== 'tool_calls') finish = 'tool_calls';
  return { text, toolCalls, finish, usage };
}
function parseArgsInto(raw: string): { args: Record<string, unknown>; badArgs?: string } { const p = parseArgs(raw); return { args: p.args, ...(p.bad ? { badArgs: p.bad } : {}) }; }

function midStream(ep: ApiEndpoint, err: any): ApiError {
  const msg = String(err?.message ?? err?.type ?? JSON.stringify(err)).slice(0, 200);
  const t = String(err?.type ?? err?.code ?? '');
  if (/rate|429|overloaded|quota/i.test(t + msg)) return new ApiError('rate_limit', `${ep.label} is rate-limiting or overloaded: ${msg}`, 429);
  if (/auth|permission|invalid.*key/i.test(t + msg)) return new ApiError('auth', `${ep.label} rejected the API key: ${msg}`, 401);
  return new ApiError('server', `${ep.label} stopped the answer: ${msg}`, 500);
}

// ── Anthropic-compatible ─────────────────────────────────────────────────────────────────────────────────────────
export function toAnthropicMessages(msgs: ChatMsg[]): unknown[] {
  const out: any[] = [];
  for (const m of msgs) {
    if (m.role === 'user') out.push({ role: 'user', content: m.text });
    else if (m.role === 'assistant') {
      const content: any[] = [];
      if (m.text) content.push({ type: 'text', text: m.text });
      for (const t of m.toolCalls) content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.args });
      out.push({ role: 'assistant', content });
    } else {
      const block = { type: 'tool_result', tool_use_id: m.callId, content: m.text, ...(m.isError ? { is_error: true } : {}) };
      const last = out[out.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') last.content.push(block); // results of one assistant turn share a user message
      else out.push({ role: 'user', content: [block] });
    }
  }
  return out;
}

export async function streamAnthropic(o: { ep: ApiEndpoint; key: string | null; model: string; system: string; messages: ChatMsg[]; tools: ToolDef[]; fetch: FetchFn; signal?: AbortSignal; maxTokens?: number } & StreamHooks): Promise<StreamResult> {
  const body: Record<string, unknown> = {
    model: o.model, stream: true, max_tokens: o.maxTokens ?? 8192, ...(o.system ? { system: o.system } : {}), messages: toAnthropicMessages(o.messages),
    ...(o.tools.length ? { tools: o.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
  };
  const res = await open(o.ep, o.key, body, o.fetch, o.signal);
  let text = ''; let finish: StreamResult['finish'] = 'other';
  const usage: Usage = { input: 0, output: 0, cached: 0 }; let sawUsage = false;
  const blocks = new Map<number, { type: string; id: string; name: string; json: string }>();
  try {
    for await (const j of sseJson(res.body, o.signal)) {
      switch (j?.type) {
        case 'message_start': { const u = j.message?.usage; if (u) { sawUsage = true; usage.input = Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0); usage.cached = Number(u.cache_read_input_tokens ?? 0); usage.output = Number(u.output_tokens ?? 0); } break; }
        case 'content_block_start': { const b = j.content_block ?? {}; blocks.set(Number(j.index ?? 0), { type: String(b.type), id: String(b.id ?? ''), name: String(b.name ?? ''), json: '' }); break; }
        case 'content_block_delta': {
          const d = j.delta ?? {}; const blk = blocks.get(Number(j.index ?? 0));
          if (d.type === 'text_delta' && d.text) { text += d.text; o.onText?.(d.text); }
          else if (d.type === 'thinking_delta' && d.thinking) o.onReasoning?.(d.thinking);
          else if (d.type === 'input_json_delta' && blk) blk.json += String(d.partial_json ?? '');
          break;
        }
        case 'message_delta': {
          const sr = j.delta?.stop_reason;
          if (sr) finish = sr === 'tool_use' ? 'tool_calls' : sr === 'end_turn' || sr === 'stop_sequence' ? 'stop' : sr === 'max_tokens' ? 'length' : 'other';
          if (j.usage?.output_tokens !== undefined) { sawUsage = true; usage.output = Number(j.usage.output_tokens); }
          break;
        }
        case 'error': throw midStream(o.ep, j.error);
        default: break;
      }
    }
  } catch (e) { throw e instanceof ApiError ? e : (e as any)?.name === 'AbortError' ? new ApiError('aborted', 'Cancelled.') : networkError(o.ep, e); }
  const toolCalls: ToolCall[] = [...blocks.entries()].sort((a, b) => a[0] - b[0]).filter(([, b]) => b.type === 'tool_use').map(([i, b]) => ({ id: b.id || `call_${i}`, name: b.name, ...parseArgsInto(b.json) }));
  if (toolCalls.length) finish = 'tool_calls';
  return { text, toolCalls, finish, usage: sawUsage ? usage : null };
}

// ── the loop ─────────────────────────────────────────────────────────────────────────────────────────────────────
export interface ToolOutcome { text: string; isError?: boolean }
export interface LoopHooks extends StreamHooks {
  onToolStart?(call: ToolCall): void;
  onToolResult?(call: ToolCall, r: ToolOutcome): void;
  onUsage?(u: Usage): void;
}
export interface LoopInput extends LoopHooks {
  ep: ApiEndpoint; key: string | null; model: string; system: string;
  /** Mutated: the assistant and tool messages of this turn are appended. */
  history: ChatMsg[];
  tools: ToolDef[];
  run(call: ToolCall): Promise<ToolOutcome>;
  fetch: FetchFn;
  signal?: AbortSignal;
  maxSteps?: number;
  maxTokens?: number;
}
export interface LoopResult { finish: StreamResult['finish'] | 'max-steps'; steps: number; usage: Usage; text: string }

export async function runAgentLoop(i: LoopInput): Promise<LoopResult> {
  const total: Usage = { input: 0, output: 0, cached: 0 };
  const stream = i.ep.protocol === 'anthropic' ? streamAnthropic : streamOpenAi;
  const max = i.maxSteps ?? 25;
  let lastText = '';
  for (let step = 1; step <= max; step++) {
    if (i.signal?.aborted) throw new ApiError('aborted', 'Cancelled.');
    const r = await stream({ ep: i.ep, key: i.key, model: i.model, system: i.system, messages: i.history, tools: i.tools, fetch: i.fetch, ...(i.signal ? { signal: i.signal } : {}), ...(i.maxTokens ? { maxTokens: i.maxTokens } : {}), ...(i.onText ? { onText: i.onText } : {}), ...(i.onReasoning ? { onReasoning: i.onReasoning } : {}) });
    if (r.usage) { total.input += r.usage.input; total.output += r.usage.output; total.cached += r.usage.cached; i.onUsage?.(r.usage); }
    if (r.text || r.toolCalls.length) i.history.push({ role: 'assistant', text: r.text, toolCalls: r.toolCalls });
    lastText = r.text || lastText;
    if (!r.toolCalls.length) return { finish: r.finish, steps: step, usage: total, text: lastText };
    for (const call of r.toolCalls) {
      if (i.signal?.aborted) throw new ApiError('aborted', 'Cancelled.');
      i.onToolStart?.(call);
      let out: ToolOutcome;
      if (call.badArgs) out = { text: `Tool call failed: ${call.badArgs}. Send the arguments as one JSON object.`, isError: true };
      else if (!i.tools.some((t) => t.name === call.name)) out = { text: `No tool named "${call.name}". Available: ${i.tools.map((t) => t.name).join(', ')}.`, isError: true };
      else { try { out = await i.run(call); } catch (e: any) { out = { text: `Tool failed: ${String(e?.message ?? e).slice(0, 400)}`, isError: true }; } }
      i.onToolResult?.(call, out);
      i.history.push({ role: 'tool', callId: call.id, name: call.name, text: out.text, ...(out.isError ? { isError: true } : {}) });
    }
  }
  return { finish: 'max-steps', steps: max, usage: total, text: lastText };
}

/** Keep the conversation bounded without splitting a tool call from its result: drop whole oldest user turns. */
export function trimHistory(h: ChatMsg[], maxMessages = 80): ChatMsg[] {
  if (h.length <= maxMessages) return h;
  let start = h.length - maxMessages;
  while (start < h.length && h[start]!.role !== 'user') start++;
  return start >= h.length ? h.slice(-2) : h.slice(start);
}
