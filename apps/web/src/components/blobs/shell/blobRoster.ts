// Roster ordering: the Chief is always first and never reorders; the team follows, pinned first and then by the most
// recent activity. Pure, so the "Kora first" rule is tested without React.
import { CHIEF_BLOB_ID, type BlobProfile } from "@kora/contracts";

export interface Roster {
  readonly chief: BlobProfile | null;
  /** Visible, un-retired members in display order. */
  readonly team: BlobProfile[];
  /** Hidden by the user (still on the team). */
  readonly hidden: BlobProfile[];
  /** Retired (archived): off the roster until rehired. */
  readonly retired: BlobProfile[];
}

export function isChief(blob: Pick<BlobProfile, "id" | "role">): boolean {
  return blob.role === "chief" || blob.id === CHIEF_BLOB_ID;
}

/** `lastActiveAt`: blobId -> epoch ms of the blob's newest thread activity (missing = never). */
export function orderRoster(
  blobs: readonly BlobProfile[],
  lastActiveAt: ReadonlyMap<string, number> = new Map(),
): Roster {
  const chief = blobs.find((b) => isChief(b) && !b.archivedAt) ?? null;
  const rest = blobs.filter((b) => b !== chief && !isChief(b));
  const activity = (b: BlobProfile) => lastActiveAt.get(b.id) ?? 0;
  const byRecency = (a: BlobProfile, b: BlobProfile) =>
    Number(b.pinned) - Number(a.pinned) ||
    activity(b) - activity(a) ||
    a.createdAt - b.createdAt ||
    a.name.localeCompare(b.name);
  const live = rest.filter((b) => !b.archivedAt);
  return {
    chief,
    team: live.filter((b) => !b.hidden).sort(byRecency),
    hidden: live.filter((b) => b.hidden).sort(byRecency),
    retired: rest
      .filter((b) => b.archivedAt)
      .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)),
  };
}

/** Names are unique case-insensitively among non-retired blobs (delegation and @mention route by name). */
export function isNameTaken(
  blobs: readonly Pick<BlobProfile, "id" | "name" | "archivedAt">[],
  name: string,
  exceptId: string | null = null,
): boolean {
  const wanted = name.trim().toLowerCase();
  if (wanted.length === 0) return false;
  return blobs.some(
    (b) => !b.archivedAt && b.id !== exceptId && b.name.trim().toLowerCase() === wanted,
  );
}
