// Persistence for chat threads (§01 §8) — plain filesystem, no DB (matches kora's lightweight style).
//
//   ~/.kora/chat/
//     index.json                 # thread heads for chat.thread.list
//     <threadId>/
//       meta.json                # ChatThreadInfo + resume cursor + lastSeq
//       events.ndjson            # append-only ChatEvent log (one JSON per line, seq-ordered)
//
// The EVENT LOG is the source of truth. The transcript is a fold over
// events.ndjson; chat.events.backfill streams from it. `seq` is a gap-free per-thread counter
// assigned here on append. Archive-not-delete is the safe default; hard delete is separate and
// user-confirmed (never agent-initiated).
import fs from 'node:fs';
import path from 'node:path';
import { koraHome } from '../protocol/types';
import { isSafePathSegment } from '../util/safe-path';
import { isFleetAgentMode, type ChatEvent, type ChatThreadInfo, type ThreadAgentMode, type ThreadId } from './events';

/** Persisted per-thread meta: the thread head plus the provider resume cursor (§5). */
export interface ThreadMeta extends ChatThreadInfo {
  /** Opaque provider resume cursor (Claude session_id, etc.), updated on thread.started/turn.settled. */
  resume?: unknown;
  /** The permission mode last picked for this thread (SessionManager.setPermissionMode) — survives a restart. */
  runtimeMode?: import('./events').RuntimeMode;
  /** A mode switch not yet delivered to the agent (SessionManager.setAgentMode sets it, takeModeNotice clears it). */
  pendingModeNotice?: import('./events').PendingModeNotice | null;
  /** The mode the agent was last told about (a flip back to it before delivery cancels the notice). */
  announcedAgentMode?: import('./events').ThreadAgentMode;
  /** "Don't ask again in this thread" in the worker picker: the lead's proposed workers are approved as-is. */
  autoApproveWorkers?: boolean;
  /** The worker pane this hidden thread runs (server/driver-pane.ts): never listed, never shown in the sidebar. */
  workerPaneId?: string | null;
  /** Auto model: what the composer's "Auto" pick resolved to for this thread (sticky; escalated = moved up once). */
  autoModel?: { model: string; reason: string; escalated?: boolean; stuck?: boolean; lead?: boolean; advisor?: string; big?: boolean; /** picked because a plan window was tight (Auto's plan headroom) */ headroom?: boolean } | null;
}

const AGENT_MODES: readonly ThreadAgentMode[] = ['chat', 'orchestrator', 'swarm'];

/**
 * Back-fill a meta.json read from disk (the migration is on READ, never a rewrite pass):
 *  - `agentMode` — written before swarm existed, only `isOrchestrator` is there: true ⇒ 'orchestrator', else 'chat'.
 *    An unknown value (a newer daemon's mode) falls back to the legacy flag, so a stale store never gains fleet
 *    tools it did not have.
 *  - `isOrchestrator` — always re-derived (`isFleetAgentMode(agentMode)`); the gates keep reading it.
 *  - `announcedAgentMode` — what the agent was last told; defaults to the notice's `from` when one is pending,
 *    else to the current mode (a legacy thread's agent already knows its mode).
 */
export function normalizeMeta(raw: ThreadMeta): ThreadMeta {
  const m = raw as ThreadMeta & { agentMode?: unknown };
  const agentMode: ThreadAgentMode = AGENT_MODES.includes(m.agentMode as ThreadAgentMode)
    ? (m.agentMode as ThreadAgentMode)
    : (m.isOrchestrator ? 'orchestrator' : 'chat');
  const pendingModeNotice = raw.pendingModeNotice ?? null;
  const announcedAgentMode: ThreadAgentMode = AGENT_MODES.includes(raw.announcedAgentMode as ThreadAgentMode)
    ? raw.announcedAgentMode!
    : (pendingModeNotice ? pendingModeNotice.from : agentMode);
  return { ...raw, agentMode, isOrchestrator: isFleetAgentMode(agentMode), pendingModeNotice, announcedAgentMode };
}

const uid = (): string => `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export class ChatThreadStore {
  readonly root: string;
  // In-memory seq high-water mark per thread so append is O(1) and gap-free even under bursts.
  private seqHwm = new Map<ThreadId, number>();
  // Threads whose log ends in a torn line (a crash or a full disk mid-append): the next append starts a new line, or
  // it would be glued onto the torn bytes and lost with them (deep audit 2026-10-13 A2-6).
  private tornTail = new Set<ThreadId>();

  constructor(root?: string) {
    this.root = root ?? path.join(koraHome(), 'chat');
    // Chat transcripts are the user's conversations (pasted code, keys typed by mistake): owner-only.
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  /**
   * The thread's directory. The id arrives over the wire (chat.thread.delete etc.), so it must be ONE path segment:
   * an id of "", "." or ".." joined onto the root used to name the chat root, ~/.kora or $HOME itself — and delete()
   * removes the directory recursively.
   */
  private threadDir(id: ThreadId): string {
    if (!isSafePathSegment(id)) throw new Error(`invalid thread id: ${JSON.stringify(String(id)).slice(0, 80)}`);
    return path.join(this.root, id);
  }
  private metaPath(id: ThreadId): string { return path.join(this.threadDir(id), 'meta.json'); }
  private eventsPath(id: ThreadId): string { return path.join(this.threadDir(id), 'events.ndjson'); }

  // ── thread heads ────────────────────────────────────────────────────────────
  create(input: {
    agent: ChatThreadInfo['agent']; cwd: string; account?: string | null;
    model?: ChatThreadInfo['model']; isOrchestrator?: boolean; title?: string; worktree?: string | null;
    /** Wins over `isOrchestrator` (kept for old callers). */
    agentMode?: ThreadAgentMode;
    /** Set by SessionManager.create for a thread born in swarm (the first turn carries it). */
    pendingModeNotice?: ThreadMeta['pendingModeNotice'];
    workerPaneId?: string | null;
  }): ThreadMeta {
    const now = Date.now();
    const id = uid();
    const agentMode: ThreadAgentMode = input.agentMode ?? (input.isOrchestrator ? 'orchestrator' : 'chat');
    const pendingModeNotice = input.pendingModeNotice ?? null;
    const meta: ThreadMeta = {
      id,
      title: input.title?.trim() || 'New thread',
      agent: input.agent,
      cwd: input.cwd,
      account: input.account ?? null,
      model: input.model ?? null,
      isOrchestrator: isFleetAgentMode(agentMode),
      agentMode,
      pendingModeNotice,
      announcedAgentMode: pendingModeNotice ? pendingModeNotice.from : agentMode,
      state: 'idle',
      createdAt: now,
      updatedAt: now,
      lastSeq: 0,
      workerPaneIds: [],
      archived: false,
      worktree: input.worktree ?? null,
      ...(input.workerPaneId ? { workerPaneId: input.workerPaneId } : {}),
    };
    fs.mkdirSync(this.threadDir(id), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.eventsPath(id), '');
    this.writeMeta(meta);
    this.seqHwm.set(id, 0);
    return meta;
  }

  has(id: ThreadId): boolean { return isSafePathSegment(id) && fs.existsSync(this.metaPath(id)); }

  get(id: ThreadId): ThreadMeta {
    const raw = fs.readFileSync(this.metaPath(id), 'utf8');
    let parsed: ThreadMeta;
    try { parsed = JSON.parse(raw) as ThreadMeta; } catch { return this.recoverMeta(id); }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.cwd !== 'string') return this.recoverMeta(id);
    return normalizeMeta(parsed);
  }

  /**
   * A meta.json that is empty or not JSON (a crash or a full disk mid-write) made every later turn of the thread fail
   * with a bare "Unexpected end of JSON input" (found 2026-10-04). Rebuild the head from index.json (title, agent,
   * folder) and the event log (seq, the Claude session to resume), keep the damaged bytes aside, and carry on: the
   * thread's own settings (model, mode) fall back to the defaults. Without an index entry there is nothing to rebuild
   * from, so say that plainly instead.
   */
  private recoverMeta(id: ThreadId): ThreadMeta {
    const file = this.metaPath(id);
    let head: { id: string; title?: string; agent?: ChatThreadInfo['agent']; cwd?: string; account?: string | null; updatedAt?: number; archived?: boolean } | undefined;
    try {
      const index = JSON.parse(fs.readFileSync(path.join(this.root, 'index.json'), 'utf8')) as unknown;
      head = Array.isArray(index) ? (index as typeof head[]).find((h) => h?.id === id) : undefined;
    } catch { /* no usable index */ }
    if (!head || typeof head.cwd !== 'string' || !head.agent) {
      throw new Error(`This thread's saved state is damaged (${file}) and cannot be rebuilt. Start a new thread in this project; this conversation stays readable here.`);
    }
    let resume: string | undefined;
    try {
      for (const line of fs.readFileSync(this.eventsPath(id), 'utf8').split('\n')) {
        if (!line.includes('"thread.started"')) continue;
        try { const ev = JSON.parse(line) as { type?: string; providerThreadId?: string }; if (ev.type === 'thread.started' && ev.providerThreadId) resume = ev.providerThreadId; } catch { /* skip a bad line */ }
      }
    } catch { /* no event log */ }
    const now = Date.now();
    const meta: ThreadMeta = {
      id,
      title: head.title?.trim() || 'Recovered thread',
      agent: head.agent,
      cwd: head.cwd,
      account: head.account ?? null,
      model: null,
      isOrchestrator: false,
      agentMode: 'chat',
      pendingModeNotice: null,
      announcedAgentMode: 'chat',
      state: 'idle',
      createdAt: head.updatedAt ?? now,
      updatedAt: now,
      lastSeq: this.lastSeq(id),
      workerPaneIds: [],
      archived: !!head.archived,
      worktree: null,
      ...(resume ? { resume } : {}),
    };
    try { fs.renameSync(file, `${file}.damaged-${now}`); } catch { /* the rewrite below replaces it anyway */ }
    this.writeMeta(meta);
    console.error(`[kora] chat thread ${id}: meta.json was damaged; rebuilt it from index.json and the event log (the damaged copy is kept beside it)`);
    return meta;
  }

  tryGet(id: ThreadId): ThreadMeta | null {
    try { return this.get(id); } catch { return null; }
  }

  private writeMeta(meta: ThreadMeta): void {
    // Write meta atomically (tmp + rename) so a crash mid-write never leaves a truncated head.
    const p = this.metaPath(meta.id);
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
    fs.renameSync(tmp, p);
    this.writeIndex();
  }

  /** Merge a patch into the thread head and persist. Returns the updated meta. */
  update(id: ThreadId, patch: Partial<ThreadMeta>): ThreadMeta {
    const meta = this.get(id);
    const next: ThreadMeta = { ...meta, ...patch, id: meta.id, updatedAt: Date.now() };
    this.writeMeta(next);
    return next;
  }

  rename(id: ThreadId, title: string): ThreadMeta { return this.update(id, { title: title.trim() || 'Untitled' }); }
  archive(id: ThreadId): ThreadMeta { return this.update(id, { archived: true }); }
  unarchive(id: ThreadId): ThreadMeta { return this.update(id, { archived: false }); }

  /** Hard delete — removes the whole thread directory. User-confirmed only; never agent-initiated. */
  delete(id: ThreadId): void {
    const dir = this.threadDir(id); // throws on an id that is not one plain path segment
    this.seqHwm.delete(id);
    // Never follow a symlinked thread dir out of the store: unlink the link itself, keep whatever it pointed at.
    let st: fs.Stats | null = null; try { st = fs.lstatSync(dir); } catch { st = null; }
    if (st?.isSymbolicLink()) fs.unlinkSync(dir);
    else fs.rmSync(dir, { recursive: true, force: true });
    this.writeIndex();
  }

  /** All non-deleted thread heads, newest-updated first. Archived threads included (caller filters). */
  list(): ChatThreadInfo[] {
    let ids: string[] = [];
    try { ids = fs.readdirSync(this.root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { ids = []; }
    const out: ChatThreadInfo[] = [];
    for (const id of ids) { const m = this.tryGet(id); if (m) out.push(m); }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  }

  /**
   * index.json is a convenience mirror (list() reads the thread dirs), yet rebuilding it reads and parses EVERY thread's
   * meta.json — and the head is updated on every streamed chat event. Measured on a 113-thread store: 1.5 ms of
   * synchronous work per delta, growing with the thread count, all of it on the daemon's event loop. Coalesce: at most
   * one rebuild per second.
   */
  private indexTimer: NodeJS.Timeout | null = null;
  private writeIndex(): void {
    if (this.indexTimer) return;
    this.indexTimer = setTimeout(() => { this.indexTimer = null; this.flushIndex(); }, 1000);
    this.indexTimer.unref();
  }
  /** Rebuild index.json now (tests; a caller that wants the mirror current). */
  flushIndex(): void {
    if (this.indexTimer) { clearTimeout(this.indexTimer); this.indexTimer = null; }
    const heads: Array<{ id: string; title: string; agent: ChatThreadInfo['agent']; cwd: string; account: string | null; updatedAt: number; archived: boolean }> = this.list().map((t) => ({ id: t.id, title: t.title, agent: t.agent, cwd: t.cwd, account: t.account, updatedAt: t.updatedAt, archived: !!t.archived }));
    // A thread whose meta.json cannot be read right now keeps its previous head: the index is what recoverMeta rebuilds
    // it from, so dropping the entry on the next rewrite would make the damage permanent.
    try {
      const seen = new Set(heads.map((h) => h.id));
      const prev = JSON.parse(fs.readFileSync(path.join(this.root, 'index.json'), 'utf8')) as unknown;
      for (const h of Array.isArray(prev) ? (prev as typeof heads) : []) {
        if (h && isSafePathSegment(h.id) && !seen.has(h.id) && fs.existsSync(this.metaPath(h.id))) heads.push(h);
      }
    } catch { /* no previous index */ }
    try {
      const p = path.join(this.root, 'index.json');
      const tmp = `${p}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(heads, null, 2));
      fs.renameSync(tmp, p);
    } catch { /* index is a convenience mirror; list() reads dirs directly */ }
  }

  // ── event log (the source of truth) ───────────────────────────────────────────
  /** Highest seq persisted for this thread (0 when none). Reads the last ndjson line lazily once. */
  lastSeq(id: ThreadId): number {
    const cached = this.seqHwm.get(id);
    if (cached !== undefined) return cached;
    let n = 0;
    try {
      const raw = fs.readFileSync(this.eventsPath(id), 'utf8');
      if (raw.length && !raw.endsWith('\n')) this.tornTail.add(id);
      const lines = raw.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try { n = (JSON.parse(line) as ChatEvent).seq; break; } catch { /* skip bad line */ }
      }
    } catch { n = 0; }
    this.seqHwm.set(id, n);
    return n;
  }

  /**
   * Assign the next gap-free seq, stamp `at` (if unset), append to the log, and return the sealed
   * event. This is the ONLY place seq is minted, so the counter is monotonic and gap-free per thread.
   */
  append(id: ThreadId, event: Omit<ChatEvent, 'seq'> & { seq?: number }): ChatEvent {
    const seq = this.lastSeq(id) + 1;
    const sealed = { ...event, threadId: id, seq, at: event.at ?? Date.now() } as ChatEvent;
    const torn = this.tornTail.has(id);
    try { fs.appendFileSync(this.eventsPath(id), (torn ? '\n' : '') + JSON.stringify(sealed) + '\n'); }
    catch (e) { this.tornTail.add(id); throw e; } // a write that failed part-way (ENOSPC) may have left a torn line
    if (torn) this.tornTail.delete(id);
    this.seqHwm.set(id, seq);
    return sealed;
  }

  /** Replay cursor: events with seq > sinceSeq, up to `limit`, in order. The backfill path (§5). */
  read(id: ThreadId, sinceSeq = 0, limit = Infinity): { events: ChatEvent[]; nextSeq: number } {
    let raw = '';
    try { raw = fs.readFileSync(this.eventsPath(id), 'utf8'); } catch { return { events: [], nextSeq: sinceSeq }; }
    const events: ChatEvent[] = [];
    let nextSeq = sinceSeq;
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let ev: ChatEvent;
      try { ev = JSON.parse(t) as ChatEvent; } catch { continue; }
      if (ev.seq <= sinceSeq) { nextSeq = Math.max(nextSeq, ev.seq); continue; }
      if (events.length >= limit) break;
      events.push(ev);
      nextSeq = ev.seq;
    }
    return { events, nextSeq };
  }
}
