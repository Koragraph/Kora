// Jobs: how Kora (the Chief) runs a multi-blob piece of work (docs/bots/SPEC.md "Running a multi-blob job", ARCH 6.4).
//
//   JobStore       persisted jobs (one JSON file each under <KORA_HOME>/blobs/jobs/), the per-step state machine
//   JobEngine      plans, starts (queue when a blob is busy, never two blobs on one file), settles, checks, accepts,
//                  follows up, cancels, reconciles after a restart; emits the versioned `job` card
//   ProposalStore  "Build me a blob" proposal cards (versioned in place), so Hire works after a restart
//   ConfirmStore   edit / retire / hire cards that wait for the user's click
//
// Step states: planned -> queued -> running -> waiting (on the user) -> checking (Kora reads the result) -> done,
// or failed / cancelled from any live state. Nothing here talks to a model: the bridge starts the threads.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { blobsStoreDir } from './home';
import { DelegationLog, normalizeKind } from './delegation';
import type { BlobDraft } from './templates';
import { CHIEF_BLOB_ID, type BlobProfile, type ThreadOrigin, type TokenTotals } from './types';

// ── the engine side, as the runtime sees it (twin of ui-server host.ts BlobEngineBridge) ─────────────────────────
export interface BlobEngineBridge {
  startThread(p: { blobId: string; title: string; prompt: string; origin: ThreadOrigin; fromKoraThreadId: string | null }): Promise<{ threadId: string; koraThreadId: string } | { refused: 'busy' | 'archived' | 'unknown' }>;
  sendToThread(threadId: string, text: string, origin: ThreadOrigin): Promise<void>;
  snapshot(threadId: string): { state: 'running' | 'idle' | 'needs-you' | 'error'; finalText: string | null; outputs: string[]; tokens: TokenTotals; interrupted?: boolean } | null;
  runningCount(blobId: string): number;
  appendCard(koraThreadId: string, card: JobCardWire | ProposalCardWire | ConfirmCardWire): void;
  queueNote(koraThreadId: string, text: string): void;
  onSettled(cb: (e: { threadId: string; koraThreadId: string; blobId: string; ok: boolean }) => void): () => void;
  /** Optional: stop a running thread (job cancel). */
  interrupt?(threadId: string): void | Promise<void>;
}

/** The blobs a job can name. BlobStore satisfies it. */
export interface BlobDirectory {
  get(id: string): BlobProfile | null;
  byName(name: string): BlobProfile | null;
}

export const MAX_RUNNING_PER_BLOB = 3;
export const MAX_PLAN_STEPS = 12;
export const MIN_BRIEF_CHARS = 40;
export const CHECKING_AUTO_ACCEPT_MS = 10 * 60_000;
const GIST_CAP = 600;
const FINAL_CAP = 6000;

/** Phrases that ask for something even without a question mark ("Please tell me ...", "I need to know ..."). */
const ASKS_STRONG = /\b(before i (?:start|write|begin|can|go on|draft)|i need (?:to know|from you|a few|some|your)|please (?:tell|share|confirm|send|reply|answer|choose|pick|provide)|tell me (?:the|your|which|what|who)|i(?:'| a)m waiting for (?:your|you))\b/i;
/** Phrases that only count together with a question mark. */
const ASKS_WEAK = /\b(could you|can you|would you|what (?:is|are|was|were|'s) (?:your|the)|which (?:one|of)|who (?:is|are)|my questions?|a few questions|questions? for you|do you want)\b/i;
/**
 * A step that ended its turn by asking the USER something (names, a story, a choice) is not finished and not "working": it
 * is waiting on the user. Live QA #2: Junip asked three questions, the job card kept saying "working" and Kora (who had to
 * relay them) never knew the step was parked. A deliverable on disk means it finished; a short reply that ends in a question
 * or reads like one does not.
 */
export function asksUser(text: string, outputs: readonly string[] = []): boolean {
  const t = text.trim();
  if (!t || outputs.length > 0) return false;
  if (t.length > 2500) return false; // a long document that merely mentions a question
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
  const lastLines = lines.slice(-4).join(' ');
  const endsWithQuestion = /\?["')\]*_\s]*$/.test(t);
  if (ASKS_STRONG.test(lastLines) || ASKS_STRONG.test(t.slice(0, 300))) return true;
  // "Done. The memo is ready. Want me to change anything?" finished: a closing offer is not a blocking question
  if (endsWithQuestion && /^\W*(done|here(?:'| i)s|here are|finished|all set|ready|i (?:have |'ve )?(?:wrote|written|made|created|saved|finished|put))\b/i.test(t)) return false;
  if (endsWithQuestion) return ASKS_WEAK.test(t.slice(-500)) || lines.length <= 3;
  return false;
}

// ── wire shapes (key-for-key twins of contracts/src/blobs.ts; the ui-server validates) ──────────────────────────────
export interface JobStepWire {
  id: string; blobId: string; blobName: string; title: string; task: string; kind: string; dependsOn: string[];
  status: 'queued' | 'running' | 'needs-you' | 'done' | 'failed' | 'cancelled';
  threadId: string | null; resultGist: string | null; outputs: string[]; startedAt: number | null; finishedAt: number | null;
}
export interface JobCardWire {
  cardKind: 'job'; cardId: string; version: number; title: string; status: 'planned' | 'running' | 'done' | 'failed' | 'cancelled'; steps: JobStepWire[]; createdAt: number;
}
export interface ProposalCardWire { cardKind: 'proposal'; cardId: string; version: number; draft: BlobDraft; state: 'open' | 'hired' | 'dismissed'; hiredBlobId: string | null }
/** NEW card kind (needs a contract entry + a small client card): an edit / retire / hire that waits for a click. */
export interface ConfirmCardWire {
  cardKind: 'confirm'; cardId: string; version: number; action: 'edit' | 'retire' | 'hire'; blobId: string | null; blobName: string | null;
  summary: string; details: string[]; state: 'open' | 'confirmed' | 'dismissed' | 'failed'; result: string | null;
}

// ── JSON table ─────────────────────────────────────────────────────────────────────────────────────────────
function writeAtomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
const rid = (p: string) => `${p}_${crypto.randomBytes(5).toString('hex')}`;
const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const firstLine = (s: string) => s.split('\n').find((l) => l.trim())?.trim() ?? '';

// ── steps and jobs ─────────────────────────────────────────────────────────────────────────────────────────
export type StepState = 'planned' | 'queued' | 'running' | 'waiting' | 'checking' | 'done' | 'failed' | 'cancelled';
export const TERMINAL: ReadonlySet<StepState> = new Set(['done', 'failed', 'cancelled']);
const TRANSITIONS: Record<StepState, readonly StepState[]> = {
  planned: ['queued', 'running', 'cancelled', 'failed'],
  queued: ['running', 'cancelled', 'failed'],
  running: ['waiting', 'checking', 'failed', 'cancelled'],
  waiting: ['running', 'checking', 'failed', 'cancelled'],
  checking: ['running', 'done', 'failed', 'cancelled'],
  done: [], failed: [], cancelled: [],
};
export class JobStateError extends Error { constructor(msg: string) { super(msg); this.name = 'JobStateError'; } }
export const canTransition = (from: StepState, to: StepState): boolean => TRANSITIONS[from].includes(to);

export interface JobStepRec {
  id: string; blobId: string; blobName: string; title: string; task: string; kind: string; dependsOn: string[];
  /** Absolute path of the declared output file (inside the target blob's folder), or null. */
  output: string | null;
  state: StepState;
  threadId: string | null;
  brief: string | null;
  queuedAt: number | null;
  queuedReason: 'busy' | 'file' | null;
  resultGist: string | null;
  finalText: string | null;
  outputs: string[];
  startedAt: number | null;
  finishedAt: number | null;
  checkingSince: number | null;
  /** 1 = the first run; 2 = after the one follow-up. */
  attempts: number;
  redo: boolean;
  tokens: number;
  error: string | null;
  /** In-memory only: startThread is in flight (counts as active for the busy count and the file lock). */
  launching?: boolean;
}
export interface JobRec {
  id: string; title: string; koraThreadId: string | null; createdAt: number; updatedAt: number;
  /** Card version; bumps on every push. */
  version: number; cancelled: boolean; steps: JobStepRec[];
}

export type JobStatus = 'planned' | 'running' | 'done' | 'failed' | 'cancelled';

/**
 * Each step's state as the user should read it: a step that has not started (planned/queued) behind a cancelled or
 * failed step (directly or further up) can never run, so it reads cancelled. Without this a job whose only live
 * step was cancelled stayed "running" forever (QA 2026-10-10: job_e52bb9ca7d).
 */
export function effectiveStates(job: JobRec): Map<string, StepState> {
  const out = new Map<string, StepState>(job.steps.map((s) => [s.id, s.state]));
  for (let grew = true; grew;) {
    grew = false;
    for (const s of job.steps) {
      const cur = out.get(s.id)!;
      if (cur !== 'planned' && cur !== 'queued') continue;
      if (s.dependsOn.some((d) => { const ds = out.get(d); return ds === 'cancelled' || ds === 'failed'; })) { out.set(s.id, 'cancelled'); grew = true; }
    }
  }
  return out;
}

export function jobStatus(job: JobRec): JobStatus {
  const eff = effectiveStates(job);
  const st = job.steps.map((s) => eff.get(s.id)!);
  if (st.every((s) => TERMINAL.has(s))) {
    if (st.some((s) => s === 'failed')) return 'failed';
    if (job.cancelled) return 'cancelled'; // the user cancelled the whole job: it reads Cancelled, whatever finished before
    if (st.some((s) => s === 'done')) return 'done';
    return 'cancelled';
  }
  if (st.every((s) => s === 'planned' || s === 'queued') && !job.steps.some((s) => s.startedAt != null)) return 'planned';
  return 'running';
}

const WIRE_STEP: Record<StepState, JobStepWire['status']> = {
  planned: 'queued', queued: 'queued', running: 'running', waiting: 'needs-you', checking: 'running', done: 'done', failed: 'failed', cancelled: 'cancelled',
};

export function jobCard(job: JobRec): JobCardWire {
  const eff = effectiveStates(job);
  return {
    cardKind: 'job', cardId: job.id, version: job.version, title: job.title, status: jobStatus(job), createdAt: job.createdAt,
    steps: job.steps.map((s) => ({
      id: s.id, blobId: s.blobId, blobName: s.blobName, title: s.title, task: s.task, kind: s.kind, dependsOn: [...s.dependsOn], status: WIRE_STEP[eff.get(s.id) ?? s.state],
      threadId: s.threadId, resultGist: s.resultGist, outputs: [...s.outputs], startedAt: s.startedAt, finishedAt: s.finishedAt,
    })),
  };
}

// ── store ──────────────────────────────────────────────────────────────────────────────────────────────────
export class JobStore extends EventEmitter {
  private jobs = new Map<string, JobRec>();
  private dir: string | null;

  /** `dir` null = memory only (tests). Default <KORA_HOME>/blobs/jobs. */
  constructor(o: { dir?: string | null } = {}) {
    super();
    this.dir = o.dir === undefined ? path.join(blobsStoreDir(), 'jobs') : o.dir;
    if (this.dir) {
      let names: string[] = [];
      try { names = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')); } catch { /* none yet */ }
      for (const f of names) {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) as JobRec;
          if (j && typeof j.id === 'string' && Array.isArray(j.steps)) { for (const s of j.steps) s.launching = false; this.jobs.set(j.id, j); }
        } catch { /* corrupt job file: skipped */ }
      }
    }
  }

  /**
   * Jobs left with no live blob once `blobId` is deleted (every step was for a blob that no longer exists) are removed,
   * file and all. A job that still has a step for a living blob stays: its card is still that blob's history.
   */
  forgetBlob(blobId: string, exists: (id: string) => boolean): string[] {
    const gone: string[] = [];
    for (const job of [...this.jobs.values()]) {
      if (!job.steps.some((s) => s.blobId === blobId)) continue;
      if (job.steps.some((s) => s.blobId !== blobId && exists(s.blobId))) continue;
      this.jobs.delete(job.id);
      if (this.dir) { try { fs.rmSync(path.join(this.dir, `${job.id}.json`), { force: true }); } catch { /* advisory */ } }
      gone.push(job.id);
      this.emit('changed', job.id);
    }
    return gone;
  }

  get(id: string): JobRec | null { return this.jobs.get(id) ?? null; }
  list(): JobRec[] { return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt); }
  add(job: JobRec): void { this.jobs.set(job.id, job); this.save(job); }
  save(job: JobRec): void {
    job.updatedAt = Date.now();
    if (this.dir) {
      const clean = { ...job, steps: job.steps.map(({ launching: _l, ...s }) => s) };
      try { writeAtomic(path.join(this.dir, `${job.id}.json`), JSON.stringify(clean, null, 1) + '\n'); } catch { /* advisory */ }
    }
    this.emit('changed', job.id);
  }
  findByThread(threadId: string): { job: JobRec; step: JobStepRec } | null {
    for (const job of this.jobs.values()) for (const step of job.steps) if (step.threadId === threadId) return { job, step };
    return null;
  }
  /** Steps of `blobId` that are queued, running or waiting (for cards: "lately ... (running)"). */
  activeStepsOf(blobId: string): Array<{ job: JobRec; step: JobStepRec }> {
    const out: Array<{ job: JobRec; step: JobStepRec }> = [];
    for (const job of this.jobs.values()) for (const step of job.steps) if (step.blobId === blobId && !TERMINAL.has(step.state) && step.state !== 'planned') out.push({ job, step });
    return out;
  }
  /** Move a step along the state machine; an illegal move throws (the engine never swallows these). */
  transition(step: JobStepRec, to: StepState): void {
    if (step.state === to) return;
    if (!canTransition(step.state, to)) throw new JobStateError(`step ${step.id}: ${step.state} -> ${to} is not allowed`);
    step.state = to;
  }
}

// ── plan validation ────────────────────────────────────────────────────────────────────────────────────────
export interface PlanStepInput { id: string; blob: string; task: string; kind?: string; dependsOn?: string[]; output?: string }
export type PlanError = { error: string };

const claimKey = (p: string) => p.toLowerCase();
const overlaps = (a: string, b: string) => { const x = claimKey(a), y = claimKey(b); return x === y || x.startsWith(y + path.sep) || y.startsWith(x + path.sep); };

/** Absolute path for a declared output: absolute stays, relative lands in the target blob's outputs/. Must stay inside its folder. */
export function resolveOutput(raw: string, blob: BlobProfile): string | PlanError {
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(blob.workspace, 'outputs', raw);
  const ws = path.resolve(blob.workspace);
  if (!(abs === ws || abs.startsWith(ws + path.sep))) return { error: `output ${raw} is outside ${blob.name}'s folder (${ws}); a blob only writes inside its own folder` };
  return abs;
}

export function validatePlan(title: string, steps: PlanStepInput[], dir: BlobDirectory): { steps: JobStepRec[] } | PlanError {
  if (!title.trim()) return { error: 'the job needs a title' };
  if (!Array.isArray(steps) || steps.length === 0) return { error: 'the plan needs at least one step' };
  if (steps.length > MAX_PLAN_STEPS) return { error: `at most ${MAX_PLAN_STEPS} steps per job; split it into two jobs` };
  const ids = new Set<string>();
  const out: JobStepRec[] = [];
  for (const raw of steps) {
    const id = String(raw?.id ?? '').trim();
    if (!/^[A-Za-z0-9_-]{1,24}$/.test(id)) return { error: `step id "${id}" must be 1-24 letters, digits, - or _` };
    if (ids.has(id)) return { error: `step id "${id}" is used twice` };
    ids.add(id);
    const task = String(raw.task ?? '').trim();
    if (!task) return { error: `step ${id} has no task` };
    const ref = String(raw.blob ?? '').trim();
    const blob = dir.byName(ref) ?? dir.get(ref);
    if (!blob) return { error: `step ${id}: no blob named "${ref}" on the team (call list_team)` };
    if (blob.archivedAt != null) return { error: `step ${id}: ${blob.name} is retired` };
    if (blob.role === 'chief') return { error: `step ${id}: you are the Chief; do your own steps yourself and leave them out of the plan` };
    let output: string | null = null;
    if (raw.output && String(raw.output).trim()) { const r = resolveOutput(String(raw.output).trim(), blob); if (typeof r !== 'string') return { error: `step ${id}: ${r.error}` }; output = r; }
    out.push({
      id, blobId: blob.id, blobName: blob.name, title: cap(firstLine(task), 80), task, kind: normalizeKind(raw.kind), dependsOn: [...new Set((raw.dependsOn ?? []).map(String))], output,
      state: 'planned', threadId: null, brief: null, queuedAt: null, queuedReason: null, resultGist: null, finalText: null, outputs: [], startedAt: null, finishedAt: null,
      checkingSince: null, attempts: 0, redo: false, tokens: 0, error: null,
    });
  }
  const byId = new Map(out.map((s) => [s.id, s]));
  for (const s of out) for (const d of s.dependsOn) {
    if (d === s.id) return { error: `step ${s.id} depends on itself` };
    if (!byId.has(d)) return { error: `step ${s.id} depends on "${d}", which is not in the plan` };
  }
  // cycles (Kahn)
  const indeg = new Map(out.map((s) => [s.id, s.dependsOn.length]));
  const ready = out.filter((s) => s.dependsOn.length === 0).map((s) => s.id);
  let seen = 0;
  while (ready.length) { const n = ready.pop()!; seen++; for (const s of out) if (s.dependsOn.includes(n)) { const k = indeg.get(s.id)! - 1; indeg.set(s.id, k); if (k === 0) ready.push(s.id); } }
  if (seen !== out.length) return { error: 'the plan has a dependency cycle' };
  // never two blobs on the same file
  const reach = (from: string, to: string, seenIds = new Set<string>()): boolean => {
    if (seenIds.has(from)) return false; seenIds.add(from);
    return byId.get(from)!.dependsOn.some((d) => d === to || reach(d, to, seenIds));
  };
  for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
    const a = out[i], b = out[j];
    if (!a.output || !b.output || !overlaps(a.output, b.output)) continue;
    const ordered = reach(a.id, b.id) || reach(b.id, a.id);
    if (!ordered) return { error: `steps ${a.id} and ${b.id} would write the same file (${a.output}) at the same time; give them different output files or make one depend on the other` };
    if (a.blobId !== b.blobId) return { error: `steps ${a.id} and ${b.id} (different blobs) both claim ${a.output}; two blobs never edit the same file. Use separate output files` };
  }
  return { steps: out };
}

// ── the engine ─────────────────────────────────────────────────────────────────────────────────────────────
export type DelegateResult =
  | { ok: true; state: 'started'; threadId: string }
  | { ok: true; state: 'queued'; reason: 'busy' | 'file'; detail: string }
  | { ok: false; error: string };

export interface JobEngineOptions {
  store: JobStore;
  blobs: BlobDirectory;
  log: DelegationLog;
  bridge: () => BlobEngineBridge | null;
  now?: () => number;
  maxRunning?: number;
  checkTimeoutMs?: number;
}

export class JobEngine extends EventEmitter {
  private store: JobStore; private blobs: BlobDirectory; private log: DelegationLog;
  private bridgeFn: () => BlobEngineBridge | null;
  private now: () => number;
  private maxRunning: number; private checkTimeoutMs: number;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(o: JobEngineOptions) {
    super();
    this.store = o.store; this.blobs = o.blobs; this.log = o.log; this.bridgeFn = o.bridge;
    this.now = o.now ?? Date.now; this.maxRunning = o.maxRunning ?? MAX_RUNNING_PER_BLOB; this.checkTimeoutMs = o.checkTimeoutMs ?? CHECKING_AUTO_ACCEPT_MS;
    this.store.on('changed', (id: string) => this.emit('changed', id));
  }

  private bridge(): BlobEngineBridge | null { try { return this.bridgeFn(); } catch { return null; } }

  // ── planning ─────────────────────────────────────────────────────────────────────────────────────
  plan(i: { title: string; steps: PlanStepInput[]; koraThreadId: string | null }): { job: JobRec; card: JobCardWire } | PlanError {
    const v = validatePlan(i.title, i.steps, this.blobs);
    if ('error' in v) return v;
    const now = this.now();
    const job: JobRec = { id: rid('job'), title: cap(i.title.trim(), 100), koraThreadId: i.koraThreadId, createdAt: now, updatedAt: now, version: 1, cancelled: false, steps: v.steps };
    this.store.add(job);
    return { job, card: jobCard(job) };
  }

  /** Push the next card version to Kora's thread (the transcript shows the highest version per cardId). */
  private push(job: JobRec): void {
    job.version += 1;
    this.store.save(job);
    const b = this.bridge();
    if (b && job.koraThreadId) { try { b.appendCard(job.koraThreadId, jobCard(job)); } catch { /* cards are advisory */ } }
  }
  private note(job: JobRec, text: string): void {
    const b = this.bridge();
    if (b && job.koraThreadId) { try { b.queueNote(job.koraThreadId, text); } catch { /* advisory */ } }
  }

  // ── starting ─────────────────────────────────────────────────────────────────────────────────────
  private activeClaims(exceptJob: string, exceptStep: string): Array<{ output: string; blobName: string }> {
    const out: Array<{ output: string; blobName: string }> = [];
    for (const j of this.store.list()) for (const s of j.steps) {
      if (j.id === exceptJob && s.id === exceptStep) continue;
      if (s.output && (s.state === 'running' || s.state === 'waiting' || s.launching)) out.push({ output: s.output, blobName: s.blobName });
    }
    return out;
  }
  private inFlightFor(blobId: string): number {
    let n = 0;
    for (const j of this.store.list()) for (const s of j.steps) if (s.blobId === blobId && s.launching) n++;
    return n;
  }

  /** Give step `stepId` its brief and start it (or queue it). */
  async delegate(jobId: string, stepId: string, brief: string): Promise<DelegateResult> {
    const job = this.find(jobId);
    if (!job) return { ok: false, error: this.noJob(jobId) };
    if (job.cancelled) return { ok: false, error: 'that job was cancelled' };
    const step = job.steps.find((s) => s.id === stepId);
    if (!step) return { ok: false, error: `job ${jobId} has no step ${stepId}` };
    if (step.state === 'cancelled') return { ok: false, error: `step ${stepId} was cancelled by the user. Do not start it again unless they ask` };
    if (step.state !== 'planned') return { ok: false, error: `step ${stepId} is already ${step.state}` };
    const dead = step.dependsOn.filter((d) => { const st = job.steps.find((s) => s.id === d)?.state; return st === 'cancelled' || st === 'failed'; });
    if (dead.length) return { ok: false, error: `step ${stepId} depends on ${dead.join(', ')}, which did not finish (cancelled or failed). Do not start it` };
    const b = brief.trim();
    if (b.length < MIN_BRIEF_CHARS) return { ok: false, error: `the brief is too short (${b.length} characters). The blob has not seen this chat: state the goal, the inputs, what done looks like and where to write the output` };
    const waiting = step.dependsOn.filter((d) => job.steps.find((s) => s.id === d)?.state !== 'done');
    if (waiting.length) return { ok: false, error: `step ${stepId} waits on ${waiting.join(', ')} (not accepted yet). Check and accept those first, then include their results in this brief` };
    const target = this.blobs.get(step.blobId);
    if (!target || target.archivedAt != null) { this.failStep(job, step, `${step.blobName} is no longer on the team`); return { ok: false, error: `${step.blobName} is no longer on the team` }; }
    step.brief = b; step.queuedAt = this.now(); step.attempts = 1;
    this.store.transition(step, 'queued');
    this.store.save(job);
    await this.pump();
    const s = job.steps.find((x) => x.id === stepId)!;
    if (s.state === 'running' && s.threadId) return { ok: true, state: 'started', threadId: s.threadId };
    if (s.state === 'queued') return { ok: true, state: 'queued', reason: s.queuedReason ?? 'busy', detail: s.queuedReason === 'file' ? 'another blob is writing the same file' : `${s.blobName} is busy` };
    return { ok: false, error: s.error ?? `step ${stepId} could not start (${s.state})` };
  }

  /** Start every queued step that can start now. Serialised: two callers never launch the same step. */
  pump(): Promise<void> {
    const run = this.tail.then(() => this.pumpNow(), () => this.pumpNow());
    this.tail = run.catch(() => {});
    return run;
  }

  private async pumpNow(): Promise<void> {
    this.sweepChecking();
    const queued: Array<{ job: JobRec; step: JobStepRec }> = [];
    for (const job of this.store.list()) if (!job.cancelled) for (const step of job.steps) if (step.state === 'queued' && !step.launching) queued.push({ job, step });
    queued.sort((a, b) => (a.step.queuedAt ?? 0) - (b.step.queuedAt ?? 0));
    for (const { job, step } of queued) { if (step.state === 'queued' && !job.cancelled) await this.launch(job, step); }
  }

  private async launch(job: JobRec, step: JobStepRec): Promise<void> {
    const bridge = this.bridge();
    if (!bridge) { step.error = 'the blob engine is not attached yet'; step.queuedReason = 'busy'; return; }
    const target = this.blobs.get(step.blobId);
    if (!target || target.archivedAt != null) { this.failStep(job, step, `${step.blobName} is no longer on the team`); return; }
    if (bridge.runningCount(step.blobId) + this.inFlightFor(step.blobId) >= this.maxRunning) { this.markQueued(job, step, 'busy'); return; }
    if (step.output) {
      const clash = this.activeClaims(job.id, step.id).find((c) => overlaps(c.output, step.output!));
      if (clash) { this.markQueued(job, step, 'file'); return; }
    }
    step.launching = true;
    const origin: ThreadOrigin = { kind: 'kora', jobId: job.id, stepId: step.id, fromThreadId: job.koraThreadId, fromBlobId: CHIEF_BLOB_ID };
    try {
      const r = await bridge.startThread({ blobId: step.blobId, title: step.title, prompt: composePrompt(step, target), origin, fromKoraThreadId: job.koraThreadId });
      step.launching = false;
      if ('refused' in r) {
        if (r.refused === 'busy') { this.markQueued(job, step, 'busy'); return; }
        this.failStep(job, step, r.refused === 'archived' ? `${step.blobName} is retired` : `${step.blobName} is not on the team`);
        return;
      }
      step.threadId = r.threadId;
      if (TERMINAL.has(step.state)) { try { await bridge.interrupt?.(r.threadId); } catch { /* best effort */ } return; } // cancelled while the thread was starting
      step.startedAt = this.now(); step.queuedReason = null; step.error = null;
      this.store.transition(step, 'running');
      this.push(job);
    } catch (e: any) {
      step.launching = false;
      this.failStep(job, step, `could not start the thread: ${e?.message ?? e}`);
    }
  }

  private markQueued(job: JobRec, step: JobStepRec, reason: 'busy' | 'file'): void {
    const changed = step.queuedReason !== reason;
    step.queuedReason = reason; step.launching = false;
    if (changed) this.push(job); else this.store.save(job);
  }

  // ── settling and checking ────────────────────────────────────────────────────────────────────────
  /** A blob thread finished a turn (bridge.onSettled). */
  async settle(e: { threadId: string; ok: boolean }): Promise<void> {
    const hit = this.store.findByThread(e.threadId);
    if (!hit) return;
    const { job, step } = hit;
    if (step.state !== 'running' && step.state !== 'waiting') return;
    const snap = this.bridge()?.snapshot(e.threadId) ?? null;
    // The blob is working again (the user answered / approved): back to running, nothing to check yet.
    if (snap?.state === 'running') {
      if (step.state === 'waiting') { this.store.transition(step, 'running'); this.push(job); }
      return;
    }
    this.absorbSnapshot(job, step, snap, e.ok);
    await this.pump();
  }

  private absorbSnapshot(job: JobRec, step: JobStepRec, snap: ReturnType<BlobEngineBridge['snapshot']>, ok: boolean): void {
    const text = snap?.finalText?.trim() ?? '';
    if (snap) { step.outputs = [...snap.outputs]; step.tokens = snap.tokens.input + snap.tokens.output; }
    if (!ok || snap?.state === 'error') {
      this.failStep(job, step, text ? `${step.blobName} stopped with an error: ${cap(text, 200)}` : `${step.blobName} stopped with an error`);
      return;
    }
    if (snap?.state === 'needs-you') {
      if (step.state !== 'waiting') { this.store.transition(step, 'waiting'); }
      step.resultGist = cap(text || 'waiting for you', GIST_CAP);
      this.push(job);
      this.note(job, `[kora] ${step.blobName} needs the user on "${step.title}" (an approval or an answer). Tell the user it is waiting in ${step.blobName}'s thread; do not answer for them.`);
      return;
    }
    // The turn ended on a question for the user: the step waits on them (and goes back to running when they answer).
    if (asksUser(text, snap?.outputs ?? [])) {
      const same = step.state === 'waiting' && step.finalText === cap(text, FINAL_CAP);
      if (same) return; // already told (a periodic reconcile re-reads the same ask)
      if (step.state !== 'waiting') this.store.transition(step, 'waiting');
      step.finalText = cap(text, FINAL_CAP);
      step.resultGist = cap(text, GIST_CAP);
      this.push(job);
      this.note(job, `[kora] ${step.blobName} asked the user a question on "${step.title}" and is waiting for the answer in ${step.blobName}'s thread. Tell the user what it asked, in one short list, and that they answer there; do not answer for them. It continues by itself afterwards.`);
      return;
    }
    step.finalText = cap(text, FINAL_CAP);
    step.resultGist = cap(firstLine(text) || text || 'finished', GIST_CAP);
    step.checkingSince = this.now();
    this.store.transition(step, 'checking');
    this.push(job);
    this.note(job, `[kora] ${step.blobName} finished "${step.title}" (job ${job.id}, step ${step.id}). Read the result against your brief with wait_for, then accept_step, or follow_up once if it is off.`);
  }

  private failStep(job: JobRec, step: JobStepRec, reason: string): void {
    if (TERMINAL.has(step.state)) return;
    step.error = reason; step.launching = false; step.finishedAt = this.now();
    this.store.transition(step, 'failed');
    this.logStep(job, step, 'failed');
    const skipped = this.skipDead(job);
    this.push(job);
    this.note(job, `[kora] Step "${step.title}" (${step.blobName}) failed: ${reason}${skipped.length ? ` Steps that needed it will not run: ${skipped.join(', ')}.` : ''}`);
  }

  /** Planned/queued steps behind a failed or cancelled one can never start: settle them as cancelled. Returns their ids. */
  private skipDead(job: JobRec): string[] {
    const eff = effectiveStates(job);
    const out: string[] = [];
    for (const s of job.steps) {
      if ((s.state === 'planned' || s.state === 'queued') && eff.get(s.id) === 'cancelled') {
        s.finishedAt = this.now(); s.launching = false;
        this.store.transition(s, 'cancelled');
        out.push(s.id);
      }
    }
    return out;
  }

  private logStep(job: JobRec, step: JobStepRec, outcome: 'done' | 'failed' | 'cancelled'): void {
    if (outcome === 'cancelled' && step.startedAt == null) return; // never ran: nothing to learn from
    this.log.append({
      jobId: job.id, stepId: step.id, blobId: step.blobId, kind: step.kind, title: step.title, brief: step.brief ?? step.task, outcome,
      durationMs: step.startedAt != null ? (step.finishedAt ?? this.now()) - step.startedAt : 0, tokens: step.tokens, reaction: step.redo ? 'redo' : null,
    });
  }

  /** Kora read the result and it is good: the step is done and its dependents may start. */
  async accept(jobId: string, stepId: string, auto = false): Promise<{ ok: true } | { ok: false; error: string }> {
    const found = this.need(jobId, stepId); if ('error' in found) return { ok: false, error: found.error };
    const { job, step } = found;
    if (step.state === 'cancelled') return { ok: false, error: `step ${stepId} was cancelled by the user. Leave it cancelled and tell them so` };
    if (step.state !== 'checking') return { ok: false, error: `step ${stepId} is ${step.state}, not waiting to be checked` };
    step.finishedAt = this.now();
    this.store.transition(step, 'done');
    this.logStep(job, step, 'done');
    this.push(job);
    if (!auto) await this.pump();
    return { ok: true };
  }

  /** The one follow-up Kora may send in the same thread. */
  async followUp(jobId: string, stepId: string, message: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const found = this.need(jobId, stepId); if ('error' in found) return { ok: false, error: found.error };
    const { job, step } = found;
    if (step.state === 'cancelled') return { ok: false, error: `step ${stepId} was cancelled by the user. Leave it cancelled and tell them so` };
    if (step.state !== 'checking') return { ok: false, error: `step ${stepId} is ${step.state}; a follow-up goes to a step that has finished and is being checked` };
    if (step.attempts >= 2) return { ok: false, error: 'one follow-up was already sent for this step. Accept it as it is, do the fix yourself, or tell the user what is missing' };
    if (!message.trim()) return { ok: false, error: 'the follow-up message is empty' };
    const bridge = this.bridge();
    if (!bridge || !step.threadId) return { ok: false, error: 'that step has no thread to follow up in' };
    try { await bridge.sendToThread(step.threadId, message.trim(), { kind: 'kora', jobId: job.id, stepId: step.id, fromThreadId: job.koraThreadId, fromBlobId: CHIEF_BLOB_ID }); }
    catch (e: any) { return { ok: false, error: `could not reach the thread: ${e?.message ?? e}` }; }
    step.attempts += 1; step.redo = true; step.checkingSince = null; step.finalText = null; step.resultGist = null;
    this.store.transition(step, 'running');
    this.push(job);
    return { ok: true };
  }

  /** The wrong-id answer the model sees: it names the real ids so the next call lands, and nothing here reaches the user as a raw error. */
  private noJob(jobId: string): string {
    const open = this.store.list().filter((j) => !j.cancelled && jobStatus(j) !== 'done' && jobStatus(j) !== 'failed' && jobStatus(j) !== 'cancelled').slice(0, 5);
    const ids = open.map((j) => `${j.id} ("${j.title}")`);
    return `there is no job with the id "${jobId}"; job ids look like job_xxxx and come from the plan_job result${ids.length ? ` (open jobs: ${ids.join(', ')})` : ' (there is no open job: call plan_job first)'}. Retry with the exact id. This slip is yours to fix quietly: nothing was started or lost, so do not tell the user a step was stopped or failed because of it.`;
  }

  /**
   * A job by the id the model passed: exact id, then the same id in another case/without the "job_" prefix, then a
   * unique title/slug match, then the only open job there is (a weak model that guessed a slug still lands).
   */
  private find(jobId: string): JobRec | null {
    const raw = String(jobId ?? '').trim();
    const exact = this.store.get(raw);
    if (exact) return exact;
    if (!raw) return null;
    const jobs = this.store.list();
    const low = raw.toLowerCase();
    const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const byId = jobs.filter((j) => j.id.toLowerCase() === low || j.id.toLowerCase() === `job_${low}`);
    if (byId.length === 1) return byId[0];
    const byTitle = jobs.filter((j) => slug(j.title) === slug(raw));
    if (byTitle.length === 1) return byTitle[0];
    const open = jobs.filter((j) => { const st = jobStatus(j); return !j.cancelled && (st === 'planned' || st === 'running'); });
    return open.length === 1 ? open[0] : null;
  }

  /** Cancel a whole job, or one step (and nothing else). Running threads are interrupted when the bridge can. */
  async cancel(jobId: string, stepId?: string | null): Promise<{ ok: true; cancelled: string[] } | { ok: false; error: string }> {
    const job = this.store.get(jobId); // exact id only: a guess must never cancel the wrong job
    if (!job) return { ok: false, error: this.noJob(jobId) };
    const targets = stepId ? job.steps.filter((s) => s.id === stepId) : job.steps;
    if (stepId && !targets.length) return { ok: false, error: `job ${jobId} has no step ${stepId}` };
    const done: string[] = [];
    // Everything that depends on a cancelled step (directly or not) is cancelled with it: its input will never exist.
    const all = new Set<JobStepRec>(targets);
    for (let grew = true; grew;) {
      grew = false;
      for (const s of job.steps) if (!all.has(s) && s.dependsOn.some((d) => [...all].some((t) => t.id === d))) { all.add(s); grew = true; }
    }
    for (const s of job.steps.filter((x) => all.has(x))) {
      if (TERMINAL.has(s.state)) continue;
      // Mark it cancelled FIRST: the interrupted turn settles right away and `settle` must find a terminal step.
      const stop = s.threadId && (s.state === 'running' || s.state === 'waiting') ? s.threadId : null;
      s.finishedAt = this.now(); s.launching = false;
      this.store.transition(s, 'cancelled');
      this.logStep(job, s, 'cancelled');
      done.push(s.id);
      if (stop) { try { await this.bridge()?.interrupt?.(stop); } catch { /* best effort */ } }
    }
    if (!stepId) job.cancelled = true;
    if (done.length) this.note(job, `[kora] The user cancelled ${stepId ? `step ${stepId}${done.length > 1 ? ` and what depended on it (${done.filter((d) => d !== stepId).join(', ')})` : ''}` : 'the job'} (${done.join(', ')}). It was stopped on purpose: do not restart it, do not do its work yourself, and do not accept or follow up on it. Tell the user it was cancelled.`);
    this.push(job);
    await this.pump();
    return { ok: true, cancelled: done };
  }

  /**
   * Stop on the Kora (Chief) thread: cancel every unfinished job planned from it, which interrupts its running step
   * threads (cascading to dependents). Returns the cancelled step ids. The cancel note is queued on the lead, which holds it until the person writes again.
   */
  async cancelForThread(koraThreadId: string): Promise<string[]> {
    const out: string[] = [];
    for (const job of this.store.list()) {
      if (job.koraThreadId !== koraThreadId || job.cancelled) continue;
      const st = jobStatus(job);
      if (st === 'done' || st === 'failed' || st === 'cancelled') continue;
      const r = await this.cancel(job.id);
      if (r.ok) out.push(...r.cancelled);
    }
    return out;
  }

  /** The user's reaction on a finished step ("good" / "redo"): written to the delegation log. */
  feedback(jobId: string, stepId: string, reaction: 'good' | 'redo'): boolean {
    const step = this.find(jobId)?.steps.find((s) => s.id === stepId);
    if (step && reaction === 'redo') step.redo = true;
    return this.log.react({ jobId, stepId }, reaction);
  }

  /** Steps in `checking` longer than the timeout are accepted so a forgotten check never pins a job open. */
  sweepChecking(): void {
    const t = this.now();
    for (const job of this.store.list()) for (const s of job.steps) {
      if (s.state === 'checking' && s.checkingSince != null && t - s.checkingSince >= this.checkTimeoutMs) {
        s.finishedAt = t; this.store.transition(s, 'done'); this.logStep(job, s, 'done'); this.push(job);
      }
    }
  }
  startSweeper(everyMs = 60_000): () => void {
    // Also re-read running steps: a thread that finished before its id was recorded (instant failure) never settles again.
    const h = setInterval(() => { try { this.sweepChecking(); } catch { /* advisory */ } void this.reconcile({ minAgeMs: 3_000 }).catch(() => {}); }, everyMs);
    h.unref?.();
    return () => clearInterval(h);
  }

  /** After a daemon restart: running/waiting steps whose thread ended while we were away settle now; lost ones fail. */
  async reconcile(o: { minAgeMs?: number } = {}): Promise<void> {
    // Heal jobs left by an older build: steps stranded behind a cancelled/failed one read cancelled, not "running".
    for (const job of this.store.list()) { if (this.skipDead(job).length) this.push(job); }
    const bridge = this.bridge(); if (!bridge) return;
    for (const job of this.store.list()) for (const step of job.steps) {
      if ((step.state !== 'running' && step.state !== 'waiting') || !step.threadId) continue;
      const snap = bridge.snapshot(step.threadId);
      if (!snap) { this.failStep(job, step, `${step.blobName}'s thread was lost when the app restarted`); continue; }
      if (snap.state === 'running') continue;
      if (snap.state === 'needs-you' && step.state === 'waiting') continue; // already told
      if (o.minAgeMs && this.now() - (step.startedAt ?? 0) < o.minAgeMs) continue; // a settle that is about to arrive on its own
      // The app restarted mid-turn: what the blob wrote is half an answer, not a result to check and accept.
      if (snap.interrupted && (step.state === 'running' || step.state === 'waiting')) { this.failStep(job, step, `the app restarted while ${step.blobName} was working, so the step was cut off. Send it again (delegate_to) if it is still wanted`); continue; }
      this.absorbSnapshot(job, step, snap, snap.state !== 'error');
    }
    await this.pump();
  }

  // ── reading ──────────────────────────────────────────────────────────────────────────────────────
  get(jobId: string): JobRec | null { return this.find(jobId); }
  card(jobId: string): JobCardWire | null { const j = this.find(jobId); return j ? jobCard(j) : null; }
  private need(jobId: string, stepId: string): { job: JobRec; step: JobStepRec } | { error: string } {
    const job = this.find(jobId);
    if (!job) return { error: this.noJob(jobId) };
    const step = job.steps.find((s) => s.id === stepId);
    if (!step) return { error: `job ${jobId} has no step ${stepId}` };
    return { job, step };
  }

  /** Block until the named steps have left queued/running (or the timeout, or a new user message). */
  async waitFor(jobId: string, stepIds: string[] | null, timeoutMs: number, o: { pollMs?: number; interrupted?: () => boolean } = {}): Promise<{ job: JobRec; steps: JobStepRec[]; timedOut: boolean; interrupted: boolean } | { error: string }> {
    const job = this.find(jobId);
    if (!job) return { error: this.noJob(jobId) };
    const pick = () => (stepIds && stepIds.length ? job.steps.filter((s) => stepIds.includes(s.id)) : job.steps);
    if (stepIds && stepIds.length) { const missing = stepIds.filter((id) => !job.steps.some((s) => s.id === id)); if (missing.length) return { error: `job ${jobId} has no step ${missing.join(', ')}` }; }
    const pending = (s: JobStepRec) => s.state === 'queued' || s.state === 'running' || !!s.launching;
    // real time on purpose: the injected clock is for step timestamps, a wait must end even when it stands still
    const deadline = Date.now() + timeoutMs;
    const poll = o.pollMs ?? 1000;
    for (;;) {
      this.sweepChecking();
      if (!pick().some(pending)) return { job, steps: pick(), timedOut: false, interrupted: false };
      if (o.interrupted?.()) return { job, steps: pick(), timedOut: false, interrupted: true };
      if (Date.now() >= deadline) return { job, steps: pick(), timedOut: true, interrupted: false };
      await new Promise<void>((resolve) => {
        const finish = () => { clearTimeout(t); this.off('changed', finish); resolve(); };
        const t = setTimeout(finish, Math.min(poll, Math.max(1, deadline - Date.now())));
        this.once('changed', finish);
      });
    }
  }
}

/** What the blob is told: the task, then the brief, then where to put the result. */
export function composePrompt(step: JobStepRec, target: BlobProfile): string {
  const where = step.output ?? path.join(target.workspace, 'outputs') + path.sep;
  return [
    `# ${step.title}`,
    '',
    step.brief ?? step.task,
    '',
    '---',
    `Write the deliverable to: ${where}`,
    'Stay inside your own folder. Finish with a short result summary (what you did, what you found, what is uncertain) that Kora can relay to the user.',
  ].join('\n');
}

// ── proposals ("Build me a blob") ──────────────────────────────────────────────────────────────────────────
export interface ProposalRec { id: string; version: number; draft: BlobDraft; state: 'open' | 'hired' | 'dismissed'; hiredBlobId: string | null; koraThreadId: string | null; createdAt: number; updatedAt: number }

class JsonTable<T extends { id: string }> {
  protected rows = new Map<string, T>();
  constructor(private file: string | null) {
    if (file) { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); for (const r of (j?.rows ?? []) as T[]) if (r && typeof r.id === 'string') this.rows.set(r.id, r); } catch { /* fresh */ } }
  }
  protected flush(): void { if (this.file) { try { writeAtomic(this.file, JSON.stringify({ v: 1, rows: [...this.rows.values()] }, null, 1) + '\n'); } catch { /* advisory */ } } }
  get(id: string): T | null { return this.rows.get(id) ?? null; }
  list(): T[] { return [...this.rows.values()]; }
}

export class ProposalStore extends JsonTable<ProposalRec> {
  constructor(o: { file?: string | null } = {}) { super(o.file === undefined ? path.join(blobsStoreDir(), 'proposals.json') : o.file); }
  create(draft: BlobDraft, koraThreadId: string | null): ProposalRec {
    const t = Date.now();
    const r: ProposalRec = { id: rid('prop'), version: 1, draft, state: 'open', hiredBlobId: null, koraThreadId, createdAt: t, updatedAt: t };
    this.rows.set(r.id, r); this.flush(); return r;
  }
  /** Replace the draft of an open proposal (version + 1, same card). */
  revise(id: string, draft: BlobDraft): ProposalRec | { error: string } {
    const r = this.rows.get(id);
    if (!r) return { error: `no proposal ${id}` };
    if (r.state !== 'open') return { error: `proposal ${id} was already ${r.state}; propose a new blob instead` };
    r.draft = draft; r.version += 1; r.updatedAt = Date.now(); this.flush(); return r;
  }
  markHired(id: string, blobId: string, finalDraft?: BlobDraft): ProposalRec | null {
    const r = this.rows.get(id); if (!r) return null;
    r.state = 'hired'; r.hiredBlobId = blobId; if (finalDraft) r.draft = finalDraft; r.version += 1; r.updatedAt = Date.now(); this.flush(); return r;
  }
  dismiss(id: string): ProposalRec | null {
    const r = this.rows.get(id); if (!r || r.state !== 'open') return r ?? null;
    r.state = 'dismissed'; r.version += 1; r.updatedAt = Date.now(); this.flush(); return r;
  }
  card(r: ProposalRec): ProposalCardWire { return { cardKind: 'proposal', cardId: r.id, version: r.version, draft: r.draft, state: r.state, hiredBlobId: r.hiredBlobId }; }
}

// ── confirm cards (edit / retire / hire) ───────────────────────────────────────────────────────────────────
export type ConfirmAction =
  | { kind: 'edit'; blobId: string; patch: { name?: string; title?: string; soul?: string; permission?: 'ask' | 'auto' | 'full' } }
  | { kind: 'retire'; blobId: string }
  | { kind: 'hire'; templateIds: string[] };

export interface ConfirmRec {
  id: string; version: number; action: ConfirmAction; blobId: string | null; blobName: string | null; summary: string; details: string[];
  state: 'open' | 'confirmed' | 'dismissed' | 'failed'; result: string | null; koraThreadId: string | null; createdAt: number;
}

export class ConfirmStore extends JsonTable<ConfirmRec> {
  constructor(o: { file?: string | null } = {}) { super(o.file === undefined ? path.join(blobsStoreDir(), 'confirms.json') : o.file); }
  create(i: { action: ConfirmAction; blobId: string | null; blobName: string | null; summary: string; details: string[]; koraThreadId: string | null; state?: ConfirmRec['state']; result?: string | null }): ConfirmRec {
    const r: ConfirmRec = { id: rid('conf'), version: 1, action: i.action, blobId: i.blobId, blobName: i.blobName, summary: i.summary, details: i.details, state: i.state ?? 'open', result: i.result ?? null, koraThreadId: i.koraThreadId, createdAt: Date.now() };
    this.rows.set(r.id, r); this.flush(); return r;
  }
  settle(id: string, state: 'confirmed' | 'dismissed' | 'failed', result: string | null): ConfirmRec | null {
    const r = this.rows.get(id); if (!r) return null;
    r.state = state; r.result = result; r.version += 1; this.flush(); return r;
  }
  card(r: ConfirmRec): ConfirmCardWire {
    return { cardKind: 'confirm', cardId: r.id, version: r.version, action: r.action.kind, blobId: r.blobId, blobName: r.blobName, summary: r.summary, details: r.details, state: r.state, result: r.result };
  }
}
