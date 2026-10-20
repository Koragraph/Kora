import {
  stripSlashPrefixedWindowsDrive,
  splitFilePathPosition,
  formatFilePathPosition,
  fileBasename,
} from "@kora/client-runtime/markdown/links";
import { isWin32AbsolutePath } from "@kora/shared/projectPaths";

function normalizeForDisplay(loc: string): string {
  const slashed = stripSlashPrefixedWindowsDrive(loc.replaceAll("\\", "/"));
  // macOS reports /private/var/... for a project that was opened as /var/...
  return slashed.replace(/^\/private(?=\/(?:var|tmp|etc)(?:\/|$))/, "");
}

/** `kora/src/a.ts:12`: the path under the workspace folder's name, with its position kept. */
export function formatWorkspaceRelativePath(
  pathWithPlace: string,
  rootFolder: string | undefined,
): string {
  const place = splitFilePathPosition(pathWithPlace);
  const loc = normalizeForDisplay(place.path);
  return formatFilePathPosition({
    ...place,
    path: rootFolder ? underRoot(loc, rootFolder) : loc,
  });
}

function underRoot(loc: string, rootFolder: string): string {
  const baseDir = normalizeForDisplay(rootFolder.trim().replace(/[\\/]+$/, ""));
  const caption = fileBasename(baseDir);
  const fold =
    isWin32AbsolutePath(baseDir) || rootFolder.trim().startsWith("\\\\")
      ? (str: string) => str.toLowerCase()
      : (str: string) => str;

  if (fold(loc) === fold(baseDir)) return caption;
  const rootWithSlash = `${baseDir}/`;
  if (fold(loc).startsWith(fold(rootWithSlash)))
    return `${caption}/${loc.slice(rootWithSlash.length)}`;

  if (!loc.startsWith("/") && !isWin32AbsolutePath(loc)) {
    const relative = loc.replace(/^(?:\.\/)+/, "").replace(/^\/+/, "");
    return relative.startsWith(`${caption}/`) ? loc : `${caption}/${relative}`;
  }
  return loc;
}
