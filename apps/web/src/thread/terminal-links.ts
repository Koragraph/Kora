import { formatFilePathPosition, splitFilePathPosition } from "@kora/client-runtime/markdown/links";

import { isMacPlatform } from "../util/utils";

export type TerminalLinkKind = "url" | "path";

export interface TerminalLinkMatch {
  end: number;
  start: number;
  text: string;
  kind: TerminalLinkKind;
}

export interface TerminalBufferLineLike {
  readonly isWrapped?: boolean;
  translateToString(trimTrailing?: boolean): string;
}

export interface WrappedTerminalLinkLineSegment {
  endIndex: number;
  startIndex: number;
  text: string;
  bufferLineNumber: number;
}

export interface WrappedTerminalLinkLine {
  segments: ReadonlyArray<WrappedTerminalLinkLineSegment>;
  text: string;
}

const URL_PATTERN = /https?:\/\/[^\s"'`<>]+/gi;
const PATH_PATTERN = new RegExp(
  [
    // anchored forms: home, dot-relative, root, drive letter, UNC
    String.raw`(?:~/|\.{1,2}/|/|[A-Za-z]:[\\/]|\\\\)[^\s"'<>\x60]+`,
    // bare relative path with at least one slash, optional :line[:col]
    String.raw`(?:[A-Za-z0-9._-]+/)+[A-Za-z0-9._-]+(?::\d+){0,2}`,
  ].join("|"),
  "g",
);
const BRACKET_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
];

const count = (str: string, char: string) => str.split(char).length - 1;

/** Drops sentence punctuation and closers that have no matching opener inside the match. */
function trimClosingDelimiters(matched: string): string {
  let str = matched;
  for (let changed = true; changed;) {
    changed = false;
    const stripped = str.replace(/[.,;!?]+$/, "");
    if (stripped !== str) {
      str = stripped;
      changed = true;
    }
    for (const [open, close] of BRACKET_PAIRS) {
      while (str.endsWith(close) && count(str, close) > count(str, open)) {
        str = str.slice(0, -1);
        changed = true;
      }
    }
  }
  return str;
}

export const isTerminalUrl = (val: string): boolean => /^https?:\/\//i.test(val);

export function isAbsolutePath(val: string): boolean {
  return val.startsWith("/") || /^[A-Za-z]:[\\/]/.test(val) || val.startsWith("\\\\");
}

export function extractTerminalLinks(ln: string): TerminalLinkMatch[] {
  const located: TerminalLinkMatch[] = [];
  const overlaps = (begin: number, until: number) =>
    located.some((link) => begin < link.end && until > link.start);

  const scan = (pattern: RegExp, variant: TerminalLinkKind) => {
    for (const matched of ln.matchAll(pattern)) {
      const str = trimClosingDelimiters(matched[0]);
      if (str === "") continue;
      if (variant === "path" && isTerminalUrl(str)) continue;
      const begin = matched.index;
      const until = begin + str.length;
      if (overlaps(begin, until)) continue;
      located.push({ kind: variant, text: str, start: begin, end: until });
    }
  };
  scan(URL_PATTERN, "url");
  scan(PATH_PATTERN, "path");
  return located.sort((left, right) => left.start - right.start);
}

export function collectWrappedTerminalLinkLine(
  lineNumber: number,
  lineAt: (bufferLineIndex: number) => TerminalBufferLineLike | null | undefined,
): WrappedTerminalLinkLine | null {
  if (!lineAt(lineNumber - 1)) return null;

  let first = lineNumber;
  while (first > 1 && lineAt(first - 1)?.isWrapped === true) {
    first -= 1;
    if (!lineAt(first - 1)) return null;
  }
  // `first` now names the line that really starts the logical row; make sure its own line exists.
  if (!lineAt(first - 1)) return null;

  const pieces: WrappedTerminalLinkLineSegment[] = [];
  let str = "";
  for (let number = first; ; number += 1) {
    const ln = lineAt(number - 1);
    if (!ln) break;
    const continues = lineAt(number)?.isWrapped === true;
    const seg = ln.translateToString(!continues);
    pieces.push({
      bufferLineNumber: number,
      text: seg,
      startIndex: str.length,
      endIndex: str.length + seg.length,
    });
    str += seg;
    if (!continues) break;
  }
  return { text: str, segments: pieces };
}

export function isTerminalLinkActivation(
  evt: Pick<MouseEvent, "metaKey" | "ctrlKey">,
  hostOs: string = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  if (hostOs === "") return false;
  return isMacPlatform(hostOs) ? evt.metaKey && !evt.ctrlKey : evt.ctrlKey && !evt.metaKey;
}

// ---------- resolving a clicked path ----------

const looksWindows = (fallbackBase: string) =>
  /^[A-Za-z]:[\\/]/.test(fallbackBase) ||
  fallbackBase.startsWith("\\\\") ||
  /[A-Za-z]:\\/.test(fallbackBase);

function inferHome(workDir: string): string | null {
  const unix = /^(\/(?:Users|home)\/[^/\\]+)/.exec(workDir);
  if (unix) return unix[1]!;
  const windows = /^([A-Za-z]:[\\/]Users[\\/][^\\/]+)/.exec(workDir);
  return windows ? windows[1]! : null;
}

function joinOnto(fallbackBase: string, tail: string): string {
  const separator = looksWindows(fallbackBase) ? "\\" : "/";
  const head = fallbackBase.replace(/[\\/]+$/, "");
  const rest = separator === "\\" ? tail.replaceAll("/", "\\") : tail.replace(/^\/+/, "");
  return `${head}${separator}${rest}`;
}

export function resolvePathLinkTarget(rawPath: string, workDir: string): string {
  const place = splitFilePathPosition(rawPath);
  let loc = place.path;
  if (loc.startsWith("~/")) {
    const home = inferHome(workDir);
    if (home) loc = joinOnto(home, loc.slice(2));
  } else if (!isAbsolutePath(loc)) {
    loc = joinOnto(workDir, loc);
  }
  return formatFilePathPosition({ ...place, path: loc });
}
