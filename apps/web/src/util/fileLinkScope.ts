/**
 * Whether a file link in a reply points outside the thread's folder. `[x](file:///etc/hosts)` used to open any absolute
 * path in the Files dock on one click, so a prompt-injected reply could put `~/.ssh/...` a click away (pl4 S3-8): such
 * links now ask first. Relative paths resolve inside the folder; `..` segments that climb out count as outside.
 *
 * Windows paths (`C:\…`, `C:/…`, `/C:/…` from a `file:///C:/…` URL, `\\server\share`) are compared by their own rules:
 * either separator, case-folded. Without them `C:\Users\me\x` read as a RELATIVE path and stayed "inside" the folder.
 */
export function fileLinkOutsideFolder(path: string, cwd: string | undefined | null): boolean {
  const target = path.trim();
  if (!target) return false;
  if (isWindowsPath(target) || (cwd != null && isWindowsPath(cwd)))
    return outsideWindows(target, cwd);
  const isAbsolute = target.startsWith("/") || target.startsWith("~");
  if (!cwd) return isAbsolute;
  const root = normalize(cwd);
  const full = normalize(isAbsolute ? target : `${root}/${target}`);
  if (full === null || root === null) return true;
  return full !== root && !full.startsWith(`${root}/`);
}

const WIN_DRIVE = /^\/?[a-zA-Z]:[\\/]/;
const isWindowsPath = (p: string): boolean => WIN_DRIVE.test(p) || p.startsWith("\\\\");

function outsideWindows(target: string, cwd: string | undefined | null): boolean {
  const isAbsolute = isWindowsPath(target) || target.startsWith("~") || /^[\\/]/.test(target);
  if (!cwd || !isWindowsPath(cwd)) return isAbsolute || !cwd;
  const root = normalizeWindows(cwd);
  const full = normalizeWindows(isAbsolute ? target : `${cwd}\\${target}`);
  if (full === null || root === null) return true;
  return full !== root && !full.startsWith(`${root}\\`);
}

/** `C:\a\b` (lower-cased, `\`-joined, `..` resolved); null for a home-relative, rooted-without-drive or escaping path. */
function normalizeWindows(p0: string): string | null {
  if (p0.startsWith("~")) return null;
  const p = p0.replace(/^\/(?=[a-zA-Z]:)/, "");
  const unc = p.startsWith("\\\\") || p.startsWith("//");
  const parts = p.split(/[\\/]+/).filter(Boolean);
  const head = unc ? `\\\\${parts.shift() ?? ""}\\${parts.shift() ?? ""}` : parts.shift();
  if (!head || (!unc && !/^[a-zA-Z]:$/.test(head))) return null;
  const out: string[] = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(part);
  }
  return [head, ...out].join("\\").toLowerCase();
}

function normalize(p: string): string | null {
  if (p.startsWith("~")) return null; // home-relative: never inside a project folder string we can compare
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(part);
  }
  return `/${out.join("/")}`;
}
