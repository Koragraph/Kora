import { describe, expect, it } from "vite-plus/test";

import {
  agentsSummary,
  blankServer,
  draftFrom,
  draftProblems,
  joinCommandLine,
  saveInputOf,
  splitCommandLine,
  targetLine,
} from "./extensionsModel";

describe("extensions model", () => {
  it("summarises agents in a fixed order", () => {
    expect(agentsSummary(["codex", "claude", "opencode", "antigravity"])).toBe("All agents");
    expect(agentsSummary(["codex", "claude"])).toBe("Claude Code, Codex");
    expect(agentsSummary([])).toBe("No agent");
  });

  it("shows the command or the URL, shortened", () => {
    expect(targetLine({ transport: "stdio", command: "npx", args: ["-y", "pkg"], url: null })).toBe(
      "npx -y pkg",
    );
    expect(
      targetLine({
        transport: "http",
        command: null,
        args: [],
        url: `https://x.dev/${"a".repeat(120)}`,
      }).endsWith("…"),
    ).toBe(true);
  });

  it("moves parsed credential values out of the definition into typed secret values", () => {
    const parsed = {
      ...blankServer(),
      name: "gh",
      command: "npx",
      env: [
        { key: "GITHUB_TOKEN", value: "ghp_1", secret: true },
        { key: "MODE", value: "ro", secret: false },
      ],
    };
    const d = draftFrom(parsed);
    expect(d.server.env[0]).toEqual({ key: "GITHUB_TOKEN", value: null, secret: true });
    expect(d.secretValues).toEqual({ "env:GITHUB_TOKEN": "ghp_1" });
    const input = saveInputOf(d);
    expect(input.secrets).toEqual([{ slot: "env:GITHUB_TOKEN", value: "ghp_1" }]);
    expect(JSON.stringify(input.server)).not.toContain("ghp_1");
  });

  it("explains what is missing before Save", () => {
    const base = { ...blankServer(), name: "x", command: "npx" };
    expect(draftProblems({ server: base, previousName: null, secretValues: {} }, [])).toEqual([]);
    expect(
      draftProblems(
        { server: { ...base, name: "kora" }, previousName: null, secretValues: {} },
        [],
      )[0],
    ).toMatch(/reserved/);
    expect(draftProblems({ server: base, previousName: null, secretValues: {} }, ["X"])[0]).toMatch(
      /already have/,
    );
    expect(draftProblems({ server: base, previousName: "x", secretValues: {} }, ["x"])).toEqual([]);
    expect(
      draftProblems(
        { server: { ...base, agents: [] }, previousName: null, secretValues: {} },
        [],
      )[0],
    ).toMatch(/agent/);
    const secretless = { ...base, env: [{ key: "T", value: null, secret: true }] };
    expect(
      draftProblems({ server: secretless, previousName: null, secretValues: {} }, [])[0],
    ).toMatch(/value for T/);
    expect(
      draftProblems({ server: secretless, previousName: "x", secretValues: {} }, ["x"]),
    ).toEqual([]);
  });

  it("round-trips command lines with quotes", () => {
    const words = splitCommandLine(`node "my server.js" --dir 'a b'`);
    expect(words).toEqual(["node", "my server.js", "--dir", "a b"]);
    expect(splitCommandLine(joinCommandLine(words))).toEqual(words);
  });
});
