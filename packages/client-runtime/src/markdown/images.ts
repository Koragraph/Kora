import { isWin32AbsolutePath } from "@kora/shared/projectPaths";

import {
  stripSlashPrefixedWindowsDrive,
  splitMarkdownLinkSearchAndHash,
  safeDecodeURIComponent,
  parseFileUrlHref,
  normalizeMarkdownLinkDestination,
} from "./links.ts";

export type MarkdownImageSource =
  | { _tag: "Direct"; uri: string }
  | { _tag: "WorkspaceFile"; path: string }
  | { _tag: "Blocked" };

const BLOCKED: MarkdownImageSource = { _tag: "Blocked" };

export function markdownImageSourceFragment(source: string): string {
  const destination = normalizeMarkdownLinkDestination(source);
  const hashAt = destination.indexOf("#");
  return hashAt < 0 ? "" : destination.slice(hashAt);
}

const decodedPath = (raw: string): string =>
  stripSlashPrefixedWindowsDrive(safeDecodeURIComponent(raw));

type MaybeText = string | null | undefined;

export function classifyMarkdownImageSource(
  value: MaybeText,
  workspaceRoot?: string | null,
): MarkdownImageSource {
  if (value === null || value === undefined) return BLOCKED;
  const destination = normalizeMarkdownLinkDestination(value);
  if (destination === "" || destination.startsWith("#") || destination.startsWith("?")) {
    return BLOCKED;
  }

  if (/^(?:https?|data|blob):/i.test(destination) || destination.startsWith("//")) {
    return { _tag: "Direct", uri: destination };
  }

  if (/^file:/i.test(destination)) {
    const file = parseFileUrlHref(destination);
    return file === null ? BLOCKED : { _tag: "WorkspaceFile", path: decodedPath(file.path) };
  }

  const path = decodedPath(splitMarkdownLinkSearchAndHash(destination).path);
  if (path === "") return BLOCKED;
  if (path.startsWith("/") || isWin32AbsolutePath(path)) return { _tag: "WorkspaceFile", path };
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path) || path.startsWith("~/") || path.startsWith("~\\")) {
    return BLOCKED;
  }

  if (!workspaceRoot) return BLOCKED;
  const separator = isWin32AbsolutePath(workspaceRoot) ? "\\" : "/";
  const root = workspaceRoot.replace(/[/\\]+$/, "");
  const relative = path.replace(/[/\\]/g, separator).replace(/^[/\\]+/, "");
  return { _tag: "WorkspaceFile", path: `${root}${separator}${relative}` };
}
