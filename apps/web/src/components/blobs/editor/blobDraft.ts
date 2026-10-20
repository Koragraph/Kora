// The editor's draft: plain data, discarded on cancel, turned into a `blobs.create` BlobDraft or a minimal
// `blobs.update` patch on save. Pure, so the rules (dirty, validation, patch) are unit-tested.
import type {
  BlobDefaults,
  BlobDraft,
  BlobEngine,
  BlobPermission,
  BlobProfile,
  BlobProfilePatch,
  BlobToolGrants,
} from "@kora/contracts";

import { shuffledOutfit, type BlobOutfit } from "~/components/blobs/avatar";
import { fromAvatarOutfit, sameOutfit, toAvatarOutfit } from "../outfit";
import { isNameTaken } from "../shell/blobRoster";
import { suggestBlobName } from "../shell/blobNames";
import { NO_GRANTS, normalizeGrants, type AppGrants } from "../apps/appsModel";
import { SOUL_PRESETS } from "./soulPresets";

export const NAME_MAX = 32;
export const TITLE_MAX = 40;
export const SOUL_MAX = 8000;

export interface EditorDraft {
  readonly name: string;
  readonly title: string;
  readonly outfit: BlobOutfit;
  readonly soul: string;
  /** null = best installed. */
  readonly engine: BlobEngine | null;
  readonly permission: BlobPermission;
  /** Free helpers for its legwork (reading many pages, checking a list): on by default; at most two at a time. */
  readonly helpers: boolean;
  /** Which connected apps it may use (`BlobToolGrants.apps`). Default: none. */
  readonly apps: AppGrants;
}

export function newEditorDraft(input: {
  readonly defaults: BlobDefaults | null;
  readonly takenNames: Iterable<string>;
  readonly random?: () => number;
}): EditorDraft {
  const random = input.random ?? Math.random;
  return {
    name: suggestBlobName(input.takenNames, random),
    title: "",
    outfit: shuffledOutfit(false, random),
    soul: input.defaults?.soulTemplate.trim() ? input.defaults.soulTemplate : SOUL_PRESETS[0]!.text,
    engine: input.defaults?.engine ?? null,
    permission: input.defaults?.permission ?? "auto",
    helpers: true,
    apps: NO_GRANTS,
  };
}

/** A proposal's draft (Tweak) opens the editor with its name, title, soul, look, model and permission filled in. */
export function editorDraftFromBlobDraft(d: BlobDraft): EditorDraft {
  return {
    name: d.name,
    title: d.title,
    outfit: toAvatarOutfit(d.outfit, d.templateId ?? d.name, false),
    soul: d.soul,
    engine: d.engine,
    permission: d.permission,
    helpers: true,
    apps: NO_GRANTS,
  };
}

export function editorDraftFromBlob(profile: BlobProfile, soul: string): EditorDraft {
  return {
    name: profile.name,
    title: profile.title,
    outfit: toAvatarOutfit(profile.outfit, profile.id, profile.role === "chief"),
    soul,
    engine: profile.engine,
    permission: profile.permission,
    helpers: profile.helpers !== false,
    apps: normalizeGrants(profile.toolGrants?.apps),
  };
}

const sameEngine = (a: BlobEngine | null, b: BlobEngine | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.instanceId === b.instanceId &&
    a.model === b.model &&
    a.effort === b.effort);

/** Same grants whatever the order of the entries. */
function sameGrants(a: AppGrants, b: AppGrants): boolean {
  if (a.mode !== b.mode) return false;
  if (a.mode !== "list") return true;
  const x = [...a.allow].map((e) => e.toLowerCase()).sort();
  const y = [...b.allow].map((e) => e.toLowerCase()).sort();
  return x.length === y.length && x.every((e, i) => e === y[i]);
}

export function isEditorDraftDirty(a: EditorDraft, b: EditorDraft): boolean {
  return (
    !sameGrants(a.apps, b.apps) ||
    a.name.trim() !== b.name.trim() ||
    a.title.trim() !== b.title.trim() ||
    a.soul.trim() !== b.soul.trim() ||
    a.permission !== b.permission ||
    a.helpers !== b.helpers ||
    !sameOutfit(a.outfit, b.outfit) ||
    !sameEngine(a.engine, b.engine)
  );
}

export interface DraftErrors {
  readonly name?: string;
  readonly soul?: string;
}

export function validateEditorDraft(
  draft: EditorDraft,
  blobs: readonly Pick<BlobProfile, "id" | "name" | "archivedAt">[],
  exceptId: string | null,
): DraftErrors {
  const errors: { name?: string; soul?: string } = {};
  const name = draft.name.trim();
  if (name.length === 0) errors.name = "Give your blob a name.";
  else if (name.length > NAME_MAX) errors.name = `Keep it under ${NAME_MAX} characters.`;
  else if (isNameTaken(blobs, name, exceptId))
    errors.name = `You already have a blob called ${name}.`;
  if (draft.soul.length > SOUL_MAX)
    errors.soul = `That is a lot of personality (max ${SOUL_MAX} characters).`;
  return errors;
}

export function toBlobDraft(draft: EditorDraft, base?: BlobDraft): BlobDraft {
  const title = draft.title.trim();
  return {
    // A tweaked proposal keeps what the editor does not show: what it does, how, its apps, skills and routines.
    ...(base
      ? {
          apps: base.apps,
          skills: base.skills,
          routines: base.routines,
          templateId: base.templateId,
        }
      : {}),
    name: draft.name.trim(),
    title,
    job: base?.job ?? title,
    howItWorks: base?.howItWorks ?? [],
    soul: draft.soul.trim(),
    engine: draft.engine,
    permission: draft.permission,
    outfit: fromAvatarOutfit(draft.outfit),
    apps: base?.apps ?? [],
    skills: base?.skills ?? [],
    routines: base?.routines ?? [],
    templateId: base?.templateId ?? null,
  };
}

/** Only what changed, so an untouched field is never rewritten (and the Chief's fixed fields are never sent). */
export function toProfilePatch(
  original: EditorDraft,
  draft: EditorDraft,
  /** The profile's current grants: an apps change keeps the rest of them (mcp, computer) as they are. */
  baseGrants?: BlobToolGrants,
): BlobProfilePatch {
  const patch: {
    name?: string;
    title?: string;
    outfit?: ReturnType<typeof fromAvatarOutfit>;
    engine?: BlobEngine;
    permission?: BlobPermission;
    helpers?: boolean;
    toolGrants?: BlobToolGrants;
  } = {};
  if (draft.name.trim() !== original.name.trim()) patch.name = draft.name.trim();
  if (draft.title.trim() !== original.title.trim()) patch.title = draft.title.trim();
  if (!sameOutfit(draft.outfit, original.outfit)) patch.outfit = fromAvatarOutfit(draft.outfit);
  if (!sameEngine(draft.engine, original.engine) && draft.engine) patch.engine = draft.engine;
  if (draft.permission !== original.permission) patch.permission = draft.permission;
  if (draft.helpers !== original.helpers) patch.helpers = draft.helpers;
  if (baseGrants && !sameGrants(draft.apps, original.apps)) {
    patch.toolGrants = {
      ...baseGrants,
      apps: { mode: draft.apps.mode, allow: [...draft.apps.allow] },
    };
  }
  return patch;
}
