// The starter roster + Kora (docs/bots/SPEC.md "Starter roster"), the funny-name generator, and the helpers that turn a
// draft (a template, or a proposal card) into a real blob. Pure data + small helpers; the SOUL texts live in templates/.
import path from 'node:path';
import crypto from 'node:crypto';
import { blobHome } from './home';
import { CHIEF_SOUL } from './chief';
import { writeFileAtomic } from './store';
import { popo } from './templates/popo';
import { bobble } from './templates/bobble';
import { dimp } from './templates/dimp';
import { junip } from './templates/junip';
import { wobbo } from './templates/wobbo';
import { tibbo } from './templates/tibbo';
import { mibble } from './templates/mibble';
import { zonk } from './templates/zonk';
import { plonk } from './templates/plonk';
import { fizzle } from './templates/fizzle';
import { kora, KORA_SOUL } from './templates/kora';
import { FUNNY_NAMES } from './templates/names';
import type { StarterSpec } from './templates/spec';
import type { BlobCreateInput, BlobEngine, BlobOutfitWire, BlobPermission, BlobProfile, BlobToolGrants } from './types';

export { KORA_SOUL, FUNNY_NAMES };
export type { StarterSpec };

/** Structural twin of the contract's BlobDraft: what a proposal card carries and what Hire turns into a blob. */
export interface BlobDraft {
  name: string;
  title: string;
  job: string;
  howItWorks: string[];
  soul: string;
  /** null = the best installed engine at hire time. */
  engine: BlobEngine | null;
  permission: BlobPermission;
  outfit: BlobOutfitWire | null;
  apps: string[];
  skills: string[];
  routines: Array<{ title: string; cadence: string; prompt?: string }>;
  templateId: string | null;
}

/** Structural twin of the contract's BlobTemplate (what `blobs.templates` returns). */
export interface BlobTemplateWire { id: string; draft: BlobDraft; blurb: string; exampleAsks: string[]; wants: string[] }

/** The ten hireable starters, in gallery order. */
export const STARTERS: readonly StarterSpec[] = [popo, bobble, dimp, junip, wobbo, tibbo, mibble, zonk, plonk, fizzle];
/** Kora herself (not hireable; she is seeded). */
export const KORA_SPEC: StarterSpec = kora;

export const STARTER_IDS: readonly string[] = STARTERS.map((s) => s.id);

/**
 * Starters renamed in template version 3. Blobs the user already hired keep their name, outfit and `templateId`; this map lets
 * every lookup by template id (or name) still find the right spec. It is never used to rename anything.
 */
export const RENAMED_STARTERS: Readonly<Record<string, string>> = {
  pintu: 'junip', gumbo: 'wobbo', zuzu: 'tibbo', mochi: 'mibble', noodle: 'zonk', bloop: 'plonk', pip: 'fizzle',
};
/** The current template id for an id that may be a pre-rename one. */
export function canonicalTemplateId(id: string | null | undefined): string | null {
  if (!id) return null;
  const k = id.trim().toLowerCase();
  return RENAMED_STARTERS[k] ?? k;
}

export function draftOf(s: StarterSpec): BlobDraft {
  return {
    name: s.name, title: s.title, job: s.job, howItWorks: [...s.howItWorks], soul: s.soul, engine: null, permission: 'auto',
    outfit: { head: s.outfit.head, face: s.outfit.face, neck: s.outfit.neck }, apps: [...s.apps], skills: [...s.skills],
    routines: s.routines.map((r) => ({ ...r })), templateId: s.id,
  };
}

function wire(s: StarterSpec): BlobTemplateWire {
  return { id: s.id, draft: draftOf(s), blurb: s.blurb, exampleAsks: [...s.exampleAsks], wants: [...s.wants] };
}

/** The gallery: the ten hireable starters. */
export function listTemplates(): BlobTemplateWire[] { return STARTERS.map(wire); }
export function getTemplate(id: string): BlobTemplateWire | null {
  const key = canonicalTemplateId(id) ?? '';
  const s = STARTERS.find((t) => t.id === key || t.name.toLowerCase() === key);
  return s ? wire(s) : null;
}
/** Kora's template (id "kora"): seeding and tests; never part of the gallery. */
export function koraTemplate(): BlobTemplateWire { return wire(KORA_SPEC); }

/** The "does:" line for a blob made from a template (a custom blob falls back to its SOUL, see cards.ts). */
export function templateJob(templateId: string | null | undefined): string | null {
  if (!templateId) return null;
  const tid = canonicalTemplateId(templateId);
  const s = tid === KORA_SPEC.id ? KORA_SPEC : STARTERS.find((t) => t.id === tid);
  return s ? s.job : null;
}

// ── names ────────────────────────────────────────────────────────────────────────────────────────────────

/** A free funny name: the first unused one from a shuffled list; "Name 2", "Name 3"... only when every name is taken. */
export function suggestName(taken: Iterable<string>, rand: () => number = Math.random): string {
  const used = new Set([...taken].map((n) => n.trim().toLowerCase()));
  for (const s of [...STARTERS, KORA_SPEC]) used.add(s.name.toLowerCase());
  const pool = FUNNY_NAMES.filter((n) => !used.has(n.toLowerCase()));
  if (pool.length) return pool[Math.floor(rand() * pool.length) % pool.length];
  const base = FUNNY_NAMES[Math.floor(rand() * FUNNY_NAMES.length) % FUNNY_NAMES.length];
  for (let i = 2; ; i++) if (!used.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

// ── drafts -> blobs ──────────────────────────────────────────────────────────────────────────────────────

// ONLY ids the sprite has art for (apps/web .../avatar/spriteMap.ts). The wire keeps a `neck` slot for compatibility;
// nothing is drawn for it, so a proposal never offers one.
const HEADS = new Set(['top-hat', 'beanie', 'cap', 'beret', 'crown', 'headphones', 'flower']);
const FACES = new Set(['monocle', 'round-glasses', 'square-glasses', 'sunglasses']);
const NECKS = new Set<string>();
/** Retired outfit ids (hats/face items/neckwear that no longer have art): treated as "nothing", never as a bare-body claim. */
const ARTLESS_ITEMS = new Set(['party-hat', 'cowboy-hat', 'chef-hat', 'bucket-hat', 'moustache', 'eyepatch', 'freckles', 'blush', 'bow-tie', 'scarf', 'tie', 'bandana']);
const ART_CHOICES: ReadonlyArray<{ slot: 'head' | 'face'; id: string }> = [
  { slot: 'face', id: 'round-glasses' }, { slot: 'face', id: 'square-glasses' }, { slot: 'face', id: 'monocle' }, { slot: 'face', id: 'sunglasses' },
  { slot: 'head', id: 'top-hat' }, { slot: 'head', id: 'beanie' }, { slot: 'head', id: 'cap' }, { slot: 'head', id: 'beret' }, { slot: 'head', id: 'headphones' }, { slot: 'head', id: 'flower' },
];

/** A proposal's outfit with art: what was asked for, else one accessory picked from the name (a bare body is never shipped). */
export function outfitWithArt(outfit: BlobDraft['outfit'] | null | undefined, name: string): { head: string | null; face: string | null; neck: string | null } {
  const head = outfit?.head && HEADS.has(outfit.head) ? outfit.head : null;
  const face = outfit?.face && FACES.has(outfit.face) ? outfit.face : null;
  if (head || face) return { head, face, neck: null };
  let h = 0x811c9dc5;
  for (const ch of `blob-outfit:${name.trim().toLowerCase()}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  const pick = ART_CHOICES[h % ART_CHOICES.length]!;
  return { head: pick.slot === 'head' ? pick.id : null, face: pick.slot === 'face' ? pick.id : null, neck: null };
}

const NO_ITEM = new Set(['none', 'null', 'no', 'nothing', 'n/a', 'na', 'false', 'off', 'default', 'plain']);
const ITEM_ALIASES: Record<string, string> = {
  glasses: 'round-glasses', spectacles: 'round-glasses', specs: 'round-glasses', eyeglasses: 'round-glasses', 'wire-glasses': 'round-glasses',
  shades: 'sunglasses', mustache: 'moustache', stache: 'moustache', hat: 'cap', tophat: 'top-hat', 'top hat': 'top-hat', bowtie: 'bow-tie',
  headphone: 'headphones', earphones: 'headphones', 'baseball-cap': 'cap', chefhat: 'chef-hat', partyhat: 'party-hat', cowboyhat: 'cowboy-hat', bucket: 'bucket-hat',
};

/** What a model wrote for an outfit slot ("None", "Round Glasses", "glasses") as the item id the sprite knows, or null for "nothing". Unknown words pass through for validateDraft to name. */
export function normalizeOutfitItem(value: unknown): string | null {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw || NO_ITEM.has(raw)) return null;
  const kebab = raw.replace(/[\s_]+/g, '-');
  const item = ITEM_ALIASES[kebab] ?? ITEM_ALIASES[raw] ?? kebab;
  return ARTLESS_ITEMS.has(item) ? null : item;
}

/** Problems with a draft, as plain sentences for the model; [] when it is fine. `crown` is reserved for the Chief. */
export function validateDraft(d: Partial<BlobDraft>, opts: { maxSoul?: number } = {}): string[] {
  const out: string[] = [];
  const name = (d.name ?? '').trim();
  if (!name) out.push('name is empty');
  else if (name.length > 40) out.push('name is longer than 40 characters');
  if (!(d.title ?? '').trim()) out.push('title is empty (one or two words: "Researcher")');
  if (!(d.job ?? '').trim()) out.push('job is empty (one line saying what it does)');
  if (!(d.soul ?? '').trim()) out.push('soul is empty');
  else if ((d.soul ?? '').length > (opts.maxSoul ?? 12_000)) out.push('soul is too long');
  if (d.permission && !['ask', 'auto', 'full'].includes(d.permission)) out.push('permission must be ask, auto or full');
  const o = d.outfit;
  if (o) {
    if (o.head && !HEADS.has(o.head)) out.push(`unknown head item "${o.head}" (choose one of: ${[...HEADS].filter((h) => h !== 'crown').join(', ')}; or leave head out)`);
    if (o.head === 'crown') out.push('the crown is reserved for the Chief');
    if (o.face && !FACES.has(o.face)) out.push(`unknown face item "${o.face}" (choose one of: ${[...FACES].join(', ')}; or leave face out)`);
    if (o.neck && !NECKS.has(o.neck)) out.push(`neck items are not available: leave neck out`);
  }
  return out;
}

/** The defaults to hire with when a draft leaves things open. */
export interface HireContext { defaultEngine: BlobEngine; grants?: BlobToolGrants }

export function draftToCreateInput(d: BlobDraft, ctx: HireContext): BlobCreateInput {
  return {
    name: d.name.trim(), title: d.title.trim(), soul: d.soul, engine: d.engine ?? ctx.defaultEngine, permission: d.permission,
    outfit: d.outfit ?? null, templateId: d.templateId, ...(d.templateId ? { templateVersion: TEMPLATE_VERSION } : {}), ...(ctx.grants ? { toolGrants: ctx.grants } : {}),
  };
}

interface StoreForHire {
  create(input: BlobCreateInput): BlobProfile;
  byName(name: string): BlobProfile | null;
  list(opts?: { includeArchived?: boolean }): BlobProfile[];
  rehire(id: string): BlobProfile;
}

/** Create the blob for a draft (Hire / Tweak / hire_template) and store its suggested routines, paused. Throws BlobStoreError on a name clash. */
export function hireFromDraft(store: StoreForHire, draft: BlobDraft, ctx: HireContext): BlobProfile {
  const p = store.create(draftToCreateInput(draft, ctx));
  writeRoutinesPaused(p.id, draft.routines);
  return p;
}

/** Suggested routines are stored paused (Phase 4 consumes <blobHome>/routines.json). */
export function writeRoutinesPaused(blobId: string, routines: ReadonlyArray<{ title: string; cadence: string; prompt?: string }>): void {
  if (!routines.length) return;
  writeFileAtomic(path.join(blobHome(blobId), 'routines.json'), JSON.stringify({ routines: routines.map((r) => ({ title: r.title, cadence: r.cadence, ...(r.prompt ? { prompt: r.prompt } : {}), paused: true })) }, null, 2) + '\n');
}

/** Hire a starter by id: rehire it when an archived copy exists, refuse when it is already on the team. */
export function hireTemplate(store: StoreForHire, templateId: string, ctx: HireContext, nameOverride?: string): { profile: BlobProfile; rehired: boolean } | { error: string } {
  const t = getTemplate(templateId);
  if (!t) return { error: `no starter template "${templateId}"` };
  const name = (nameOverride ?? t.draft.name).trim();
  const active = store.byName(name);
  if (active) return { error: `${active.name} is already on the team` };
  const archived = store.list({ includeArchived: true }).find((b) => b.archivedAt != null && canonicalTemplateId(b.templateId) === t.id && b.name.toLowerCase() === name.toLowerCase());
  if (archived) return { profile: store.rehire(archived.id), rehired: true };
  return { profile: hireFromDraft(store, { ...t.draft, name }, ctx), rehired: false };
}

/**
 * Phase 1 seeded Kora with the short stand-in SOUL. If it is still byte-for-byte that text (the user never edited it),
 * move her to the full Chief SOUL. An edited SOUL is never touched. Returns true when it changed.
 */
export function upgradeKoraSoul(store: { get(id: string): BlobProfile | null; soul(id: string): string; writeSoul(id: string, text: string): void }, koraId: string): boolean {
  const k = store.get(koraId);
  if (!k) return false;
  const cur = store.soul(koraId).trim();
  if (cur !== CHIEF_SOUL.trim()) return false;
  store.writeSoul(koraId, KORA_SOUL);
  return true;
}

/**
 * Starter-template SOUL version. Bump it whenever a starter's SOUL text changes, and add the OLD text's hash to
 * LEGACY_SOUL_HASHES below. A blob stamped with an older version (or none) whose SOUL is still byte-for-byte an older
 * shipped text moves to the current one; a SOUL the user edited is never touched.
 */
export const TEMPLATE_VERSION = 3;

/** sha256 (first 16 hex) of the trimmed SOUL text of every superseded shipped starter version. */
export const LEGACY_SOUL_HASHES: Readonly<Record<string, readonly string[]>> = {
  // v3 renamed the starters and fixed teammate mentions. Keys are the NEW ids; the hashes are every older shipped text.
  popo: ['a4fc335474cfe15f', 'cac654111d191931', '0d83294acdc61728'],
  bobble: ['dffcf7e560ef1718'],
  dimp: ['995aa3c6fec1fc48'],
  plonk: ['d617ec5e1ea0e0fd', '18a401d121709abc'],
  wobbo: ['6d457575de7f9026', '008b26baeb9d9a10'],
  mibble: ['989a42199bd21437', '57358f776daff6cc'],
  zonk: ['67dd2814358976cb', '8d77caada4d50b3c'],
  junip: ['5d32ea8ad3cc99ac', '0dec1413e12db429'],
  tibbo: ['f7d6431a9a06dbe6', 'e326480dae630855'],
  fizzle: ['b752a11e806c738a'],
  kora: ['999d2328e72e0d8f', 'ad46886979ce9e1e'],
};

export function soulHash(text: string): string { return crypto.createHash('sha256').update(text.trim()).digest('hex').slice(0, 16); }

type SoulRefreshStore = {
  list(opts?: { includeArchived?: boolean }): BlobProfile[];
  soul(id: string): string; writeSoul(id: string, text: string): void; setTemplateVersion(id: string, v: number): void;
};

/**
 * Bring starter blobs hired before the latest SOUL rules up to the current template text. Idempotent and safe: only a
 * blob that is behind (no/older templateVersion) is looked at, only a SOUL equal to a known older shipped text is
 * replaced, and every examined blob is stamped so a user edit made later is never compared again. Returns the names changed.
 */
export function refreshStarterSouls(store: SoulRefreshStore, legacy: Readonly<Record<string, readonly string[]>> = LEGACY_SOUL_HASHES): string[] {
  const changed: string[] = [];
  for (const b of store.list({ includeArchived: true })) {
    if ((b.templateVersion ?? 0) >= TEMPLATE_VERSION) continue;
    const tid = canonicalTemplateId(b.templateId) ?? (b.role === 'chief' ? 'kora' : null);
    const spec = tid === 'kora' ? KORA_SPEC : STARTERS.find((s) => s.id === tid);
    if (!spec) continue;
    const cur = store.soul(b.id);
    if (cur.trim() !== spec.soul.trim() && (legacy[spec.id] ?? []).includes(soulHash(cur))) {
      // A blob hired under a pre-rename name keeps that name: its refreshed SOUL says "You are <its name>".
      const own = b.name.trim();
      const renamed = own && own.toLowerCase() !== spec.name.toLowerCase() && tid !== 'kora';
      store.writeSoul(b.id, renamed ? spec.soul.replace(new RegExp(`\\b${spec.name}\\b`, 'g'), own) : spec.soul);
      changed.push(b.name);
    }
    store.setTemplateVersion(b.id, TEMPLATE_VERSION);
  }
  return changed;
}
