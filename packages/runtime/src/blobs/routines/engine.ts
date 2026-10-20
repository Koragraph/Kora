// The routine executor. One tick (30 s, unref'd) decides what is due for every routine; a run is a hidden execution thread
// started through an injected bridge; its settle event moves the receipt and posts the dated report to the results thread.
//
//   - a routine never overlaps itself: a due tick while a run is live is skipped (counted, not queued);
//   - occurrences the daemon slept through become `missed` receipts; at most ONE catch-up run per routine starts on wake (if the
//     routine allows it and the miss is recent) and at most MAX_CATCH_UPS_PER_TICK across all routines per tick, never a burst;
//   - spending guards: MAX_CONCURRENT_RUNS live at once, MAX_RUNS_PER_BLOB_PER_DAY unattended runs per blob, and a routine
//     whose last AUTO_PAUSE_AFTER_FAILURES runs all failed is paused;
//   - webhook events share this executor: they queue (at most MAX_QUEUED_EVENTS per routine) and run one after another.
import { EventEmitter } from 'node:events';
import { buildRunPrompt, stamp } from './prompt';
import { nextOccurrence, occurrencesBetween } from './schedule';
import { rid, type RoutineStore } from './store';
import { AUTO_PAUSE_AFTER_FAILURES, LIVE_RUN, MAX_CATCH_UPS_PER_TICK, MAX_CONCURRENT_RUNS, MAX_QUEUED_EVENTS, MAX_RUNS_PER_BLOB_PER_DAY, MIN_INTERVAL_MINUTES, type Routine, type RoutineReportCard, type RoutineRun, type RunSource } from './types';

export const TICK_MS = 30_000;
/** An occurrence this fresh counts as "on time" (tick jitter); anything older was slept through. */
export const GRACE_MS = 2 * TICK_MS + 5_000;
export const CATCH_UP_WINDOW_MS = 6 * 3_600_000;
export const QUEUE_TTL_MS = 30 * 60_000;
const REPORT_CAP = 6000;
/** Finished runs (and their hidden threads) kept per routine; the dated reports in the results thread are not touched. */
export const RUNS_KEPT_PER_ROUTINE = 50;
const MAX_MISSED_RECORDED = 10;

export interface HiddenThreadOrigin { kind: 'routine'; jobId: string | null; stepId: string | null; fromThreadId: string | null; fromBlobId: string | null; routineId: string; runId: string }

/** What the ui-server provides. `startHiddenThread` must create a thread that never shows in the sidebar / thread list. */
export interface RoutineBridge {
  startHiddenThread(p: { blobId: string; title: string; prompt: string; origin: HiddenThreadOrigin }): Promise<{ threadId: string } | { refused: 'busy' | 'archived' | 'unknown' }>;
  snapshot(threadId: string): { state: 'running' | 'idle' | 'needs-you' | 'error'; finalText: string | null; outputs: string[] } | null;
  interrupt?(threadId: string): void | Promise<void>;
  /** A visible thread to hold reports for "Create a dedicated results thread". Returns its id. */
  createResultsThread(p: { blobId: string; title: string }): Promise<{ threadId: string } | null>;
  threadExists?(threadId: string): boolean;
  /**
   * Delete a finished routine run's hidden thread (retention). Must refuse (false) for anything that is not a hidden routine
   * thread, or that is still running / waiting on an answer. Absent: threads are kept.
   */
  deleteHiddenThread?(threadId: string): Promise<boolean>;
  /** Append the dated report card to the results thread. false = could not post. */
  postReport(resultsThreadId: string, card: RoutineReportCard): Promise<boolean>;
  onSettled(cb: (e: { threadId: string; blobId: string; ok: boolean }) => void): () => void;
}

export type AttentionKind = 'needs-you' | 'settled' | 'failed';
export interface EngineOptions {
  store: RoutineStore;
  bridge: () => RoutineBridge | null;
  /** The blob exists and is not archived. */
  blobActive: (blobId: string) => boolean;
  notify?: (blobId: string, kind: AttentionKind, routineTitle: string) => void;
  now?: () => number;
  log?: (msg: string) => void;
  tickMs?: number;
}

export type WebhookFire = { status: 'accepted'; runId: string; queued: boolean } | { status: 'paused' | 'unknown' | 'queue-full' | 'unavailable' };

export class RoutineEngine extends EventEmitter {
  private store: RoutineStore;
  private now: () => number;
  private log: (m: string) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private unsubscribe: (() => void) | null = null;
  private lastPersist = 0;
  private notified = new Set<string>();
  private catchUpsThisTick = 0;

  constructor(private o: EngineOptions) {
    super();
    this.store = o.store; this.now = o.now ?? Date.now; this.log = o.log ?? (() => {});
  }

  /** Start ticking. Safe to call twice. The first pass runs at once: that is the "daemon was off" catch-up. */
  start(): void {
    if (this.timer) return;
    this.attachBridge();
    void this.reconcile().then(() => this.sweepRetention()).then(() => this.tick()).catch((e) => this.log(`[routines] start failed: ${e?.message ?? e}`));
    this.timer = setInterval(() => { void this.tick().catch((e) => this.log(`[routines] tick failed: ${e?.message ?? e}`)); }, this.o.tickMs ?? TICK_MS);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null; this.unsubscribe?.(); this.unsubscribe = null;
    this.persistCursors(this.now());
  }
  /** Subscribe to settles once a bridge exists (called by start and by the service when the engine attaches late). */
  attachBridge(): void {
    if (this.unsubscribe) return;
    const b = this.o.bridge(); if (!b) return;
    this.unsubscribe = b.onSettled((e) => { void this.serial(() => this.settle(e.threadId)).catch((err) => this.log(`[routines] settle failed: ${err?.message ?? err}`)); });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }
  private changed(routineId: string | null, blobId?: string): void { this.emit('changed', { routineId, blobId: blobId ?? null }); }

  // ── the tick ─────────────────────────────────────────────────────────────────────────────────────────
  tick(): Promise<void> { return this.serial(() => this.tickNow(this.now())); }

  private async tickNow(now: number): Promise<void> {
    this.attachBridge();
    this.catchUpsThisTick = 0;
    for (const r of [...this.store.all()]) {
      if (r.paused || !this.o.blobActive(r.blobId)) { if (r.paused) this.advanceQuiet(r, now); continue; }
      await this.evaluate(r, now);
    }
    await this.startQueued(now);
    await this.watchdog(now);
    this.persistCursors(now);
  }

  /** A paused routine accrues no missed runs: its cursor just follows the clock (in memory; persisted lazily). */
  private advanceQuiet(r: Routine, now: number): void { this.store.patch(r.id, { cursor: now }, false); }

  private async evaluate(r: Routine, now: number): Promise<void> {
    const { recent, total } = occurrencesBetween(r.cadence, r.cursor, now, MAX_MISSED_RECORDED + 1);
    if (total === 0) { this.store.patch(r.id, { cursor: now }, false); return; }
    const already = new Set(this.store.runsForRoutine(r.id).map((x) => x.dueAt));
    const fresh = recent.filter((t) => !already.has(t));
    const onTime = fresh.filter((t) => now - t <= GRACE_MS);
    const late = fresh.filter((t) => now - t > GRACE_MS);
    const newestLate = late.length ? late[late.length - 1]! : null;
    let candidate = onTime.length ? onTime[onTime.length - 1]! : (r.catchUp === 'one' && newestLate !== null && now - newestLate <= CATCH_UP_WINDOW_MS ? newestLate : null);
    // The 5-minute floor holds for rules saved before it covered custom cron (`* * * * *`): a run that would start within
    // MIN_INTERVAL_MINUTES of the last one is skipped quietly (pl7 S2-5).
    if (candidate !== null && r.cadence.kind === 'cron' && r.lastRunAt && now - r.lastRunAt < MIN_INTERVAL_MINUTES * 60_000) candidate = null;
    const source: RunSource = onTime.length ? 'schedule' : 'catch-up';
    // after a long sleep every routine is behind at once: start a couple per tick and let the rest follow (the cursor stays, they are still in the window)
    if (candidate !== null && source === 'catch-up' && this.catchUpsThisTick >= MAX_CATCH_UPS_PER_TICK) return;
    if (candidate !== null && source === 'catch-up') this.catchUpsThisTick++;
    // Everything slept through becomes a "missed" receipt, except the one occurrence that runs. The oldest receipt
    // summarises any earlier ones we did not keep.
    const droppedCount = Math.max(0, total - recent.length);
    const missedTimes = late.filter((t) => t !== candidate);
    missedTimes.forEach((t, i) => this.store.putRun(this.newRun(r, 'missed', 'schedule', t, { endedAt: now, reason: i === 0 && droppedCount ? `Kora was not running (and ${droppedCount} earlier ones)` : 'Kora was not running at this time' })));
    // an on-time occurrence that is not the candidate cannot exist (we take the newest); older on-time ones are dropped silently.
    const patch: Partial<Routine> = { cursor: now };
    if (candidate !== null) {
      if (this.liveRunOf(r.id)) patch.skipped = r.skipped + 1;
      else await this.startRun(r, candidate, source, null);
    }
    if (r.cadence.kind === 'once') patch.paused = true;
    this.store.patch(r.id, patch);
    this.changed(r.id, r.blobId);
  }

  /** Runs of this blob that actually started in the last 24 h (not the one being decided). */
  private startedInLastDay(blobId: string, exceptRunId: string): number {
    const since = this.now() - 24 * 3_600_000;
    return this.store.runsOfBlob(blobId, 1000).filter((x) => x.id !== exceptRunId && x.source !== 'manual' && x.startedAt != null && x.startedAt >= since).length;
  }
  /** Runs with a live execution thread right now, across every blob (not counting `exceptRunId`). */
  private liveThreadRuns(exceptRunId: string): number {
    return this.store.liveRuns().filter((x) => x.id !== exceptRunId && x.threadId && (x.status === 'active' || x.status === 'waiting')).length;
  }

  private liveRunOf(routineId: string): RoutineRun | null { return this.store.runsForRoutine(routineId).find((x) => LIVE_RUN.has(x.status)) ?? null; }

  private newRun(r: Routine, status: RoutineRun['status'], source: RunSource, dueAt: number, extra: Partial<RoutineRun> = {}): RoutineRun {
    return {
      id: rid('run'), routineId: r.id, blobId: r.blobId, title: r.title, status, source, dueAt, startedAt: null, endedAt: null, threadId: null, koraThreadId: null,
      resultsThreadId: null, report: null, reason: null, outputs: [], webhookId: null, eventPayload: null, updatedAt: this.now(), ...extra,
    };
  }

  // ── starting runs ────────────────────────────────────────────────────────────────────────────────────
  private async startRun(r: Routine, dueAt: number, source: RunSource, ev: { webhookId: string; payload: string } | null, existing?: RoutineRun): Promise<RoutineRun> {
    let run = existing ?? this.store.putRun(this.newRun(r, 'queued', source, dueAt, ev ? { webhookId: ev.webhookId, eventPayload: ev.payload } : {}));
    if (run.source !== 'manual') {
      // an unattended run spends the user's usage with nobody watching: a per-blob daily budget, and a global cap on live runs
      if (!run.threadId && this.startedInLastDay(r.blobId, run.id) >= MAX_RUNS_PER_BLOB_PER_DAY) return this.close(run, 'missed', `Daily run budget reached (${MAX_RUNS_PER_BLOB_PER_DAY} unattended runs in 24 hours)`);
      if (this.liveThreadRuns(run.id) >= MAX_CONCURRENT_RUNS) return run; // stays queued; startQueued retries each tick until QUEUE_TTL_MS
    }
    this.attachBridge();
    const bridge = this.o.bridge();
    if (!bridge) return run; // stays queued until the engine has a bridge
    const trig = run.webhookId ? r.triggers.find((t) => t.id === run.webhookId) : null;
    const prev = r.rememberLastRun ? this.store.runsForRoutine(r.id).find((x) => x.id !== run.id && x.status === 'completed' && x.report) : null;
    const prompt = buildRunPrompt({
      routine: r, now: this.now(), source: run.source,
      previous: prev ? { report: prev.report, at: prev.endedAt } : null,
      webhook: run.webhookId ? { label: trig?.label ?? 'Webhook', payload: run.eventPayload ?? '', receivedAt: run.dueAt } : null,
    });
    const tz = 'tz' in r.cadence ? r.cadence.tz : undefined;
    let res: Awaited<ReturnType<RoutineBridge['startHiddenThread']>>;
    try {
      res = await bridge.startHiddenThread({
        blobId: r.blobId, title: `${r.title} · ${stamp(run.dueAt, tz)}`, prompt,
        origin: { kind: 'routine', jobId: null, stepId: null, fromThreadId: null, fromBlobId: null, routineId: r.id, runId: run.id },
      });
    } catch (e: any) { res = { refused: 'unknown' }; this.log(`[routines] start failed for ${r.id}: ${e?.message ?? e}`); }
    if ('refused' in res) {
      if (res.refused === 'busy') return run; // stays queued; retried each tick until QUEUE_TTL_MS
      return this.close(run, 'failed', res.refused === 'archived' ? 'This blob is retired' : 'Could not start the run');
    }
    run = this.store.putRun({ ...run, status: 'active', startedAt: this.now(), threadId: res.threadId });
    this.store.patch(r.id, { lastRunAt: this.now() });
    this.changed(r.id, r.blobId);
    return run;
  }

  private async startQueued(now: number): Promise<void> {
    for (const run of this.store.liveRuns().filter((x) => x.status === 'queued').sort((a, b) => a.dueAt - b.dueAt)) {
      const r = this.store.get(run.routineId);
      if (!r || !this.o.blobActive(r.blobId)) { this.close(run, 'cancelled', 'The routine or its blob is gone'); continue; }
      if (now - run.dueAt > QUEUE_TTL_MS) { this.close(run, 'missed', 'It stayed busy for too long'); continue; }
      const busy = this.store.runsForRoutine(r.id).some((x) => x.id !== run.id && (x.status === 'active' || x.status === 'waiting'));
      if (busy) continue;
      if (!run.threadId) await this.startRun(r, run.dueAt, run.source, null, run);
    }
  }

  private async watchdog(now: number): Promise<void> {
    for (const run of this.store.liveRuns()) {
      if (run.status === 'queued' || !run.threadId) continue;
      const r = this.store.get(run.routineId);
      const max = r?.maxRunMinutes;
      if (!r || !max || !run.startedAt || now - run.startedAt < max * 60_000) continue;
      try { await this.o.bridge()?.interrupt?.(run.threadId); } catch { /* best effort */ }
      await this.finish(run, 'failed', `Stopped after ${max} minutes (this routine's run limit)`);
    }
  }

  /** After a restart: a live run whose thread no longer exists has failed. */
  reconcile(): Promise<void> {
    return this.serial(async () => {
      const b = this.o.bridge(); if (!b) return;
      for (const run of this.store.liveRuns()) {
        if (!run.threadId) continue;
        const snap = b.snapshot(run.threadId);
        if (!snap) { this.close(run, 'failed', 'Kora restarted and the run was lost'); continue; }
        if (snap.state !== 'running') await this.settle(run.threadId);
      }
    });
  }

  // ── settling ─────────────────────────────────────────────────────────────────────────────────────────
  private async settle(threadId: string): Promise<void> {
    const run = this.store.runByThread(threadId);
    if (!run || !LIVE_RUN.has(run.status)) return;
    const snap = this.o.bridge()?.snapshot(threadId) ?? null;
    if (!snap) { this.close(run, 'failed', 'The run thread is gone'); return; }
    if (snap.state === 'running') { if (run.status === 'waiting') { this.store.putRun({ ...run, status: 'active' }); this.changed(run.routineId, run.blobId); } return; }
    if (snap.state === 'needs-you') {
      if (run.status !== 'waiting') {
        this.store.putRun({ ...run, status: 'waiting' }); this.changed(run.routineId, run.blobId);
        if (!this.notified.has(run.id)) { this.notified.add(run.id); this.o.notify?.(run.blobId, 'needs-you', run.title); }
      }
      return;
    }
    await this.finish(run, snap.state === 'error' ? 'failed' : 'completed', snap.state === 'error' ? 'The run hit an error' : null, snap);
  }

  private close(run: RoutineRun, status: RoutineRun['status'], reason: string | null): RoutineRun {
    const next = this.store.putRun({ ...run, status, reason, endedAt: this.now(), eventPayload: null });
    this.changed(run.routineId, run.blobId);
    return next;
  }

  private async finish(run: RoutineRun, status: 'completed' | 'failed', reason: string | null, snap?: { finalText: string | null; outputs: string[] } | null): Promise<void> {
    const s = snap ?? this.o.bridge()?.snapshot(run.threadId ?? '') ?? null;
    const text = (s?.finalText ?? '').trim();
    const report = status === 'completed' ? (text || 'The run finished without writing a report.') : (text || reason || 'The run failed.');
    const outputs = s?.outputs ?? [];
    let closed = this.close({ ...run, report: report.slice(0, REPORT_CAP), outputs }, status, reason);
    const r = this.store.get(run.routineId);
    if (r) {
      const posted = await this.postReport(r, closed);
      if (posted) closed = this.store.putRun({ ...closed, resultsThreadId: posted });
      else closed = this.store.putRun({ ...closed, reason: [closed.reason, 'Could not post the report'].filter(Boolean).join(' · ') });
    }
    this.notified.delete(run.id);
    if (r) {
      const streak = status === 'failed' ? (r.failStreak ?? 0) + 1 : 0;
      const pause = streak >= AUTO_PAUSE_AFTER_FAILURES && !r.paused;
      this.store.patch(r.id, { failStreak: streak, ...(pause ? { paused: true } : {}) });
      if (pause) { this.log(`[routines] ${r.id} paused after ${streak} failed runs in a row`); this.o.notify?.(run.blobId, 'failed', `${run.title} paused after ${AUTO_PAUSE_AFTER_FAILURES} failed runs`); }
    }
    this.o.notify?.(run.blobId, status === 'failed' ? 'failed' : 'settled', run.title);
    await this.prune(run.routineId);
    this.changed(run.routineId, run.blobId);
  }

  /** Retention: older finished runs go, with their hidden threads (a thread that cannot be deleted right now is retried next time). */
  async prune(routineId: string, keep = RUNS_KEPT_PER_ROUTINE): Promise<number> {
    const dropped = this.store.pruneRuns(routineId, keep);
    await this.deleteThreadsOf(dropped);
    return dropped.length;
  }
  /** The hidden threads behind `runs`, deleted best-effort (never throws; a run that is gone is gone). */
  async deleteThreadsOf(runs: ReadonlyArray<RoutineRun>): Promise<void> {
    const b = this.o.bridge();
    if (!b?.deleteHiddenThread) return;
    for (const run of runs) {
      if (!run.threadId) continue;
      try { await b.deleteHiddenThread(run.threadId); } catch (e: any) { this.log(`[routines] could not delete ${run.threadId}: ${e?.message ?? e}`); }
    }
  }
  /** The once-per-start sweep: trims every routine's history (threads from before retention existed included). */
  private async sweepRetention(): Promise<void> {
    for (const r of [...this.store.all()]) await this.prune(r.id);
  }

  /** Post the dated report. Returns the results thread id, or null when nothing could be posted. */
  private async postReport(r: Routine, run: RoutineRun): Promise<string | null> {
    const b = this.o.bridge(); if (!b) return null;
    let target = r.results.threadId;
    if (target && b.threadExists && !b.threadExists(target)) target = null; // the user deleted it
    if (!target) {
      const made = await b.createResultsThread({ blobId: r.blobId, title: `${r.title} · results` }).catch(() => null);
      if (!made) return null;
      target = made.threadId;
      this.store.patch(r.id, { results: { mode: 'dedicated', threadId: target } });
    }
    const card: RoutineReportCard = {
      cardKind: 'routine-report', cardId: rid('rr'), version: 1, routineId: r.id, runId: run.id, blobId: r.blobId, title: r.title,
      status: run.status === 'completed' ? 'completed' : run.status === 'cancelled' ? 'cancelled' : 'failed', ranAt: run.endedAt ?? this.now(),
      text: run.report ?? '', outputs: run.outputs, executionThreadId: run.threadId, resultsThreadId: target,
    };
    const ok = await b.postReport(target, card).catch(() => false);
    return ok ? target : null;
  }

  // ── asked-for runs ───────────────────────────────────────────────────────────────────────────────────
  /** "Run now": ignores the schedule, refuses while a run is live. */
  runNow(routineId: string): Promise<{ ok: true; runId: string } | { ok: false; reason: string }> {
    return this.serial(async () => {
      const r = this.store.get(routineId);
      if (!r) return { ok: false as const, reason: 'No such routine' };
      if (!this.o.blobActive(r.blobId)) return { ok: false as const, reason: 'This blob is retired' };
      if (this.liveRunOf(r.id)) return { ok: false as const, reason: 'A run is already in progress' };
      const run = await this.startRun(r, this.now(), 'manual', null);
      return { ok: true as const, runId: run.id };
    });
  }

  /** A webhook event for a trigger. The body is stored untrusted and fenced into the prompt when the run starts. */
  fireWebhook(webhookId: string, payload: string): Promise<WebhookFire> {
    return this.serial(async () => {
      const hit = this.store.byWebhook(webhookId);
      if (!hit) return { status: 'unknown' as const };
      const { routine: r } = hit;
      if (r.paused || !this.o.blobActive(r.blobId)) return { status: 'paused' as const };
      const live = this.store.runsForRoutine(r.id).filter((x) => LIVE_RUN.has(x.status));
      if (live.filter((x) => x.status === 'queued').length >= MAX_QUEUED_EVENTS) return { status: 'queue-full' as const };
      this.store.patchTrigger(r.id, webhookId, { lastEventAt: this.now() });
      const run = live.length === 0
        ? await this.startRun(r, this.now(), 'webhook', { webhookId, payload })
        : this.store.putRun(this.newRun(r, 'queued', 'webhook', this.now(), { webhookId, eventPayload: payload }));
      this.changed(r.id, r.blobId);
      return { status: 'accepted' as const, runId: run.id, queued: run.status === 'queued' };
    });
  }

  cancelRun(runId: string): Promise<boolean> {
    return this.serial(async () => {
      const run = this.store.getRun(runId);
      if (!run || !LIVE_RUN.has(run.status)) return false;
      if (run.threadId) { try { await this.o.bridge()?.interrupt?.(run.threadId); } catch { /* best effort */ } }
      this.close(run, 'cancelled', 'Stopped by you');
      return true;
    });
  }

  /** Cancel every live run of a routine right now (before it is deleted). Synchronous so the caller can delete straight after. */
  cancelAllOf(routineId: string): void {
    for (const run of this.store.runsForRoutine(routineId).filter((x) => LIVE_RUN.has(x.status))) {
      if (run.threadId) { try { void Promise.resolve(this.o.bridge()?.interrupt?.(run.threadId)).catch(() => {}); } catch { /* best effort */ } }
      this.close(run, 'cancelled', 'The routine was deleted');
    }
  }

  /** The next time this routine will fire, or null (paused, finished, impossible rule). */
  nextRunAt(r: Routine): number | null { return r.paused ? null : nextOccurrence(r.cadence, Math.max(r.cursor, this.now() - 1)); }

  // ── persistence of cursors ───────────────────────────────────────────────────────────────────────────
  private persistCursors(now: number): void {
    if (now - this.lastPersist < 5 * 60_000 && this.timer) return;
    this.lastPersist = now;
    this.store.flush();
  }
}
