import {
  isWindowsDrivePath,
  isWin32AbsolutePath,
  isUncPath,
  isExplicitRelativePath,
  dispatchProjectPath,
  canonicalProjectPath,
} from "@kora/shared/projectPaths";

export { canonicalProjectPath, dispatchProjectPath };
export { isExplicitRelativePath as isExplicitRelativeProjectPath };

type AbsoluteKind = "windows" | "unix" | "none";

const absoluteKindOf = (value: string): AbsoluteKind =>
  isWindowsDrivePath(value) || isUncPath(value)
    ? "windows"
    : value.startsWith("/")
      ? "unix"
      : "none";

const preferredSeparator = (value: string): "/" | "\\" => {
  const kind = absoluteKindOf(value);
  if (kind === "windows") return "\\";
  if (kind === "unix") return "/";
  return value.includes("\\") ? "\\" : "/";
};

const isWindowsPlatform = (platform: string): boolean => /^win(dows)?/i.test(platform);

/** For a unix path only "/" separates; otherwise "\\" does too. */
const separatorIndex = (value: string): number =>
  absoluteKindOf(value) === "unix"
    ? value.lastIndexOf("/")
    : Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));

export function hasTrailingPathSeparator(value: string): boolean {
  return absoluteKindOf(value) === "unix"
    ? value.endsWith("/")
    : value.endsWith("/") || value.endsWith("\\");
}

export function isFilesystemBrowseQuery(value: string, platform = ""): boolean {
  const browsePrefixes = ["/", "~/", "./", "../", ".\\", "..\\"];
  return (
    browsePrefixes.some((prefix) => value.startsWith(prefix)) ||
    (isWindowsPlatform(platform) && isWin32AbsolutePath(value))
  );
}

export function isUnsupportedWindowsProjectPath(value: string, platform: string): boolean {
  return isWin32AbsolutePath(value) && !isWindowsPlatform(platform);
}

/** The root of an absolute path (with its trailing separator) and the segments after it. */
function splitAbsolute(
  path: string,
): { root: string; separator: "/" | "\\"; segments: string[] } | null {
  const separator = preferredSeparator(path);
  let root: string;
  if (isUncPath(path)) {
    const parts = path
      .replace(/^\\\\/, "")
      .split(/[\\/]+/)
      .filter(Boolean);
    root = `\\\\${parts.slice(0, 2).join("\\")}\\`;
    return { root, separator, segments: parts.slice(2) };
  }
  if (isWindowsDrivePath(path)) {
    root = `${path.slice(0, 2)}\\`;
    return {
      root,
      separator,
      segments: path
        .slice(2)
        .split(/[\\/]+/)
        .filter(Boolean),
    };
  }
  if (path.startsWith("/")) {
    return { root: "/", separator, segments: path.split("/").filter(Boolean) };
  }
  return null;
}

export function resolveProjectPathForDispatch(value: string, cwd?: string | null): string {
  const trimmed = value.trim();
  if (!isExplicitRelativePath(trimmed) || !cwd) return dispatchProjectPath(trimmed);

  const base = splitAbsolute(dispatchProjectPath(cwd));
  if (base === null) return dispatchProjectPath(trimmed);

  const segments = [...base.segments];
  for (const part of trimmed.split(/[\\/]/)) {
    switch (part) {
      case "":
      case ".":
        break;
      case "..":
        segments.pop();
        break;
      default:
        segments.push(part);
    }
  }
  return dispatchProjectPath(`${base.root}${segments.join(base.separator)}`);
}

type PathedProject = { workspaceRoot?: string; cwd?: string };

export function findProjectByPath<T extends PathedProject>(
  projects: readonly T[],
  candidatePath: string,
): T | undefined {
  const candidate = canonicalProjectPath(candidatePath);
  if (candidate.length === 0) return undefined;
  return projects.find(
    (project) => canonicalProjectPath(project.workspaceRoot ?? project.cwd ?? "") === candidate,
  );
}

export function inferProjectTitleFromPath(value: string): string {
  const normalized = dispatchProjectPath(value);
  const segments = normalized
    .split(absoluteKindOf(normalized) === "unix" ? "/" : /[\\/]/)
    .filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? normalized;
}

// Helpers for editing a typed folder path one segment at a time.

export function getBrowseDirectoryPath(currentPath: string): string {
  const index = separatorIndex(currentPath);
  return index === -1 ? currentPath : currentPath.slice(0, index + 1);
}

export function getBrowseLeafPathSegment(currentPath: string): string {
  return currentPath.slice(separatorIndex(currentPath) + 1);
}

export function appendBrowsePathSegment(currentPath: string, segment: string): string {
  return `${getBrowseDirectoryPath(currentPath)}${segment}${preferredSeparator(currentPath)}`;
}

export function getBrowseParentPath(currentPath: string): string | null {
  const absolute = splitAbsolute(currentPath);
  if (absolute !== null) {
    if (absolute.segments.length === 0) return null;
    if (absolute.segments.length === 1) return absolute.root;
    return `${absolute.root}${absolute.segments.slice(0, -1).join(absolute.separator)}${absolute.separator}`;
  }

  const stripped = currentPath.replace(/[\\/]+$/, "");
  const index = separatorIndex(stripped);
  if (index === -1) return null;
  return stripped.slice(0, index + 1);
}

export function canNavigateUp(currentPath: string): boolean {
  if (!hasTrailingPathSeparator(currentPath)) return false;
  return getBrowseParentPath(currentPath) !== null;
}

export * from "./projectCommands.ts";
export * from "./projectEntities.ts";
