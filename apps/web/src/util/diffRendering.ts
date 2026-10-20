import type { FileDiffMetadata } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs";

export type DiffThemeName = "pierre-light" | "pierre-dark";

export function resolveDiffThemeName(palette: "light" | "dark"): DiffThemeName {
  return palette === "dark" ? "pierre-dark" : "pierre-light";
}

export function fnv1a32(text: string, seed = 0x811c9dc5, multiplier = 0x01000193): number {
  let hash = seed >>> 0;
  for (let idx = 0; idx < text.length; idx++) {
    hash = Math.imul(hash ^ text.charCodeAt(idx), multiplier) >>> 0;
  }
  return hash;
}

export function buildPatchCacheKey(delta: string, scope = "diff-panel"): string {
  const trimmed = delta.trim();
  const head = fnv1a32(trimmed).toString(36);
  const tail = fnv1a32(trimmed, 0x9e3779b9, 0x85ebca6b).toString(36);
  return `${scope}:${trimmed.length}:${head}:${tail}`;
}

export type RenderablePatch =
  | { kind: "files"; files: FileDiffMetadata[] }
  | { kind: "raw"; text: string; reason: string };

export interface DiffLineStat {
  deletions: number;
  additions: number;
}

/**
 * The library's partial-patch parser keeps hunk starts in source-file coordinates, but its
 * virtualizer walks compact rows, so starts are rewritten as running sums.
 */
function compactHunkOffsets(fileRef: FileDiffMetadata): FileDiffMetadata {
  if (!fileRef.isPartial) return fileRef;
  let split = 0;
  let unified = 0;
  const hunks = fileRef.hunks.map((hunk) => {
    const compacted = { ...hunk, splitLineStart: split, unifiedLineStart: unified };
    split += hunk.splitLineCount;
    unified += hunk.unifiedLineCount;
    return compacted;
  });
  return {
    ...fileRef,
    hunks,
    splitLineCount: split,
    unifiedLineCount: unified,
    ...(fileRef.cacheKey ? { cacheKey: `${fileRef.cacheKey}:compact-partial` } : {}),
  };
}

export function getRenderablePatch(
  delta: string | undefined,
  cacheScope = "diff-panel",
  opts?: { compactPartialHunkOffsets?: boolean },
): RenderablePatch | null {
  if (!delta || delta.trim() === "") return null;
  const str = delta.trim();
  try {
    const decoded = parsePatchFiles(str, buildPatchCacheKey(str, cacheScope));
    let files = decoded.flatMap((patch) => patch.files);
    if (opts?.compactPartialHunkOffsets) files = files.map(compactHunkOffsets);
    if (files.length === 0) {
      return { kind: "raw", text: str, reason: "Unsupported diff format. Showing raw patch." };
    }
    return { kind: "files", files };
  } catch {
    return { kind: "raw", text: str, reason: "Failed to parse patch. Showing raw patch." };
  }
}

function resolveFileDiffPath(fileDiff: FileDiffMetadata): string {
  const unparsed = fileDiff.name ?? fileDiff.prevName ?? "";
  return unparsed.replace(/^[ab]\//, "");
}

const mix = (percent: number, b: string, rest: string) =>
  `color-mix(in srgb, var(--code-background) ${percent}%, ${b}${rest ? ` ${rest}` : ""})`;

function changeTints(tok: string): string {
  const light = (percent: number) =>
    `color-mix(in srgb, var(--code-background) ${percent}%, var(${tok}))`;
  return [
    `--diffs-bg-ADD-override: light-dark(${light(50)}, ${light(70)}) !important;`,
    `--diffs-bg-ADD-number-override: light-dark(${light(35)}, ${light(60)}) !important;`,
    `--diffs-bg-ADD-hover-override: ${light(85)} !important;`,
    `--diffs-bg-ADD-emphasis-override: ${light(80)} !important;`,
  ].join("\n  ");
}

/** Maps the renderer's palette onto Kora's code tokens (shared by the diff panel and file preview). */
const DIFF_SURFACE_SELECTORS = [
  "[data-diffs-header]",
  "[data-diff]",
  "[data-file]",
  "[data-error-wrapper]",
  "[data-virtualizer-buffer]",
];

const codeMix = (percent: number) => mix(percent, "var(--code-foreground)", "");

const DIFF_SURFACE_DECLARATIONS = [
  "--diffs-header-font-family: var(--font-sans) !important;",
  "--diffs-font-family: var(--font-mono) !important;",
  "--diffs-bg: var(--code-background) !important;",
  "--diffs-light-bg: var(--code-background) !important;",
  "--diffs-dark-bg: var(--code-background) !important;",
  "--diffs-token-light-bg: transparent;",
  "--diffs-token-dark-bg: transparent;",
  "--diffs-modified-color-override: var(--ring);",
  `--diffs-bg-context-override: ${codeMix(97)} !important;`,
  `--diffs-bg-hover-override: ${codeMix(94)} !important;`,
  `--diffs-bg-separator-override: ${codeMix(95)} !important;`,
  `--diffs-bg-buffer-override: ${codeMix(90)} !important;`,
  changeTints("--diff-addition").replaceAll("ADD", "addition"),
  changeTints("--diff-deletion").replaceAll("ADD", "deletion"),
  "background-color: var(--diffs-bg) !important;",
  "color: var(--code-foreground) !important;",
];

export const DIFF_SURFACE_THEME_UNSAFE_CSS = `
${DIFF_SURFACE_SELECTORS.join(",\n")} {
  ${DIFF_SURFACE_DECLARATIONS.join("\n  ")}
}
`;
