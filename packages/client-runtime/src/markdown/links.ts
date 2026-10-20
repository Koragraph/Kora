import { isWin32AbsolutePath } from "@kora/shared/projectPaths";

export interface FilePathPosition {
  readonly column?: number;
  readonly line?: number;
  readonly path: string;
}

export const safeDecodeURIComponent = (value: string): string => {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Malformed escapes stay as they were written.
  }
  return decoded;
};

export function normalizeMarkdownLinkDestination(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 1 && trimmed.startsWith("<") && trimmed.endsWith(">")
    ? trimmed.slice(1, -1)
    : trimmed;
}

/** Browser URL parsers write a file URL's drive as `/C:/...`; turn that back into `C:/...`. */
export function stripSlashPrefixedWindowsDrive(path: string): string {
  return /^\/[a-zA-Z]:[/\\]/.test(path) ? path.slice(1) : path;
}

export function splitMarkdownLinkSearchAndHash(value: string): { path: string; hash: string } {
  const hashAt = value.indexOf("#");
  const hash = hashAt < 0 ? "" : value.slice(hashAt);
  const beforeHash = hashAt < 0 ? value : value.slice(0, hashAt);
  const queryAt = beforeHash.indexOf("?");
  return { path: queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt), hash };
}

export function parseFileUrlHref(href: string): { path: string; hash: string } | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol.toLowerCase() !== "file:") return null;

  const host = url.hostname;
  // The pathname stays percent-encoded: callers decode exactly once.
  const path =
    host !== "" && host.toLowerCase() !== "localhost"
      ? `\\\\${host}${url.pathname.replaceAll("/", "\\")}`
      : url.pathname;
  if (path === "") return null;
  return { path: stripSlashPrefixedWindowsDrive(path), hash: url.hash };
}

const POSITION_SUFFIX = /^(.*?):(\d+)(?::(\d+))?$/;
const POSITION_ANCHOR = /^#L(\d+)(?:C(\d+))?$/i;

const withPosition = (
  path: string,
  line: number,
  column: number | undefined,
): FilePathPosition => ({
  path,
  ...(line > 0 ? { line } : {}),
  ...(line > 0 && column !== undefined && column > 0 ? { column } : {}),
});

export function splitFilePathPosition(path: string, hash = ""): FilePathPosition {
  const suffix = POSITION_SUFFIX.exec(path);
  if (suffix) {
    return withPosition(
      suffix[1]!,
      Number(suffix[2]),
      suffix[3] === undefined ? undefined : Number(suffix[3]),
    );
  }
  const anchor = POSITION_ANCHOR.exec(hash);
  if (anchor) {
    return withPosition(
      path,
      Number(anchor[1]),
      anchor[2] === undefined ? undefined : Number(anchor[2]),
    );
  }
  return { path };
}

export function formatFilePathPosition(position: FilePathPosition): string {
  const { path, line, column } = position;
  if (!line) return path;
  return path + ":" + line + (column ? ":" + column : "");
}

export function isRelativeFilePath(path: string): boolean {
  if (path.startsWith("~/") || path.startsWith("./") || path.startsWith("../")) return true;
  return !path.startsWith("/") && !isWin32AbsolutePath(path);
}

export function fileBasename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  if (trimmed === "") return path;
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
}

type RootPath = string | null | undefined;

export function workspaceRelativeFilePath(path: string, workspaceRoot: RootPath): string | null {
  if (!workspaceRoot) return null;
  const flatten = (value: string) => stripSlashPrefixedWindowsDrive(value).replaceAll("\\", "/");
  const rootWindows = isWin32AbsolutePath(stripSlashPrefixedWindowsDrive(workspaceRoot));
  const root = flatten(workspaceRoot).replace(/\/+$/, "");
  const target = flatten(path);
  const prefix = `${root}/`;
  const head = target.slice(0, prefix.length);
  const same = rootWindows ? head.toLowerCase() === prefix.toLowerCase() : head === prefix;
  return same ? target.slice(prefix.length) : null;
}

// ---- Deciding whether a link destination names a file ------------------------------------

const POSIX_ROOTS = [
  "Users",
  "home",
  "tmp",
  "var",
  "etc",
  "opt",
  "mnt",
  "Volumes",
  "private",
  "root",
  "usr",
  "bin",
  "sbin",
  "lib",
  "lib64",
  "srv",
  "dev",
  "proc",
  "sys",
  "run",
  "boot",
  "media",
  "workspace",
  "workspaces",
].map((name) => `/${name}/`);

const EXTENSIONLESS_NAMES = new Set([
  "Makefile",
  "makefile",
  "Containerfile",
  "Dockerfile",
  "GNUmakefile",
  "Justfile",
  "justfile",
  "Rakefile",
  "Gemfile",
  "Procfile",
  "Brewfile",
  "Jenkinsfile",
  "Vagrantfile",
  "Caddyfile",
  "Podfile",
  "Fastfile",
  "WORKSPACE",
  "BUILD",
  "LICENSE",
  "LICENCE",
  "COPYING",
  "NOTICE",
  "AUTHORS",
  "CHANGELOG",
  "CONTRIBUTORS",
  "CODEOWNERS",
  "README",
]);

const NAME_CHARS = "[A-Za-z0-9._-]+(?: +[A-Za-z0-9._-]+)*";
const RELATIVE_MULTI_SEGMENT = new RegExp(`^${NAME_CHARS}(?:/${NAME_CHARS})+(?::\\d+){0,2}$`);
const BARE_FILE_NAME = new RegExp(`^${NAME_CHARS}\\.[A-Za-z0-9_-]+(?::\\d+){0,2}$`);
const HAS_EXTENSION = /\.[A-Za-z0-9_-]+$/;
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:(.*)$/;
const ONLY_POSITION = /^\d+(?::\d+)?$/;

const hasExternalScheme = (path: string): boolean => {
  if (isWin32AbsolutePath(path)) return false;
  const match = SCHEME.exec(path);
  if (!match) return false;
  const rest = match[1]!;
  return rest.startsWith("//") || !ONLY_POSITION.test(rest);
};

const looksLikeFilePath = (decoded: string, position: FilePathPosition): boolean => {
  if (
    isWin32AbsolutePath(decoded) ||
    decoded.startsWith("~/") ||
    decoded.startsWith("./") ||
    decoded.startsWith("../")
  ) {
    return true;
  }
  const bare = fileBasename(position.path);
  if (position.path.startsWith("/")) {
    if (POSIX_ROOTS.some((root) => position.path.startsWith(root))) return true;
    // Only a position the author wrote counts; a `#L` anchor never promotes an app route.
    if (decoded !== position.path) return true;
    return EXTENSIONLESS_NAMES.has(bare) || HAS_EXTENSION.test(bare);
  }
  if (EXTENSIONLESS_NAMES.has(position.path)) return true;
  return RELATIVE_MULTI_SEGMENT.test(decoded) || BARE_FILE_NAME.test(position.path);
};

export function parseMarkdownFileLink(href: string): FilePathPosition | null {
  const destination = normalizeMarkdownLinkDestination(href);
  if (destination === "" || destination.startsWith("#") || destination.startsWith("//"))
    return null;

  let source: { path: string; hash: string };
  if (/^file:/i.test(destination)) {
    const parsed = parseFileUrlHref(destination);
    if (parsed === null) return null;
    source = parsed;
  } else {
    source = splitMarkdownLinkSearchAndHash(destination);
  }
  const decoded = stripSlashPrefixedWindowsDrive(safeDecodeURIComponent(source.path.trim()));
  const hash = safeDecodeURIComponent(source.hash.trim());
  if (decoded === "" || hasExternalScheme(decoded)) return null;

  const position = splitFilePathPosition(decoded, hash);
  return looksLikeFilePath(decoded, position) ? position : null;
}

// ---- Inline code that reads like a path --------------------------------------------------

const GENERIC_TLDS = new Set(
  "com net org io dev app ai co edu gov mil info biz xyz me tv cc gg chat cloud site online tech store link".split(
    " ",
  ),
);
const COUNTRY_TLDS = new Set(
  "uk de fr nl se no fi dk pl ch at be es it pt eu us ca au nz jp kr cn br ru mx ie cz tr sg hk".split(
    " ",
  ),
);

const looksLikeHostname = (segment: string, hasPosition: boolean): boolean => {
  const lowered = segment.toLowerCase();
  if (lowered.startsWith(".")) return false;
  if (lowered === "localhost") return true;
  if (/^\d+(?:\.\d+)+$/.test(lowered)) return true;
  const labels = lowered.split(".");
  if (labels.length < 2) return false;
  const tld = labels[labels.length - 1]!;
  if (GENERIC_TLDS.has(tld)) return true;
  // A `:line` suffix makes `.pl` / `.pt` style names far more likely to be files.
  return COUNTRY_TLDS.has(tld) && !hasPosition;
};

export function inlineCodeFilePathCandidate(codeText: string): string | null {
  const text = codeText.trim();
  if (text === "" || /\s/.test(text) || text.includes("`")) return null;

  const candidate = isWin32AbsolutePath(text) ? text : text.replaceAll("\\", "/");
  const positionSuffix = /:\d+(?::\d+)?$/.exec(candidate);
  const hasPosition = positionSuffix !== null;
  if (!hasPosition && !/[/\\]/.test(candidate)) return null;

  const explicit =
    candidate.startsWith("~/") ||
    candidate.startsWith("./") ||
    candidate.startsWith("../") ||
    candidate.startsWith("/") ||
    isWin32AbsolutePath(candidate);
  if (explicit) return candidate;

  const withoutPosition = hasPosition ? candidate.slice(0, -positionSuffix[0].length) : candidate;
  const firstSegment = withoutPosition.split("/")[0]!;
  if (looksLikeHostname(firstSegment, hasPosition)) return null;
  if (!hasPosition && !HAS_EXTENSION.test(fileBasename(withoutPosition))) return null;
  return candidate;
}
