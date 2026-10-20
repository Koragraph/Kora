// @effect-diagnostics nodeBuiltinImport:off -- the boundary to a blob's plain folders under KORA_HOME / the Blobs root.
// @effect-diagnostics globalDate:off -- plain mtimes for a file listing, produced outside any Effect fiber.
/**
 * Where the assistant lives on disk, as ui-server sees it. The source of truth is `packages/runtime/src/blobs/home.ts`
 * (ui-server has no workspace dependency on `@kora/runtime`: it is bundled INTO the runtime by `vp pack`, the reverse
 * direction). The blob helpers (`blobsRoot`/`isBlobsCwd`/`blobWorkspaceRootOf`) mirror that file byte for
 * byte, so the daemon and the UI server agree about what counts as an assistant folder (no graph, no worktree, trusted).
 */
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { koraHome } from "./paths.ts";

export { koraHome };

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Where blobs' Finder-visible workspaces live: `KORA_BLOBS_ROOT`, else `~/Blobs` (the dev flavor sets `~/Blobs-Dev`). */
export function blobsRoot(): string {
  const env = process.env.KORA_BLOBS_ROOT?.trim();
  if (env) return path.resolve(env.replace(/^~(?=$|\/)/, os.homedir()));
  const home = path.basename(koraHome());
  if (home === ".kora-dev") return path.join(os.homedir(), "Blobs-Dev");
  if (home === ".kora-qa") return path.join(os.homedir(), "Blobs-QA");
  return path.join(os.homedir(), "Blobs");
}
/** True when `cwd` is inside a blob's workspace (`blobsRoot()/<slug>/...`); the root itself is not a blob folder. */
export function isBlobsCwd(cwd: string | null | undefined): boolean {
  if (!cwd) return false;
  const c = real(cwd);
  const r = real(blobsRoot());
  return c.startsWith(r + path.sep);
}
/** The blob workspace root (`blobsRoot()/<slug>`) that contains `cwd`, or null outside the Blobs surface. */
export function blobWorkspaceRootOf(cwd: string): string | null {
  const c = real(cwd);
  const r = real(blobsRoot());
  if (!c.startsWith(r + path.sep)) return null;
  const slug = c.slice(r.length + 1).split(path.sep)[0];
  return slug ? path.join(r, slug) : null;
}

// ── file helpers (ui-server-only) ─────────────────────────────────────────────────────────────────────

export interface WorkspaceFileEntry {
  path: string;
  relPath: string;
  name: string;
  sizeBytes: number;
  modifiedAt: number;
}

/** Recursive listing of a directory (depth-bounded, dotfiles skipped), newest first. Missing dir = []. */
export function listWorkspaceFiles(dir: string, root: string, maxDepth = 3): WorkspaceFileEntry[] {
  const out: WorkspaceFileEntry[] = [];
  const walk = (current: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      out.push({
        path: full,
        relPath: path.relative(root, full).split(path.sep).join("/"), // the wire always uses / (the client joins and links it)
        name: entry.name,
        sizeBytes: stat.size,
        modifiedAt: Math.round(stat.mtimeMs),
      });
    }
  };
  walk(dir, 0);
  out.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return out;
}

/** Best-effort text read; missing/unreadable file = "" (never throws). */
export function readTextFile(p: string): string {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/** Atomic write: tmp file + rename in the SAME directory, so a crash mid-write never corrupts the target. */
export function writeFileAtomic(target: string, contents: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.tmp-${process.pid}-${Date.now()}`,
  );
  fs.writeFileSync(tmp, contents, "utf8");
  fs.renameSync(tmp, target);
}
