// Kora's team tools (docs/bots/ARCH.md 6.3, SPEC "Kora's tools") and the service that backs them.
//
//   teamToolSpecs   FleetToolSpec[] for the Chief: list_team, blob_status, plan_job, delegate_to, follow_up, accept_step,
//                   wait_for, cancel_job, propose_blob, edit_blob, retire_blob, list_templates, hire_template. (create_group / list_groups come from groups/tools.ts.)
//                   Every handler re-reads the CALLER's profile and refuses a non-Chief: nothing here trusts the prompt.
//   TeamService     owns the delegation log, job engine, cards, proposals and confirm cards; the one object the runtime,
//                   the ui-server RPCs and the MCP hub talk to.
//   BlobToolHub     the daemon side of `kora mcp --blobs`: bearer-token sessions, tool listing and tool calls for a blob,
//                   so Codex / OpenCode blobs get the same tools as the in-process Claude path (ruling 8).
//
// There is NO model-facing create: propose_blob only emits a proposal card. A blob exists after the user clicks Hire
// (TeamService.hireProposal) or confirms a hire_template card. Handlers never throw.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { FleetToolResult, FleetToolSpec, ParamShape } from '../session/fleet-tools';
import { BlobStoreError, MAX_SOUL_CHARS, type BlobStore } from './store';
import { DelegationLog } from './delegation';
import { journalChange, type ProfileSnapshot } from './undo';
import {
  ConfirmStore, JobEngine, JobStore, MAX_RUNNING_PER_BLOB, ProposalStore, jobStatus,
  type BlobDirectory, type BlobEngineBridge, type ConfirmAction, type ConfirmCardWire, type ConfirmRec, type JobCardWire, type JobRec, type JobStepRec, type PlanStepInput, type ProposalCardWire,
} from './jobs';
import { TeamCards, statusWord } from './cards';
import { STARTERS, canonicalTemplateId, getTemplate, hireFromDraft, hireTemplate, listTemplates, suggestName, normalizeOutfitItem, outfitWithArt, upgradeKoraSoul, refreshStarterSouls, validateDraft, type BlobDraft, type HireContext } from './templates';
import { CHIEF_BLOB_ID, type BlobCard, type BlobEngine, type BlobProfile, type BlobToolContext } from './types';

const ok = (text: string): FleetToolResult => ({ text });
const bad = (text: string): FleetToolResult => ({ text, isError: true });
const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

export interface TeamToolContext extends BlobToolContext {
  /** True when this thread runs with Full access (edit_blob then applies without a card). */
  fullAccess?: () => boolean;
  /** True when the user sent a message after `since` (wait_for returns early). */
  userMessageSince?: (since: number) => boolean;
}

export interface TeamServiceOptions {
  store: BlobStore;
  /** The engine bridge, attached late (`attachEngine`). */
  bridge?: () => BlobEngineBridge | null;
  /** Best installed engine at hire time (drafts with engine null). Default: the blob defaults, else Kora's own. */
  defaultEngine?: () => BlobEngine;
  /** Names of a blob's own skills for the cards. */
  skillsOf?: (blobId: string) => string[];
  /** Persistence off (tests): all stores in memory. */
  memoryOnly?: boolean;
  log?(msg: string): void;
  now?: () => number;
}

// ── the service ──────────────────────────────────────────────────────────────────────────────────────────
export class TeamService extends EventEmitter {
  readonly store: BlobStore;
  readonly delegation: DelegationLog;
  readonly jobStore: JobStore;
  readonly jobs: JobEngine;
  readonly proposals: ProposalStore;
  readonly confirms: ConfirmStore;
  readonly cards: TeamCards;
  private bridgeRef: BlobEngineBridge | null = null;
  private bridgeFn: () => BlobEngineBridge | null;
  private defaultEngineFn: () => BlobEngine;
  private promptHash = new Map<string, string>();
  private offSettled: (() => void) | null = null;
  private stopSweeper: (() => void) | null = null;
  private logFn: (m: string) => void;

  constructor(o: TeamServiceOptions) {
    super();
    this.store = o.store;
    this.logFn = o.log ?? (() => {});
    this.bridgeFn = o.bridge ?? (() => this.bridgeRef);
    this.defaultEngineFn = o.defaultEngine ?? (() => this.store.defaults().engine ?? this.store.get(CHIEF_BLOB_ID)?.engine ?? { instanceId: 'claude', model: 'sonnet', effort: null });
    const mem = o.memoryOnly ? null : undefined;
    this.delegation = new DelegationLog({ file: mem });
    this.jobStore = new JobStore({ dir: mem });
    this.proposals = new ProposalStore({ file: mem });
    this.confirms = new ConfirmStore({ file: mem });
    this.jobs = new JobEngine({ store: this.jobStore, blobs: o.store as BlobDirectory, log: this.delegation, bridge: () => this.bridgeFn(), ...(o.now ? { now: o.now } : {}) });
    this.cards = new TeamCards({ store: o.store, log: this.delegation, jobs: this.jobStore, ...(o.skillsOf ? { skillsOf: o.skillsOf } : {}), statusOf: (id) => this.statusOf(id), ...(o.now ? { now: o.now } : {}) });
  }

  /** Called with the ui-server's bridge (KoraBlobsLike.attachEngine). Subscribes to settles and reconciles after a restart. */
  attachEngine(bridge: BlobEngineBridge): void {
    this.offSettled?.();
    this.bridgeRef = bridge;
    this.offSettled = bridge.onSettled((e) => { void this.jobs.settle(e).catch((err) => this.logFn(`[team] settle failed: ${err?.message ?? err}`)); });
    this.stopSweeper?.();
    this.stopSweeper = this.jobs.startSweeper();
    void this.jobs.reconcile().catch((err) => this.logFn(`[team] reconcile failed: ${err?.message ?? err}`));
  }

  dispose(): void { this.offSettled?.(); this.stopSweeper?.(); this.cards.dispose(); }

  /** A deleted blob's delegation rows and the jobs it alone was in (they kept pointing at a blob that is gone). */
  forgetBlob(blobId: string): void {
    this.delegation.forgetBlob(blobId);
    this.jobStore.forgetBlob(blobId, (id) => !!this.store.get(id));
  }

  /** The attached engine bridge, or null before `attachEngine`. */
  bridge(): BlobEngineBridge | null { try { return this.bridgeFn(); } catch { return null; } }

  /** Live status word for a roster card: from the bridge's running-thread count plus waiting steps. */
  statusOf(blobId: string): string {
    const b = this.bridge();
    const running = b ? b.runningCount(blobId) : this.jobStore.activeStepsOf(blobId).filter((a) => a.step.state === 'running').length;
    const needsYou = this.jobStore.activeStepsOf(blobId).some((a) => a.step.state === 'waiting');
    return statusWord({ running, needsYou });
  }

  // ── Kora's prompt ──────────────────────────────────────────────────────────────────────────────────
  /** The block for blobSystemPromptText({ teamCards }). Records the hash this thread has seen. */
  systemTeamBlock(threadId: string): string {
    this.promptHash.set(threadId, this.cards.hash());
    return this.cards.teamBlock();
  }
  /** Per-turn delta for blobTurnContext: the block again only when the cards changed since this thread last saw them. */
  turnTeamDelta(threadId: string): string | null {
    const h = this.cards.hash();
    if (this.promptHash.get(threadId) === h) return null;
    this.promptHash.set(threadId, h);
    return `<team>\n${this.cards.render(true)}\n</team>`;
  }

  /** Move an untouched Phase 1 Kora to the full Chief SOUL (call from ensureKora). */
  upgradeKora(): boolean { const a = upgradeKoraSoul(this.store, CHIEF_BLOB_ID); return refreshStarterSouls(this.store).length > 0 || a; }

  // ── tools ──────────────────────────────────────────────────────────────────────────────────────────
  /** Team tools for the Chief; [] for every other blob (they never see them). */
  toolSpecs(ctx: TeamToolContext): FleetToolSpec[] {
    const caller = this.store.get(ctx.blobId);
    if (!caller || caller.role !== 'chief' || caller.archivedAt != null) return [];
    return teamToolSpecs(this, ctx);
  }

  hireContext(): HireContext { return { defaultEngine: this.defaultEngineFn() }; }

  /** Show a card in the calling thread (this turn) and fall back to the bridge when there is no live emitter. */
  show(ctx: Pick<BlobToolContext, 'threadId' | 'emitCard'>, card: BlobCard | JobCardWire | ProposalCardWire | ConfirmCardWire): void {
    try {
      if (ctx.emitCard) ctx.emitCard(card as BlobCard);
      else this.bridge()?.appendCard(ctx.threadId, card as any);
    } catch { /* cards are advisory */ }
  }
  private push(koraThreadId: string | null, card: ProposalCardWire | ConfirmCardWire): void {
    if (!koraThreadId) return;
    try { this.bridge()?.appendCard(koraThreadId, card); } catch { /* advisory */ }
  }
  /** A self-change receipt (with Undo) on Kora's thread: an edit applied, so the user can take it back. */
  private receipt(koraThreadId: string | null, u: { token: string; what: string }): void {
    if (!koraThreadId) return;
    try { this.bridge()?.appendCard(koraThreadId, { cardKind: 'self-change', cardId: `sc_${crypto.randomBytes(5).toString('hex')}`, version: 1, what: u.what, undoToken: u.token, undone: false } as any); } catch { /* advisory */ }
  }
  private note(koraThreadId: string | null, text: string): void {
    if (!koraThreadId) return;
    try { this.bridge()?.queueNote(koraThreadId, text); } catch { /* advisory */ }
  }

  // ── Hire (proposal cards) ──────────────────────────────────────────────────────────────────────────
  /**
   * The user clicked Hire / saved a Tweak on a proposal card: create the blob (a possibly edited `draft` wins), mark the
   * proposal hired (card v+1), tell Kora to offer a first task. Throws BlobStoreError on a name clash.
   */
  hireProposal(proposalId: string, draft?: BlobDraft): BlobProfile {
    const rec = this.proposals.get(proposalId);
    if (!rec) throw new BlobStoreError('unknown', `No proposal ${proposalId}.`);
    if (rec.state !== 'open') throw new BlobStoreError('unknown', `That proposal was already ${rec.state}.`);
    const d = draft ?? rec.draft;
    const problems = validateDraft(d, { maxSoul: MAX_SOUL_CHARS });
    if (problems.length) throw new BlobStoreError('bad-name', problems.join('; '));
    const profile = hireFromDraft(this.store, d, this.hireContext());
    const done = this.proposals.markHired(proposalId, profile.id, d)!;
    this.push(done.koraThreadId, this.proposals.card(done));
    this.note(done.koraThreadId, `[kora] The user hired ${profile.name} (${profile.title}). Welcome them in one line and offer a first task.`);
    return profile;
  }
  dismissProposal(proposalId: string): boolean {
    const r = this.proposals.dismiss(proposalId);
    if (!r) return false;
    this.push(r.koraThreadId, this.proposals.card(r));
    return true;
  }

  // ── confirm cards ──────────────────────────────────────────────────────────────────────────────────
  /** The user clicked a confirm card. */
  resolveConfirm(cardId: string, accept: boolean): { ok: boolean; message: string; profiles: BlobProfile[] } {
    const rec = this.confirms.get(cardId);
    if (!rec) return { ok: false, message: 'That card is gone.', profiles: [] };
    if (rec.state !== 'open') return { ok: false, message: `That was already ${rec.state}.`, profiles: [] };
    if (!accept) {
      const r = this.confirms.settle(cardId, 'dismissed', 'Not done.')!;
      this.push(r.koraThreadId, this.confirms.card(r));
      this.note(r.koraThreadId, `[kora] The user declined: ${r.summary}`);
      return { ok: true, message: 'Not done.', profiles: [] };
    }
    const run = this.applyAction(rec.action);
    const r = this.confirms.settle(cardId, run.ok ? 'confirmed' : 'failed', run.message)!;
    this.push(r.koraThreadId, this.confirms.card(r));
    if (run.undo) this.receipt(r.koraThreadId, run.undo);
    this.note(r.koraThreadId, run.ok ? `[kora] Done at the user's click: ${r.summary}. ${run.message}${run.profiles.length ? ' Offer each new blob a first task.' : ''}` : `[kora] That did not work: ${run.message}`);
    return run;
  }

  private applyAction(a: ConfirmAction): { ok: boolean; message: string; profiles: BlobProfile[]; undo?: { token: string; what: string } } {
    try {
      if (a.kind === 'retire') {
        const b = this.store.get(a.blobId);
        if (!b) return { ok: false, message: 'That blob no longer exists.', profiles: [] };
        for (const act of this.jobStore.activeStepsOf(b.id)) void this.jobs.cancel(act.job.id, act.step.id);
        this.store.archive(a.blobId);
        return { ok: true, message: `${b.name} left the team. Its threads, memory and folder are kept; Rehire brings it back.`, profiles: [] };
      }
      if (a.kind === 'edit') {
        const b = this.store.get(a.blobId);
        if (!b) return { ok: false, message: 'That blob no longer exists.', profiles: [] };
        const p = a.patch;
        // Ruling (b): the whole profile + SOUL goes into the undo journal BEFORE anything changes, so one Undo restores it.
        const before: ProfileSnapshot = { name: b.name, title: b.title, permission: b.permission, soul: this.store.soul(b.id) };
        const changed = [p.name !== undefined && 'name', p.title !== undefined && 'title', p.permission !== undefined && 'permission', p.soul !== undefined && 'soul'].filter(Boolean).join(', ');
        const entry = journalChange({ blobId: b.id, kind: 'profile', what: `Kora changed ${b.name} (${changed})`, before });
        if (p.soul !== undefined) this.store.writeSoul(b.id, p.soul);
        const patch: Record<string, unknown> = {};
        if (p.name !== undefined) patch.name = p.name;
        if (p.title !== undefined) patch.title = p.title;
        if (p.permission !== undefined) patch.permission = p.permission;
        if (Object.keys(patch).length) this.store.update(b.id, patch as any);
        return { ok: true, message: `${b.name} updated.`, profiles: [], undo: { token: entry.token, what: entry.what } };
      }
      const hired: BlobProfile[] = []; const notes: string[] = [];
      for (const id of a.templateIds) {
        const r = hireTemplate(this.store, id, this.hireContext());
        if ('error' in r) notes.push(r.error); else { hired.push(r.profile); notes.push(r.rehired ? `${r.profile.name} is back on the team` : `${r.profile.name} joined`); }
      }
      return { ok: hired.length > 0, message: notes.join('; '), profiles: hired };
    } catch (e: any) {
      return { ok: false, message: String(e?.message ?? e), profiles: [] };
    }
  }

  /** The gallery's Hire button (`blobs.templates.hire`): the user clicked, so no confirm card. Rehires archived starters. */
  hireStarters(templateIds: string[]): { profiles: BlobProfile[]; errors: string[] } {
    const profiles: BlobProfile[] = []; const errors: string[] = [];
    for (const id of templateIds) {
      const r = hireTemplate(this.store, id, this.hireContext());
      if ('error' in r) errors.push(r.error); else profiles.push(r.profile);
    }
    return { profiles, errors };
  }

  /** A confirm card for the model's edit / retire / hire (open), or an applied receipt on Full access. */
  requestConfirm(ctx: TeamToolContext, i: { action: ConfirmAction; blobId: string | null; blobName: string | null; summary: string; details: string[]; applyNow?: boolean }): ConfirmRec {
    const rec = this.confirms.create({ action: i.action, blobId: i.blobId, blobName: i.blobName, summary: i.summary, details: i.details, koraThreadId: ctx.threadId });
    if (i.applyNow) {
      const run = this.applyAction(i.action);
      const done = this.confirms.settle(rec.id, run.ok ? 'confirmed' : 'failed', run.message)!;
      this.show(ctx, this.confirms.card(done));
      if (run.undo) this.show(ctx, { cardKind: 'self-change', cardId: `sc_${crypto.randomBytes(5).toString('hex')}`, version: 1, what: run.undo.what, undoToken: run.undo.token, undone: false });
      return done;
    }
    this.show(ctx, this.confirms.card(rec));
    return rec;
  }

  /** Resolve "Popo" / a blob id to an ACTIVE blob. */
  resolveBlob(ref: string): BlobProfile | null {
    const r = String(ref ?? '').trim();
    if (!r) return null;
    const b = this.store.byName(r) ?? this.store.get(r);
    return b && b.archivedAt == null ? b : null;
  }
}

// ── tool specs ───────────────────────────────────────────────────────────────────────────────────────────
function chiefCheck(svc: TeamService, ctx: TeamToolContext): string | null {
  const caller = svc.store.get(ctx.blobId);
  if (caller && caller.role === 'chief' && caller.archivedAt == null) return null;
  return `${caller?.name ?? 'This blob'} cannot use team tools: only Kora, the Chief, gives work to other blobs or changes the team. If a teammate fits better, tell the user and offer to ask Kora.`;
}

const STEP_ITEMS: ParamShape = {
  id: { type: 'string', description: 'short step id, e.g. s1' },
  blob: { type: 'string', description: 'the blob that does it (a name from list_team)' },
  task: { type: 'string', description: 'one line: what this step produces' },
  kind: { type: 'string', optional: true, description: 'research | writing | analysis | planning | shopping | travel | social | build | other (feeds the delegation log)' },
  dependsOn: { type: 'string[]', optional: true, description: 'ids of steps that must be accepted first' },
  output: { type: 'string', optional: true, description: 'file the step writes, relative to that blob\'s outputs/ (two steps may never share one)' },
};

export function teamToolSpecs(svc: TeamService, ctx: TeamToolContext): FleetToolSpec[] {
  const guard = <A extends Record<string, unknown>>(fn: (a: A) => Promise<FleetToolResult> | FleetToolResult) =>
    async (a: Record<string, unknown>): Promise<FleetToolResult> => {
      const refusal = chiefCheck(svc, ctx);
      if (refusal) return bad(refusal);
      try { return await fn((a ?? {}) as A); } catch (e: any) { return bad(String(e?.message ?? e)); }
    };
  const needBlob = (ref: unknown): BlobProfile | string => svc.resolveBlob(String(ref ?? '')) ?? `No active blob called "${String(ref ?? '')}". Call list_team for the names.`;
  const stepLine = (s: JobStepRec) => `${s.id} (${s.blobName}, ${s.kind}) ${s.state}${s.queuedReason && s.state === 'queued' ? ` [${s.queuedReason}]` : ''}`;
  const jobSummary = (j: JobRec) => `Job ${j.id} "${j.title}" is ${jobStatus(j)}:\n` + j.steps.map((s) => `- ${stepLine(s)}${s.dependsOn.length ? ` after ${s.dependsOn.join(', ')}` : ''}: ${s.title}`).join('\n');

  return [
    {
      name: 'list_team',
      description: 'The full roster with each blob\'s capability card (what it does, apps, what it did lately, what it is good at) and its live status, plus starters you could hire. Use it before planning or when the cards in your prompt are not enough.',
      params: {},
      handler: guard(async () => {
        const text = svc.cards.render(true);
        const hired = new Set(svc.store.list().map((b) => canonicalTemplateId(b.templateId)).filter(Boolean));
        const free = STARTERS.filter((s) => !hired.has(s.id) && !svc.store.byName(s.name)).map((s) => `${s.name} (${s.title})`);
        const retired = svc.store.list({ includeArchived: true }).filter((b) => b.archivedAt != null).length;
        return ok([
          text || 'No other blobs yet.',
          free.length ? `Starters not on the team: ${free.join(', ')}. Use list_templates / hire_template.` : '',
          retired ? `${retired} retired blob(s) can be rehired by the user.` : '',
          `A blob running ${MAX_RUNNING_PER_BLOB} threads is busy: queue the step or pick another blob.`,
        ].filter(Boolean).join('\n\n'));
      }),
    },
    {
      name: 'blob_status',
      description: 'A live view of one blob: its running threads, the job steps it has, and what it finished lately.',
      params: { blob: { type: 'string', description: 'blob name' } },
      handler: guard(async (a) => {
        const b = needBlob(a.blob); if (typeof b === 'string') return bad(b);
        const bridge = svc.bridge();
        const running = bridge ? bridge.runningCount(b.id) : 0;
        const lines = [`${b.name} · ${b.title} · ${svc.statusOf(b.id)} · ${running}/${MAX_RUNNING_PER_BLOB} threads running${running >= MAX_RUNNING_PER_BLOB ? ' (busy: new work queues)' : ' (can take new work)'}`];
        const act = svc.jobStore.activeStepsOf(b.id);
        if (act.length) {
          lines.push('Job steps now:');
          for (const { job, step } of act) {
            const snap = step.threadId ? bridge?.snapshot(step.threadId) : null;
            lines.push(`- ${job.id}/${step.id} ${step.state}: ${step.title}${snap?.finalText ? ` — "${cap(snap.finalText.replace(/\s+/g, ' '), 140)}"` : ''}`);
          }
        } else lines.push('No job steps in progress.');
        const recent = svc.delegation.lately(b.id, 3);
        if (recent.length) lines.push('Recently: ' + recent.map((r) => `"${r.title}" ${r.outcome}`).join('; '));
        return ok(lines.join('\n'));
      }),
    },
    {
      name: 'plan_job',
      description: 'Plan a multi-blob job: a title and a list of steps (which blob does each, what depends on what). Shows the user a job card. Two steps may never write the same file. This does not start anything: call delegate_to for each step that is ready, with a self-contained brief.',
      params: { title: { type: 'string', description: 'short job title' }, steps: { type: 'object[]', items: STEP_ITEMS, description: '1 to 12 steps' } },
      handler: guard(async (a) => {
        const r = svc.jobs.plan({ title: String(a.title ?? ''), steps: (a.steps as PlanStepInput[]) ?? [], koraThreadId: ctx.threadId });
        if ('error' in r) return bad(`The plan was not accepted: ${r.error}`);
        svc.show(ctx, r.card);
        const ready = r.job.steps.filter((s) => s.dependsOn.length === 0).map((s) => s.id);
        return ok(`${jobSummary(r.job)}\n\nThe job card is on screen. Now call delegate_to (job="${r.job.id}", step=...) for the steps that are ready: ${ready.join(', ')}. Steps that depend on others start after you accept those.`);
      }),
    },
    {
      name: 'delegate_to',
      description: 'Give a task to a blob in a NEW thread, marked "from Kora". The brief must stand alone (the blob has not seen this chat): the goal, the inputs (facts, links, files, what you know about the user that matters), what done looks like, the output file. For a planned step pass job + step; without them it makes a one-step job. A blob already running 3 threads queues the step.',
      params: {
        blob: { type: 'string', description: 'blob name' },
        task: { type: 'string', description: 'one-line task title' },
        brief: { type: 'string', description: 'the full self-contained brief' },
        job: { type: 'string', optional: true, description: 'job id from plan_job' },
        step: { type: 'string', optional: true, description: 'step id from plan_job' },
        kind: { type: 'string', optional: true, description: 'task kind for the delegation log (ad hoc delegations)' },
        output: { type: 'string', optional: true, description: 'output file relative to the blob\'s outputs/ (ad hoc delegations)' },
      },
      handler: guard(async (a) => {
        const b = needBlob(a.blob); if (typeof b === 'string') return bad(b);
        if (b.role === 'chief') return bad('You are the Chief; do that step yourself.');
        let jobId = typeof a.job === 'string' && a.job ? a.job : '';
        let stepId = typeof a.step === 'string' && a.step ? a.step : '';
        if (!!jobId !== !!stepId) return bad('Pass both job and step for a planned step, or neither for a one-off delegation.');
        if (!jobId) {
          const task = String(a.task ?? '').trim();
          if (!task) return bad('task is empty');
          const planned = svc.jobs.plan({ title: cap(task, 80), koraThreadId: ctx.threadId, steps: [{ id: 's1', blob: b.name, task, kind: typeof a.kind === 'string' ? a.kind : undefined, output: typeof a.output === 'string' ? a.output : undefined }] });
          if ('error' in planned) return bad(planned.error);
          jobId = planned.job.id; stepId = 's1';
          svc.show(ctx, planned.card);
        } else {
          const step = svc.jobs.get(jobId)?.steps.find((s) => s.id === stepId);
          if (step && step.blobId !== b.id) return bad(`Step ${stepId} is planned for ${step.blobName}, not ${b.name}. Delegate it to ${step.blobName}, or plan a new job.`);
        }
        const r = await svc.jobs.delegate(jobId, stepId, String(a.brief ?? ''));
        if (!r.ok) return bad(r.error);
        if (r.state === 'queued') return ok(`${b.name} is ${r.reason === 'file' ? 'waiting on a shared file' : 'busy'} (${r.detail}). The step is queued (${jobId}/${stepId}) and starts by itself when there is room. Plan around it or pick wait_for.`);
        return ok(`${b.name} has it: new thread started (${jobId}/${stepId}). Use wait_for when you need the result; independent steps can run in parallel.`);
      }),
    },
    {
      name: 'follow_up',
      description: 'Send ONE follow-up into the same thread when a finished step is off (say exactly what to fix). Only for a step you are checking.',
      params: { job: { type: 'string' }, step: { type: 'string' }, message: { type: 'string', description: 'what to fix, precisely' } },
      handler: guard(async (a) => {
        const r = await svc.jobs.followUp(String(a.job ?? ''), String(a.step ?? ''), String(a.message ?? ''));
        return r.ok ? ok('Follow-up sent in the same thread. Use wait_for to collect the revised result.') : bad(r.error);
      }),
    },
    {
      name: 'accept_step',
      description: 'The result of a finished step is good: mark it done (it feeds the delegation log) so steps that depend on it can start.',
      params: { job: { type: 'string' }, step: { type: 'string' } },
      handler: guard(async (a) => {
        const r = await svc.jobs.accept(String(a.job ?? ''), String(a.step ?? ''));
        if (!r.ok) return bad(r.error);
        const j = svc.jobs.get(String(a.job));
        const ready = j ? j.steps.filter((s) => s.state === 'planned' && s.dependsOn.every((d) => j.steps.find((x) => x.id === d)?.state === 'done')).map((s) => s.id) : [];
        return ok(`Accepted.${ready.length ? ` Ready to delegate now: ${ready.join(', ')}.` : ''}${j && jobStatus(j) === 'done' ? ' Every step is done: write the combined answer for the user.' : ''}`);
      }),
    },
    {
      name: 'wait_for',
      description: 'Wait for a job\'s steps (or the listed ones) to finish and return each step\'s result, output files and final text. Call it ONCE for every started step (omit steps, or list them all): it returns when all of them have left running, and each call costs a full turn. Returns early if the user writes. Then check each result against its brief: accept_step or follow_up.',
      params: { job: { type: 'string' }, steps: { type: 'string[]', optional: true, description: 'step ids; default all started steps' }, timeoutSec: { type: 'number', optional: true, description: 'up to 240, default 120' } },
      handler: guard(async (a) => {
        const sec = Math.min(240, Math.max(1, Number(a.timeoutSec) || 120));
        const t0 = Date.now();
        const r = await svc.jobs.waitFor(String(a.job ?? ''), Array.isArray(a.steps) ? (a.steps as unknown[]).map(String) : null, sec * 1000, { interrupted: () => ctx.userMessageSince?.(t0) ?? false });
        if ('error' in r) return bad(r.error);
        return ok(renderWait(r));
      }),
    },
    {
      name: 'cancel_job',
      description: 'Cancel a whole job, or one step of it. Running threads are stopped when possible. Only when the user asks or the plan clearly died.',
      params: { job: { type: 'string' }, step: { type: 'string', optional: true } },
      handler: guard(async (a) => {
        const r = await svc.jobs.cancel(String(a.job ?? ''), typeof a.step === 'string' && a.step ? a.step : null);
        return r.ok ? ok(r.cancelled.length ? `Cancelled: ${r.cancelled.join(', ')}.` : 'Nothing to cancel (already finished).') : bad(r.error);
      }),
    },
    {
      name: 'propose_blob',
      description: 'Design a new blob: shows the user a PROPOSAL CARD (name, job, how it works, model, permission, apps, routines) with Hire / Tweak / Not this. It never creates anything: the blob exists only after the user clicks Hire. To change a proposal ("less chatty", "a top hat"), call again with proposalId and just the fields that change; the same card updates in place. For a new proposal pass title, job and soul.',
      params: {
        proposalId: { type: 'string', optional: true, description: 'update this open proposal instead of making a new one' },
        name: { type: 'string', optional: true, description: 'a short fun name (Tiki, Zibbo...); omit and one is picked' },
        title: { type: 'string', optional: true, description: 'role in one or two words: "Refund Watcher"' },
        job: { type: 'string', optional: true, description: 'one line: what it does' },
        howItWorks: { type: 'string[]', optional: true, description: 'three short bullets' },
        soul: { type: 'string', optional: true, description: 'its full SOUL: voice, concrete working method, limits, three example asks, apps, routine' },
        permission: { type: 'string', optional: true, enum: ['ask', 'auto', 'full'] },
        head: { type: 'string', optional: true, description: 'outfit head item, ONE of: top-hat, beanie, cap, beret, headphones, flower (never crown). A blob wears one accessory: head OR face' },
        face: { type: 'string', optional: true, description: 'outfit face item, ONE of: round-glasses, square-glasses, monocle, sunglasses. Leave both out and one is picked' },
        apps: { type: 'string[]', optional: true, description: 'connected apps it needs (Connect chips)' },
        skills: { type: 'string[]', optional: true },
        routines: { type: 'object[]', optional: true, items: { title: { type: 'string' }, cadence: { type: 'string' } }, description: 'suggested routines; stored paused' },
      },
      handler: guard(async (a) => {
        const strs = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map(String).filter(Boolean) : undefined);
        const has = (k: string) => a[k] !== undefined && a[k] !== null && a[k] !== '';
        const outfitTouched = has('head') || has('face');
        const mergeOutfit = (cur: BlobDraft['outfit']): BlobDraft['outfit'] => (outfitTouched ? { head: has('head') ? normalizeOutfitItem(a.head) : cur?.head ?? null, face: has('face') ? normalizeOutfitItem(a.face) : cur?.face ?? null, neck: null } : cur);
        const taken = () => new Set(svc.store.list().map((b) => b.name.toLowerCase()));
        let draft: BlobDraft;
        let rec = typeof a.proposalId === 'string' && a.proposalId ? svc.proposals.get(a.proposalId) : null;
        if (a.proposalId && !rec) return bad(`No proposal ${String(a.proposalId)}. Leave proposalId out to make a new one.`);
        if (rec) {
          if (rec.state !== 'open') return bad(`That proposal was already ${rec.state}. Make a new one if the user still wants a blob.`);
          const d = rec.draft;
          draft = {
            ...d, name: has('name') ? String(a.name).trim() : d.name, title: has('title') ? String(a.title).trim() : d.title, job: has('job') ? String(a.job).trim() : d.job,
            howItWorks: strs(a.howItWorks) ?? d.howItWorks, soul: has('soul') ? String(a.soul) : d.soul, permission: has('permission') ? (String(a.permission) as BlobDraft['permission']) : d.permission,
            outfit: mergeOutfit(d.outfit), apps: strs(a.apps) ?? d.apps, skills: strs(a.skills) ?? d.skills,
            routines: Array.isArray(a.routines) ? (a.routines as any[]).map((r) => ({ title: String(r?.title ?? ''), cadence: String(r?.cadence ?? '') })).filter((r) => r.title) : d.routines,
          };
        } else {
          for (const k of ['title', 'job', 'soul']) if (!has(k)) return bad(`A new proposal needs ${k}.`);
          draft = {
            name: has('name') ? String(a.name).trim() : suggestName(taken()), title: String(a.title).trim(), job: String(a.job).trim(), howItWorks: strs(a.howItWorks) ?? [], soul: String(a.soul),
            engine: svc.hireContext().defaultEngine, permission: has('permission') ? (String(a.permission) as BlobDraft['permission']) : 'auto', outfit: mergeOutfit({ head: null, face: null, neck: null }),
            apps: strs(a.apps) ?? [], skills: strs(a.skills) ?? [],
            routines: Array.isArray(a.routines) ? (a.routines as any[]).map((r) => ({ title: String(r?.title ?? ''), cadence: String(r?.cadence ?? '') })).filter((r) => r.title) : [], templateId: null,
          };
        }
        const problems = validateDraft(draft, { maxSoul: MAX_SOUL_CHARS });
        const clash = svc.store.byName(draft.name);
        if (clash) problems.push(`${clash.name} is already on the team; pick another name`);
        draft = { ...draft, outfit: outfitWithArt(draft.outfit, draft.name) };
        if (problems.length) return bad(`The proposal card was NOT shown yet: ${problems.join('; ')}. Fix that and call propose_blob again right away. The user has seen nothing, so do not mention this error or write a proposal message in the chat.`);
        if (rec) { const r = svc.proposals.revise(rec.id, draft); if ('error' in r) return bad(r.error); rec = r; }
        else rec = svc.proposals.create(draft, ctx.threadId);
        svc.show(ctx, svc.proposals.card(rec));
        return ok(`The proposal card for ${draft.name} (${draft.title}) is on screen, version ${rec.version} (proposalId ${rec.id}). Now stop and wait for the user: Hire, Tweak or Not this. Do NOT create the blob yourself; you cannot. If they ask for changes, call propose_blob again with this proposalId.`);
      }),
    },
    {
      name: 'edit_blob',
      description: 'Change another blob: name, title, soul (the COMPLETE new text) or permission. The user confirms on a card, unless this chat has Full access (then it applies at once and leaves a receipt).',
      params: {
        blob: { type: 'string' }, name: { type: 'string', optional: true }, title: { type: 'string', optional: true },
        soul: { type: 'string', optional: true, description: 'the complete new SOUL' }, permission: { type: 'string', optional: true, enum: ['ask', 'auto', 'full'] },
      },
      handler: guard(async (a) => {
        const b = needBlob(a.blob); if (typeof b === 'string') return bad(b);
        const patch: { name?: string; title?: string; soul?: string; permission?: 'ask' | 'auto' | 'full' } = {};
        const details: string[] = [];
        if (typeof a.name === 'string' && a.name.trim() && a.name.trim() !== b.name) { const c = svc.store.byName(a.name); if (c && c.id !== b.id) return bad(`${c.name} already exists.`); patch.name = a.name.trim(); details.push(`Name: ${b.name} -> ${patch.name}`); }
        if (typeof a.title === 'string' && a.title.trim() && a.title.trim() !== b.title) { patch.title = a.title.trim(); details.push(`Title: ${b.title} -> ${patch.title}`); }
        if (typeof a.permission === 'string' && a.permission !== b.permission) { patch.permission = a.permission as any; details.push(`Permission: ${b.permission} -> ${patch.permission}`); }
        if (typeof a.soul === 'string' && a.soul.trim()) {
          if (a.soul.length > MAX_SOUL_CHARS) return bad(`soul is too long (max ${MAX_SOUL_CHARS} characters)`);
          if (a.soul.trim() !== svc.store.soul(b.id).trim()) { patch.soul = a.soul; details.push(`Soul rewritten (${a.soul.length} characters)`); }
        }
        if (!details.length) return ok(`Nothing to change on ${b.name}.`);
        const full = ctx.fullAccess?.() === true;
        const rec = svc.requestConfirm(ctx, { action: { kind: 'edit', blobId: b.id, patch }, blobId: b.id, blobName: b.name, summary: `Update ${b.name}`, details, applyNow: full });
        return full ? ok(rec.state === 'confirmed' ? `Done (Full access): ${rec.result}` : `That did not work: ${rec.result}`) : ok(`A card asks the user to confirm the change to ${b.name}. Wait for their answer; do not repeat the request.`);
      }),
    },
    {
      name: 'retire_blob',
      description: 'Retire (archive) a blob. ALWAYS shows a confirm card, even with Full access. Its threads, memory and folder are kept and it can be rehired. You cannot retire yourself.',
      params: { blob: { type: 'string' } },
      handler: guard(async (a) => {
        const b = needBlob(a.blob); if (typeof b === 'string') return bad(b);
        if (b.role === 'chief') return bad('The Chief cannot be retired.');
        const act = svc.jobStore.activeStepsOf(b.id).length;
        svc.requestConfirm(ctx, { action: { kind: 'retire', blobId: b.id }, blobId: b.id, blobName: b.name, summary: `Retire ${b.name}`, details: ['Leaves the roster; threads, memory and the folder are kept', 'Rehire brings it back', ...(act ? [`${act} job step(s) in progress will be cancelled`] : [])] });
        return ok(`A card asks the user to confirm retiring ${b.name}. Wait for their answer.`);
      }),
    },
    {
      name: 'list_templates',
      description: 'The ten starter blobs you can hire (Popo, Bobble, Dimp, Junip, Wobbo, Tibbo, Mibble, Zonk, Plonk, Fizzle): job, what each wants, and whether it is already on the team.',
      params: {},
      handler: guard(async () => {
        const lines = listTemplates().map((t) => {
          const on = svc.store.byName(t.draft.name);
          return `- ${t.id}: ${t.draft.name} · ${t.draft.title} — ${t.draft.job}${t.wants.length ? ` (${t.wants.join('; ')})` : ''}${on ? ' [on the team]' : ''}`;
        });
        return ok(lines.join('\n'));
      }),
    },
    {
      name: 'hire_template',
      description: 'Offer to hire starter blobs: shows a confirm card; they join when the user clicks. One card for several templates is fine.',
      params: { templates: { type: 'string[]', description: 'template ids from list_templates, e.g. ["popo","junip"]' } },
      handler: guard(async (a) => {
        const ids = (Array.isArray(a.templates) ? a.templates : []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
        if (!ids.length) return bad('Pass at least one template id (see list_templates).');
        const picks = ids.map((id) => ({ id, t: getTemplate(id) }));
        const unknown = picks.filter((p) => !p.t).map((p) => p.id);
        if (unknown.length) return bad(`Unknown template(s): ${unknown.join(', ')}. See list_templates.`);
        const fresh = picks.filter((p) => !svc.store.byName(p.t!.draft.name));
        if (!fresh.length) return bad(`${picks.map((p) => p.t!.draft.name).join(', ')} ${picks.length > 1 ? 'are' : 'is'} already on the team.`);
        const names = fresh.map((p) => p.t!.draft.name);
        svc.requestConfirm(ctx, { action: { kind: 'hire', templateIds: fresh.map((p) => p.id) }, blobId: null, blobName: null, summary: `Hire ${names.join(', ')}`, details: fresh.map((p) => `${p.t!.draft.name} · ${p.t!.draft.title}: ${p.t!.draft.job}`) });
        return ok(`A card asks the user to hire ${names.join(', ')}. Wait for their click, then offer each a first task.`);
      }),
    },
  ];
}

/** wait_for's report: per step status, gist, outputs and (capped) final text, with the next move for each. */
export function renderWait(r: { job: JobRec; steps: JobStepRec[]; timedOut: boolean; interrupted: boolean }): string {
  const per = Math.max(400, Math.floor(6000 / Math.max(1, r.steps.length)));
  const lines: string[] = [`Job ${r.job.id} "${r.job.title}" is ${jobStatus(r.job)}.`];
  if (r.interrupted) lines.push('The user just wrote to you: read their message first, then decide whether to keep waiting.');
  else if (r.timedOut) lines.push('Timed out: some steps are still running. Call wait_for again, or update the user.');
  for (const s of r.steps) {
    lines.push('', `[${s.id}] ${s.blobName} · ${s.state}${s.queuedReason && s.state === 'queued' ? ` (${s.queuedReason})` : ''} — ${s.title}`);
    if (s.state === 'planned') lines.push('  not started: call delegate_to');
    if (s.outputs.length) lines.push(`  files: ${s.outputs.join(', ')}`);
    if (s.finalText) lines.push(`  result: ${cap(s.finalText, per)}`);
    else if (s.resultGist && s.state !== 'running') lines.push(`  note: ${s.resultGist}`);
    if (s.error) lines.push(`  error: ${s.error}`);
    if (s.state === 'checking') lines.push('  next: check it against the brief; accept_step, or follow_up once if it is off');
    if (s.state === 'waiting') lines.push('  next: it needs the user (an approval or an answer in that thread); tell them, do not answer for them');
    if (s.state === 'failed') lines.push('  next: retry with a clearer brief, give it to a better-fit blob, do it yourself, or ask the user');
  }
  return lines.join('\n').slice(0, 7500);
}

/** Every tool the blob gets: its own self tools (given) plus, for the Chief only, the team tools. */
export function allBlobToolSpecs(self: FleetToolSpec[], svc: TeamService, ctx: TeamToolContext): FleetToolSpec[] {
  return [...self, ...svc.toolSpecs(ctx)];
}

// ── the MCP hub (daemon side of `kora mcp --blobs`) ───────────────────────────────────────────────────────
export interface McpSession {
  blobId: string;
  threadId: string;
  agent: string;
  cwd: string;
  emitCard?: BlobToolContext['emitCard'];
  attachOutput?: BlobToolContext['attachOutput'];
  fullAccess?: () => boolean;
  userMessageSince?: (since: number) => boolean;
  askApproval?: BlobToolContext['askApproval'];
}
export interface McpToolInfo { name: string; description: string; params: ParamShape }
export interface BlobToolHubOptions {
  /** All tools for a blob (self + team for the Chief): the runtime's toolSpecs. */
  specsFor(ctx: TeamToolContext): FleetToolSpec[];
  /** Resolve the caller (the hub re-checks the token's blob against it). */
  getBlob(id: string): BlobProfile | null;
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export class BlobToolHub {
  private sessions = new Map<string, McpSession>();
  constructor(private o: BlobToolHubOptions) {}

  /** A bearer token for one blob session; pass it to the CLI on argv (`--token`). */
  issue(session: McpSession): string {
    const token = crypto.randomBytes(24).toString('base64url');
    this.sessions.set(sha(token), session);
    return token;
  }
  revoke(token: string): void { this.sessions.delete(sha(token)); }
  revokeThread(threadId: string): void { for (const [k, s] of this.sessions) if (s.threadId === threadId) this.sessions.delete(k); }
  size(): number { return this.sessions.size; }

  private auth(blobId: string, token: string): McpSession | null {
    if (typeof token !== 'string' || !token) return null;
    const s = this.sessions.get(sha(token));
    if (!s || s.blobId !== blobId) return null;
    const b = this.o.getBlob(blobId);
    return b && b.archivedAt == null ? s : null;
  }
  private ctxOf(s: McpSession): TeamToolContext {
    return { blobId: s.blobId, threadId: s.threadId, agent: s.agent, cwd: s.cwd, ...(s.emitCard ? { emitCard: s.emitCard } : {}), ...(s.attachOutput ? { attachOutput: s.attachOutput } : {}), ...(s.fullAccess ? { fullAccess: s.fullAccess } : {}), ...(s.userMessageSince ? { userMessageSince: s.userMessageSince } : {}), ...(s.askApproval ? { askApproval: s.askApproval } : {}) };
  }

  /** `blobs.mcp.hello`: the tools this blob may use. A bad token gets an error, never a list. */
  hello(p: { blobId: string; token: string }): { ok: true; chief: boolean; tools: McpToolInfo[] } | { ok: false; error: string } {
    const s = this.auth(p.blobId, p.token);
    if (!s) return { ok: false, error: 'invalid or expired blob session' };
    const blob = this.o.getBlob(s.blobId)!;
    const specs = this.o.specsFor(this.ctxOf(s));
    return { ok: true, chief: blob.role === 'chief', tools: specs.map((t) => ({ name: t.name, description: t.description, params: t.params })) };
  }

  /** `blobs.mcp.call`: run one tool as the session's blob. Only tools in the blob's own list can be called. */
  async call(p: { blobId: string; token: string; name: string; args?: Record<string, unknown> }): Promise<FleetToolResult> {
    const s = this.auth(p.blobId, p.token);
    if (!s) return bad('invalid or expired blob session');
    const spec = this.o.specsFor(this.ctxOf(s)).find((t) => t.name === p.name);
    if (!spec) return bad(`${this.o.getBlob(s.blobId)?.name ?? 'This blob'} has no tool "${String(p.name)}"`);
    try { return await spec.handler(p.args ?? {}); } catch (e: any) { return bad(String(e?.message ?? e)); }
  }
}
