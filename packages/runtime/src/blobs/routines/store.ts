// Routine persistence. Definitions: <blobHome>/routines.json (the file starter templates already write, paused, in the
// short {title, cadence-text, paused} shape; those entries are upgraded on load). Run receipts: <blobHome>/routine-runs.jsonl,
// append-only, the newest row for a run id wins; compacted on load. Everything is synchronous and never throws.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { blobHome } from '../home';
import { writeFileAtomic } from '../store';
import { parseCadenceText, systemTimeZone, timesIn } from './schedule';
import { DEFAULT_RUN_LIMIT_MINUTES, LIVE_RUN, type Routine, type RoutineCadence, type RoutineRun, type WebhookTrigger } from './types';

export const rid = (prefix: string) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
const RUN_KEEP_PER_BLOB = 200;
const RUN_COMPACT_AT = 600;

function upgrade(blobId: string, raw: any, now: number): Routine | null {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title ?? '').trim();
  if (!title) return null;
  if (raw.id && raw.cadence && typeof raw.cadence === 'object') return normalize(blobId, raw, now);
  // a starter template's suggestion: paused, prompt derived from the title
  const text = typeof raw.cadence === 'string' ? raw.cadence : '';
  const parsed: RoutineCadence | null = parseCadenceText(text);
  return {
    id: rid('rt'), blobId, title, prompt: typeof raw.prompt === 'string' && raw.prompt.trim() ? raw.prompt.trim().slice(0, 8000) : `Do this routine: ${title}. Use what you know about me and the tools you have, and keep the report short.`,
    cadence: parsed ?? { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00', tz: systemTimeZone() },
    paused: true, results: { mode: 'dedicated', threadId: null }, rememberLastRun: false, maxRunMinutes: DEFAULT_RUN_LIMIT_MINUTES, catchUp: 'one', triggers: [],
    cursor: now, skipped: 0, lastRunAt: null, createdAt: now, updatedAt: now, createdBy: 'template',
    // the template's own words only when the schedule could not be mapped exactly (several times with different minutes)
    suggestedCadence: text && (!parsed || (parsed.kind === 'weekly' && timesIn(text) > 1)) ? text : null,
  };
}

function normalize(blobId: string, r: any, now: number): Routine {
  const triggers: WebhookTrigger[] = Array.isArray(r.triggers) ? r.triggers.filter((t: any) => t && typeof t.id === 'string' && typeof t.secretHash === 'string').map((t: any) => ({
    id: t.id, label: String(t.label ?? 'Webhook'), secretHash: t.secretHash, createdAt: Number(t.createdAt) || now, rotatedAt: t.rotatedAt ?? null, lastEventAt: t.lastEventAt ?? null,
  })) : [];
  return {
    id: String(r.id), blobId, title: String(r.title), prompt: String(r.prompt ?? ''), cadence: r.cadence as RoutineCadence, paused: r.paused === true,
    results: r.results?.mode === 'thread' && typeof r.results.threadId === 'string' ? { mode: 'thread', threadId: r.results.threadId } : { mode: 'dedicated', threadId: typeof r.results?.threadId === 'string' ? r.results.threadId : null },
    rememberLastRun: r.rememberLastRun === true, maxRunMinutes: Number.isFinite(r.maxRunMinutes) && r.maxRunMinutes > 0 ? Number(r.maxRunMinutes) : null,
    catchUp: r.catchUp === 'none' ? 'none' : 'one', triggers, cursor: Number(r.cursor) || now, skipped: Number(r.skipped) || 0, failStreak: Number(r.failStreak) > 0 ? Math.floor(Number(r.failStreak)) : 0, lastRunAt: r.lastRunAt ?? null,
    createdAt: Number(r.createdAt) || now, updatedAt: Number(r.updatedAt) || now,
    createdBy: ['user', 'self', 'kora', 'template'].includes(r.createdBy) ? r.createdBy : 'user', suggestedCadence: typeof r.suggestedCadence === 'string' ? r.suggestedCadence : null,
  };
}

export interface RoutineStoreOptions { blobIds: () => string[]; now?: () => number; homeOf?: (blobId: string) => string }

export class RoutineStore {
  private defs = new Map<string, Routine[]>();
  private runs = new Map<string, Map<string, RoutineRun>>();
  private runLines = new Map<string, number>();
  private dirty = new Set<string>();
  private now: () => number;
  private homeOf: (blobId: string) => string;
  constructor(private o: RoutineStoreOptions) { this.now = o.now ?? Date.now; this.homeOf = o.homeOf ?? blobHome; }

  private defFile(blobId: string) { return path.join(this.homeOf(blobId), 'routines.json'); }
  private runFile(blobId: string) { return path.join(this.homeOf(blobId), 'routine-runs.jsonl'); }

  routinesOf(blobId: string): Routine[] {
    let list = this.defs.get(blobId);
    if (!list) {
      list = [];
      let upgraded = false;
      try {
        const parsed = JSON.parse(fs.readFileSync(this.defFile(blobId), 'utf8'));
        for (const raw of Array.isArray(parsed?.routines) ? parsed.routines : []) {
          const r = upgrade(blobId, raw, this.now());
          if (r) { list.push(r); if (!raw.id) upgraded = true; }
        }
      } catch { /* none yet */ }
      this.defs.set(blobId, list);
      if (upgraded) this.persist(blobId);
    }
    return list;
  }
  /** Drop everything cached for a blob that no longer exists (nothing is written: its folder is gone). */
  forget(blobId: string): void { this.defs.delete(blobId); this.runs.delete(blobId); this.runLines.delete(blobId); this.dirty.delete(blobId); }
  all(): Routine[] { return this.o.blobIds().flatMap((id) => this.routinesOf(id)); }
  get(id: string): Routine | null { return this.all().find((r) => r.id === id) ?? null; }
  byWebhook(webhookId: string): { routine: Routine; trigger: WebhookTrigger } | null {
    for (const routine of this.all()) { const trigger = routine.triggers.find((t) => t.id === webhookId); if (trigger) return { routine, trigger }; }
    return null;
  }
  activeCount(blobId: string): number { return this.routinesOf(blobId).filter((r) => !r.paused).length; }

  /** Insert or replace by id (keeps the object you pass, so callers holding it see later patches). */
  put(r: Routine): Routine {
    const list = this.routinesOf(r.blobId);
    const i = list.findIndex((x) => x.id === r.id);
    r.updatedAt = this.now();
    if (i >= 0) list[i] = r; else list.push(r);
    this.persist(r.blobId);
    return r;
  }
  /** Change fields on the stored routine in place. `persist: false` only marks it dirty (the engine's cursor heartbeat). */
  patch(id: string, p: Partial<Routine>, persist = true): Routine | null {
    const r = this.get(id); if (!r) return null;
    Object.assign(r, p);
    if (persist) this.persist(r.blobId); else this.dirty.add(r.blobId);
    return r;
  }
  patchTrigger(routineId: string, triggerId: string, p: Partial<WebhookTrigger>): void {
    const t = this.get(routineId)?.triggers.find((x) => x.id === triggerId);
    if (t) { Object.assign(t, p); this.dirty.add(this.get(routineId)!.blobId); }
  }
  /** Write everything marked dirty. */
  flush(): void { for (const b of [...this.dirty]) this.persist(b); }
  remove(id: string): Routine | null {
    const r = this.get(id); if (!r) return null;
    const list = this.routinesOf(r.blobId);
    list.splice(list.findIndex((x) => x.id === id), 1);
    this.persist(r.blobId);
    return r;
  }
  private persist(blobId: string): void {
    this.dirty.delete(blobId);
    try { writeFileAtomic(this.defFile(blobId), JSON.stringify({ routines: this.defs.get(blobId) ?? [] }, null, 2) + '\n'); } catch { /* disk trouble must not stop the tick */ }
  }

  // ── runs ───────────────────────────────────────────────────────────────────────────────────────────
  private runsOf(blobId: string): Map<string, RoutineRun> {
    let m = this.runs.get(blobId);
    if (!m) {
      m = new Map();
      let lines = 0;
      try {
        for (const l of fs.readFileSync(this.runFile(blobId), 'utf8').split('\n')) {
          if (!l) continue; lines++;
          try { const r = JSON.parse(l) as RoutineRun; if (r?.id) m.set(r.id, r); } catch { /* torn line */ }
        }
      } catch { /* none yet */ }
      this.runs.set(blobId, m); this.runLines.set(blobId, lines);
      if (lines > RUN_COMPACT_AT) this.compact(blobId);
    }
    return m;
  }
  private compact(blobId: string): void {
    const m = this.runs.get(blobId); if (!m) return;
    const keep = [...m.values()].sort((a, b) => b.updatedAt - a.updatedAt).filter((r, i) => i < RUN_KEEP_PER_BLOB || LIVE_RUN.has(r.status));
    m.clear(); for (const r of keep.reverse()) m.set(r.id, r);
    try { writeFileAtomic(this.runFile(blobId), [...m.values()].map((r) => JSON.stringify(r)).join('\n') + '\n'); this.runLines.set(blobId, m.size); } catch { /* retry next load */ }
  }
  putRun(run: RoutineRun): RoutineRun {
    const next = { ...run, updatedAt: this.now() };
    this.runsOf(run.blobId).set(next.id, next);
    try { fs.mkdirSync(this.homeOf(run.blobId), { recursive: true }); fs.appendFileSync(this.runFile(run.blobId), JSON.stringify(next) + '\n'); this.runLines.set(run.blobId, (this.runLines.get(run.blobId) ?? 0) + 1); } catch { /* the in-memory copy still serves this session */ }
    return next;
  }
  getRun(id: string): RoutineRun | null { for (const b of this.o.blobIds()) { const r = this.runsOf(b).get(id); if (r) return r; } return null; }
  runsForRoutine(routineId: string): RoutineRun[] {
    const r = this.get(routineId); if (!r) return [];
    return [...this.runsOf(r.blobId).values()].filter((x) => x.routineId === routineId).sort((a, b) => b.dueAt - a.dueAt || b.updatedAt - a.updatedAt);
  }
  runsOfBlob(blobId: string, limit = 100): RoutineRun[] {
    return [...this.runsOf(blobId).values()].sort((a, b) => b.dueAt - a.dueAt || b.updatedAt - a.updatedAt).slice(0, limit);
  }
  liveRuns(): RoutineRun[] { return this.o.blobIds().flatMap((b) => [...this.runsOf(b).values()].filter((r) => LIVE_RUN.has(r.status))); }
  runByThread(threadId: string): RoutineRun | null { for (const b of this.o.blobIds()) for (const r of this.runsOf(b).values()) if (r.threadId === threadId) return r; return null; }
  /** Forget every run of a routine (it was deleted). Returns them, so the caller can clean up their hidden threads. */
  removeRunsOf(routineId: string, blobId: string): RoutineRun[] {
    const m = this.runsOf(blobId);
    const gone: RoutineRun[] = [];
    for (const [id, r] of m) if (r.routineId === routineId) { gone.push(r); m.delete(id); }
    this.rewriteRuns(blobId);
    return gone;
  }
  private rewriteRuns(blobId: string): void {
    const m = this.runsOf(blobId);
    try { writeFileAtomic(this.runFile(blobId), [...m.values()].map((r) => JSON.stringify(r)).join('\n') + (m.size ? '\n' : '')); this.runLines.set(blobId, m.size); } catch { /* receipts are advisory */ }
  }
  /**
   * Keep the newest `keep` FINISHED runs of a routine; older finished ones are forgotten and returned (a live or queued run
   * is never touched). The caller deletes the hidden threads behind the returned runs.
   */
  pruneRuns(routineId: string, keep: number): RoutineRun[] {
    const r = this.get(routineId); if (!r) return [];
    const finished = this.runsForRoutine(routineId).filter((x) => !LIVE_RUN.has(x.status));
    const drop = finished.slice(Math.max(0, keep));
    if (drop.length === 0) return [];
    const m = this.runsOf(r.blobId);
    for (const x of drop) m.delete(x.id);
    this.rewriteRuns(r.blobId);
    return drop;
  }
  /** Drop cached state (tests / after the blob folder changed on disk). */
  reset(): void { this.defs.clear(); this.runs.clear(); this.runLines.clear(); this.dirty.clear(); }
}
