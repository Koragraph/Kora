// Importing a team file = two steps with a human in between.
//   planImport(file, local)   PURE. Turns the (already validated) file into the exact list of things that will be created:
//                             de-duplicated names, groups re-pointed at the final names, what is skipped and why, and
//                             per-blob review flags ("mentions a link", "mentions running commands").
//   applyImport(plan, host)   runs only after the person pressed Import on the review screen, through a small host
//                             interface. The safe defaults are written HERE, not read from the file: no app grants,
//                             routines paused, skills off, permission Ask. Kora is never created, edited or replaced.
import { CHIEF_BLOB_ID } from '../types';
import type { BlobToolGrants } from '../types';
import type { ResponderRule } from '../groups/types';
import { scrubText, type ScrubFinding, mergeFindings } from './scrub';
import { TEAMFILE_NAME_MAX, type TeamFile, type TeamFileOutfit, type TeamFileRoutine, type TeamFileSkill } from './schema';

export const IMPORT_TOOL_GRANTS: BlobToolGrants = { apps: { mode: 'none', allow: [] }, mcp: [], computer: { browser: false, vm: false } };
export const IMPORT_PERMISSION = 'ask' as const;
const KORA_NAMES = new Set(['kora']);

export type ReviewFlagKind = 'link' | 'commands' | 'secrets-removed' | 'instructions-override';
export interface ReviewFlag { kind: ReviewFlagKind; text: string }

export interface PlannedBlob {
  /** The name in the file. */
  fileName: string;
  /** The name it will get here (de-duplicated). */
  name: string;
  renamed: boolean;
  title: string;
  soul: string;
  outfit: TeamFileOutfit | null;
  templateId: string | null;
  skills: TeamFileSkill[];
  routines: TeamFileRoutine[];
  flags: ReviewFlag[];
  /**
   * A blob of yours already has this name. `identical`: same title and personality, so importing it adds nothing (the review
   * screen unticks it). Otherwise the person picks per blob: keep both (this planned, renamed copy), replace (the existing blob
   * takes the file's title, personality and look; its memory, chats, engine and permissions stay), or skip.
   */
  existing: { id: string; identical: boolean } | null;
}
export interface PlannedGroup { name: string; renamed: boolean; fileName: string; members: string[]; lead: string; rule: ResponderRule; instructions: string }
export interface ImportPlan {
  title: string;
  description: string;
  blobs: PlannedBlob[];
  groups: PlannedGroup[];
  /** Things in the file that will not be created, with the reason. */
  skipped: Array<{ what: string; why: string }>;
  /** "Kora stays as she is." style facts for the review screen. */
  notes: string[];
  findings: ScrubFinding[];
}

export interface LocalNames {
  blobNames: readonly string[];
  groupNames: readonly string[];
  /** Your live blobs (not Kora, not retired), to spot a same-named one. Optional: without it nothing is flagged. */
  blobs?: ReadonlyArray<{ id: string; name: string; title: string; soul: string }>;
}

function freeName(want: string, taken: Set<string>): string {
  let name = want.slice(0, TEAMFILE_NAME_MAX).trim();
  for (let i = 2; taken.has(name.toLowerCase()); i++) {
    const suffix = ` ${i}`;
    name = `${want.slice(0, TEAMFILE_NAME_MAX - suffix.length).trimEnd()}${suffix}`;
  }
  taken.add(name.toLowerCase());
  return name;
}

const sameText = (a: string, b: string): boolean => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

const URL_RE = /\bhttps?:\/\/[^\s)>\]]+/i;
const CMD_RE = /\b(?:curl|wget)\b[^\n]*\|\s*(?:sh|bash|zsh)\b|\brm\s+-rf\b|\bsudo\b|\bchmod\s+\+x\b|\bnpm\s+(?:i|install)\b[^\n]*(?:-g|--global)|\beval\s*\(/i;
const OVERRIDE_RE = /ignore (?:all |any )?(?:previous|prior|above) (?:instructions|rules)|disregard (?:your|the) (?:instructions|rules)|you (?:may|can) (?:ignore|bypass) (?:the )?(?:permission|approval)/i;

export function reviewFlags(text: string, removed: number): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  const url = URL_RE.exec(text);
  if (url) flags.push({ kind: 'link', text: `Mentions a link (${url[0].slice(0, 60)})` });
  if (CMD_RE.test(text)) flags.push({ kind: 'commands', text: 'Mentions running shell commands' });
  if (OVERRIDE_RE.test(text)) flags.push({ kind: 'instructions-override', text: 'Tries to override safety rules' });
  if (removed > 0) flags.push({ kind: 'secrets-removed', text: `${removed} secret-looking thing${removed === 1 ? '' : 's'} removed` });
  return flags;
}

export function planImport(file: TeamFile, local: LocalNames): ImportPlan {
  const taken = new Set(local.blobNames.map((n) => n.toLowerCase()));
  for (const k of KORA_NAMES) taken.add(k);
  const gTaken = new Set(local.groupNames.map((n) => n.toLowerCase()));
  const skipped: ImportPlan['skipped'] = [];
  const notes: string[] = [];
  const findings: ScrubFinding[][] = [];
  const nameMap = new Map<string, string>([['kora', 'Kora']]);   // lower(file name) -> final name; a group's "Kora" is always YOURS

  const blobs: PlannedBlob[] = [];
  for (const b of file.blobs) {
    if (KORA_NAMES.has(b.name.toLowerCase())) { skipped.push({ what: b.name, why: 'Kora is yours already. An import never replaces her.' }); continue; }
    const mine = (local.blobs ?? []).find((x) => x.name.toLowerCase() === b.name.toLowerCase());
    const name = freeName(b.name, taken);
    if (!nameMap.has(b.name.toLowerCase())) nameMap.set(b.name.toLowerCase(), name);   // a name listed twice: groups point at the first
    // secrets can ride in on an import too: scrub again, and say so
    let removed = 0;
    const s = (t: string) => { const r = scrubText(t); removed += r.removed; findings.push(r.findings); return r.text; };
    const soul = s(b.soul);
    const skills = b.skills.map((k) => ({ name: k.name, description: s(k.description) }));
    const routines = b.routines.map((r) => ({ title: r.title, cadence: r.cadence, prompt: s(r.prompt) }));
    const flagText = [soul, ...routines.map((r) => r.prompt)].join('\n');
    blobs.push({ fileName: b.name, name, renamed: name !== b.name, title: b.title, soul, outfit: b.outfit, templateId: b.template, skills, routines, flags: reviewFlags(flagText, removed),
      existing: mine ? { id: mine.id, identical: sameText(mine.title, b.title) && sameText(mine.soul, b.soul) } : null });
  }

  const groups: PlannedGroup[] = [];
  for (const g of file.groups) {
    const members = [...new Set(g.members.map((m) => nameMap.get(m.toLowerCase())).filter((m): m is string => !!m))];
    if (members.length < 2) { skipped.push({ what: `Group ${g.name}`, why: 'Fewer than two of its members are in this import.' }); continue; }
    const lead = nameMap.get(g.lead.toLowerCase());
    const name = freeName(g.name, gTaken);
    const r = scrubText(g.instructions); findings.push(r.findings);
    groups.push({ fileName: g.name, name, renamed: name !== g.name, members, lead: lead && members.includes(lead) ? lead : members.includes('Kora') ? 'Kora' : members[0], rule: g.rule, instructions: r.text });
  }

  if (file.chief) notes.push('Kora stays exactly as she is. The file\'s description of its own Kora is not applied.');
  else notes.push('Kora stays exactly as she is.');
  if (groups.some((g) => g.members.includes('Kora'))) notes.push('Groups that include Kora use your Kora.');
  notes.push('Imported blobs start with no connected apps, paused routines, skills off and the Ask permission. They pick the best engine you have installed.');
  return { title: file.name, description: file.description, blobs, groups, skipped, notes, findings: mergeFindings(...findings) };
}

// ── apply ────────────────────────────────────────────────────────────────────────────────────────

export interface ImportCreateBlob {
  name: string;
  title: string;
  soul: string;
  outfit: TeamFileOutfit | null;
  templateId: string | null;
  /** Always `IMPORT_TOOL_GRANTS`. */
  toolGrants: BlobToolGrants;
  /** Always 'ask'. */
  permission: typeof IMPORT_PERMISSION;
}
export interface ImportHost {
  createBlob(b: ImportCreateBlob): { id: string };
  /** Replace an existing blob's title, personality and look with the file's. Memory, chats, engine, apps and permission are untouched. */
  replaceBlob(id: string, b: { title: string; soul: string; outfit: TeamFileOutfit | null }): void;
  /** Record skills the file suggests. They are stored OFF: nothing is installed or enabled. */
  addSuggestedSkills(blobId: string, skills: TeamFileSkill[]): void;
  /** Create a routine that is PAUSED. */
  addPausedRoutine(blobId: string, r: TeamFileRoutine & { paused: true }): void;
  createGroup(g: { name: string; memberIds: string[]; leadId: string; rule: ResponderRule; instructions: string }): { id: string };
}
export interface ImportResult {
  blobs: Array<{ id: string; name: string }>;
  groups: Array<{ id: string; name: string }>;
  errors: Array<{ what: string; error: string }>;
}

export function applyImport(plan: ImportPlan, host: ImportHost, o: { /** Names the person unticked on the review screen. */ skipBlobs?: readonly string[]; skipGroups?: readonly string[]; /** Planned names whose existing blob is replaced instead of a renamed copy being made. */ replaceBlobs?: readonly string[] } = {}): ImportResult {
  const out: ImportResult = { blobs: [], groups: [], errors: [] };
  const idByName = new Map<string, string>([['kora', CHIEF_BLOB_ID]]);
  const skipB = new Set((o.skipBlobs ?? []).map((n) => n.toLowerCase()));
  const replaceB = new Set((o.replaceBlobs ?? []).map((n) => n.toLowerCase()));
  for (const b of plan.blobs) {
    if (skipB.has(b.name.toLowerCase())) {
      // a blob you skipped because you already have it still takes part in the file's groups (they point at yours)
      if (b.existing) idByName.set(b.name.toLowerCase(), b.existing.id);
      continue;
    }
    try {
      if (b.existing && replaceB.has(b.name.toLowerCase())) {
        host.replaceBlob(b.existing.id, { title: b.title, soul: b.soul, outfit: b.outfit });
        idByName.set(b.name.toLowerCase(), b.existing.id);
        out.blobs.push({ id: b.existing.id, name: b.fileName });
        continue;
      }
      const { id } = host.createBlob({ name: b.name, title: b.title, soul: b.soul, outfit: b.outfit, templateId: b.templateId, toolGrants: IMPORT_TOOL_GRANTS, permission: IMPORT_PERMISSION });
      if (id === CHIEF_BLOB_ID) throw new Error('refused: an import cannot create or replace Kora');
      idByName.set(b.name.toLowerCase(), id);
      out.blobs.push({ id, name: b.name });
      if (b.skills.length) host.addSuggestedSkills(id, b.skills);
      for (const r of b.routines) host.addPausedRoutine(id, { ...r, paused: true });
    } catch (e: any) { out.errors.push({ what: b.name, error: String(e?.message ?? e) }); }
  }
  const skipG = new Set((o.skipGroups ?? []).map((n) => n.toLowerCase()));
  for (const g of plan.groups) {
    if (skipG.has(g.name.toLowerCase())) continue;
    const memberIds = g.members.map((m) => idByName.get(m.toLowerCase())).filter((x): x is string => !!x);
    if (memberIds.length < 2) { out.errors.push({ what: `Group ${g.name}`, error: 'Not enough of its members were created.' }); continue; }
    const leadId = idByName.get(g.lead.toLowerCase());
    try {
      const { id } = host.createGroup({ name: g.name, memberIds, leadId: leadId && memberIds.includes(leadId) ? leadId : memberIds[0], rule: g.rule, instructions: g.instructions });
      out.groups.push({ id, name: g.name });
    } catch (e: any) { out.errors.push({ what: `Group ${g.name}`, error: String(e?.message ?? e) }); }
  }
  return out;
}
