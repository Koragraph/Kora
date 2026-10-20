import { describe, expect, it } from "vite-plus/test";

import type { HealthCheck } from "../../util/healthCheck";
import { agentsStep, claudeStep } from "./firstRunChecks";
import { parseRecentProjects } from "./projectSetup";

const row = (
  id: string,
  status: HealthCheck["status"],
  detail = "d",
  data?: Record<string, unknown>,
): HealthCheck => ({ id, label: id, status, detail, fix: null, ...(data ? { data } : {}) });

describe("claudeStep (first-run step 1)", () => {
  it("is checking until the daemon answers, and says so when it never does", () => {
    expect(claudeStep(null, false)).toEqual({ kind: "checking" });
    expect(claudeStep(null, true)).toEqual({ kind: "unreachable" });
  });

  it("is done when Claude is signed in, with the login detail", () => {
    expect(
      claudeStep([row("daemon", "ok"), row("claude-auth", "ok", "Signed in via claude.ai")], false),
    ).toEqual({ kind: "done", detail: "Signed in via claude.ai" });
  });

  it("offers the in-app login when the daemon can run it (no Terminal, no install)", () => {
    const auth = row("claude-auth", "fail", "not logged in", { login: "bundled" });
    const step = claudeStep(
      [row("claude-cli", "warn", "The `claude` command was not found."), auth],
      false,
    );
    expect(step).toEqual({ kind: "sign-in", check: auth });
  });

  it("lists what to fix when there is no way to log in from the app", () => {
    const cli = row("claude-cli", "fail", "Claude Code is not installed");
    const step = claudeStep([cli, row("claude-auth", "skip", "Needs Claude Code first.")], false);
    expect(step).toEqual({ kind: "fix", problems: [cli] });
  });

  it("does not block on an older daemon that reports no login row", () => {
    expect(claudeStep([row("daemon", "ok"), row("claude-cli", "ok")], false)).toEqual({
      kind: "done",
      detail: null,
    });
  });
});

describe("agentsStep (first-run step 1)", () => {
  it("is ready when only Codex works, and names it", () => {
    const checks = [row("claude-auth", "fail", "not logged in"), row("codex", "ok")];
    expect(agentsStep(checks, false)).toEqual({ kind: "done", agents: ["Codex"], detail: null });
    // Claude's own per-thread state is untouched.
    expect(claudeStep(checks, false).kind).toBe("fix");
  });

  it("lists every usable agent, Claude first", () => {
    const checks = [
      row("claude-auth", "ok", "Signed in"),
      row("antigravity", "ok"),
      row("opencode", "ok"),
    ];
    expect(agentsStep(checks, false)).toEqual({
      kind: "done",
      agents: ["Claude Code", "OpenCode", "Antigravity"],
      detail: "Signed in",
    });
  });

  it("shows the options when nobody is ready, with Claude's one-click login inside", () => {
    const auth = row("claude-auth", "fail", "not logged in", { login: "bundled" });
    const step = agentsStep([auth, row("codex", "skip"), row("opencode", "warn")], false);
    expect(step).toEqual({ kind: "choose", claude: { kind: "sign-in", check: auth } });
  });

  it("is checking or unreachable like the daemon says", () => {
    expect(agentsStep(null, false)).toEqual({ kind: "checking" });
    expect(agentsStep(null, true)).toEqual({ kind: "unreachable" });
  });
});

describe("parseRecentProjects", () => {
  it("keeps well-formed absolute folders and fills a missing display path", () => {
    expect(
      parseRecentProjects({
        projects: [
          { path: "/Users/me/app", name: "app", displayPath: "~/app", isGitRepo: true },
          { path: "/Users/me/notes" },
          { path: "relative" },
          null,
        ],
      }),
    ).toEqual([
      { path: "/Users/me/app", name: "app", displayPath: "~/app", isGitRepo: true },
      { path: "/Users/me/notes", name: "notes", displayPath: "/Users/me/notes", isGitRepo: false },
    ]);
    expect(parseRecentProjects(null)).toEqual([]);
  });
});

describe("missing developer tools (git)", () => {
  const noTools = row(
    "git",
    "warn",
    "Apple's command line developer tools are not installed, so git does not work yet.",
  );
  it("is shown on the project step, never as a Claude or first-chat problem", async () => {
    const { gitProblem, firstRunProblems } = await import("./firstRunChecks");
    const checks = [row("daemon", "ok"), row("claude-auth", "ok", "Signed in"), noTools];
    expect(gitProblem(checks)).toBe(noTools);
    expect(firstRunProblems(checks).problems).toEqual([]);
    expect(claudeStep(checks, false)).toEqual({ kind: "done", detail: "Signed in" });
    expect(gitProblem([row("git", "ok", "v2.50.1")])).toBeNull();
    expect(gitProblem(null)).toBeNull();
  });
});
