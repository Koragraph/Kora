// Enough hits to look past same-named neighbours (`ThreadView.test.tsx`) without
// asking for a full listing on a single click.
export const WORKSPACE_BASENAME_LOOKUP_LIMIT: number = 25;

// One counter for every caller: they all open the same panel, so the newest
// click wins regardless of which one started the lookup.
let newestLookupTicket = 0;

/** Call the returned predicate when the search settles; false means a later click superseded it. */
export function claimWorkspaceBasenameLookup(): () => boolean {
  const ticket = ++newestLookupTicket;
  return () => ticket === newestLookupTicket;
}

export interface WorkspaceEntryCandidate {
  readonly kind: "file" | "directory";
  readonly path: string;
}

function basenameOfPath(loc: string): string {
  const separatorIndex = Math.max(loc.lastIndexOf("/"), loc.lastIndexOf("\\"));
  return separatorIndex >= 0 ? loc.slice(separatorIndex + 1) : loc;
}

export function needsWorkspaceBasenameLookup(relativePath: string): boolean {
  const stripped = relativePath.trim();
  return stripped.length > 0 && !stripped.includes("/") && !stripped.includes("\\");
}

export function pickWorkspaceBasenameMatch(
  basename: string,
  records: ReadonlyArray<WorkspaceEntryCandidate>,
): string | null {
  const dest = basename.trim();
  if (!dest) return null;
  const files = records.filter((rec) => rec.kind === "file");
  const exact = files.find((rec) => basenameOfPath(rec.path) === dest);
  if (exact) return exact.path;
  // Folded matching covers casing that drifted from disk, but `FOO.ts` against
  // both `Foo.ts` and `foo.ts` has no right answer, so it resolves to nothing
  // rather than opening whichever the index ranked first.
  const folded = dest.toLowerCase();
  const foldedMatches = files.filter((rec) => basenameOfPath(rec.path).toLowerCase() === folded);
  return foldedMatches.length === 1 ? (foldedMatches[0]?.path ?? null) : null;
}
