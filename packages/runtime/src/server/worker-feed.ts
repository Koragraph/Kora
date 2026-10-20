// A worker's activity feed: the chat-like transcript its worker box renders (docs/fleet/WORKER-BOXES.md). Items are
// upserted by id; listeners get every change. The mapper turns chat ChatEvents (a DriverPane's engine) into items; the
// swarm OpenCode plugin and Koragent's event stream push items of their own. Wire twin: contracts WorkerFeedItem.
import { EventEmitter } from 'node:events';
import type { ChatEvent, FileChange } from '../session/events';

interface FeedBase { id: string; at: number }
export type WorkerFeedItem =
  | (FeedBase & { kind: 'user'; text: string; source: 'leader' | 'human' | 'kora' })
  | (FeedBase & { kind: 'assistant'; text: string; streaming: boolean })
  | (FeedBase & { kind: 'tool'; tool: string; title: string; detail: string | null; status: 'running' | 'done' | 'failed'; added: number | null; removed: number | null })
  | (FeedBase & { kind: 'approval'; requestId: string; title: string; detail: string | null; status: 'open' | 'accepted' | 'declined' | 'expired' })
  | (FeedBase & { kind: 'error'; text: string; retry: { attempt: number; max: number; nextAt: number | null } | null })
  | (FeedBase & { kind: 'notice'; text: string });

/** Items kept per worker (the box shows the tail; the full answer is the report). */
export const FEED_MAX = 300;
const TEXT_MAX = 64 * 1024;
const DETAIL_MAX = 1200;

export class WorkerFeed extends EventEmitter {
  private items: WorkerFeedItem[] = [];
  private index = new Map<string, number>();
  private seq = 0;

  snapshot(): WorkerFeedItem[] { return this.items.map((i) => ({ ...i })); }
  get(id: string): WorkerFeedItem | undefined { const n = this.index.get(id); return n === undefined ? undefined : this.items[n]; }
  get size(): number { return this.items.length; }
  /** A fresh id for an item that has no natural one. */
  nextId(prefix: string): string { return `${prefix}-${++this.seq}`; }

  upsert(item: WorkerFeedItem): void {
    const n = this.index.get(item.id);
    if (n !== undefined) this.items[n] = item;
    else {
      this.items.push(item);
      if (this.items.length > FEED_MAX) {
        this.items.splice(0, this.items.length - FEED_MAX);
        this.index.clear();
        this.items.forEach((x, i) => this.index.set(x.id, i));
      } else this.index.set(item.id, this.items.length - 1);
    }
    this.emit('item', item);
  }
  /** Patch an existing item (no-op when it is gone). */
  patch<K extends WorkerFeedItem['kind']>(id: string, kind: K, fn: (i: Extract<WorkerFeedItem, { kind: K }>) => Extract<WorkerFeedItem, { kind: K }>): void {
    const cur = this.get(id);
    if (cur && cur.kind === kind) this.upsert(fn(cur as Extract<WorkerFeedItem, { kind: K }>));
  }

  user(text: string, source: 'leader' | 'human' | 'kora', at = Date.now()): void {
    this.upsert({ id: this.nextId('u'), at, kind: 'user', text: cap(text, TEXT_MAX), source });
  }
  notice(text: string, at = Date.now()): void { this.upsert({ id: this.nextId('n'), at, kind: 'notice', text }); }
  error(text: string, retry: { attempt: number; max: number; nextAt: number | null } | null = null, at = Date.now()): string {
    const id = this.nextId('e'); this.upsert({ id, at, kind: 'error', text: cap(text, DETAIL_MAX), retry }); return id;
  }
  /** The last thing the worker did, in a few words (the minimized strip's "last action"). */
  lastAction(): string | null {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const x = this.items[i];
      if (x.kind === 'tool') return `${x.tool} ${x.title}`.trim();
      if (x.kind === 'assistant' && x.text.trim()) return firstLine(x.text);
      if (x.kind === 'error') return x.text;
    }
    return null;
  }
  /** The worker's last finished assistant message (a DriverPane's report). */
  lastAssistantText(): string {
    for (let i = this.items.length - 1; i >= 0; i--) { const x = this.items[i]; if (x.kind === 'assistant' && x.text.trim()) return x.text; }
    return '';
  }
}

/** State the mapper keeps between events of one worker. */
export interface FeedMapState { turnId: string | null; lastAssistantId: string | null; tools: Map<string, { verb: string }>; segment: number }
export function newFeedMapState(): FeedMapState { return { turnId: null, lastAssistantId: null, tools: new Map(), segment: 0 } }

/**
 * Fold one ChatEvent into the feed. Pure apart from the feed and `st`; returns nothing (errors and retries are the
 * DriverPane's business — it reads turn.settled itself).
 */
export function applyChatEvent(feed: WorkerFeed, st: FeedMapState, e: ChatEvent): void {
  const at = e.at || Date.now();
  switch (e.type) {
    case 'turn.started': st.turnId = e.turnId; st.lastAssistantId = null; return;
    case 'content.delta': {
      if (e.stream !== 'assistant_text' || !e.delta) return;
      // A tool call between two text runs makes two bubbles, even when the engine reuses the item id.
      const id = `a-${e.turnId ?? st.turnId ?? 't'}-${e.itemId ?? 'i'}-${st.segment}`;
      const cur = feed.get(id);
      if (cur && cur.kind === 'assistant') feed.upsert({ ...cur, text: cap(cur.text + e.delta, TEXT_MAX), streaming: true });
      else feed.upsert({ id, at, kind: 'assistant', text: cap(e.delta, TEXT_MAX), streaming: true });
      st.lastAssistantId = id;
      return;
    }
    case 'tool.started': {
      const verb = toolVerb(e.toolKind, e.toolName);
      st.tools.set(e.itemId, { verb });
      feed.upsert({ id: `t-${e.itemId}`, at, kind: 'tool', tool: verb, title: toolTitle(e.toolName, e.title, e.input), detail: null, status: 'running', added: null, removed: null });
      sealAssistant(feed, st);
      return;
    }
    case 'tool.updated': {
      if (e.input === undefined) return;
      feed.patch(`t-${e.itemId}`, 'tool', (t) => ({ ...t, title: toolTitle(null, t.title, e.input) || t.title }));
      return;
    }
    case 'tool.result': {
      const failed = e.status !== 'completed';
      const changes = e.changedFiles ?? [];
      const added = changes.length ? sum(changes, 'additions') : null;
      const removed = changes.length ? sum(changes, 'deletions') : null;
      const id = `t-${e.itemId}`;
      const cur = feed.get(id);
      const detail = failed || e.outputStream === 'command_output' ? tail(e.output ?? '', DETAIL_MAX) || null : null;
      if (cur && cur.kind === 'tool') {
        const verb = cur.tool === 'Edit' && !failed ? 'Edited' : cur.tool;
        feed.upsert({ ...cur, tool: verb, status: failed ? 'failed' : 'done', detail: detail ?? cur.detail, added: added ?? cur.added, removed: removed ?? cur.removed });
      } else feed.upsert({ id, at, kind: 'tool', tool: changes.length ? 'Edited' : 'Tool', title: changes.map((c) => c.path).join(', '), detail, status: failed ? 'failed' : 'done', added, removed });
      return;
    }
    case 'approval.opened':
      feed.upsert({ id: `ap-${e.requestId}`, at, kind: 'approval', requestId: e.requestId, title: e.title || e.toolName || 'Permission', detail: e.detail ?? null, status: 'open' });
      return;
    case 'approval.resolved':
      feed.patch(`ap-${e.requestId}`, 'approval', (a) => ({ ...a, status: e.decision === 'decline' || e.decision === 'cancel' ? 'declined' : 'accepted' }));
      return;
    case 'turn.settled':
      sealAssistant(feed, st);
      for (const it of feed.snapshot()) if (it.kind === 'tool' && it.status === 'running') feed.upsert({ ...it, status: e.state === 'completed' ? 'done' : 'failed' });
      if (e.state === 'interrupted' || e.state === 'cancelled') feed.notice('Stopped', at);
      return;
    case 'runtime.warning': feed.notice(e.message, at); return;
    case 'model.rerouted': feed.notice(`Model: ${e.to}${e.reason ? ` (${e.reason})` : ''}`, at); return;
    case 'turn.stuck': feed.notice(e.message, at); return;
    default: return;
  }
}

function sealAssistant(feed: WorkerFeed, st: FeedMapState): void {
  if (!st.lastAssistantId) return;
  feed.patch(st.lastAssistantId, 'assistant', (a) => (a.streaming ? { ...a, streaming: false } : a));
  st.lastAssistantId = null;
  st.segment++;
}

/** The display verb of a tool call (matches the chat's tool rows). */
export function toolVerb(kind: string, name: string): string {
  const n = (name || '').replace(/^mcp__[^_]+__/, '');
  if (kind === 'file_read' || /^read$/i.test(n)) return 'Read';
  if (kind === 'file_change' || /^(edit|multiedit|write|apply_patch|patch|notebookedit)$/i.test(n)) return /^write$/i.test(n) ? 'Write' : 'Edit';
  if (kind === 'command_execution' || /^(bash|shell|exec)$/i.test(n)) return 'Bash';
  if (kind === 'web_search' || /^web/i.test(n)) return 'Web';
  if (kind === 'graph_query' || /^kora_(map|locate)|explore|search_code|neighbours/i.test(n)) return 'Explore';
  if (/^(grep|glob|list|ls|find|search)$/i.test(n)) return 'Search';
  return n ? n.replace(/^kora_/, '') : 'Tool';
}

/** A short subject for the tool row: a path, a command, a query. */
export function toolTitle(name: string | null, title: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const pick = (...k: string[]) => { for (const x of k) if (typeof i[x] === 'string' && (i[x] as string).trim()) return (i[x] as string).trim(); return ''; };
  const subject = pick('command', 'cmd', 'file_path', 'filePath', 'path', 'pattern', 'query', 'url', 'description');
  const s = subject || title || name || '';
  return firstLine(s).slice(0, 200);
}

function firstLine(s: string): string { const l = s.split('\n').find((x) => x.trim()) ?? ''; return l.trim().slice(0, 160); }
function cap(s: string, n: number): string { return s.length > n ? `${s.slice(0, n)}…` : s; }
function tail(s: string, n: number): string { const t = s.trim(); return t.length > n ? `…${t.slice(-n)}` : t; }
function sum(c: FileChange[], k: 'additions' | 'deletions'): number { return c.reduce((a, x) => a + (Number(x[k]) || 0), 0); }

/** One step from the swarm OpenCode plugin (`pane.feed`) as a feed item; anything malformed is dropped. */
export function pluginFeedItem(raw: unknown): WorkerFeedItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : '');
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const id = str(r.id, 120);
  if (!id) return null;
  const at = Date.now();
  if (r.k === 'text') {
    const text = str(r.text, TEXT_MAX);
    return text.trim() ? { id: `oc-a-${id}`, at, kind: 'assistant', text, streaming: false } : null;
  }
  if (r.k === 'tool') {
    const failed = r.failed === true;
    const added = num(r.added), removed = num(r.removed);
    let verb = toolVerb('', str(r.tool, 60));
    if (verb === 'Edit' && !failed) verb = 'Edited';
    return { id: `oc-t-${id}`, at, kind: 'tool', tool: verb, title: firstLine(str(r.title, 400)).slice(0, 200), detail: str(r.detail, DETAIL_MAX) || null, status: failed ? 'failed' : 'done', added, removed };
  }
  return null;
}

/** A Koragent event as feed items (its stream has tools, steers, failovers and checks; no assistant text). */
export function koragentFeedItems(ev: { type: string }): WorkerFeedItem[] {
  const e = ev as { type: string; ts?: number; [k: string]: unknown };
  const at = Number(e.ts) || Date.now();
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (e.type) {
    case 'tool.start':
      return [{ id: `kg-t-${s(e.callID)}`, at, kind: 'tool', tool: toolVerb('', s(e.tool)), title: firstLine(s(e.title)).slice(0, 200), detail: null, status: 'running', added: null, removed: null }];
    case 'tool.end': {
      const failed = s(e.status) === 'error';
      const files = Array.isArray(e.files) ? (e.files as unknown[]).map(s).filter(Boolean) : [];
      return [{ id: `kg-t-${s(e.callID)}`, at, kind: 'tool', tool: files.length && !failed ? 'Edited' : 'Tool', title: files.join(', ').slice(0, 200), detail: failed && typeof e.exitCode === 'number' ? `exit ${e.exitCode}` : null, status: failed ? 'failed' : 'done', added: null, removed: null }];
    }
    case 'steer.received':
      return [{ id: `kg-s-${s(e.id) || at}`, at, kind: 'user', text: s(e.preview), source: e.source === 'human' || e.source === 'kora' ? e.source : 'leader' }];
    case 'route.failover':
      return [{ id: `kg-f-${at}`, at, kind: 'notice', text: `Model ${s(e.from)} → ${s(e.to)}${e.reason ? ` (${s(e.reason)})` : ''}` }];
    case 'task.check':
      return typeof e.exitCode === 'number' ? [{ id: `kg-c-${at}`, at, kind: e.exitCode === 0 ? 'notice' : 'error', ...(e.exitCode === 0 ? { text: `Check passed${e.command ? `: ${s(e.command)}` : ''}` } : { text: `Check failed${e.command ? `: ${s(e.command)}` : ''}${e.outputTail ? `\n${tail(s(e.outputTail), DETAIL_MAX)}` : ''}`, retry: null }) } as WorkerFeedItem] : [];
    case 'task.report': {
      const r = (e.report ?? {}) as Record<string, unknown>;
      const text = s(r.summary) || s(r.answer) || s(r.text);
      return text ? [{ id: `kg-r-${at}`, at, kind: 'assistant', text: text.slice(0, TEXT_MAX), streaming: false }] : [];
    }
    case 'error':
      return [{ id: `kg-e-${at}`, at, kind: 'error', text: s(e.message).slice(0, DETAIL_MAX), retry: null }];
    default:
      return [];
  }
}
