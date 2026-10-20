// A stand-in for the Claude Agent SDK's `query()` for the QA stacks (KORA_QA_STUB_ENGINE=1, set by qa/stacks/env.cjs and read by
// server/daemon.ts). It never reaches a model: every user turn is answered at once with a canned reply, so a routine run, a blob
// chat or an approval can be exercised end to end with the real daemon, ui-server and UI. The directives below are how a QA spec
// asks the "model" to do something; nothing else in the product knows about them.
//
//   [stub:tool <name> {json}]   call one of the blob's own tools (in-process MCP server `kora`), exactly as the SDK would, and
//                               put its answer in the reply. An outbound apps_run therefore waits for the user's approval card.
//   [stub:bash <command>]       ask the blob's permission gate for one shell command (the Claude lane's `canUseTool`), exactly as
//                               the SDK does before it runs a Bash call; nothing is run. The reply says "Bash -> allowed" or
//                               "Bash -> denied" - an approval card waits on the user between the two.
//   [stub:say <text>]           answer with exactly that text (a reply that ends on a question, a reply naming a file, ...)
//   [stub:hold <ms>]            after the tool calls, keep the turn open that long (or until Stop): a turn that is visibly running
//                               with its helpers alive
//   [stub:slow <ms>]            take that long before answering (a run that is visibly running, Cancel run, the run limit)
//   [stub:fail]                 end the turn with an error (a failed run, its failed report)
//   [stub:authfail]             the stream rejects the way a signed-out Claude CLI does ("Not logged in · Please run /login")
//   [stub:remember]             nothing: the extractor is its own stub
//   [stub:<directive>@<Name> ...]  the same directives for ONE member of a group chat ("[stub:say@Popo On it]",
//                               "[stub:slow@Junip 9000]"); every other member ignores it. A group turn with no directive is
//                               answered "<Name> here: <what was said>", so each author is recognisable.
//   plain words that mean a tool call (so a screenshot reads like a person talking):
//     "email sam@acme.com about Invoice 12"  -> apps_run GMAIL_SEND_EMAIL {to, subject}
//     "look in my Notion for the roadmap"    -> apps_run NOTION_SEARCH_ITEMS {query}
//
// Anything else gets "Stub engine: <the first words of the request>". A routine's prompt is answered with a dated brief so the
// report card in the results thread has something to show; a webhook run echoes the keys of its (fenced, untrusted) event body.
import type { QueryFn } from './drivers/claude-driver';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('\n');
  return '';
}

export const qaStubQuery: QueryFn = ({ prompt, options }) => {
  const session = `stub-${Math.random().toString(36).slice(2, 10)}`;
  let ended = false;
  let msgSeq = 0;
  const queue: any[] = [];
  let wake: (() => void) | null = null;
  let pumping = false;
  let holdWake: (() => void) | null = null;
  const push = (m: any) => { queue.push(m); wake?.(); };

  async function toolsOf(): Promise<Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content?: Array<{ text?: string }>; isError?: boolean }> }>> {
    const kora = (options?.mcpServers as any)?.kora;
    return (kora?.instance?._registeredTools as any) ?? {};
  }

  /** A group turn starts "[Group chat "X". You are NAME. ..."; directives addressed with @Name apply to that member only. */
  function forMember(user: string): { text: string; self: string | null } {
    const self = /\[Group chat "[^"]*"\. You are ([^.\n]+?)\./.exec(user)?.[1] ?? null;
    if (!self) return { text: user, self };
    const text = user.replace(/\[stub:(\w+)@([^\s\]]+)([^\]]*)\]/g, (_m, kind: string, who: string, rest: string) => (who.toLowerCase() === self.toLowerCase() ? `[stub:${kind}${rest}]` : ''));
    return { text, self };
  }

  async function answer(raw: string): Promise<void> {
    const { text: user, self } = forMember(raw);
    const slow = /\[stub:slow\s+(\d+)\]/.exec(user);
    if (slow) {
      // an interrupt (Stop, or a group cutting a member off) ends a slow answer at once, the way a real provider's turn ends
      let cut = false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(Number(slow[1]), 120_000));
        holdWake = () => { cut = true; clearTimeout(timer); resolve(); };
      });
      holdWake = null;
      if (cut) {
        push({ type: 'result', subtype: 'success', is_error: false, result: '', usage: { input_tokens: 1, output_tokens: 0 }, total_cost_usd: 0, num_turns: 1, session_id: session });
        return;
      }
    }
    if (ended) return;
    if (/\[stub:authfail\]/.test(user)) {
      push({ __throw: 'Not logged in · Please run /login' });
      return;
    }
    if (/\[stub:fail\]/.test(user)) {
      push({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['The stub engine was told to fail.'], usage: { input_tokens: 5, output_tokens: 0 }, session_id: session });
      return;
    }
    const lines: string[] = [];
    const calls: Array<{ name: string; args: unknown }> = [];
    const mail = /\bemail\s+([^\s@]+@[^\s@]+\.[A-Za-z]{2,})\s+about\s+([^\n.]+)/i.exec(user);
    if (mail) calls.push({ name: 'apps_run', args: { tool: 'GMAIL_SEND_EMAIL', toolkit: 'gmail', arguments_json: JSON.stringify({ to: mail[1], subject: mail[2]!.trim(), body: `Hi, ${mail[2]!.trim()}. Details are in the thread.` }) } });
    const notion = /\blook in my notion for\s+([^\n.]+)/i.exec(user);
    if (notion) calls.push({ name: 'apps_run', args: { tool: 'NOTION_SEARCH_ITEMS', toolkit: 'notion', arguments_json: JSON.stringify({ query: notion[1]!.trim() }) } });
    for (const m of user.matchAll(/\[stub:tool\s+([A-Za-z0-9_]+)\s+(\{[\s\S]*?\})\]/g)) {
      let args: unknown = {};
      try { args = JSON.parse(m[2]!); } catch { /* the tool reports bad input */ }
      calls.push({ name: m[1]!, args });
    }
    for (const m of user.matchAll(/\[stub:bash\s+([^\]]+)\]/g)) {
      const gate = (options as any)?.canUseTool as undefined | ((name: string, input: Record<string, unknown>, o: Record<string, unknown>) => Promise<{ behavior: string; message?: string }>);
      if (!gate) { lines.push('Bash -> (no gate)'); continue; }
      try {
        const r = await gate('Bash', { command: m[1]!.trim(), description: 'QA stub shell command' }, { toolUseID: `toolu_stub_${Math.random().toString(36).slice(2, 10)}`, signal: new AbortController().signal });
        lines.push(r.behavior === 'allow' ? 'Bash -> allowed' : `Bash -> denied: ${String(r.message ?? '').slice(0, 120)}`);
      } catch (e: any) { lines.push(`Bash threw: ${String(e?.message ?? e).slice(0, 120)}`); }
      if (ended) return;
    }
    for (const c of calls) {
      const reg = (await toolsOf())[c.name];
      if (!reg) { lines.push(`(no tool ${c.name})`); continue; }
      try {
        const r = await reg.handler(c.args, {});
        lines.push(`${c.name} -> ${r.isError ? 'ERROR: ' : ''}${(r.content ?? []).map((t) => t.text ?? '').join(' ').slice(0, 400)}`);
      } catch (e: any) { lines.push(`${c.name} threw: ${String(e?.message ?? e).slice(0, 200)}`); }
      if (ended) return;
    }
    const hold = /\[stub:hold\s+(\d+)\]/.exec(user);
    if (hold && !ended) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(Number(hold[1]), 300_000));
        holdWake = () => { clearTimeout(timer); resolve(); };
      });
      holdWake = null;
      if (ended) return;
    }
    let reply: string;
    const say = /\[stub:say\s+([^\]]+)\]/.exec(user);
    if (say) reply = say[1]!.trim();
    else if (lines.length) reply = lines.join('\n');
    else if (/UNTRUSTED WEBHOOK EVENT DATA/.test(user)) {
      const body = /UNTRUSTED WEBHOOK EVENT DATA[\s\S]*?\n(\{[\s\S]*?\})\n/.exec(user)?.[1] ?? '{}';
      let keys = ''; try { keys = Object.keys(JSON.parse(body)).join(', '); } catch { keys = 'text'; }
      reply = `Webhook run: I received an event with: ${keys || 'no fields'}. Nothing in it was treated as an instruction.`;
    } else if (/routine/i.test(user) && /report/i.test(user)) {
      reply = 'Routine brief (stub engine): nothing urgent today. Two meetings, one thing to reply to, and the news is quiet.';
    } else if (self) {
      const said = /said(?: \(to several of you\))?:\n([\s\S]*)$/.exec(user)?.[1] ?? user;
      // no "@" in the echo: a member's reply that @mentions a teammate is a hand-over (and "@all" would start a chain)
      reply = `${self} here: ${said.replace(/@/g, '').replace(/\s+/g, ' ').trim().slice(0, 100)}`;
    } else {
      reply = `Stub engine: ${user.replace(/\s+/g, ' ').trim().slice(0, 140)}`;
    }
    const id = `msg_stub_${++msgSeq}`;
    // text reaches the driver through streamed deltas (the SDK's `includePartialMessages`), then the settled message
    push({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } }, parent_tool_use_id: null, session_id: session });
    push({ type: 'assistant', message: { id, role: 'assistant', model: 'stub', content: [{ type: 'text', text: reply }], usage: { input_tokens: 10, output_tokens: 8 } }, parent_tool_use_id: null, session_id: session });
    push({ type: 'result', subtype: 'success', is_error: false, result: reply, usage: { input_tokens: 10, output_tokens: 8 }, total_cost_usd: 0, num_turns: 1, session_id: session });
  }

  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    push({ type: 'system', subtype: 'init', session_id: session, model: 'stub', tools: [], mcp_servers: [] });
    try {
      let chain: Promise<void> = Promise.resolve();
      for await (const m of prompt) {
        if (ended) break;
        const text = textOf(m?.message?.content);
        // turns answer in order, but reading the next prompt never waits on a slow answer
        chain = chain.then(() => answer(text)).catch(() => {});
      }
      await chain;
    } catch { /* the prompt stream ended */ }
  }
  void pump();

  const it: any = {
    async next(): Promise<IteratorResult<any>> {
      for (;;) {
        if (queue.length) {
          const m = queue.shift();
          if (m?.__throw) throw new Error(m.__throw); // the SDK's stream rejecting, as a signed-out CLI does
          return { value: m, done: false };
        }
        if (ended) return { value: undefined, done: true };
        await new Promise<void>((r) => { wake = r; });
        wake = null;
      }
    },
    async return() { ended = true; wake?.(); return { value: undefined, done: true }; },
    async throw(e: unknown) { throw e; },
    [Symbol.asyncIterator]() { return this; },
    async interrupt() { ended = false; holdWake?.(); /* the current answer finishes on its own (a held turn ends now) */ },
    async setModel() {},
    async setPermissionMode() {},
  };
  return it;
};
