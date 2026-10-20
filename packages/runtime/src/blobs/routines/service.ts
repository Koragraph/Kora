// RoutineService: the one object the runtime, the ui-server RPCs, the daemon and the self tools talk to. It owns the
// store, the engine and the webhook receiver, validates every write, and holds the permission rules for blobs changing
// routines (own = free + receipt + Undo; another blob's = Kora only, asks unless Full access; 20 active = asks).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { blobsStoreDir } from '../home';
import { RoutineEngine, type AttentionKind, type RoutineBridge } from './engine';
import { describeCadence, nextOccurrence, systemTimeZone, validateCadence } from './schedule';
import { RoutineStore, rid } from './store';
import { WebhookReceiver, hashSecret, newWebhookId, newWebhookSecret, webhookPort, webhookUrl } from './webhook';
import {
  AGENT_ASK_ACTIVE_ROUTINES, DEFAULT_RUN_LIMIT_MINUTES, LIVE_RUN, MAX_PROMPT_CHARS, MAX_TITLE_CHARS,
  type ResultsTarget, type Routine, type RoutineCadence, type RoutineConfirmCard, type RoutineRun, type WebhookTrigger,
} from './types';

export interface BlobLike { id: string; name: string; role: 'chief' | 'member'; archivedAt: number | null }
export interface BlobDirectoryLike { get(id: string): BlobLike | null; byName(name: string): BlobLike | null; list(o?: { includeArchived?: boolean }): BlobLike[] }

export interface RoutineServiceOptions {
  blobs: BlobDirectoryLike;
  bridge?: () => RoutineBridge | null;
  notify?: (blobId: string, kind: AttentionKind, routineTitle: string) => void;
  now?: () => number;
  log?: (msg: string) => void;
  /** Use a fixed receiver port (tests pass 0). Default: webhookPort(). */
  webhookPort?: number;
  receiver?: { rateLimit?: number; maxBodyBytes?: number };
}

export type Actor = { kind: 'user' } | { kind: 'blob'; blobId: string; fullAccess: boolean };

export interface RoutineInput {
  blobId: string;
  title: string;
  prompt: string;
  cadence: RoutineCadence;
  paused?: boolean;
  results?: ResultsTarget;
  rememberLastRun?: boolean;
  maxRunMinutes?: number | null;
  catchUp?: 'none' | 'one';
}
export type RoutinePatch = Partial<Omit<RoutineInput, 'blobId'>>;

export interface TriggerView { id: string; label: string; url: string; createdAt: number; rotatedAt: number | null; lastEventAt: number | null }
export interface RoutineView extends Omit<Routine, 'triggers'> {
  triggers: TriggerView[];
  nextRunAt: number | null;
  /** The live run, if any ("active" / "waiting" / "queued"). */
  live: RoutineRun | null;
  lastRun: RoutineRun | null;
}

export type Result<T> = { ok: true; value: T } | { ok: false; message: string };
const fail = <T = never>(message: string): Result<T> => ({ ok: false, message }) as Result<T>;
const good = <T>(value: T): Result<T> => ({ ok: true, value });

export interface UndoRow { token: string; blobId: string; routineId: string; op: 'create' | 'update' | 'delete'; before: Routine | null; what: string; at: number }
interface Pending { token: string; blobId: string; apply: () => Result<string>; at: number; card: RoutineConfirmCard }
const PENDING_TTL_MS = 60 * 60_000;

const normTitle = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const sameTitle = (a: string, b: string): boolean => normTitle(a) === normTitle(b) && normTitle(a) !== '';
/** A template suggestion (paused, never turned on) that a routine of the user's own with the same title makes redundant. */
export function isSupersededSuggestion<R extends Pick<Routine, 'id' | 'title' | 'createdBy' | 'paused'>>(r: R, all: readonly R[]): boolean {
  return r.createdBy === 'template' && r.paused && all.some((o) => o.id !== r.id && o.createdBy !== 'template' && sameTitle(o.title, r.title));
}

export class RoutineService extends EventEmitter {
  readonly store: RoutineStore;
  readonly engine: RoutineEngine;
  private receiver: WebhookReceiver | null = null;
  private now: () => number;
  private pending = new Map<string, Pending>();
  private journalMem = new Map<string, UndoRow>();
  private port: number;

  constructor(readonly o: RoutineServiceOptions) {
    super();
    this.now = o.now ?? Date.now;
    this.port = o.webhookPort ?? webhookPort();
    this.store = new RoutineStore({ blobIds: () => o.blobs.list({ includeArchived: true }).map((b) => b.id), now: this.now });
    this.engine = new RoutineEngine({
      store: this.store, bridge: o.bridge ?? (() => null), now: this.now, ...(o.log ? { log: o.log } : {}), ...(o.notify ? { notify: o.notify } : {}),
      blobActive: (id) => { const b = o.blobs.get(id); return !!b && b.archivedAt == null; },
    });
    this.engine.on('changed', (e) => this.emit('changed', e));
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────────────────────────────
  start(): void { this.engine.start(); }
  async stop(): Promise<void> { this.engine.stop(); await this.stopReceiver(); }

  async startReceiver(): Promise<{ port: number } | null> {
    if (this.receiver) return { port: this.receiver.address()?.port ?? this.port };
    const r = new WebhookReceiver({
      port: this.port, ...(this.o.receiver?.rateLimit ? { ratePerMinute: this.o.receiver.rateLimit } : {}), ...(this.o.receiver?.maxBodyBytes ? { maxBodyBytes: this.o.receiver.maxBodyBytes } : {}),
      now: this.now,
      lookup: (id) => { const hit = this.store.byWebhook(id); return hit ? { secretHash: hit.trigger.secretHash } : null; },
      onEvent: (id, body) => this.engine.fireWebhook(id, body),
    });
    try { const a = await r.start(); this.receiver = r; this.port = a.port; return { port: a.port }; }
    catch (e: any) { this.o.log?.(`[routines] webhook receiver could not start on ${this.port}: ${e?.code ?? e?.message ?? e}`); return null; }
  }
  async stopReceiver(): Promise<void> { const r = this.receiver; this.receiver = null; await r?.stop(); }
  status(): { webhookPort: number; receiverUp: boolean; baseUrl: string } { return { webhookPort: this.port, receiverUp: !!this.receiver, baseUrl: `http://127.0.0.1:${this.port}` }; }

  // ── reads ────────────────────────────────────────────────────────────────────────────────────────────
  view(r: Routine): RoutineView {
    const runs = this.store.runsForRoutine(r.id);
    const { triggers, ...rest } = r;
    return {
      ...rest, nextRunAt: r.paused ? null : nextOccurrence(r.cadence, Math.max(r.cursor, this.now() - 1)),
      live: runs.find((x) => LIVE_RUN.has(x.status)) ?? null, lastRun: runs.find((x) => !LIVE_RUN.has(x.status) && x.status !== 'missed') ?? null,
      triggers: triggers.map((t) => this.triggerView(t)),
    };
  }
  private triggerView(t: WebhookTrigger): TriggerView { return { id: t.id, label: t.label, url: webhookUrl(this.port, t.id), createdAt: t.createdAt, rotatedAt: t.rotatedAt, lastEventAt: t.lastEventAt }; }
  /** A template's paused suggestion is hidden once the blob has a routine of its own with the same title (live QA #3: two "Morning brief" rows). */
  list(blobId: string): RoutineView[] {
    const all = this.store.routinesOf(blobId);
    return all.filter((r) => !isSupersededSuggestion(r, all)).map((r) => this.view(r));
  }
  runs(blobId: string, limit = 100): RoutineRun[] { return this.store.runsOfBlob(blobId, limit).map((r) => ({ ...r, eventPayload: null })); }
  get(id: string): Routine | null { return this.store.get(id); }
  nameOf(blobId: string): string { return this.o.blobs.get(blobId)?.name ?? 'This blob'; }
  defaultTimeZone(): string { return systemTimeZone(); }

  // ── writes (validated) ───────────────────────────────────────────────────────────────────────────────
  /** null = this would be accepted. */
  check(i: { title: string; prompt: string; cadence: RoutineCadence; paused?: boolean; maxRunMinutes?: number | null }): string | null {
    const title = String(i.title ?? '').trim(), prompt = String(i.prompt ?? '').trim();
    if (!title) return 'A routine needs a title';
    if (title.length > MAX_TITLE_CHARS) return `The title is too long (max ${MAX_TITLE_CHARS} characters)`;
    if (!prompt) return 'A routine needs instructions for the run';
    if (prompt.length > MAX_PROMPT_CHARS) return `The instructions are too long (max ${MAX_PROMPT_CHARS} characters)`;
    const c = validateCadence(i.cadence); if (c) return c;
    if (i.cadence.kind === 'once' && i.cadence.at <= this.now() && !i.paused) return 'That time has already passed';
    const m = i.maxRunMinutes;
    if (m != null && (!Number.isFinite(m) || m < 1 || m > 7 * 1440)) return 'The run limit must be between 1 minute and 7 days';
    return null;
  }

  create(input: RoutineInput, by: Routine['createdBy'] = 'user'): Result<Routine> {
    const blob = this.o.blobs.get(input.blobId);
    if (!blob || blob.archivedAt != null) return fail('That blob is not available');
    const err = this.check(input); if (err) return fail(err);
    const now = this.now();
    // Creating "Morning brief" fulfils the template's suggestion of the same name: the suggestion goes (it never ran), so the list has one row.
    for (const twin of this.store.routinesOf(input.blobId)) {
      if (twin.createdBy === 'template' && twin.paused && sameTitle(twin.title, input.title) && !this.store.runsForRoutine(twin.id).length) this.store.remove(twin.id);
    }
    const cadence: RoutineCadence = input.cadence.kind === 'interval' ? { ...input.cadence, anchor: Math.floor(now / 60_000) * 60_000 } : input.cadence;
    const r: Routine = {
      id: rid('rt'), blobId: input.blobId, title: input.title.trim(), prompt: input.prompt.trim(), cadence, paused: input.paused === true,
      results: input.results ?? { mode: 'dedicated', threadId: null }, rememberLastRun: input.rememberLastRun === true, maxRunMinutes: input.maxRunMinutes === undefined ? DEFAULT_RUN_LIMIT_MINUTES : input.maxRunMinutes,
      catchUp: input.catchUp ?? (cadence.kind === 'interval' ? 'none' : 'one'), triggers: [], cursor: now, createdBy: by, skipped: 0, lastRunAt: null, suggestedCadence: null, createdAt: now, updatedAt: now,
    };
    this.store.put(r); this.emit('changed', { routineId: r.id, blobId: r.blobId });
    return good(r);
  }

  update(id: string, patch: RoutinePatch): Result<Routine> {
    const cur = this.store.get(id); if (!cur) return fail('No such routine');
    const next: Routine = { ...cur };
    if (patch.title !== undefined) next.title = patch.title.trim();
    if (patch.prompt !== undefined) next.prompt = patch.prompt.trim();
    if (patch.results !== undefined) next.results = patch.results;
    if (patch.rememberLastRun !== undefined) next.rememberLastRun = patch.rememberLastRun;
    if (patch.maxRunMinutes !== undefined) next.maxRunMinutes = patch.maxRunMinutes;
    if (patch.catchUp !== undefined) next.catchUp = patch.catchUp;
    if (patch.paused === false && cur.paused) next.failStreak = 0; // the user turned it back on after an auto-pause: a fresh count
    const cadenceChanged = patch.cadence !== undefined && JSON.stringify(patch.cadence) !== JSON.stringify(cur.cadence);
    if (patch.cadence !== undefined && cadenceChanged) {
      const sameRhythm = patch.cadence.kind === 'interval' && cur.cadence.kind === 'interval' && patch.cadence.everyMinutes === cur.cadence.everyMinutes;
      next.cadence = patch.cadence.kind === 'interval' ? { ...patch.cadence, anchor: sameRhythm ? cur.cadence.kind === 'interval' ? cur.cadence.anchor : this.now() : Math.floor(this.now() / 60_000) * 60_000 } : patch.cadence;
    }
    if (patch.paused !== undefined) next.paused = patch.paused;
    const err = this.check(next); if (err) return fail(err);
    // resuming, or a new rhythm, starts from now: no backlog of "missed" runs for time the routine was not running.
    if ((cur.paused && !next.paused) || cadenceChanged) next.cursor = this.now();
    this.store.put(next); this.emit('changed', { routineId: id, blobId: next.blobId });
    return good(next);
  }

  remove(id: string): Result<Routine> {
    const r = this.store.get(id); if (!r) return fail('No such routine');
    this.engine.cancelAllOf(id);
    // its finished runs' hidden threads go with it (the dated reports already in a results thread stay)
    void this.engine.deleteThreadsOf(this.store.removeRunsOf(id, r.blobId)).catch(() => {});
    this.store.remove(id); this.emit('changed', { routineId: id, blobId: r.blobId });
    return good(r);
  }

  /** What a cadence means, from the same engine that will run it: plain words (runtime wording) and the next three times. */
  preview(cadence: RoutineCadence): Result<{ words: string; next: number[] }> {
    const probe: RoutineCadence = cadence.kind === 'interval' ? { ...cadence, anchor: Math.floor(this.now() / 60_000) * 60_000 } : cadence;
    const err = validateCadence(probe); if (err) return fail(err);
    const next: number[] = []; let cur = this.now();
    for (let i = 0; i < 3; i++) { const n = nextOccurrence(probe, cur); if (n === null) break; next.push(n); cur = n; }
    return good({ words: describeCadence(probe), next });
  }

  /** The blob was deleted: stop its live runs and forget its routines without writing into the folder that is gone. */
  forgetBlob(blobId: string): void {
    // by blob, not by routine: the deleted blob is no longer in the directory that routine lookups walk
    for (const run of this.store.runsOfBlob(blobId, 1000)) {
      if (LIVE_RUN.has(run.status) && run.threadId) { try { void Promise.resolve(this.o.bridge?.()?.interrupt?.(run.threadId)).catch(() => {}); } catch { /* best effort */ } }
    }
    this.store.forget(blobId);
  }

  runNow(id: string) { return this.engine.runNow(id); }
  cancelRun(runId: string) { return this.engine.cancelRun(runId); }

  // ── webhook triggers ─────────────────────────────────────────────────────────────────────────────────
  /** The secret is returned here and nowhere else: it is not stored, only its hash. */
  createTrigger(routineId: string, label: string): Result<{ trigger: TriggerView; secret: string }> {
    const r = this.store.get(routineId); if (!r) return fail('No such routine');
    if (r.triggers.length >= 5) return fail('A routine can have up to 5 webhooks');
    const secret = newWebhookSecret();
    const t: WebhookTrigger = { id: newWebhookId(), label: String(label ?? '').trim().slice(0, 60) || 'Webhook', secretHash: hashSecret(secret), createdAt: this.now(), rotatedAt: null, lastEventAt: null };
    this.store.patch(routineId, { triggers: [...r.triggers, t] });
    this.emit('changed', { routineId, blobId: r.blobId });
    return good({ trigger: this.triggerView(t), secret });
  }
  rotateTrigger(routineId: string, triggerId: string): Result<{ trigger: TriggerView; secret: string }> {
    const r = this.store.get(routineId); const t = r?.triggers.find((x) => x.id === triggerId);
    if (!r || !t) return fail('No such webhook');
    const secret = newWebhookSecret();
    const next: WebhookTrigger = { ...t, secretHash: hashSecret(secret), rotatedAt: this.now() };
    this.store.patch(routineId, { triggers: r.triggers.map((x) => (x.id === triggerId ? next : x)) });
    this.emit('changed', { routineId, blobId: r.blobId });
    return good({ trigger: this.triggerView(next), secret });
  }
  deleteTrigger(routineId: string, triggerId: string): Result<true> {
    const r = this.store.get(routineId); if (!r || !r.triggers.some((x) => x.id === triggerId)) return fail('No such webhook');
    this.store.patch(routineId, { triggers: r.triggers.filter((x) => x.id !== triggerId) });
    this.emit('changed', { routineId, blobId: r.blobId });
    return good(true);
  }

  // ── blob-initiated changes: permission rules, receipts, Undo ─────────────────────────────────────────
  /** Who may touch `targetBlobId`'s routines, and does it need the user's OK. */
  gate(actor: Actor, targetBlobId: string, enabling: boolean): { allow: true } | { allow: false; refuse: string } | { allow: 'ask'; why: string } {
    if (actor.kind === 'user') return { allow: true };
    const caller = this.o.blobs.get(actor.blobId);
    if (!caller || caller.archivedAt != null) return { allow: false, refuse: 'unknown blob' };
    if (targetBlobId !== actor.blobId && caller.role !== 'chief') return { allow: false, refuse: 'You can only change your own routines. Ask Kora to change another blob\'s.' };
    if (enabling && this.store.activeCount(targetBlobId) >= AGENT_ASK_ACTIVE_ROUTINES) return { allow: 'ask', why: `${this.nameOf(targetBlobId)} already has ${this.store.activeCount(targetBlobId)} active routines` };
    // A routine spends the user's usage on a clock with nobody watching: an agent never arms one (itself or another's) on its own say-so.
    if (enabling && targetBlobId === actor.blobId) return { allow: 'ask', why: `${this.nameOf(targetBlobId)} wants to run this on a schedule` };
    if (targetBlobId === actor.blobId) return { allow: true };
    return actor.fullAccess ? { allow: true } : { allow: 'ask', why: `Changing ${this.nameOf(targetBlobId)}'s routines` };
  }

  /** Open an approval card for a change. `apply` runs only when the user confirms. */
  ask(blobId: string, summary: string, details: string[], apply: () => Result<string>): RoutineConfirmCard {
    this.sweepPending();
    const token = `rc_${crypto.randomBytes(8).toString('hex')}`;
    const card: RoutineConfirmCard = { cardKind: 'routine-confirm', cardId: rid('rcc'), version: 1, token, blobId, summary, details, state: 'open', result: null };
    this.pending.set(token, { token, blobId, apply, at: this.now(), card });
    return card;
  }
  /** The user's answer on a confirm card. Returns the card to show next. */
  confirm(token: string, accept: boolean): Result<RoutineConfirmCard> {
    this.sweepPending();
    const p = this.pending.get(token);
    if (!p) return fail('This request expired. Ask again.');
    this.pending.delete(token);
    if (!accept) return good({ ...p.card, version: p.card.version + 1, state: 'dismissed', result: null });
    const r = p.apply();
    return good({ ...p.card, version: p.card.version + 1, state: r.ok ? 'confirmed' : 'failed', result: r.ok ? r.value : r.message });
  }
  private sweepPending(): void { const n = this.now(); for (const [k, p] of this.pending) if (n - p.at > PENDING_TTL_MS) this.pending.delete(k); }

  private undoFile() { return path.join(blobsStoreDir(), 'routine-undo.jsonl'); }
  journal(e: Omit<UndoRow, 'token' | 'at'>): UndoRow {
    const row: UndoRow = { ...e, token: `undo_rt_${crypto.randomBytes(6).toString('hex')}`, at: this.now() };
    try { fs.mkdirSync(path.dirname(this.undoFile()), { recursive: true }); fs.appendFileSync(this.undoFile(), JSON.stringify(row) + '\n'); } catch { /* the receipt still works this session */ }
    this.journalMem.set(row.token, row);
    return row;
  }
  private undoRows(): any[] {
    try { return fs.readFileSync(this.undoFile(), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
  }
  /** Tokens this service issued (the runtime routes `undo_rt_*` here). */
  ownsUndo(token: string): boolean { return token.startsWith('undo_rt_'); }
  isUndone(token: string): boolean { return this.undoRows().some((r) => r.done === token); }
  async undo(token: string): Promise<boolean> {
    if (!this.ownsUndo(token) || this.isUndone(token)) return false;
    const row: UndoRow | undefined = this.journalMem.get(token) ?? this.undoRows().find((r) => r.token === token);
    if (!row) return false;
    if (row.op === 'create') { const r = this.remove(row.routineId); if (!r.ok) return false; }
    else if (row.before) {
      const cur = this.store.get(row.routineId);
      // Undoing an edit never resurrects an older webhook secret: triggers stay as they are now.
      const restored: Routine = { ...row.before, triggers: cur ? cur.triggers : row.before.triggers, cursor: this.now() };
      this.store.put(restored); this.emit('changed', { routineId: row.routineId, blobId: row.blobId });
    } else return false;
    try { fs.appendFileSync(this.undoFile(), JSON.stringify({ done: token, at: this.now() }) + '\n'); } catch { /* ok */ }
    return true;
  }
}
