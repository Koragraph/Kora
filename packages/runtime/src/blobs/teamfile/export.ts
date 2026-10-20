// Writing a team file. `TeamExportSource` is a plain snapshot the host assembles from the stores (blobs, SOUL, outfit,
// skills' names, routines, groups); this module never reads disk. Everything text goes through the scrubber, and the
// report says exactly what was left in and what was removed - the export dialog shows that before anything is saved.
import { dump } from 'js-yaml';
import { CHIEF_BLOB_ID } from '../types';
import { mergeFindings, scrubText, SCRUB_LABEL, type ScrubFinding } from './scrub';
import {
  NEVER_INCLUDED, TEAMFILE_INSTRUCTIONS_MAX, TEAMFILE_MARKER, TEAMFILE_MAX_BLOBS, TEAMFILE_MAX_GROUPS, TEAMFILE_ROUTINE_PROMPT_MAX, TEAMFILE_SOUL_MAX, TEAMFILE_VERSION,
  type TeamFile, type TeamFileBlob, type TeamFileGroup, type TeamFileOutfit,
} from './schema';
import type { ResponderRule } from '../groups/types';

export interface ExportBlobSource {
  id: string;
  name: string;
  title: string;
  role: 'chief' | 'member';
  soul: string;
  outfit: TeamFileOutfit | null;
  templateId: string | null;
  skills: Array<{ name: string; description: string }>;
  routines: Array<{ title: string; cadence: string; prompt: string }>;
}
export interface ExportGroupSource { id: string; name: string; memberIds: string[]; leadId: string; rule: ResponderRule; instructions: string }
export interface TeamExportSource { blobs: ExportBlobSource[]; groups: ExportGroupSource[] }

export interface ExportSelection {
  /** Member blobs to include (the Chief is controlled by `chief`). */
  blobIds: string[];
  groupIds: string[];
  /** Describe Kora in the file (informational for the importer). */
  chief: boolean;
  routines: boolean;
  skills: boolean;
  name?: string;
  description?: string;
}

export interface ExportBlobSummary { id: string; name: string; title: string; soulChars: number; skills: number; routines: number; removed: number }
export interface ExportGroupSummary { id: string; name: string; members: string[]; lead: string; rule: ResponderRule; /** Why it was left out. */ dropped: string | null }
export interface ExportReport {
  blobs: ExportBlobSummary[];
  groups: ExportGroupSummary[];
  chief: boolean;
  findings: ScrubFinding[];
  /** "2 API keys and 1 email address removed" ; null when nothing was. */
  scrubNote: string | null;
  neverIncluded: readonly string[];
  bytes: number;
}
export interface ExportResult { markdown: string; file: TeamFile; report: ExportReport; fileName: string }

/** Everything selected, the default of the dialog. */
export function defaultSelection(src: TeamExportSource): ExportSelection {
  return { blobIds: src.blobs.filter((b) => b.role !== 'chief').map((b) => b.id), groupIds: src.groups.map((g) => g.id), chief: true, routines: true, skills: true };
}

function noteOf(findings: ScrubFinding[]): string | null {
  if (!findings.length) return null;
  const parts = findings.map((f) => `${f.count} ${SCRUB_LABEL[f.kind]}`);
  return `${parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1] : parts[0]} removed`;
}

export function fileNameFor(name: string): string {
  const s = name.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `${s || 'team'}.kora-team.md`;
}

export function buildTeamFile(src: TeamExportSource, sel: ExportSelection, now: () => Date = () => new Date()): ExportResult {
  const all: ScrubFinding[][] = [];
  const clean = (text: string, max: number): { text: string; removed: number } => {
    const r = scrubText(text);
    all.push(r.findings);
    return { text: r.text.slice(0, max), removed: r.removed };
  };
  const chiefSrc = src.blobs.find((b) => b.role === 'chief' || b.id === CHIEF_BLOB_ID) ?? null;
  const wantIds = new Set(sel.blobIds);
  const chosen = src.blobs.filter((b) => b.role !== 'chief' && wantIds.has(b.id)).slice(0, TEAMFILE_MAX_BLOBS);

  const blobs: TeamFileBlob[] = [];
  const summaries: ExportBlobSummary[] = [];
  for (const b of chosen) {
    let removed = 0;
    const take = (t: string, max: number) => { const r = clean(t, max); removed += r.removed; return r.text; };
    const skills = sel.skills ? b.skills.map((s) => ({ name: take(s.name, 60), description: take(s.description, 200) })) : [];
    const routines = sel.routines ? b.routines.map((r) => ({ title: take(r.title, 80), cadence: take(r.cadence, 80), prompt: take(r.prompt, TEAMFILE_ROUTINE_PROMPT_MAX) })) : [];
    const soul = take(b.soul, TEAMFILE_SOUL_MAX);
    blobs.push({ name: b.name, title: take(b.title, 60), soul, outfit: b.outfit, template: b.templateId, skills, routines });
    summaries.push({ id: b.id, name: b.name, title: b.title, soulChars: soul.length, skills: skills.length, routines: routines.length, removed });
  }

  // groups: keep the members that are exported (Kora always travels as the name "Kora"); a group needs two
  const nameOf = (id: string): string | null => (id === CHIEF_BLOB_ID ? 'Kora' : chosen.find((b) => b.id === id)?.name ?? null);
  const groups: TeamFileGroup[] = [];
  const groupSummaries: ExportGroupSummary[] = [];
  for (const g of src.groups.filter((x) => sel.groupIds.includes(x.id)).slice(0, TEAMFILE_MAX_GROUPS)) {
    const members = g.memberIds.map(nameOf).filter((n): n is string => !!n);
    const lead = nameOf(g.leadId);
    const dropped = members.length < 2 ? `Only ${members.length} of its members are in the file.` : null;
    groupSummaries.push({ id: g.id, name: g.name, members, lead: lead && members.includes(lead) ? lead : members[0] ?? '', rule: g.rule, dropped });
    if (dropped) continue;
    groups.push({ name: g.name, members, lead: lead && members.includes(lead) ? lead : members[0], rule: g.rule, instructions: clean(g.instructions, TEAMFILE_INSTRUCTIONS_MAX).text });
  }

  const chief = sel.chief && chiefSrc ? { name: chiefSrc.name, title: chiefSrc.title, soul: clean(chiefSrc.soul, TEAMFILE_SOUL_MAX).text, outfit: chiefSrc.outfit } : null;
  const single = blobs.length === 1 && groups.length === 0;
  const name = (sel.name ?? '').trim() || (single ? blobs[0].name : 'My team');
  const file: TeamFile = {
    version: TEAMFILE_VERSION, kind: single ? 'blob' : 'team', name, description: clean((sel.description ?? '').trim(), 300).text,
    exportedAt: now().toISOString(), chief, blobs, groups,
  };
  const findings = mergeFindings(...all);
  const markdown = renderTeamFile(file);
  const report: ExportReport = {
    blobs: summaries, groups: groupSummaries, chief: !!chief, findings, scrubNote: noteOf(findings), neverIncluded: NEVER_INCLUDED,
    bytes: Buffer.byteLength(markdown, 'utf8'),
  };
  return { markdown, file, report, fileName: fileNameFor(name) };
}

// ── rendering ────────────────────────────────────────────────────────────────────────────────────

const yamlObj = (f: TeamFile) => ({
  [TEAMFILE_MARKER]: f.version,
  kind: f.kind,
  name: f.name,
  ...(f.description ? { description: f.description } : {}),
  exported_at: f.exportedAt,
  ...(f.chief ? { chief: { name: f.chief.name, title: f.chief.title, ...(f.chief.outfit ? { outfit: f.chief.outfit } : {}), soul: f.chief.soul } } : {}),
  blobs: f.blobs.map((b) => ({
    name: b.name, title: b.title, ...(b.template ? { template: b.template } : {}), ...(b.outfit ? { outfit: b.outfit } : {}), soul: b.soul,
    ...(b.skills.length ? { skills: b.skills } : {}), ...(b.routines.length ? { routines: b.routines } : {}),
  })),
  ...(f.groups.length ? { groups: f.groups } : {}),
});

const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };
const fence = (s: string) => s.replace(/```/g, "'''");

/** Frontmatter (the data) + a human-readable body (never read back). */
export function renderTeamFile(f: TeamFile): string {
  const yaml = dump(yamlObj(f), { noRefs: true, lineWidth: -1, indent: 2, skipInvalid: true }).trimEnd();
  const body: string[] = [`# ${f.name}`, ''];
  body.push(f.description || (f.kind === 'blob' ? `A Kora blob: ${f.blobs[0]?.name ?? ''}.` : `A team of ${f.blobs.length} Kora blobs${f.groups.length ? ` and ${f.groups.length} group${f.groups.length === 1 ? '' : 's'}` : ''}.`), '');
  body.push('> A Kora team file. Open it in Kora (Team > Import) to review exactly what it will create. Nothing in it can run on its own: apps are off, routines are paused, and skills are off until you turn them on.', '');
  for (const b of f.blobs) {
    body.push(`## ${b.name}${b.title ? ` - ${b.title}` : ''}`, '');
    if (b.soul) body.push(clip(b.soul, 280), '');
    if (b.skills.length) body.push(`Skills: ${b.skills.map((s) => s.name).join(', ')}`, '');
    if (b.routines.length) body.push('Suggested routines (paused until you turn them on):', ...b.routines.map((r) => `- ${r.title}${r.cadence ? ` (${r.cadence})` : ''}`), '');
  }
  if (f.groups.length) {
    body.push('## Groups', '');
    for (const g of f.groups) body.push(`- **${g.name}**: ${g.members.join(', ')} (lead ${g.lead}, replies: ${g.rule})${g.instructions ? ` - ${clip(fence(g.instructions), 120)}` : ''}`);
    body.push('');
  }
  body.push('---', '', `Not included, ever: ${NEVER_INCLUDED.join('; ').toLowerCase()}.`, '');
  return `---\n${yaml}\n---\n\n${body.join('\n')}`;
}
