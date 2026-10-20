import { describe, expect, it } from "vite-plus/test";

import type { HealthCheck } from "../../util/healthCheck";
import { FIRST_RUN_CHECKS, firstRunProblems } from "./SetupCheck";

const row = (id: string, status: HealthCheck["status"], detail = "d"): HealthCheck => ({
  id,
  label: id,
  status,
  detail,
  fix: null,
});

describe("firstRunProblems", () => {
  it("asks only for what a first chat needs", () => {
    expect(FIRST_RUN_CHECKS).toEqual([
      "daemon",
      "claude-cli",
      "claude-auth",
      "codex",
      "opencode",
      "antigravity",
      "git",
      "cli-path",
    ]);
  });

  it("lists failures and warnings, nothing else", () => {
    const { problems, readyLine } = firstRunProblems([
      row("daemon", "ok"),
      row("claude-cli", "ok"),
      row("claude-auth", "fail", "Claude Code is not logged in"),
    ]);
    expect(problems.map((p) => p.id)).toEqual(["claude-auth"]);
    expect(readyLine).toBeNull();
  });

  it("all good: one ready line built from the login row", () => {
    const { problems, readyLine } = firstRunProblems([
      row("daemon", "ok"),
      row("claude-cli", "ok"),
      row("claude-auth", "ok", "Signed in via claude.ai, max plan"),
    ]);
    expect(problems).toEqual([]);
    expect(readyLine).toBe("Ready: Claude Code.");
  });

  it("a Codex-only user is ready; Claude's rows are not problems", () => {
    const checks = [
      row("daemon", "ok"),
      row("claude-cli", "warn"),
      row("claude-auth", "fail", "not logged in"),
      row("codex", "ok"),
      row("opencode", "warn"),
      row("antigravity", "skip"),
    ];
    expect(firstRunProblems(checks)).toEqual({ problems: [], readyLine: "Ready: Codex." });
  });

  it("a Claude thread still needs the Claude login when only Codex works", () => {
    const { problems } = firstRunProblems(
      [row("daemon", "ok"), row("claude-auth", "fail"), row("codex", "ok")],
      { requireClaude: true },
    );
    expect(problems.map((p) => p.id)).toEqual(["claude-auth"]);
  });

  it("no agent usable: the Claude rows are the problems", () => {
    const { problems } = firstRunProblems([
      row("daemon", "ok"),
      row("claude-auth", "fail"),
      row("codex", "skip"),
      row("opencode", "warn"),
      row("antigravity", "skip"),
    ]);
    expect(problems.map((p) => p.id)).toEqual(["claude-auth"]);
  });

  it("a down daemon blocks even when an agent works", () => {
    const { problems } = firstRunProblems([row("daemon", "fail"), row("codex", "ok")]);
    expect(problems.map((p) => p.id)).toEqual(["daemon"]);
  });
});
