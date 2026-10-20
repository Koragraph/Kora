// @effect-diagnostics nodeBuiltinImport:off -- a throwaway HOME-like folder for the file-reading path.
// Recent projects for the first-run screen: only folders that still exist, never home / temp / Kora's own folders,
// newest first, at most four, and nothing at all when Claude Code has never run here.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import {
  claudeGlobalConfigPath,
  pickRecentProjects,
  readRecentProjects,
  RECENT_PROJECTS_LIMIT,
} from "./recentProjects.ts";

// Fixture paths are POSIX; P() resolves them for this OS (D:\Users\dev on Windows) like the code under test does.
const P = (p: string) => NodePath.resolve(p);
const HOME = P("/Users/dev");
const existing = new Set([
  P("/Users/dev/Projects/app"),
  P("/Users/dev/Projects/api"),
  P("/Users/dev/Projects/notes"),
  P("/Users/dev/Projects/web"),
  P("/Users/dev/Projects/cli"),
  P("/Users/dev/.kora/worktrees/app-w1"),
  P("/private/var/folders/xy/T/scratch"),
  P("/Users/dev"),
  P("/Users"),
]);
const git = new Set([
  P("/Users/dev/Projects/app"),
  P("/Users/dev/Projects/api"),
  P("/Users/dev/Projects/web"),
  P("/Users/dev/Projects/cli"),
]);
const deps = {
  home: HOME,
  excludedRoots: ["/private/var/folders", "/Users/dev/.kora", "/Users/dev/.claude"].map(P),
  isDirectory: (p: string) => existing.has(p),
  isGitRepo: (p: string) => git.has(p),
};

NodeTest.describe("pickRecentProjects", () => {
  NodeTest.it(
    "offers existing folders newest first and skips home, parents, temp and Kora's own",
    () => {
      const picked = pickRecentProjects(
        {
          projects: {
            [P("/Users/dev")]: { lastStartTime: 9 },
            [P("/Users")]: { lastStartTime: 9 },
            [P("/Users/dev/Projects/app")]: { lastStartTime: 100 },
            [P("/Users/dev/Projects/api")]: { lastStartTime: 300 },
            [P("/Users/dev/Projects/gone")]: { lastStartTime: 999 },
            [P("/Users/dev/.kora/worktrees/app-w1")]: { lastStartTime: 998 },
            [P("/private/var/folders/xy/T/scratch")]: { lastStartTime: 997 },
            [P("/Users/dev/Projects/notes")]: { lastStartTime: 200 },
            "relative/path": { lastStartTime: 996 },
          },
        },
        deps,
      );
      NodeAssert.deepEqual(
        picked.map((p) => [p.name, p.isGitRepo, p.lastUsedAt]),
        [
          ["api", true, 300],
          ["notes", false, 200],
          ["app", true, 100],
        ],
      );
      NodeAssert.equal(picked[0]?.path, P("/Users/dev/Projects/api"));
      NodeAssert.equal(picked[0]?.displayPath, `~${NodePath.sep}Projects${NodePath.sep}api`);
    },
  );

  NodeTest.it("caps the list and ranks undated git repos before undated plain folders", () => {
    const picked = pickRecentProjects(
      {
        projects: {
          [P("/Users/dev/Projects/notes")]: {},
          [P("/Users/dev/Projects/app")]: {},
          [P("/Users/dev/Projects/api")]: {},
          [P("/Users/dev/Projects/web")]: {},
          [P("/Users/dev/Projects/cli")]: { lastStartTime: 5 },
        },
      },
      deps,
    );
    NodeAssert.equal(picked.length, RECENT_PROJECTS_LIMIT);
    NodeAssert.equal(picked[0]?.name, "cli");
    NodeAssert.ok(!picked.some((p) => p.name === "notes"), "the plain folder is the one cut");
  });

  NodeTest.it("returns nothing for a config without projects", () => {
    NodeAssert.deepEqual(pickRecentProjects(null, deps), []);
    NodeAssert.deepEqual(pickRecentProjects({ projects: [] }, deps), []);
    NodeAssert.deepEqual(pickRecentProjects({ numStartups: 3 }, deps), []);
  });
});

NodeTest.describe("readRecentProjects", () => {
  NodeTest.it(
    "reads $CLAUDE_CONFIG_DIR/.claude.json and never lists the temp folders it lives in",
    () => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-recent-"));
      try {
        const repo = NodePath.join(dir, "repo");
        NodeFS.mkdirSync(NodePath.join(repo, ".git"), { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(dir, ".claude.json"),
          JSON.stringify({ projects: { [repo]: { lastStartTime: 1 } } }),
        );
        const env = { CLAUDE_CONFIG_DIR: dir, KORA_HOME: NodePath.join(dir, "kora") };
        NodeAssert.equal(
          claudeGlobalConfigPath(env, "/Users/x"),
          NodePath.join(dir, ".claude.json"),
        );
        // The repo is under the OS temp dir, which is never offered.
        NodeAssert.deepEqual(readRecentProjects(env, "/Users/x"), []);
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  NodeTest.it("is empty (not an error) when Claude Code never ran", () => {
    NodeAssert.equal(
      claudeGlobalConfigPath({}, "/Users/x"),
      NodePath.join("/Users/x", ".claude.json"),
    );
    NodeAssert.deepEqual(readRecentProjects({ CLAUDE_CONFIG_DIR: "/nonexistent/kora" }, "/x"), []);
  });
});
