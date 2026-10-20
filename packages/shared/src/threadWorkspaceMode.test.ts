import { describe, expect, it } from "vite-plus/test";

import { resolveDefaultThreadEnvMode } from "./threadWorkspaceMode.ts";

describe("default thread env mode", () => {
  it.each([
    ["the project setting wins", "worktree", "local", "local", "worktree"],
    ["kora.json is next", null, "worktree", "local", "worktree"],
    ["the global default is last", undefined, null, "local", "local"],
  ] as const)("%s", (_label, projectSetting, projectFile, globalDefault, expected) => {
    expect(resolveDefaultThreadEnvMode({ projectSetting, projectFile, globalDefault })).toBe(
      expected,
    );
  });
});
