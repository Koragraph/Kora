const DRIVE_PREFIX = /^[a-zA-Z]:([/\\]|$)/;
const DRIVE_ROOT = /^[a-zA-Z]:[/\\]$/;
const BARE_DRIVE = /^[a-zA-Z]:$/;
const EXPLICIT_RELATIVE_PREFIXES = ["./", "../", ".\\", "..\\"];

export const isWindowsDrivePath = (value: string): boolean => DRIVE_PREFIX.test(value);

export const isUncPath = (value: string): boolean => value.slice(0, 2) === "\\\\";

export function isWin32AbsolutePath(value: string): boolean {
  return isWindowsDrivePath(value) || isUncPath(value);
}

export function isExplicitRelativePath(value: string): boolean {
  if (value === "." || value === "..") return true;
  return EXPLICIT_RELATIVE_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function isRootPath(value: string): boolean {
  // The drive separator is required: a bare `C:` is not the drive root (it
  // means "current directory on C:"), and treating it as already-canonical
  // would leave it as `C:` while `C:\` and `C:/` normalize to the drive root,
  // so the same location would fail project identity/dedup comparisons.
  return DRIVE_ROOT.test(value) || ["/", "\\"].includes(value);
}

function trimTrailingPathSeparators(value: string): string {
  if (!value || isRootPath(value)) return value;
  const separators = value[0] === "/" ? /\/+$/g : /[\\/]+$/g;
  const stripped = value.replace(separators, "");
  if (!stripped) return value;
  return BARE_DRIVE.test(stripped) ? stripped + "\\" : stripped;
}

export function dispatchProjectPath(value: string): string {
  return trimTrailingPathSeparators(value.trim());
}

export function canonicalProjectPath(value: string): string {
  const normalized = dispatchProjectPath(value);
  const windowsStyle = isUncPath(normalized) || isWindowsDrivePath(normalized);
  return windowsStyle ? normalized.replaceAll("/", "\\").toLowerCase() : normalized;
}
