// @effect-diagnostics nodeBuiltinImport:off -- plain Node fs reads at the HTTP boundary, not Effect code.
// Folders Claude Code has already opened on this Mac, offered as one-click picks on Kora's first-run screen
// (`GET /api/onboarding/recent-projects`). The source is the `projects` map of Claude Code's global config
// (`$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`). Read-only: the file is never written. A folder is offered
// only while it still exists, and never when it is the home folder (or a parent of it), a temp folder, or one of Kora's
// or Claude Code's own data folders. Newest first by Claude Code's `lastStartTime`.
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFS from "node:fs";

import { isSafeToIndex } from "./graph.ts";

export interface RecentProject {
  readonly path: string;
  /** The folder's name, for the chip. */
  readonly name: string;
  /** The path with the home folder written as `~`, for display. */
  readonly displayPath: string;
  readonly isGitRepo: boolean;
  /** Claude Code's last session start in this folder (epoch ms), when it recorded one. */
  readonly lastUsedAt: number | null;
}

export const RECENT_PROJECTS_LIMIT = 4;

/** Where Claude Code keeps its global config (the file that lists the folders it has opened). */
export function claudeGlobalConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = NodeOS.homedir(),
): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim();
  return dir ? NodePath.join(dir, ".claude.json") : NodePath.join(home, ".claude.json");
}

export interface RecentProjectsDeps {
  readonly home: string;
  /** Folders whose contents are never offered (temp dirs, Kora's home, Claude Code's own folder). */
  readonly excludedRoots: ReadonlyArray<string>;
  readonly isDirectory: (p: string) => boolean;
  readonly isGitRepo: (p: string) => boolean;
  readonly limit?: number;
}

const inside = (p: string, root: string): boolean =>
  p === root || p.startsWith(root + NodePath.sep);

/** The pure part: which `projects` keys of a parsed `.claude.json` to offer, newest first. */
export function pickRecentProjects(config: unknown, deps: RecentProjectsDeps): RecentProject[] {
  const projects = (config as { projects?: unknown } | null)?.projects;
  if (!projects || typeof projects !== "object" || Array.isArray(projects)) return [];
  const seen = new Set<string>();
  const out: Array<RecentProject & { readonly order: number }> = [];
  let order = 0;
  for (const [raw, entry] of Object.entries(projects as Record<string, unknown>)) {
    order += 1;
    if (!NodePath.isAbsolute(raw)) continue;
    const folder = NodePath.resolve(raw);
    if (seen.has(folder)) continue;
    seen.add(folder);
    if (folder === deps.home || inside(deps.home, folder)) continue;
    if (!isSafeToIndex(folder)) continue;
    if (deps.excludedRoots.some((root) => inside(folder, root))) continue;
    if (!deps.isDirectory(folder)) continue;
    const started = (entry as { lastStartTime?: unknown } | null)?.lastStartTime;
    out.push({
      path: folder,
      name: NodePath.basename(folder),
      displayPath: inside(folder, deps.home) ? `~${folder.slice(deps.home.length)}` : folder,
      isGitRepo: deps.isGitRepo(folder),
      lastUsedAt: typeof started === "number" && Number.isFinite(started) ? started : null,
      order,
    });
  }
  out.sort(
    (a, b) =>
      (b.lastUsedAt ?? -1) - (a.lastUsedAt ?? -1) ||
      // Same (or no) timestamp: git repos first, then the file's own (insertion) order, newest last.
      Number(b.isGitRepo) - Number(a.isGitRepo) ||
      b.order - a.order,
  );
  return out
    .slice(0, deps.limit ?? RECENT_PROJECTS_LIMIT)
    .map(({ order: _order, ...project }) => project);
}

function realpathOr(p: string): string {
  try {
    return NodeFS.realpathSync(p);
  } catch {
    return p;
  }
}

/** The folders a fresh Kora should offer: read `.claude.json` (if any) and filter it. Never throws. */
export function readRecentProjects(
  env: NodeJS.ProcessEnv = process.env,
  home: string = NodeOS.homedir(),
): RecentProject[] {
  let config: unknown = null;
  try {
    config = JSON.parse(NodeFS.readFileSync(claudeGlobalConfigPath(env, home), "utf8"));
  } catch {
    return []; // no Claude Code yet, or an unreadable file: nothing to offer
  }
  const koraHome = env.KORA_HOME || NodePath.join(home, ".kora");
  const excludedRoots = [
    ...new Set(
      [
        NodeOS.tmpdir(),
        // oxlint-disable-next-line kora/no-posix-only-paths -- macOS temp roots; os.tmpdir() covers Windows
        "/tmp",
        "/private/tmp",
        "/var/folders",
        "/private/var/folders",
        koraHome,
        NodePath.join(home, ".kora"),
        NodePath.join(home, ".claude"),
        env.CLAUDE_CONFIG_DIR?.trim() || null,
      ]
        .filter((p): p is string => typeof p === "string" && p.length > 0)
        .flatMap((p) => [NodePath.resolve(p), realpathOr(p)]),
    ),
  ];
  return pickRecentProjects(config, {
    home: NodePath.resolve(home),
    excludedRoots,
    isDirectory: (p) => {
      try {
        return NodeFS.statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    isGitRepo: (p) => NodeFS.existsSync(NodePath.join(p, ".git")),
  });
}
