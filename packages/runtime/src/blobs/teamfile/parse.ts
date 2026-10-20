// Reading a team file. The input is UNTRUSTED: a hard size cap, no YAML aliases / anchors / custom tags (they are how
// parser bombs are built), a plain JSON-ish schema (no dates, no merges), then every field is re-built from scratch with
// clamped lengths so unknown keys can never ride along. Nothing here touches disk or the network.
import { JSON_SCHEMA, load, parseEvents } from 'js-yaml';
import { cleanText } from './scrub';
import {
  TEAMFILE_INSTRUCTIONS_MAX, TEAMFILE_MARKER, TEAMFILE_MAX_BLOBS, TEAMFILE_MAX_BYTES, TEAMFILE_MAX_GROUPS, TEAMFILE_MAX_ROUTINES, TEAMFILE_MAX_SKILLS,
  TEAMFILE_NAME_MAX, TEAMFILE_ROUTINE_PROMPT_MAX, TEAMFILE_SOUL_MAX, TEAMFILE_TITLE_MAX, TEAMFILE_VERSION, isRule,
  type TeamFile, type TeamFileBlob, type TeamFileChief, type TeamFileGroup, type TeamFileOutfit, type TeamFileRoutine, type TeamFileSkill,
} from './schema';

export type ParseResult = { ok: true; file: TeamFile; warnings: string[] } | { ok: false; error: string };

const EVENT_ALIAS = 5;

/** Split "---\n<yaml>\n---\n<body>". */
export function splitFrontmatter(text: string): { yaml: string; body: string } | null {
  const t = text.replace(/^﻿/, '');
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)([\s\S]*)$/.exec(t);
  return m ? { yaml: m[1], body: m[2] } : null;
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? cleanText(v).trim().slice(0, max) : '');
const soulStr = (v: unknown, max: number): string => (typeof v === 'string' ? cleanText(v).replace(/\s+$/, '').slice(0, max) : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const slot = (v: unknown): string | null => (typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,23}$/.test(v) ? v : null);

function outfitOf(v: unknown): TeamFileOutfit | null {
  if (!isObj(v)) return null;
  const o = { head: slot(v.head), face: slot(v.face), neck: slot(v.neck) };
  return o.head || o.face || o.neck ? o : null;
}

function blobOf(v: unknown): TeamFileBlob | null {
  if (!isObj(v)) return null;
  const name = str(v.name, TEAMFILE_NAME_MAX);
  if (!name) return null;
  const skills: TeamFileSkill[] = [];
  for (const s of arr(v.skills).slice(0, TEAMFILE_MAX_SKILLS)) {
    const o: Record<string, unknown> = typeof s === 'string' ? { name: s } : isObj(s) ? s : {};
    const n = str(o.name, 60).replace(/[^\w .+-]/g, '');
    if (n) skills.push({ name: n, description: str(o.description, 200) });
  }
  const routines: TeamFileRoutine[] = [];
  for (const r of arr(v.routines).slice(0, TEAMFILE_MAX_ROUTINES)) {
    if (!isObj(r)) continue;
    const title = str(r.title, 80);
    if (title) routines.push({ title, cadence: str(r.cadence, 80), prompt: soulStr(r.prompt, TEAMFILE_ROUTINE_PROMPT_MAX) });
  }
  return { name, title: str(v.title, TEAMFILE_TITLE_MAX), soul: soulStr(v.soul, TEAMFILE_SOUL_MAX), outfit: outfitOf(v.outfit), template: slot(v.template), skills, routines };
}

function groupOf(v: unknown): TeamFileGroup | null {
  if (!isObj(v)) return null;
  const name = str(v.name, TEAMFILE_NAME_MAX);
  const members = [...new Set(arr(v.members).map((m) => str(m, TEAMFILE_NAME_MAX)).filter(Boolean))].slice(0, 12);
  if (!name || members.length < 2) return null;
  const lead = str(v.lead, TEAMFILE_NAME_MAX);
  return { name, members, lead: members.includes(lead) ? lead : members[0], rule: isRule(v.rule) ? v.rule : 'auto', instructions: soulStr(v.instructions, TEAMFILE_INSTRUCTIONS_MAX) };
}

function chiefOf(v: unknown): TeamFileChief | null {
  if (!isObj(v)) return null;
  return { name: str(v.name, TEAMFILE_NAME_MAX) || 'Kora', title: str(v.title, TEAMFILE_TITLE_MAX) || 'Chief', soul: soulStr(v.soul, TEAMFILE_SOUL_MAX), outfit: outfitOf(v.outfit) };
}

export function parseTeamFile(text: string): ParseResult {
  if (typeof text !== 'string') return { ok: false, error: 'That is not a text file.' };
  if (Buffer.byteLength(text, 'utf8') > TEAMFILE_MAX_BYTES) return { ok: false, error: `That file is too big for a team file (max ${Math.round(TEAMFILE_MAX_BYTES / 1024)} KB).` };
  const parts = splitFrontmatter(text);
  if (!parts) return { ok: false, error: "This isn't a Kora team file. Open a file that was shared from Kora." };

  let doc: unknown;
  try {
    for (const e of parseEvents(parts.yaml, { maxDepth: 12 })) {
      const ev = e as { type: number; anchorStart?: number; tagStart?: number };
      if (ev.type === EVENT_ALIAS || (ev.anchorStart ?? -1) >= 0) return { ok: false, error: 'Team files cannot use YAML anchors or aliases.' };
      if ((ev.tagStart ?? -1) >= 0) return { ok: false, error: 'Team files cannot use YAML tags.' };
    }
    doc = load(parts.yaml, { schema: JSON_SCHEMA, maxDepth: 12 });
  } catch {
    return { ok: false, error: "This isn't a Kora team file: it could not be read. Open a file that was shared from Kora." };
  }
  if (!isObj(doc) || doc[TEAMFILE_MARKER] === undefined) return { ok: false, error: "This isn't a Kora team file. Open a file that was shared from Kora." };
  const version = Number(doc[TEAMFILE_MARKER]);
  if (!Number.isInteger(version) || version < 1) return { ok: false, error: 'This team file has an unreadable version.' };
  if (version > TEAMFILE_VERSION) return { ok: false, error: `This team file is version ${version}; this Kora reads version ${TEAMFILE_VERSION}. Update Kora to open it.` };

  const warnings: string[] = [];
  const rawBlobs = arr(doc.blobs);
  if (rawBlobs.length > TEAMFILE_MAX_BLOBS) warnings.push(`Only the first ${TEAMFILE_MAX_BLOBS} blobs are read.`);
  const blobs = rawBlobs.slice(0, TEAMFILE_MAX_BLOBS).map(blobOf).filter((b): b is TeamFileBlob => !!b);
  const rawGroups = arr(doc.groups);
  if (rawGroups.length > TEAMFILE_MAX_GROUPS) warnings.push(`Only the first ${TEAMFILE_MAX_GROUPS} groups are read.`);
  const groups = rawGroups.slice(0, TEAMFILE_MAX_GROUPS).map(groupOf).filter((g): g is TeamFileGroup => !!g);
  if (rawBlobs.length - blobs.length > 0 && rawBlobs.length <= TEAMFILE_MAX_BLOBS) warnings.push(`${rawBlobs.length - blobs.length} blob(s) were unreadable and skipped.`);
  if (!blobs.length && !groups.length) return { ok: false, error: 'This team file has no blobs in it.' };
  return {
    ok: true, warnings,
    file: {
      version: TEAMFILE_VERSION, kind: doc.kind === 'blob' ? 'blob' : 'team', name: str(doc.name, 60) || 'Imported team', description: str(doc.description, 300),
      exportedAt: str(doc.exported_at ?? doc.exportedAt, 40), chief: chiefOf(doc.chief), blobs, groups,
    },
  };
}
