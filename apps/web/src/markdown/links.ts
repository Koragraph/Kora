import {
  workspaceRelativeFilePath,
  splitFilePathPosition,
  safeDecodeURIComponent,
  parseMarkdownFileLink,
  parseFileUrlHref,
  normalizeMarkdownLinkDestination,
  inlineCodeFilePathCandidate,
  formatFilePathPosition,
  fileBasename,
} from "@kora/client-runtime/markdown/links";

import { formatWorkspaceRelativePath } from "../workspace/filePathDisplay";
import {
  resolvePathLinkTarget,
  isTerminalLinkActivation,
  isAbsolutePath,
} from "../thread/terminal-links";

export { normalizeMarkdownLinkDestination };

export interface MarkdownFileLinkMeta {
  column?: number;
  line?: number;
  basename: string;
  workspaceRelativePath: string | null;
  displayPath: string;
  targetPath: string;
  filePath: string;
}

// [text](dest) with an optional quoted title; dest is <angle bracketed> or a run without spaces.
const INLINE_LINK = /\[[^\]]*\]\(\s*(<[^>\n]*>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

export function extractMarkdownLinkHrefs(markdown: string): string[] {
  return Array.from(markdown.matchAll(INLINE_LINK), (match) =>
    normalizeMarkdownLinkDestination(match[1] ?? ""),
  ).filter((linkTarget) => linkTarget !== "");
}

export const shouldOpenMarkdownFileLinkInEditor = (
  evt: Pick<MouseEvent, "metaKey" | "ctrlKey">,
  hostOs?: string,
): boolean => isTerminalLinkActivation(evt, hostOs);

export const shouldOpenMarkdownFileLinkInBrowserByDefault = (loc: string): boolean =>
  /\.pdf$/i.test(loc.split(/[?#]/, 1)[0] ?? "");

export const isWindowsDrivePathHref = (linkTarget: string): boolean =>
  /^[A-Za-z]:[\\/]/.test(safeDecodeURIComponent(linkTarget));

export function rewriteMarkdownFileUriHref(linkTarget: string | undefined): string | null {
  if (!linkTarget) return null;
  const decoded = parseFileUrlHref(normalizeMarkdownLinkDestination(linkTarget));
  return decoded ? `${decoded.path}${decoded.hash}` : null;
}

export function resolveMarkdownFileLinkTarget(
  linkTarget: string | undefined,
  workDir?: string,
  baseDir: string | undefined = workDir,
): string | null {
  if (!linkTarget) return null;
  const decoded = parseMarkdownFileLink(linkTarget);
  if (!decoded) return null;
  const withPosition = formatFilePathPosition(decoded);
  if (isAbsolutePath(decoded.path)) return withPosition;
  // Relative links need the directory they were written against.
  return baseDir ? resolvePathLinkTarget(withPosition, baseDir) : null;
}

function metaForTarget(targetPath: string, workDir: string | undefined): MarkdownFileLinkMeta {
  const { path, line, column } = splitFilePathPosition(targetPath);
  return {
    filePath: path,
    targetPath,
    displayPath: formatWorkspaceRelativePath(targetPath, workDir),
    workspaceRelativePath: workspaceRelativeFilePath(path, workDir),
    ...(column !== undefined ? { column } : {}),
    ...(line !== undefined ? { line } : {}),
    basename: fileBasename(path),
  };
}

export function resolveMarkdownFileLinkMeta(
  linkTarget: string | undefined,
  workDir?: string,
  baseDir: string | undefined = workDir,
): MarkdownFileLinkMeta | null {
  const dest = resolveMarkdownFileLinkTarget(linkTarget, workDir, baseDir);
  return dest === null ? null : metaForTarget(dest, workDir);
}

/** Inline code needs stronger evidence of being a path than an explicit link does. */
export function resolveInlineCodeFileLinkMeta(
  codeText: string,
  workDir?: string,
  baseDir: string | undefined = workDir,
): MarkdownFileLinkMeta | null {
  const cand = inlineCodeFilePathCandidate(codeText);
  return cand === null ? null : resolveMarkdownFileLinkMeta(cand, workDir, baseDir);
}
