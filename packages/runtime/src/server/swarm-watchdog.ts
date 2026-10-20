// Watchdog for slow or silent swarm workers (found live: nemotron takes 10+ min, or goes idle without its report).
//
//   T1 (swarm.watchdog.nudgeAfterMs, default 8 min)   no report yet → one nudge: finish the current step, write the
//                                                     report now.
//   T2 (swarm.watchdog.reassignAfterMs, default 15 m) still no report → reassign: kill the worker and respawn the task
//                                                     on a FASTER model in the same worktree (failover reason 'stalled').
//                                                     A worker that made progress in the last minute gets until 1.5×T2.
//   idle without a report                             SwarmService nudges once after 20 s; still idle and reportless
//                                                     2 min later → reassign (the "skipped its report" case).
//   paid model over its per-task cap                  stop: a last "write your report now" + kill after a grace period.
// Progress = the newest OpenCode message/part of the worker's session (its DB, read-only) or, when that can't be read,
// the pane's last output. The decision is a pure function; SwarmService runs it on a 15 s tick.
import fs from 'node:fs';
import { opencodeDbPath } from './swarm-usage';
import { partToStep } from './swarm-step';
import type { SwarmStep } from '../protocol/types';
import { log } from './log';

export interface WatchdogSettings { nudgeAfterMs: number; reassignAfterMs: number }
export const WATCHDOG_DEFAULTS: WatchdogSettings = { nudgeAfterMs: 8 * 60_000, reassignAfterMs: 15 * 60_000 };
/** Progress this recent at T2 buys a worker time, up to 1.5 × T2. */
export const ACTIVE_GRACE_MS = 60_000;
/** Working with no model progress at all this long (a free model's stream that died mid-reply: found live 2026-10-19,
 *  the TUI kept its spinner for 15 min) → reassign without waiting for T2 (4 min: live runs showed free models that go quiet never come back; a test run is ≤90 s). Far past a check's 90 s budget. */
export const SILENT_STREAM_MS = 4 * 60_000;
/** Idle with no report this long after the automatic idle nudge → reassign. */
export const IDLE_NO_REPORT_MS = 2 * 60_000;
/** After the budget stop's last nudge, the worker is killed this much later. */
export const BUDGET_GRACE_MS = 90_000;

export interface WatchdogInput {
  now: number;
  /** This attempt's launch time. */ attemptStartedAt: number;
  /** Newest progress signal (≥ attemptStartedAt). */ lastProgressAt: number;
  hasReport: boolean;
  /** The verify/bounce pipeline owns the task (report in, gate running or bounced). */ inVerify: boolean;
  /** When the confirmed-idle-without-report state began (null = working). */ idleSince: number | null;
  /** SwarmService's own idle nudge was sent for this task. */ idleNudged: boolean;
  /** This attempt already got the T1 nudge. */ wdNudged: boolean;
  /** Paid model spend so far on this task (USD), and its cap (0 = none). */ spentUsd?: number; capUsd?: number;
  /** The budget stop was sent at (null = not yet; < 0 = already killed). */ budgetStopAt?: number | null;
  settings: WatchdogSettings;
}
export type WatchdogAction =
  | { kind: 'none' }
  | { kind: 'nudge'; elapsedMs: number }
  | { kind: 'reassign'; why: 'slow' | 'no-report' }
  | { kind: 'budget-stop' }
  | { kind: 'budget-kill' };

/** Pure. One action per tick, most urgent first. */
export function watchdogDecision(i: WatchdogInput): WatchdogAction {
  if (i.capUsd && i.capUsd > 0 && (i.spentUsd ?? 0) >= i.capUsd) {
    if (i.budgetStopAt == null) return { kind: 'budget-stop' };
    // A report written after the stop goes through verify as usual; a worker that ignores the stop is killed.
    if (!i.hasReport && i.budgetStopAt >= 0 && i.now - i.budgetStopAt >= BUDGET_GRACE_MS) return { kind: 'budget-kill' };
    return { kind: 'none' };
  }
  if (i.hasReport || i.inVerify) return { kind: 'none' };
  const { nudgeAfterMs: t1, reassignAfterMs: t2 } = i.settings;
  const elapsed = i.now - i.attemptStartedAt;
  if (i.idleSince != null && i.idleNudged && i.now - i.idleSince >= IDLE_NO_REPORT_MS) return { kind: 'reassign', why: 'no-report' };
  if (i.idleSince == null && elapsed >= SILENT_STREAM_MS && i.now - i.lastProgressAt >= SILENT_STREAM_MS) return { kind: 'reassign', why: 'slow' };
  if (t2 > 0 && elapsed >= t2) {
    const active = i.idleSince == null && i.now - i.lastProgressAt < ACTIVE_GRACE_MS;
    if (!active || elapsed >= t2 * 1.5) return { kind: 'reassign', why: 'slow' };
  }
  if (t1 > 0 && !i.wdNudged && elapsed >= t1 && i.idleSince == null) return { kind: 'nudge', elapsedMs: elapsed };
  return { kind: 'none' };
}

/**
 * Koragent workers (event-driven) are never killed first. A 'reassign' decision becomes, in order:
 *   1. escalate — an in-session steer (source kora, delivery steer: "wrap up, report now") plus `model.reject` of the
 *      current model, so Koragent's route moves to its next model at the step boundary (same pane, same session);
 *   2. wait     — KORAGENT_ESCALATE_GRACE_MS for that to land (a route.failover / model.switch restarts the clock);
 *   3. respawn  — only then the OpenCode-style last resort: kill the pane and respawn on a faster model.
 */
export const KORAGENT_ESCALATE_GRACE_MS = 3 * 60_000;
export function koragentStallStep(i: { now: number; escalatedAt: number | null; graceMs?: number }): 'escalate' | 'wait' | 'respawn' {
  if (i.escalatedAt == null) return 'escalate';
  return i.now - i.escalatedAt < (i.graceMs ?? KORAGENT_ESCALATE_GRACE_MS) ? 'wait' : 'respawn';
}
export function koragentStallText(reportPath: string, elapsedMs: number, model: string): string {
  const min = Math.max(1, Math.round(elapsedMs / 60_000));
  return `Kora: this task has run ${min} min on ${model} without finishing. Stop exploring: finish the edit you are on, run the check once, and call task_report now (report path ${reportPath}). Anything unfinished goes in Blockers.`;
}

export function watchdogNudgeText(reportPath: string, elapsedMs: number): string {
  const min = Math.max(1, Math.round(elapsedMs / 60_000));
  return `Kora: you have been on this task for ${min} min. Finish the step you are on, then write your report to ${reportPath} now (what you changed, how you verified it, what is left). Keep it short; do not start anything new.`;
}
export function budgetStopText(reportPath: string, spentUsd: number, capUsd: number): string {
  return `Kora: this task has used its spend cap ($${spentUsd.toFixed(3)} of $${capUsd.toFixed(2)}). Stop now and write your report to ${reportPath} (what you changed, what is left). Do not make any more model calls after that.`;
}

// ---- OpenCode progress + spend (its session DB, read-only) --------------------------------------------------------------

export interface WorkerActivity { lastAt: number; costUsd: number }

/**
 * Newest message/part time and summed cost of the root OpenCode sessions under each worktree since `sinceMs`. One
 * indexed read-only query per tick for every live worker (sub-millisecond on a 35 MB DB; the session table is small).
 * A DB that can't be opened, or a query slower than 250 ms, turns this off for 10 min: the pane's output is the
 * fallback signal. Never throws.
 */
export class OpencodeActivity {
  private db: any = null;
  private offUntil = 0;
  constructor(private readonly dbPath: string = opencodeDbPath()) {}

  read(dirs: { dir: string; sinceMs: number }[], now = Date.now()): Map<string, WorkerActivity> {
    const out = new Map<string, WorkerActivity>();
    if (!dirs.length || now < this.offUntil) return out;
    const origEmit = process.emitWarning; (process as any).emitWarning = () => {}; // node:sqlite is "experimental"
    try {
      if (!this.db) {
        if (!fs.existsSync(this.dbPath)) { this.offUntil = now + 60_000; return out; }
        const { DatabaseSync } = require('node:sqlite');
        this.db = new DatabaseSync(this.dbPath, { readOnly: true, timeout: 100 });
      }
      const t0 = Date.now();
      // Progress = the MODEL's output: the newest assistant message or part (parts update while it streams). Not the
      // session row or a user message, which Kora's own nudge writes (found live 2026-10-19: each nudge reset the clock
      // on a stream that had been dead for 8 min).
      const q = this.db.prepare(`select s.id as id, s.cost as cost, s.time_created as updated,
          max(coalesce((select max(m.time_updated) from message m where m.session_id = s.id and json_extract(m.data, '$.role') = 'assistant'), 0),
              coalesce((select max(p.time_updated) from part p join message m on m.id = p.message_id where p.session_id = s.id and json_extract(m.data, '$.role') = 'assistant'), 0)) as msg
        from session s where s.parent_id is null and (s.directory = ? or s.directory like ? escape '\\') and s.time_created >= ?`);
      for (const { dir, sinceMs } of dirs) {
        const like = `${dir.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`;
        let lastAt = 0, costUsd = 0;
        // OpenCode records the symlink-resolved folder (/private/var/… for a /var/… worktree), so look under both forms.
        let real = dir; try { real = fs.realpathSync(dir); } catch { /* a swept worktree */ }
        const seen = new Set<string>();
        for (const d of real === dir ? [dir] : [dir, real]) {
          const dlike = d === dir ? like : `${real.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`;
          for (const r of q.all(d, dlike, sinceMs - 60_000) as any[]) {
            if (seen.has(String(r.id))) continue;
            seen.add(String(r.id));
            lastAt = Math.max(lastAt, Number(r.updated) || 0, Number(r.msg) || 0);
            costUsd += Number(r.cost) || 0;
          }
        }
        if (lastAt) out.set(dir, { lastAt, costUsd });
      }
      const ms = Date.now() - t0;
      if (ms > 250) { log(`swarm: opencode activity read took ${ms} ms — off for 10 min (pane output is the fallback)`); this.offUntil = now + 10 * 60_000; this.close(); }
    } catch (e: any) {
      log(`swarm: opencode activity unavailable (${e?.message ?? e}) — pane output is the fallback`);
      this.offUntil = now + 10 * 60_000;
      this.close();
    } finally { (process as any).emitWarning = origEmit; }
    return out;
  }

  /**
   * The newest step (thought bubble) of each worktree's root OpenCode sessions, from the newest `text` / `reasoning`
   * / `tool` part across them since `sinceMs` (assistant-authored only — a user-turn `text` part never counts).
   * Same DB handle and off-switch as `read()`. Every requested dir gets an entry (`null` when it has no matching
   * part yet, or the DB itself is unreachable); the map is empty only when the DB read is off (rate-limited after
   * a slow query, or unopenable). Never throws.
   */
  /**
   * `match` narrows to the session whose user prompt contains that text — assistant-lane workers share one folder,
   * so the directory alone cannot tell them apart; their prompt names their own `scratch/<taskId>/` report path.
   * Results are keyed by `key` (default: `dir`).
   */
  readSteps(dirs: { dir: string; sinceMs: number; match?: string; key?: string }[], now = Date.now()): Map<string, SwarmStep | null> {
    const out = new Map<string, SwarmStep | null>();
    if (!dirs.length || now < this.offUntil) return out;
    const origEmit = process.emitWarning; (process as any).emitWarning = () => {}; // node:sqlite is "experimental"
    try {
      if (!this.db) {
        if (!fs.existsSync(this.dbPath)) { this.offUntil = now + 60_000; return out; }
        const { DatabaseSync } = require('node:sqlite');
        this.db = new DatabaseSync(this.dbPath, { readOnly: true, timeout: 100 });
      }
      const t0 = Date.now();
      const q = this.db.prepare(`select p.data as pdata, p.time_created as pt
          from part p join message m on m.id = p.message_id join session s on s.id = p.session_id
          where s.parent_id is null and (s.directory = ? or s.directory like ? escape '\\') and s.time_created >= ?
            and json_extract(m.data, '$.role') = 'assistant' and json_extract(p.data, '$.type') in ('text', 'reasoning', 'tool')
            and (? = '' or exists (select 1 from part up join message um on um.id = up.message_id
                  where up.session_id = s.id and json_extract(um.data, '$.role') = 'user' and instr(coalesce(json_extract(up.data, '$.text'), ''), ?) > 0))
          order by p.time_created desc limit 1`);
      for (const { dir, sinceMs, match, key } of dirs) {
        const like = `${dir.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`;
        let step: SwarmStep | null = null;
        try {
          const row = q.get(dir, like, sinceMs - 60_000, match ?? '', match ?? '') as { pdata: string; pt: number } | undefined;
          if (row) { try { step = partToStep(JSON.parse(row.pdata), Number(row.pt) || now); } catch { step = null; } }
        } catch { step = null; }
        out.set(key ?? dir, step);
      }
      const ms = Date.now() - t0;
      if (ms > 250) { log(`swarm: opencode step read took ${ms} ms — off for 10 min (steps go blank)`); this.offUntil = now + 10 * 60_000; this.close(); }
    } catch (e: any) {
      log(`swarm: opencode step unavailable (${e?.message ?? e}) — steps go blank`);
      this.offUntil = now + 10 * 60_000;
      this.close();
    } finally { (process as any).emitWarning = origEmit; }
    return out;
  }

  close(): void { try { this.db?.close?.(); } catch { /* gone */ } this.db = null; }
}
