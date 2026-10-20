// Team files on the web: the wire twins of the runtime's export report and import plan (docs/bots/GROUPS.md), the two
// small APIs the dialogs call, and the pure helpers (selection, summaries, labels) the tests cover.
import type { BlobOutfit } from "~/components/blobs/avatar";

export type Rule = "auto" | "lead" | "mention";
export type ApiRes<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

// ── export ───────────────────────────────────────────────────────────────────────────────────────
export interface ExportBlobOption {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly outfit: BlobOutfit;
  readonly skills: number;
  readonly routines: number;
}
export interface ExportGroupOption {
  readonly id: string;
  readonly name: string;
  readonly memberIds: ReadonlyArray<string>;
}
export interface ExportSelection {
  readonly blobIds: ReadonlyArray<string>;
  readonly groupIds: ReadonlyArray<string>;
  readonly chief: boolean;
  readonly routines: boolean;
  readonly skills: boolean;
  readonly name: string;
}
export interface ExportReportWire {
  readonly blobs: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly title: string;
    readonly soulChars: number;
    readonly skills: number;
    readonly routines: number;
    readonly removed: number;
  }>;
  readonly groups: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly members: ReadonlyArray<string>;
    readonly lead: string;
    readonly rule: Rule;
    readonly dropped: string | null;
  }>;
  readonly chief: boolean;
  readonly findings: ReadonlyArray<{ readonly kind: string; readonly count: number }>;
  readonly scrubNote: string | null;
  readonly neverIncluded: ReadonlyArray<string>;
  readonly bytes: number;
}
export interface TeamExportApi {
  preview(selection: ExportSelection): Promise<ApiRes<ExportReportWire>>;
  /** Save as a .md file (the host opens the save dialog). */
  save(selection: ExportSelection): Promise<ApiRes<{ readonly path: string | null }>>;
  copy(selection: ExportSelection): Promise<ApiRes<object>>;
}

export function initialSelection(
  blobs: ReadonlyArray<ExportBlobOption>,
  groups: ReadonlyArray<ExportGroupOption>,
  only?: { blobId?: string },
): ExportSelection {
  if (only?.blobId) {
    const b = blobs.find((x) => x.id === only.blobId);
    return {
      blobIds: b ? [b.id] : [],
      groupIds: [],
      chief: false,
      routines: true,
      skills: true,
      name: b?.name ?? "",
    };
  }
  return {
    blobIds: blobs.map((b) => b.id),
    groupIds: groups.map((g) => g.id),
    chief: true,
    routines: true,
    skills: true,
    name: "My team",
  };
}

export function toggleId(ids: ReadonlyArray<string>, id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

/** A group is exportable when at least two of its members are in the file (Kora always travels as the name "Kora"). */
export function groupKeeps(
  group: ExportGroupOption,
  selection: ExportSelection,
  koraId: string | null,
): { readonly kept: number; readonly ok: boolean } {
  const kept = group.memberIds.filter(
    (id) => id === koraId || selection.blobIds.includes(id),
  ).length;
  return { kept, ok: kept >= 2 };
}

export function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
}

export const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

export function exportSummary(sel: ExportSelection, groupsOk: number): string {
  const parts = [plural(sel.blobIds.length, "blob")];
  if (groupsOk > 0) parts.push(plural(groupsOk, "group"));
  return parts.join(" and ");
}

export const NEVER_INCLUDED_DEFAULT: ReadonlyArray<string> = [
  "Chats and memory",
  "API keys and secrets",
  "Model choices",
  "Connected apps and permissions",
  "Computers and folders",
];

// ── import ───────────────────────────────────────────────────────────────────────────────────────
export type FlagKind = "link" | "commands" | "secrets-removed" | "instructions-override";
export interface PlannedBlobWire {
  readonly fileName: string;
  readonly name: string;
  readonly renamed: boolean;
  readonly title: string;
  readonly soul: string;
  readonly outfit: {
    readonly head: string | null;
    readonly face: string | null;
    readonly neck: string | null;
  } | null;
  readonly skills: ReadonlyArray<{ readonly name: string; readonly description: string }>;
  readonly routines: ReadonlyArray<{
    readonly title: string;
    readonly cadence: string;
    readonly prompt: string;
  }>;
  readonly flags: ReadonlyArray<{ readonly kind: FlagKind; readonly text: string }>;
  /** You already have a blob with this name; `identical` = same title and personality. */
  readonly existing?: { readonly id: string; readonly identical: boolean } | null;
}
export interface PlannedGroupWire {
  readonly fileName: string;
  readonly name: string;
  readonly renamed: boolean;
  readonly members: ReadonlyArray<string>;
  readonly lead: string;
  readonly rule: Rule;
  readonly instructions: string;
}
export interface ImportPlanWire {
  /** The daemon keeps the plan under this id: the client only says which parts to skip, it never sends content back. */
  readonly planId: string;
  readonly title: string;
  readonly description: string;
  readonly blobs: ReadonlyArray<PlannedBlobWire>;
  readonly groups: ReadonlyArray<PlannedGroupWire>;
  readonly skipped: ReadonlyArray<{ readonly what: string; readonly why: string }>;
  readonly notes: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  readonly removedSecrets: number;
}
export interface ImportResultWire {
  readonly blobs: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly groups: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly errors: ReadonlyArray<{ readonly what: string; readonly error: string }>;
}
export interface TeamImportApi {
  fromText(text: string): Promise<ApiRes<ImportPlanWire>>;
  fromUrl(url: string): Promise<ApiRes<ImportPlanWire>>;
  apply(
    planId: string,
    skip: {
      readonly blobs: ReadonlyArray<string>;
      readonly groups: ReadonlyArray<string>;
      readonly replace?: ReadonlyArray<string>;
    },
  ): Promise<ApiRes<ImportResultWire>>;
}

export const IMPORT_MAX_BYTES = 256 * 1024;

export interface ImportSkips {
  readonly blobs: ReadonlyArray<string>;
  readonly groups: ReadonlyArray<string>;
  /** Planned names whose existing blob is replaced (title, personality, look) instead of a renamed copy being made. */
  readonly replace?: ReadonlyArray<string>;
}

/** What the review screen starts with: a blob you already have in identical form is unticked (it would add nothing); the rest are kept as renamed copies. */
export function defaultImportSkips(plan: ImportPlanWire): string[] {
  return plan.blobs.filter((b) => b.existing?.identical === true).map((b) => b.name);
}

export type ExistingChoice = "keep" | "replace";

/** What pressing Import will create, after the person's unticks. A group needs two of its members to still be there. */
export function importCounts(plan: ImportPlanWire, skip: ImportSkips) {
  const blobs = plan.blobs.filter((b) => !skip.blobs.includes(b.name));
  const names = new Set(blobs.map((b) => b.name));
  const groups = plan.groups.filter(
    (g) =>
      !skip.groups.includes(g.name) &&
      g.members.filter((m) => m === "Kora" || names.has(m)).length >= 2,
  );
  return {
    blobs: blobs.length,
    groups: groups.length,
    routines: blobs.reduce((n, b) => n + b.routines.length, 0),
    skills: blobs.reduce((n, b) => n + b.skills.length, 0),
    droppedGroups: plan.groups
      .filter((g) => !groups.includes(g) && !skip.groups.includes(g.name))
      .map((g) => g.name),
  };
}

export function importButtonLabel(c: { blobs: number; groups: number }): string {
  if (c.blobs === 0 && c.groups === 0) return "Nothing to import";
  const parts: string[] = [];
  if (c.blobs) parts.push(plural(c.blobs, "blob"));
  if (c.groups) parts.push(plural(c.groups, "group"));
  return `Import ${parts.join(" and ")}`;
}

/** "Added Wobbo and Tibbo", "Replaced Popo", "Added Wobbo and replaced Popo" (the finished import, in plain words). */
export function doneSummary(
  result: { blobs: ReadonlyArray<{ name: string }>; groups: ReadonlyArray<unknown> },
  replacedNames: ReadonlyArray<string>,
): string {
  const replaced = result.blobs.filter((b) => replacedNames.includes(b.name));
  const added = result.blobs.filter((b) => !replacedNames.includes(b.name));
  const parts: string[] = [];
  if (added.length) parts.push(`Added ${plural(added.length, "blob")}`);
  if (result.groups.length)
    parts.push(`${parts.length ? "added" : "Added"} ${plural(result.groups.length, "group")}`);
  if (replaced.length)
    parts.push(
      `${parts.length ? "replaced" : "Replaced"} ${replaced.map((b) => b.name).join(", ")}`,
    );
  return parts.length ? parts.join(" and ") : "Nothing was imported";
}

export const FLAG_LABEL: Record<FlagKind, string> = {
  link: "Has a link",
  commands: "Mentions commands",
  "secrets-removed": "Secrets removed",
  "instructions-override": "Tries to bypass rules",
};

/** Risky flags get the stronger style; "secrets removed" is good news. */
export const flagIsRisky = (k: FlagKind): boolean =>
  k === "commands" || k === "instructions-override";

export function looksLikeUrl(s: string): boolean {
  return /^https:\/\/\S+$/i.test(s.trim());
}
