// Where blobs live on this Mac, read from the blobs the daemon already knows (their workspaces share one parent), so the
// editor never shows a hard-coded `~/Blobs` on an install whose folder is `~/Blobs-Dev`.

/** `/Users/me/Blobs-Dev/popo` -> `~/Blobs-Dev/popo` (home is guessed from the path shape; any other path is unchanged). */
export function tildify(path: string): string {
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/, "~").replace(/^\/home\/[^/]+(?=\/|$)/, "~");
}

/** The common parent of the blobs' workspaces, shown with `~`; "~/Blobs" only when no blob exists yet. */
export function blobsRootLabel(blobs: ReadonlyArray<{ readonly workspace: string }>): string {
  const first = blobs[0]?.workspace;
  if (!first) return "~/Blobs";
  const root = first.replace(/\/+$/, "").replace(/\/[^/]+$/, "");
  return tildify(root || "/");
}

/** The folder a new blob will get: `<root>/<name>` (the daemon picks the final slug). */
export function newBlobFolderLabel(
  blobs: ReadonlyArray<{ readonly workspace: string }>,
  name: string,
): string {
  return `${blobsRootLabel(blobs)}/${name.trim() || "…"}`;
}
