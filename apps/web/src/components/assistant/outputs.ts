/**
 * assistant-lane outputs: classifying, extracting and opening files the agent
 * produced under a chat project's root (`<project>/outputs/`, but anything
 * under the project root counts — scratch and files/ included).
 *
 * Two sources feed the "what did this turn produce" list rendered in
 * ThreadTranscript:
 *  - tool activity (`WorkLogEntry.changedFiles`, already extracted from
 *    file_change / Write-shaped tool payloads by session-logic.ts)
 *  - the assistant's own final markdown (an explicit link or a path-shaped
 *    inline code span that resolves under the project root)
 */
import {
  fileBasename,
  inlineCodeFilePathCandidate,
  isRelativeFilePath,
  workspaceRelativeFilePath,
} from "@kora/client-runtime/markdown/links";
import type { HostThreadRef } from "@kora/contracts";
import {
  FileCodeIcon,
  FileIcon,
  FileJsonIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  GlobeIcon,
  ImageIcon,
  PresentationIcon,
  TableIcon,
  type LucideIcon,
} from "lucide-react";
import { useCallback } from "react";

import { useDockStore } from "~/stores/dockStore";

import { extractMarkdownLinkHrefs, resolveMarkdownFileLinkTarget } from "../../markdown/links";

export type OutputKind =
  | "markdown"
  | "table"
  | "html"
  | "json"
  | "image"
  | "pdf"
  | "code"
  | "other";

const KIND_BY_EXTENSION: Readonly<Record<string, OutputKind>> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".mdx": "markdown",
  ".csv": "table",
  ".tsv": "table",
  ".html": "html",
  ".htm": "html",
  ".json": "json",
  ".jsonc": "json",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "image",
  ".webp": "image",
  ".svg": "image",
  ".avif": "image",
  ".ico": "image",
  ".pdf": "pdf",
};

/** Binary office/archive formats: never previewable inline, always the "open externally" card. */
const OTHER_BINARY_EXTENSIONS = new Set([
  ".docx",
  ".doc",
  ".xlsx",
  ".xls",
  ".pptx",
  ".ppt",
  ".zip",
  ".tar",
  ".gz",
  ".rar",
  ".7z",
  ".sqlite",
  ".db",
]);

function extname(path: string): string {
  const base = fileBasename(path);
  const dotIndex = base.lastIndexOf(".");
  return dotIndex > 0 ? base.slice(dotIndex).toLowerCase() : "";
}

export function classifyOutputKind(path: string): OutputKind {
  const extension = extname(path);
  const known = KIND_BY_EXTENSION[extension];
  if (known) return known;
  if (OTHER_BINARY_EXTENSIONS.has(extension)) return "other";
  return "code";
}

const OUTPUT_KIND_ICON: Readonly<Record<OutputKind, LucideIcon>> = {
  markdown: FileTextIcon,
  table: TableIcon,
  html: GlobeIcon,
  json: FileJsonIcon,
  image: ImageIcon,
  pdf: FileIcon,
  code: FileCodeIcon,
  other: FileIcon,
};

export function outputKindIcon(kind: OutputKind): LucideIcon {
  return OUTPUT_KIND_ICON[kind];
}

const OUTPUT_KIND_LABEL: Readonly<Record<OutputKind, string>> = {
  markdown: "Report",
  table: "Table",
  html: "Page",
  json: "Data",
  image: "Image",
  pdf: "PDF",
  code: "Code",
  other: "File",
};

export function outputKindLabel(kind: OutputKind): string {
  return OUTPUT_KIND_LABEL[kind];
}

// ---------------------------------------------------------------------------
// Output families (Blobs): what kind of rich card / preview a finished file earns
// ---------------------------------------------------------------------------

/**
 * Finer than `OutputKind` where it matters for a preview: spreadsheets, Word documents and slide decks are all
 * "other" binaries to the file viewer, but the Blobs surface renders each its own way (a sheet table, a document
 * card, a deck card). Text families reuse `OutputKind`'s meaning.
 */
export type OutputFamily =
  | "sheet"
  | "delimited"
  | "document"
  | "slides"
  | "pdf"
  | "image"
  | "markdown"
  | "html"
  | "json"
  | "text"
  | "other";

const FAMILY_BY_EXTENSION: Readonly<Record<string, OutputFamily>> = {
  ".xlsx": "sheet",
  ".xlsm": "sheet",
  ".csv": "delimited",
  ".tsv": "delimited",
  ".docx": "document",
  ".pptx": "slides",
  ".pdf": "pdf",
  ".md": "markdown",
  ".markdown": "markdown",
  ".mdx": "markdown",
  ".html": "html",
  ".htm": "html",
  ".json": "json",
  ".jsonc": "json",
  ".txt": "text",
};

export function classifyOutputFamily(path: string): OutputFamily {
  const extension = extname(path);
  const known = FAMILY_BY_EXTENSION[extension];
  if (known) return known;
  const kind = classifyOutputKind(path);
  return kind === "image" ? "image" : kind === "other" ? "other" : "text";
}

const OUTPUT_FAMILY_LABEL: Readonly<Record<OutputFamily, string>> = {
  sheet: "Spreadsheet",
  delimited: "Table",
  document: "Document",
  slides: "Slides",
  pdf: "PDF",
  image: "Image",
  markdown: "Report",
  html: "Page",
  json: "Data",
  text: "File",
  other: "File",
};

const OUTPUT_FAMILY_ICON: Readonly<Record<OutputFamily, LucideIcon>> = {
  sheet: FileSpreadsheetIcon,
  delimited: TableIcon,
  document: FileTextIcon,
  slides: PresentationIcon,
  pdf: FileIcon,
  image: ImageIcon,
  markdown: FileTextIcon,
  html: GlobeIcon,
  json: FileJsonIcon,
  text: FileCodeIcon,
  other: FileIcon,
};

export function outputFamilyIcon(family: OutputFamily): LucideIcon {
  return OUTPUT_FAMILY_ICON[family];
}

export function outputFamilyLabel(family: OutputFamily): string {
  return OUTPUT_FAMILY_LABEL[family];
}

/** Families whose bytes are binary: they cannot come through `projects.readFile` and need the file-bytes path. */
export function outputFamilyIsBinary(family: OutputFamily): boolean {
  return (
    family === "sheet" ||
    family === "document" ||
    family === "slides" ||
    family === "pdf" ||
    family === "image"
  );
}

/** "420 B" / "12 KB" / "3.4 MB", matching the format already used for fleet worker reports. */
export function formatOutputSize(byteLength: number): string {
  if (!Number.isFinite(byteLength) || byteLength < 0) return "0 B";
  if (byteLength < 1024) return `${byteLength} B`;
  if (byteLength < 1024 * 1024) return `${(byteLength / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
  return `${(byteLength / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

function normalizeRootPath(root: string): string {
  return root.replaceAll("\\", "/").replace(/\/+$/, "");
}

/**
 * A raw path reported by a tool call or authored in markdown, resolved to a
 * path relative to the project root — the shape `FileViewerPanel`'s
 * `relativePath` and `projects.readFile` expect. Returns null when the path
 * cannot be placed inside the root (outside the project, or unresolvable).
 */
export function resolveProjectOutputPath(
  rawPath: string,
  root: string | null | undefined,
): string | null {
  if (!root || !rawPath) return null;
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) return null;

  if (isRelativeFilePath(trimmed)) {
    const normalized = trimmed.replaceAll("\\", "/").replace(/^\.\//, "");
    if (normalized.length === 0 || normalized.startsWith("../")) return null;
    return normalized;
  }

  const relative = workspaceRelativeFilePath(trimmed, normalizeRootPath(root));
  if (relative) return relative;
  // The same folder under another spelling (a symlinked home or temp dir: /var/… vs /private/var/…): an absolute
  // path into this project's outputs/ still names the deliverable.
  const normalized = trimmed.replaceAll("\\", "/");
  const rootName = normalizeRootPath(root).replace(/\/+$/, "").split("/").at(-1);
  const marker = rootName ? `/${rootName}/outputs/` : null;
  const at = marker ? normalized.lastIndexOf(marker) : -1;
  return at >= 0 && marker ? `outputs/${normalized.slice(at + marker.length)}` : null;
}

interface OutputCandidateSource {
  readonly changedFiles?: ReadonlyArray<string> | undefined;
}

/** Paths a tool activity (file_change / Write et al.) reported, resolved under the project root. */
/** A tool-written file that is tooling, not a deliverable: a helper script, or anything in the blob's `scratch/` folder. */
function isHelperOutputPath(relativePath: string): boolean {
  return /\.(py|sh|bash|zsh|command)$/i.test(relativePath) || /(^|\/)scratch\//.test(relativePath);
}

/**
 * Files a tool call wrote. Helper scripts and `scratch/` files get no card from the activity (the model wrote them to
 * get its job done); one the assistant's own text names still does (extractOutputPathsFromMarkdown).
 */
export function extractOutputPathsFromWorkLogEntry(
  entry: OutputCandidateSource,
  root: string | null | undefined,
): string[] {
  if (!root || !entry.changedFiles || entry.changedFiles.length === 0) return [];
  const resolved: string[] = [];
  for (const rawPath of entry.changedFiles) {
    const relativePath = resolveProjectOutputPath(rawPath, root);
    if (relativePath && !isHelperOutputPath(relativePath)) resolved.push(relativePath);
  }
  return resolved;
}

const INLINE_CODE_PATTERN = /`([^`\n]+)`/g;
const BARE_OUTPUT_NAME_PATTERN =
  /^[\w.\- ]+\.(md|markdown|csv|tsv|html?|json|txt|pdf|png|jpe?g|gif|svg|webp|xlsx|docx|pptx)$/i;

/** Paths the assistant's own markdown mentions (explicit links and path-shaped inline code). */
export function extractOutputPathsFromMarkdown(
  markdown: string,
  root: string | null | undefined,
  cwd?: string,
): string[] {
  if (!root || !markdown) return [];
  const resolved: string[] = [];

  for (const href of extractMarkdownLinkHrefs(markdown)) {
    const target = resolveMarkdownFileLinkTarget(href, cwd ?? root);
    if (!target) continue;
    const relativePath = resolveProjectOutputPath(target, root);
    if (relativePath) resolved.push(relativePath);
  }

  for (const match of markdown.matchAll(INLINE_CODE_PATTERN)) {
    const codeText = match[1];
    if (!codeText) continue;
    // A bare file name ("report.csv") on the assistant lane names a deliverable in outputs/ — that's where the leader
    // is told to write, and it often mentions just the name after writing it from a shell command.
    const bare = codeText.trim();
    if (BARE_OUTPUT_NAME_PATTERN.test(bare)) {
      resolved.push(`outputs/${bare}`);
      continue;
    }
    const candidate = inlineCodeFilePathCandidate(codeText);
    if (!candidate) continue;
    const relativePath = resolveProjectOutputPath(candidate, root);
    if (relativePath) resolved.push(relativePath);
  }

  return resolved;
}

/** Latest mention of a path wins; a set keeps the first position, which is what a stable card order wants. */
export function dedupeOutputPaths(paths: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}

export function outputDisplayName(relativePath: string): string {
  return fileBasename(relativePath);
}

/** Default character budget for `truncateOutputName` — long enough that the common report/data
 *  filenames the swarm writes ("llm-inference-cost-comparison.csv") stay legible on the card. */
const OUTPUT_NAME_MAX_CHARS = 36;

/**
 * Middle-truncates a filename to at most `maxChars`, keeping the extension visible
 * ("llm-inference-cost…comparison.csv" rather than "llm-inference-cost-compari…"). The full name
 * always belongs in a `title` attribute alongside this — truncation is display-only.
 */
export function truncateOutputName(name: string, maxChars: number = OUTPUT_NAME_MAX_CHARS): string {
  if (name.length <= maxChars) return name;

  const dotIndex = name.lastIndexOf(".");
  // No extension, or a dotfile (".gitignore") whose leading dot isn't an extension separator.
  const hasExtension = dotIndex > 0 && dotIndex < name.length - 1;
  const extension = hasExtension ? name.slice(dotIndex) : "";
  const stem = hasExtension ? name.slice(0, dotIndex) : name;

  // Reserve room for the extension and the ellipsis; split what's left between the head and tail
  // of the stem so both ends stay readable.
  const budget = Math.max(maxChars - extension.length - 1, 2);
  const headLength = Math.ceil(budget / 2);
  const tailLength = Math.floor(budget / 2);

  if (stem.length <= budget) return `${stem}${extension}`;
  const head = stem.slice(0, headLength);
  const tail = tailLength > 0 ? stem.slice(stem.length - tailLength) : "";
  return `${head}…${tail}${extension}`;
}

// ---------------------------------------------------------------------------
// Opening a chat output in the right panel
// ---------------------------------------------------------------------------

/**
 * Opens `relativePath` (project-root-relative) as the thread's right-panel
 * file surface — the same "file" surface kind `FileViewerPanel` already
 * renders, so no new panel kind or ThreadView wiring is required.
 */
function openChatOutput(ref: HostThreadRef, relativePath: string): void {
  useDockStore.getState().openFile(ref, relativePath);
}

export function useOpenChatOutput(
  ref: HostThreadRef | null | undefined,
): (relativePath: string) => void {
  return useCallback(
    (relativePath: string) => {
      if (!ref) return;
      openChatOutput(ref, relativePath);
    },
    [ref],
  );
}
