// The outside tool set - the whole attack surface of `kora mcp --team`, as pure functions over an injected OutsideHost.
// Deliberately NOT here: approvals / permission answers, deletes, settings, secrets, memory edits, app grants,
// computer/browser lifecycle, routine/webhook secrets. A name not in `toolDefs()` does not exist for an outside client.
import type { OutsideBlob, OutsideHost, OutsideOutput, OutsideRow, OutsideToolResult, ThreadStatus, ToolParams } from './types';

export interface ToolCtx {
  host: OutsideHost;
  via: { client: string; tokenId: string };
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface ToolDef {
  name: string;
  description: string;
  params: ToolParams;
  /** Makes a Blob do work (counted against the tighter send limit). */
  send?: boolean;
  /** Longest this tool may legitimately hold the call, for the bridge's socket timeout. */
  maxSeconds?: number;
  target(args: Record<string, any>): string | null;
  run(ctx: ToolCtx, args: Record<string, any>): Promise<OutsideToolResult>;
}

export const LIMITS = { threadsDefault: 20, threadsMax: 50, searchMax: 20, outputsDefault: 30, outputsMax: 100, textMax: 8000, readDefault: 6000, readMin: 500, readMax: 20_000, rowCap: 2000, waitDefault: 45, waitMax: 300, replyCap: 6000, strMax: 300 };

const ok = (data: unknown): OutsideToolResult => ({ text: JSON.stringify(data) });
const fail = (message: string): OutsideToolResult => ({ text: message, isError: true });
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}... [+${s.length - n} chars]` : s);
const clampInt = (v: unknown, def: number, lo: number, hi: number) => { const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : def; return Math.min(Math.max(n, lo), hi); };

export const encodeCursor = (o: number): string => 'c1.' + Buffer.from(JSON.stringify({ o })).toString('base64url');
export function decodeCursor(c: unknown): number | null {
  if (c === undefined || c === null || c === '') return 0;
  if (typeof c !== 'string' || !c.startsWith('c1.')) return null;
  try { const o = JSON.parse(Buffer.from(c.slice(3), 'base64url').toString('utf8'))?.o; return Number.isInteger(o) && o >= 0 ? o : null; } catch { return null; }
}

function resolveBlob(host: OutsideHost, ref: unknown): OutsideBlob | string {
  const q = typeof ref === 'string' ? ref.trim() : '';
  if (!q) return 'Say which blob (its id or name).';
  const all = host.listBlobs();
  const hit = all.find((b) => b.id === q) ?? all.find((b) => b.name.toLowerCase() === q.toLowerCase());
  return hit ?? `No blob "${q}". Call list_blobs for the team.`;
}
function resolveThread(host: OutsideHost, ref: unknown) {
  const q = typeof ref === 'string' ? ref.trim() : '';
  if (!q) return 'Say which thread (an id from list_threads).';
  const t = host.getThread(q);
  return t ?? `No thread "${q}" (or its blob is archived).`;
}

const lastTurn = (rows: OutsideRow[]) => { let i = rows.length - 1; while (i >= 0 && rows[i]!.role !== 'user') i--; return rows.slice(i + 1); };
const outputsOf = (rows: OutsideRow[]): OutsideOutput[] => rows.flatMap((r) => r.outputs ?? []);
const outView = (o: OutsideOutput) => ({ path: o.path, name: o.name, ...(o.bytes != null ? { bytes: o.bytes } : {}), ...(o.at != null ? { at: o.at } : {}), ...(o.caption ? { caption: o.caption } : {}) });
const attention = (rows: OutsideRow[], status: ThreadStatus): string | undefined => {
  if (status !== 'needs-you') return undefined;
  const r = [...rows].reverse().find((x) => x.needsYou);
  return `Needs you in Kora${r?.needsYou ? `: ${clip(r.needsYou, 200)}` : ''}. Approvals can only be answered in the Kora app.`;
};

export function compactRows(rows: OutsideRow[], offset: number, maxChars: number) {
  const out: any[] = [];
  let used = 0; let i = offset;
  for (; i < rows.length; i++) {
    const r = rows[i]!;
    const item: Record<string, unknown> = { i, role: r.role };
    if (r.role === 'tool') item.text = clip(`${r.tool?.name ?? 'tool'}: ${r.tool?.summary ?? r.text}`, 240);
    else item.text = clip(r.text, LIMITS.rowCap);
    if (r.via) item.via = r.via;
    if (r.at != null) item.at = r.at;
    if (r.outputs?.length) item.outputs = r.outputs.map((o) => o.name);
    if (r.needsYou) item.needsYou = clip(r.needsYou, 200);
    const size = JSON.stringify(item).length;
    if (out.length && used + size > maxChars) break;
    out.push(item); used += size;
  }
  return { messages: out, next: i < rows.length ? i : null };
}

async function send(ctx: ToolCtx, target: { blobId?: string; threadId?: string }, textRaw: unknown): Promise<OutsideToolResult & { data?: any }> {
  const text = typeof textRaw === 'string' ? textRaw.trim() : '';
  if (!text) return fail('text is required.');
  if (text.length > LIMITS.textMax) return fail(`text is too long (max ${LIMITS.textMax} characters).`);
  const r = await ctx.host.sendMessage({ ...target, text, via: ctx.via });
  if ('refused' in r && r.refused) {
    const why = { busy: 'That blob is already running its maximum number of threads. Wait for one to finish (wait_for) and try again.', archived: 'That blob is archived.', unknown: 'Kora does not know that blob or thread.', empty: 'Nothing to send.' }[r.refused];
    return fail(r.message ?? why);
  }
  const ok_ = r as { threadId: string; blobId: string };
  const data = { thread: ok_.threadId, blob: ok_.blobId, started: !target.threadId, status: 'running' as const, next: 'Call wait_for(thread) to get the reply.' };
  return { ...ok(data), data };
}

export function toolDefs(host: OutsideHost): ToolDef[] {
  const T: ToolDef[] = [
    {
      name: 'list_blobs', description: 'List the Blobs on the user\'s Kora team: id, name, title, status, and engine/model.', params: {},
      target: () => null,
      async run({ host: h }) { return ok({ blobs: h.listBlobs().map((b) => ({ id: b.id, name: b.name, title: b.title, role: b.role, status: b.status, engine: b.engine.instanceId, model: b.engine.model })) }); },
    },
    {
      name: 'get_blob', description: 'One Blob\'s profile summary and capability card (what it is good at, skills).', params: { blob: { type: 'string', description: 'Blob id or name.' } },
      target: (a) => a.blob ?? null,
      async run({ host: h }, a) {
        const b = resolveBlob(h, a.blob); if (typeof b === 'string') return fail(b);
        const d = h.describeBlob(b.id); if (!d) return fail(`No profile for ${b.name}.`);
        return ok({ id: b.id, name: b.name, title: b.title, role: b.role, status: b.status, engine: b.engine.instanceId, model: b.engine.model, summary: clip(d.summary, 1500), card: d.card ? clip(d.card, 2500) : null, skills: d.skills.slice(0, 40) });
      },
    },
    {
      name: 'list_threads', description: 'A Blob\'s conversation threads, newest first. Page with the returned cursor.',
      params: { blob: { type: 'string', description: 'Blob id or name.' }, limit: { type: 'number', optional: true, description: `Default ${LIMITS.threadsDefault}, max ${LIMITS.threadsMax}.` }, cursor: { type: 'string', optional: true } },
      target: (a) => a.blob ?? null,
      async run({ host: h }, a) {
        const b = resolveBlob(h, a.blob); if (typeof b === 'string') return fail(b);
        const off = decodeCursor(a.cursor); if (off === null) return fail('That cursor is not valid. Start again without one.');
        const limit = clampInt(a.limit, LIMITS.threadsDefault, 1, LIMITS.threadsMax);
        const all = h.listThreads(b.id).slice().sort((x, y) => y.updatedAt - x.updatedAt);
        const page = all.slice(off, off + limit);
        return ok({ blob: b.id, threads: page.map((t) => ({ id: t.id, title: clip(t.title, 120), status: t.status, updatedAt: t.updatedAt, messages: t.messageCount })), nextCursor: off + limit < all.length ? encodeCursor(off + limit) : null, total: all.length });
      },
    },
    {
      name: 'read_thread', description: 'A compact transcript page: user/assistant text, tool rows summarised, outputs listed. Page with the returned cursor.',
      params: { thread: { type: 'string', description: 'Thread id.' }, cursor: { type: 'string', optional: true }, max_chars: { type: 'number', optional: true, description: `Page size in characters. Default ${LIMITS.readDefault}, ${LIMITS.readMin}-${LIMITS.readMax}.` } },
      target: (a) => a.thread ?? null,
      async run({ host: h }, a) {
        const t = resolveThread(h, a.thread); if (typeof t === 'string') return fail(t);
        const off = decodeCursor(a.cursor); if (off === null) return fail('That cursor is not valid. Start again without one.');
        const rows = h.threadRows(t.id);
        const page = compactRows(rows, Math.min(off, rows.length), clampInt(a.max_chars, LIMITS.readDefault, LIMITS.readMin, LIMITS.readMax));
        const att = attention(rows, t.status);
        return ok({ thread: t.id, blob: t.blobId, title: clip(t.title, 120), status: t.status, ...(att ? { attention: att } : {}), messages: page.messages, nextCursor: page.next === null ? null : encodeCursor(page.next), total: rows.length });
      },
    },
    {
      name: 'search', description: 'Search threads, blobs and outputs by text.', params: { query: { type: 'string' } },
      target: (a) => (typeof a.query === 'string' ? `q:${a.query.slice(0, 40)}` : null),
      async run({ host: h }, a) {
        const q = typeof a.query === 'string' ? a.query.trim() : '';
        if (q.length < 2) return fail('query needs at least 2 characters.');
        if (q.length > 200) return fail('query is too long (max 200 characters).');
        const hits = h.search(q, LIMITS.searchMax).slice(0, LIMITS.searchMax);
        return ok({ hits: hits.map((x) => ({ kind: x.kind, id: x.id, blob: x.blobId, title: clip(x.title, 120), snippet: clip(x.snippet, 240) })) });
      },
    },
    {
      name: 'send_message', send: true,
      description: 'Send a message to a Blob (starts a new thread) or to an existing thread. Returns immediately; use wait_for to get the reply. The transcript shows it as sent "via" this client.',
      params: { blob: { type: 'string', optional: true, description: 'Blob id or name: starts a new thread.' }, thread: { type: 'string', optional: true, description: 'Existing thread id: continues it.' }, text: { type: 'string' } },
      target: (a) => a.thread ?? a.blob ?? null,
      async run(ctx, a) {
        if (!!a.blob === !!a.thread) return fail('Give exactly one of blob (new thread) or thread (continue one).');
        if (a.thread) { const t = resolveThread(ctx.host, a.thread); if (typeof t === 'string') return fail(t); return send(ctx, { threadId: t.id }, a.text); }
        const b = resolveBlob(ctx.host, a.blob); if (typeof b === 'string') return fail(b);
        return send(ctx, { blobId: b.id }, a.text);
      },
    },
    {
      name: 'ask_kora', send: true,
      description: 'Send a message to Kora, the Chief: she plans and hands work to the right Blobs. Use thread to continue an earlier conversation with her.',
      params: { text: { type: 'string' }, thread: { type: 'string', optional: true, description: 'A thread id from an earlier ask_kora.' } },
      target: (a) => a.thread ?? 'kora',
      async run(ctx, a) {
        const chief = ctx.host.chiefId(); if (!chief) return fail('Kora (the Chief) is not set up yet. Open Kora once first.');
        if (a.thread) { const t = resolveThread(ctx.host, a.thread); if (typeof t === 'string') return fail(t); if (t.blobId !== chief) return fail('That thread is not a conversation with Kora. Use send_message for other blobs.'); return send(ctx, { threadId: t.id }, a.text); }
        return send(ctx, { blobId: chief }, a.text);
      },
    },
    {
      name: 'wait_for', maxSeconds: LIMITS.waitMax,
      description: 'Wait until a thread settles, needs the user, or errors, then return the final reply and outputs. On timeout it returns the current status with timedOut:true - call it again.',
      params: { thread: { type: 'string' }, timeout_s: { type: 'number', optional: true, description: `Default ${LIMITS.waitDefault}, max ${LIMITS.waitMax}.` } },
      target: (a) => a.thread ?? null,
      async run(ctx, a) {
        const t0 = resolveThread(ctx.host, a.thread); if (typeof t0 === 'string') return fail(t0);
        const timeout = clampInt(a.timeout_s, LIMITS.waitDefault, 1, LIMITS.waitMax) * 1000;
        const deadline = ctx.now() + timeout;
        let t = t0;
        while (t.status === 'running' && ctx.now() < deadline) {
          await ctx.sleep(Math.min(500, Math.max(1, deadline - ctx.now())));
          const n = ctx.host.getThread(t0.id); if (!n) return fail('That thread is gone.');
          t = n;
        }
        const rows = ctx.host.threadRows(t.id);
        const turn = lastTurn(rows);
        const reply = turn.filter((r) => r.role === 'assistant').map((r) => r.text).join('\n\n').trim();
        const att = attention(rows, t.status);
        return ok({ thread: t.id, blob: t.blobId, status: t.status, timedOut: t.status === 'running', ...(att ? { attention: att } : {}), reply: clip(reply, LIMITS.replyCap), outputs: outputsOf(turn).map(outView) });
      },
    },
    {
      name: 'set_model', description: 'Change a Blob\'s model. Only models Kora\'s own model picker offers for that blob are accepted.',
      params: { blob: { type: 'string' }, model: { type: 'string', description: 'Model id or label from the picker.' } },
      target: (a) => (a.blob ? `${a.blob}:${String(a.model ?? '').slice(0, 40)}` : null),
      async run({ host: h }, a) {
        const b = resolveBlob(h, a.blob); if (typeof b === 'string') return fail(b);
        const want = typeof a.model === 'string' ? a.model.trim().toLowerCase() : '';
        if (!want) return fail('Say which model.');
        const allowed = h.allowedModels(b.id);
        const hit = allowed.find((m) => m.model.toLowerCase() === want || `${m.instanceId}/${m.model}`.toLowerCase() === want || m.label.toLowerCase() === want);
        if (!hit) return fail(`"${a.model}" is not available for ${b.name}. Allowed: ${allowed.slice(0, 15).map((m) => m.model).join(', ') || 'none'}.`);
        if (!(await h.setModel(b.id, hit))) return fail(`Kora could not switch ${b.name} to ${hit.label}.`);
        return ok({ blob: b.id, engine: hit.instanceId, model: hit.model, label: hit.label });
      },
    },
    {
      name: 'interrupt', description: 'Stop the turn a thread is currently running.', params: { thread: { type: 'string' } },
      target: (a) => a.thread ?? null,
      async run({ host: h }, a) {
        const t = resolveThread(h, a.thread); if (typeof t === 'string') return fail(t);
        if (t.status !== 'running') return ok({ thread: t.id, interrupted: false, status: t.status });
        return ok({ thread: t.id, interrupted: await h.interrupt(t.id) });
      },
    },
    {
      name: 'list_outputs', description: 'Files a Blob has produced (paths are relative to its Outputs folder in Finder).',
      params: { blob: { type: 'string' }, limit: { type: 'number', optional: true, description: `Default ${LIMITS.outputsDefault}, max ${LIMITS.outputsMax}.` } },
      target: (a) => a.blob ?? null,
      async run({ host: h }, a) {
        const b = resolveBlob(h, a.blob); if (typeof b === 'string') return fail(b);
        return ok({ blob: b.id, outputs: h.listOutputs(b.id, clampInt(a.limit, LIMITS.outputsDefault, 1, LIMITS.outputsMax)).slice(0, LIMITS.outputsMax).map(outView) });
      },
    },
  ];
  const g = host.groups;
  if (g) {
    T.push(
      {
        name: 'list_groups', description: 'Group chats on the team.', params: {}, target: () => null,
        async run() { return ok({ groups: g.list().map((x) => ({ id: x.id, name: x.name, members: x.members })) }); },
      },
      {
        name: 'send_to_group', send: true, description: 'Post a message in a group chat (shown as sent "via" this client).', params: { group: { type: 'string', description: 'Group id or name.' }, text: { type: 'string' } },
        target: (a) => (a.group ? `group:${a.group}` : null),
        async run(ctx, a) {
          const q = typeof a.group === 'string' ? a.group.trim() : '';
          const grp = g.list().find((x) => x.id === q || x.name.toLowerCase() === q.toLowerCase());
          if (!grp) return fail(`No group "${q}". Call list_groups.`);
          const text = typeof a.text === 'string' ? a.text.trim() : '';
          if (!text) return fail('text is required.');
          if (text.length > LIMITS.textMax) return fail(`text is too long (max ${LIMITS.textMax} characters).`);
          const r = await g.send({ groupId: grp.id, text, via: ctx.via });
          return r.ok ? ok({ group: grp.id, sent: true }) : fail(r.message ?? 'Kora could not post that.');
        },
      },
    );
  }
  return T;
}

/** Type/optional/enum/length checks against a tool's params. Returns the cleaned args or an error string. */
export function validateArgs(params: ToolParams, raw: unknown): { args: Record<string, any> } | { error: string } {
  const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, any> = {};
  for (const [k, p] of Object.entries(params)) {
    const v = a[k];
    if (v === undefined || v === null || v === '') { if (!p.optional) return { error: `${k} is required.` }; continue; }
    if (p.type === 'number') { if (typeof v !== 'number' || !Number.isFinite(v)) return { error: `${k} must be a number.` }; }
    else if (p.type === 'boolean') { if (typeof v !== 'boolean') return { error: `${k} must be true or false.` }; }
    else {
      if (typeof v !== 'string') return { error: `${k} must be text.` };
      const max = k === 'text' ? LIMITS.textMax + 1 : LIMITS.strMax;
      if (v.length > max) return { error: `${k} is too long.` };
      if (p.enum && !p.enum.includes(v)) return { error: `${k} must be one of ${p.enum.join(', ')}.` };
    }
    out[k] = v;
  }
  return { args: out };
}
