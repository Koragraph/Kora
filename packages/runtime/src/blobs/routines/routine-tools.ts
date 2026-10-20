// The routine self tools: list_routines, schedule_routine, change_routine (FleetToolSpecs, agent-neutral like the other
// blob tools). A blob ARMING a routine (its own, or as Kora another's) asks the user first - a routine spends usage on a clock with nobody
// watching - and leaves a one-line receipt with Undo once approved. Pausing / editing / deleting its own is free. Kora may change
// another blob's, but that asks unless the thread has Full access; any other blob is refused. Enabling a 6th active routine
// always asks. Handlers re-read the caller from the store (nothing trusts the prompt) and never throw.
import crypto from 'node:crypto';
import type { FleetToolResult, FleetToolSpec } from '../../session/fleet-tools';
import type { BlobToolContext } from '../types';
import { describeCadence, isValidTimeZone, systemTimeZone, wallToEpoch, wallParts } from './schedule';
import type { Actor, BlobLike, RoutinePatch, RoutineService, Result } from './service';
import type { Routine, RoutineCadence } from './types';

const ok = (text: string): FleetToolResult => ({ text });
const bad = (text: string): FleetToolResult => ({ text, isError: true });
const cardId = (p: string) => `${p}_${crypto.randomBytes(5).toString('hex')}`;

export interface RoutineToolContext extends BlobToolContext {
  /** True when this thread runs with Full access. */
  fullAccess?: () => boolean;
}

const DAY_WORDS: Record<string, number[]> = {
  sun: [0], sunday: [0], mon: [1], monday: [1], tue: [2], tues: [2], tuesday: [2], wed: [3], wednesday: [3], thu: [4], thur: [4], thurs: [4], thursday: [4],
  fri: [5], friday: [5], sat: [6], saturday: [6], weekdays: [1, 2, 3, 4, 5], weekday: [1, 2, 3, 4, 5], weekends: [0, 6], weekend: [0, 6], daily: [0, 1, 2, 3, 4, 5, 6], everyday: [0, 1, 2, 3, 4, 5, 6],
};

/** The cadence a tool call describes, or an error string. Exactly one of every_minutes / days+time / cron / once_at. */
export function cadenceFromArgs(a: Record<string, unknown>, tzDefault = systemTimeZone()): RoutineCadence | string {
  const tz = typeof a.timezone === 'string' && a.timezone.trim() ? a.timezone.trim() : tzDefault;
  if (!isValidTimeZone(tz)) return `Unknown time zone "${tz}". Use an IANA name like America/New_York.`;
  const kinds = [a.every_minutes != null, Array.isArray(a.days) && a.days.length > 0, typeof a.cron === 'string' && a.cron.trim() !== '', typeof a.once_at === 'string' && a.once_at.trim() !== ''].filter(Boolean).length;
  if (kinds !== 1) return 'Give exactly one of: every_minutes, days (+ time), cron, once_at.';
  if (a.every_minutes != null) return { kind: 'interval', everyMinutes: Number(a.every_minutes), anchor: 0 };
  if (typeof a.cron === 'string' && a.cron.trim()) return { kind: 'cron', expr: a.cron.trim(), tz };
  if (typeof a.once_at === 'string' && a.once_at.trim()) {
    const s = a.once_at.trim();
    if (/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) { const t = Date.parse(s); return Number.isFinite(t) ? { kind: 'once', at: t } : 'once_at is not a date and time'; }
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(s);
    if (!m) return 'once_at must look like 2026-10-12T09:00 (in the given time zone) or carry an offset';
    const day = Math.floor(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!) / 86_400_000);
    return { kind: 'once', at: wallToEpoch(day, +m[4]!, +m[5]!, tz).t };
  }
  const days = new Set<number>();
  for (const w of a.days as unknown[]) { const d = DAY_WORDS[String(w).trim().toLowerCase()]; if (!d) return `Unknown day "${String(w)}". Use mon..sun, weekdays, weekends or daily.`; d.forEach((x) => days.add(x)); }
  if (typeof a.time !== 'string') return 'days needs a time like 08:00';
  return { kind: 'weekly', days: [...days].sort((x, y) => x - y), time: a.time.trim(), tz };
}

function fmtNext(ms: number | null, tz: string): string {
  if (ms == null) return 'not scheduled';
  const p = wallParts(ms, tz);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)} ${tz}`;
}

export function routineToolSpecs(svc: RoutineService, ctx: RoutineToolContext): FleetToolSpec[] {
  const caller = (): BlobLike | null => svc.o.blobs.get(ctx.blobId);
  const actor = (): Actor => ({ kind: 'blob', blobId: ctx.blobId, fullAccess: ctx.fullAccess?.() === true });
  const emit = (c: unknown) => { try { ctx.emitCard?.(c as never); } catch { /* cards are advisory */ } };

  /** Resolve the blob a call is about: the caller by default; another by name (Kora only, enforced by gate). */
  const target = (name: unknown): BlobLike | string => {
    const me = caller(); if (!me || me.archivedAt != null) return 'unknown blob';
    if (typeof name !== 'string' || !name.trim() || name.trim().toLowerCase() === me.name.toLowerCase()) return me;
    const other = svc.o.blobs.byName(name.trim());
    return other && other.archivedAt == null ? other : `no blob named "${name}"`;
  };
  const findRoutine = (idOrTitle: unknown, blob: BlobLike): Routine | string => {
    const q = String(idOrTitle ?? '').trim();
    if (!q) return 'routine is empty (use list_routines for ids)';
    const mine = svc.store.routinesOf(blob.id);
    const hit = mine.find((r) => r.id === q) ?? mine.filter((r) => r.title.toLowerCase() === q.toLowerCase());
    if (Array.isArray(hit)) return hit.length === 1 ? hit[0]! : hit.length ? `several routines are called "${q}"; use the id` : `no routine "${q}" on ${blob.name}`;
    return hit;
  };
  const receipt = (blob: BlobLike, what: string, undo: { op: 'create' | 'update' | 'delete'; before: Routine | null; routineId: string }) => {
    const row = svc.journal({ blobId: blob.id, routineId: undo.routineId, op: undo.op, before: undo.before, what });
    emit({ cardKind: 'self-change', cardId: cardId('sc'), version: 1, what, undoToken: row.token, undone: false });
  };
  const askOrDo = (blob: BlobLike, enabling: boolean, summary: string, details: string[], run: () => Result<string>): FleetToolResult => {
    const g = svc.gate(actor(), blob.id, enabling);
    if (!g.allow && 'refuse' in g) return bad(g.refuse);
    if (g.allow === 'ask') {
      emit(svc.ask(blob.id, summary, [g.why, ...details], run));
      return ok(`${g.why}, so it needs the user's OK. A card with the details is in the chat; nothing has changed yet. Do not retry: tell the user it is waiting for their approval.`);
    }
    const r = run();
    return r.ok ? ok(r.value) : bad(r.message);
  };

  return [
    {
      name: 'list_routines',
      description: 'List routines (recurring work a blob does on its own): id, schedule, state, next run. Yours by default; Kora can pass `blob` to see another blob\'s.',
      params: { blob: { type: 'string', optional: true, description: 'blob name (Kora only); default: you' } },
      async handler(a) {
        try {
          const b = target(a.blob); if (typeof b === 'string') return bad(b);
          const me = caller()!;
          if (b.id !== me.id && me.role !== 'chief') return bad('You can only list your own routines.');
          const views = svc.list(b.id);
          if (!views.length) return ok(`${b.name} has no routines.`);
          return ok(views.map((v) => `- ${v.id} "${v.title}": ${describeCadence(v.cadence)}; ${v.paused ? 'paused' : v.live ? `running (${v.live.status})` : `next ${fmtNext(v.nextRunAt, 'tz' in v.cadence ? v.cadence.tz : systemTimeZone())}`}${v.triggers.length ? `; ${v.triggers.length} webhook(s)` : ''}`).join('\n'));
        } catch (e: any) { return bad(String(e?.message ?? e)); }
      },
    },
    {
      name: 'schedule_routine',
      description: 'Create a routine: recurring work you do on your own with a report afterwards (a morning brief, a weekly summary). Pick ONE timing: every_minutes (5-1440), days + time (weekly pattern), cron (5 fields; for calendar rules like "0 9 1-7 * 1" is NOT first Monday - use "0 9 * * 1#1"; last day of month "0 9 L * *"), or once_at. Use it when the user asks for something recurring, or after they agree to a recurring suggestion. The user is asked to approve before it starts running (a card appears in the chat; do not ask in the text and do not retry). Kora may create one for another blob (asks unless Full access). Approved routines get a receipt with Undo and stop a run after 15 minutes.',
      params: {
        title: { type: 'string', description: 'short name, e.g. "Morning brief"' },
        prompt: { type: 'string', description: 'what to do on each run, written as instructions to yourself' },
        every_minutes: { type: 'number', optional: true, description: '5 to 1440' },
        days: { type: 'string[]', optional: true, description: 'mon..sun, or weekdays / weekends / daily' },
        time: { type: 'string', optional: true, description: '24-hour HH:MM, used with days' },
        cron: { type: 'string', optional: true, description: '5-field cron, evaluated in timezone. Supports L (last day), 1#2 (second Monday), 5L (last Friday)' },
        once_at: { type: 'string', optional: true, description: 'one run at this date and time, e.g. 2026-10-12T09:00 (in timezone) or with an offset' },
        timezone: { type: 'string', optional: true, description: 'IANA zone, default: this Mac\'s' },
        remember_last_run: { type: 'boolean', optional: true, description: 'start each run with the previous report (up to 2,000 characters)' },
        paused: { type: 'boolean', optional: true, description: 'create it paused' },
        blob: { type: 'string', optional: true, description: 'Kora only: the blob this routine is for' },
      },
      async handler(a) {
        try {
          const b = target(a.blob); if (typeof b === 'string') return bad(b);
          const cadence = cadenceFromArgs(a); if (typeof cadence === 'string') return bad(cadence);
          const input = { blobId: b.id, title: String(a.title ?? ''), prompt: String(a.prompt ?? ''), cadence, ...(a.remember_last_run === true ? { rememberLastRun: true } : {}), ...(a.paused === true ? { paused: true } : {}) };
          const bad0 = svc.check(input); if (bad0) return bad(bad0);
          const me = caller()!;
          const by: Routine['createdBy'] = b.id === me.id ? 'self' : 'kora';
          const run = (): Result<string> => {
            const r = svc.create(input, by); if (!r.ok) return r;
            const what = b.id === me.id ? `${b.name} scheduled "${r.value.title}" · ${describeCadence(r.value.cadence)}` : `${me.name} scheduled "${r.value.title}" for ${b.name} · ${describeCadence(r.value.cadence)}`;
            receipt(b, what, { op: 'create', before: null, routineId: r.value.id });
            return { ok: true, value: `Scheduled "${r.value.title}" (${r.value.id}): ${describeCadence(r.value.cadence)}${r.value.paused ? ', paused' : `. Next run ${fmtNext(svc.view(r.value).nextRunAt, 'tz' in r.value.cadence ? r.value.cadence.tz : systemTimeZone())}`}. The user has a receipt with Undo.` };
          };
          return askOrDo(b, input.paused !== true, `Schedule "${input.title.trim()}" for ${b.name}`, [describeCadence(cadence), input.prompt.trim().slice(0, 300)], run);
        } catch (e: any) { return bad(String(e?.message ?? e)); }
      },
    },
    {
      name: 'change_routine',
      description: 'Change, pause, resume or delete a routine. action: update (any of title, prompt, timing, remember_last_run), pause, resume, delete. Pausing, editing or deleting your own routines needs no OK (the user gets a receipt with Undo); resuming one asks; Kora asks before changing another blob\'s unless Full access.',
      params: {
        routine: { type: 'string', description: 'routine id (from list_routines) or exact title' },
        action: { type: 'string', enum: ['update', 'pause', 'resume', 'delete'] },
        blob: { type: 'string', optional: true, description: 'Kora only: whose routine' },
        title: { type: 'string', optional: true }, prompt: { type: 'string', optional: true },
        every_minutes: { type: 'number', optional: true }, days: { type: 'string[]', optional: true }, time: { type: 'string', optional: true },
        cron: { type: 'string', optional: true }, once_at: { type: 'string', optional: true }, timezone: { type: 'string', optional: true },
        remember_last_run: { type: 'boolean', optional: true },
      },
      async handler(a) {
        try {
          const b = target(a.blob); if (typeof b === 'string') return bad(b);
          const r = findRoutine(a.routine, b); if (typeof r === 'string') return bad(r);
          const me = caller()!;
          const who = b.id === me.id ? b.name : `${me.name} (for ${b.name})`;
          const action = String(a.action ?? '');
          const before: Routine = JSON.parse(JSON.stringify(r));
          if (action === 'pause' || action === 'resume' || action === 'update') {
            const patch: RoutinePatch = {};
            if (action === 'pause') patch.paused = true;
            if (action === 'resume') patch.paused = false;
            if (action === 'update') {
              if (typeof a.title === 'string') patch.title = a.title;
              if (typeof a.prompt === 'string') patch.prompt = a.prompt;
              if (typeof a.remember_last_run === 'boolean') patch.rememberLastRun = a.remember_last_run;
              if (a.every_minutes != null || a.days != null || a.cron != null || a.once_at != null) {
                const c = cadenceFromArgs(a, 'tz' in r.cadence ? r.cadence.tz : systemTimeZone()); if (typeof c === 'string') return bad(c);
                patch.cadence = c;
              }
              if (!Object.keys(patch).length) return bad('nothing to update: pass a title, prompt, timing or remember_last_run');
            }
            const verb = action === 'pause' ? 'paused' : action === 'resume' ? 'resumed' : 'updated';
            return askOrDo(b, action === 'resume', `${action === 'update' ? 'Change' : action === 'pause' ? 'Pause' : 'Resume'} "${r.title}" for ${b.name}`, Object.keys(patch).map((k) => `${k}: ${k === 'cadence' ? describeCadence(patch.cadence!) : String((patch as Record<string, unknown>)[k]).slice(0, 200)}`), () => {
              const u = svc.update(r.id, patch); if (!u.ok) return u;
              receipt(b, `${who} ${verb} "${u.value.title}"${action === 'update' && patch.cadence ? ` · ${describeCadence(u.value.cadence)}` : ''}`, { op: 'update', before, routineId: r.id });
              return { ok: true, value: `Done: "${u.value.title}" ${verb}. The user has a receipt with Undo.` };
            });
          }
          if (action === 'delete') {
            return askOrDo(b, false, `Delete "${r.title}" for ${b.name}`, [describeCadence(r.cadence)], () => {
              const u = svc.remove(r.id); if (!u.ok) return u;
              receipt(b, `${who} deleted "${r.title}"`, { op: 'delete', before, routineId: r.id });
              return { ok: true, value: `Deleted "${r.title}". The user has a receipt with Undo.` };
            });
          }
          return bad('action must be update, pause, resume or delete');
        } catch (e: any) { return bad(String(e?.message ?? e)); }
      },
    },
  ];
}
