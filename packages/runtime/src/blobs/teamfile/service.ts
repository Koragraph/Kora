// TeamFileService: the daemon end of team files (Phase 3 wiring). It assembles the export source from the stores, builds the
// file, and keeps IMPORT PLANS server-side: the client sees a plan (to review) and may only say which parts to skip; what
// gets created always comes from the plan held here, never from anything the client sends back (safe defaults are applied by
// `applyImport`: no app grants, routines paused, skills off, permission Ask, never Kora).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../store';
import { blobHome } from '../home';
import { CHIEF_BLOB_ID, type BlobEngine, type BlobProfile } from '../types';
import type { GroupStore } from '../groups/store';
import { writeRoutinesPaused } from '../templates';
import { fetchTeamFile, type TeamFetchDeps } from './fetch';
import { buildTeamFile, type ExportReport, type ExportSelection, type ExportBlobSource, type TeamExportSource } from './export';
import { IMPORT_TOOL_GRANTS, applyImport, planImport, type ImportHost, type ImportPlan, type ImportResult } from './import';
import { parseTeamFile } from './parse';

export const PLAN_TTL_MS = 15 * 60_000;
export const PLAN_MAX = 8;

export interface TeamFileServiceOptions {
  store: {
    list(o?: { includeArchived?: boolean }): BlobProfile[];
    get(id: string): BlobProfile | null;
    soul(id: string): string;
    update(id: string, patch: { title?: string; outfit?: BlobProfile['outfit'] }): BlobProfile;
    writeSoul(id: string, text: string): void;
    create(input: { name: string; title: string; soul: string; engine: BlobEngine; permission?: BlobProfile['permission']; outfit?: BlobProfile['outfit']; toolGrants?: BlobProfile['toolGrants']; templateId?: string | null }): BlobProfile;
  };
  groups: Pick<GroupStore, 'list' | 'create' | 'get'>;
  /** A blob's OWN skills (never the user's, never the built-in document pack). */
  skillsOf(blobId: string): Array<{ name: string; description: string }>;
  /** Its routines as words: title, the cadence in plain words, the instructions. */
  routinesOf(blobId: string): Array<{ title: string; cadence: string; prompt: string }>;
  fetchDeps?: TeamFetchDeps;
  now?: () => number;
  log?: (msg: string) => void;
}

/** The plan as the client sees it (web `ImportPlanWire`). */
export interface ImportPlanView {
  planId: string;
  title: string;
  description: string;
  blobs: Array<{
    fileName: string; name: string; renamed: boolean; title: string; soul: string;
    outfit: { head: string | null; face: string | null; neck: string | null } | null;
    skills: Array<{ name: string; description: string }>;
    routines: Array<{ title: string; cadence: string; prompt: string }>;
    flags: Array<{ kind: string; text: string }>;
    existing: { id: string; identical: boolean } | null;
  }>;
  groups: Array<{ fileName: string; name: string; renamed: boolean; members: string[]; lead: string; rule: string; instructions: string }>;
  skipped: Array<{ what: string; why: string }>;
  notes: string[];
  warnings: string[];
  removedSecrets: number;
}

export type PlanResult = { ok: true; plan: ImportPlanView } | { ok: false; error: string };

export class TeamFileService {
  private plans = new Map<string, { plan: ImportPlan; at: number }>();
  private o: TeamFileServiceOptions;
  private now: () => number;

  constructor(o: TeamFileServiceOptions) { this.o = o; this.now = o.now ?? Date.now; }

  // ── export ─────────────────────────────────────────────────────────────────────────────────────
  /** What the export dialog lists: every active blob (Kora is described through `chief`), every group. */
  options(): { blobs: Array<{ id: string; name: string; title: string; skills: number; routines: number }>; groups: Array<{ id: string; name: string; memberIds: string[] }> } {
    return {
      blobs: this.o.store.list().filter((b) => b.role !== 'chief').map((b) => ({ id: b.id, name: b.name, title: b.title, skills: this.o.skillsOf(b.id).length, routines: this.o.routinesOf(b.id).length })),
      groups: this.o.groups.list().map((g) => ({ id: g.id, name: g.name, memberIds: [...g.memberIds] })),
    };
  }

  source(): TeamExportSource {
    const blobs: ExportBlobSource[] = this.o.store.list().map((b) => ({
      id: b.id, name: b.name, title: b.title, role: b.role, soul: this.o.store.soul(b.id),
      outfit: b.outfit ? { head: b.outfit.head ?? null, face: b.outfit.face ?? null, neck: b.outfit.neck ?? null } : null,
      templateId: b.templateId,
      skills: b.role === 'chief' ? [] : this.o.skillsOf(b.id),
      routines: b.role === 'chief' ? [] : this.o.routinesOf(b.id),
    }));
    return { blobs, groups: this.o.groups.list().map((g) => ({ id: g.id, name: g.name, memberIds: [...g.memberIds], leadId: g.leadId, rule: g.rule, instructions: g.instructions })) };
  }

  private clean(sel: Partial<ExportSelection> | undefined): ExportSelection {
    const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 64) : []);
    return {
      blobIds: ids(sel?.blobIds), groupIds: ids(sel?.groupIds), chief: sel?.chief === true,
      routines: sel?.routines !== false, skills: sel?.skills !== false,
      ...(typeof sel?.name === 'string' && sel.name.trim() ? { name: sel.name.trim().slice(0, 60) } : {}),
    };
  }

  preview(sel: Partial<ExportSelection> | undefined): ExportReport { return buildTeamFile(this.source(), this.clean(sel), () => new Date(this.now())).report; }
  export(sel: Partial<ExportSelection> | undefined): { markdown: string; fileName: string; report: ExportReport } {
    const r = buildTeamFile(this.source(), this.clean(sel), () => new Date(this.now()));
    return { markdown: r.markdown, fileName: r.fileName, report: r.report };
  }

  // ── import: plan ───────────────────────────────────────────────────────────────────────────────
  private local() {
    return {
      blobNames: this.o.store.list({ includeArchived: true }).map((b) => b.name),
      groupNames: this.o.groups.list().map((g) => g.name),
      blobs: this.o.store.list().filter((b) => b.role !== 'chief').map((b) => ({ id: b.id, name: b.name, title: b.title, soul: this.o.store.soul(b.id) })),
    };
  }

  planFromText(text: string): PlanResult {
    const parsed = parseTeamFile(String(text ?? ''));
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const plan = planImport(parsed.file, this.local());
    return { ok: true, plan: this.keep(plan, parsed.warnings) };
  }

  async planFromUrl(url: string): Promise<PlanResult> {
    let fetched: { text: string; url: string };
    try { fetched = await fetchTeamFile(String(url ?? ''), this.o.fetchDeps ?? {}); }
    catch (e: any) { return { ok: false, error: String(e?.message ?? e) }; }
    return this.planFromText(fetched.text);
  }

  private keep(plan: ImportPlan, warnings: string[]): ImportPlanView {
    const now = this.now();
    for (const [id, p] of this.plans) if (now - p.at > PLAN_TTL_MS) this.plans.delete(id);
    while (this.plans.size >= PLAN_MAX) this.plans.delete(this.plans.keys().next().value as string);
    const planId = `plan_${crypto.randomBytes(9).toString('hex')}`;
    this.plans.set(planId, { plan, at: now });
    return {
      planId, title: plan.title, description: plan.description,
      blobs: plan.blobs.map((b) => ({ fileName: b.fileName, name: b.name, renamed: b.renamed, title: b.title, soul: b.soul, outfit: b.outfit, skills: b.skills, routines: b.routines, flags: b.flags, existing: b.existing })),
      groups: plan.groups.map((g) => ({ fileName: g.fileName, name: g.name, renamed: g.renamed, members: g.members, lead: g.lead, rule: g.rule, instructions: g.instructions })),
      skipped: plan.skipped, notes: plan.notes, warnings, removedSecrets: plan.findings.reduce((n, f) => n + f.count, 0),
    };
  }

  /** The plan is gone (applied, expired or never existed). */
  hasPlan(planId: string): boolean { const p = this.plans.get(planId); return !!p && this.now() - p.at <= PLAN_TTL_MS; }

  // ── import: apply ──────────────────────────────────────────────────────────────────────────────
  /** Create what the person kept. `engine` is the best installed one (the ui-server resolves it: the runtime cannot see readiness). */
  apply(planId: string, skip: { blobs?: readonly string[]; groups?: readonly string[]; replace?: readonly string[] }, engine: BlobEngine): ImportResult {
    const held = this.plans.get(planId);
    if (!held || this.now() - held.at > PLAN_TTL_MS) throw new Error('That import expired. Open the file again to review it.');
    this.plans.delete(planId); // one use
    const host: ImportHost = {
      createBlob: (b) => {
        const p = this.o.store.create({ name: b.name, title: b.title, soul: b.soul, engine, permission: 'ask', outfit: b.outfit, toolGrants: IMPORT_TOOL_GRANTS, templateId: b.templateId });
        if (p.id === CHIEF_BLOB_ID || p.role === 'chief') throw new Error('refused: an import cannot create or replace Kora');
        return { id: p.id };
      },
      replaceBlob: (id, b) => {
        // title, personality and look only: memory, chats, engine, permission and app grants stay exactly as they are
        this.o.store.update(id, { title: b.title, ...(b.outfit ? { outfit: b.outfit } : {}) });
        this.o.store.writeSoul(id, b.soul);
      },
      addSuggestedSkills: (blobId, skills) => {
        // names only, stored OFF: nothing is copied into skills/ and nothing is enabled
        try { writeFileAtomic(path.join(blobHome(blobId), 'skills-suggested.json'), JSON.stringify({ skills: skills.map((s) => ({ name: s.name, description: s.description })) }, null, 2) + '\n'); } catch (e: any) { this.o.log?.(`teamfile: could not record skills for ${blobId}: ${e?.message ?? e}`); }
      },
      addPausedRoutine: (blobId, r) => { this.appendPausedRoutine(blobId, r); },
      createGroup: (g) => { const made = this.o.groups.create({ name: g.name, memberIds: g.memberIds, leadId: g.leadId, rule: g.rule, instructions: g.instructions }); return { id: made.id }; },
    };
    return applyImport(held.plan, host, { skipBlobs: [...(skip.blobs ?? [])], skipGroups: [...(skip.groups ?? [])], replaceBlobs: [...(skip.replace ?? [])] });
  }

  /** `routines.json` is the file starter templates write; routines land there PAUSED and the routine service adopts them. */
  private appendPausedRoutine(blobId: string, r: { title: string; cadence: string; prompt: string }): void {
    const file = path.join(blobHome(blobId), 'routines.json');
    let prior: Array<{ title: string; cadence: string; prompt?: string; paused?: boolean }> = [];
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(j?.routines)) prior = j.routines; } catch { /* none yet */ }
    if (prior.length) {
      writeFileAtomic(file, JSON.stringify({ routines: [...prior, { title: r.title, cadence: r.cadence, prompt: r.prompt, paused: true }] }, null, 2) + '\n');
      return;
    }
    writeRoutinesPaused(blobId, [r]);
  }
}
