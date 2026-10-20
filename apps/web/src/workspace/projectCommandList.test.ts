import { projectCommandEnv, projectScriptCwd } from "@kora/shared/projectCommands";
import { describe, expect, test } from "vite-plus/test";

import { buildProjectCommand, nextProjectCommandId } from "./projectCommandList";

describe("running a script", () => {
  test.each([
    ["inside the worktree when there is one", "/repo/wt-a", "/repo/wt-a"],
    ["in the project root otherwise", null, "/repo"],
  ])("the working directory is %s", (_label, worktreePath, expected) => {
    expect(projectScriptCwd({ worktreePath, project: { cwd: "/repo" } })).toBe(expected);
  });

  test("the environment names the project root and the worktree", () => {
    expect(
      projectCommandEnv({ worktreePath: "/repo/wt-a", project: { cwd: "/repo" } }),
    ).toMatchObject({
      KORA_PROJECT_ROOT: "/repo",
      KORA_WORKTREE_PATH: "/repo/wt-a",
    });
  });

  test("extra variables are added and may override the built-ins; no worktree means no worktree variable", () => {
    const env = projectCommandEnv({
      project: { cwd: "/repo" },
      extraEnv: { KORA_PROJECT_ROOT: "/elsewhere", FLAG: "1" },
    });
    expect([env.KORA_PROJECT_ROOT, env.FLAG, env.KORA_WORKTREE_PATH]).toEqual([
      "/elsewhere",
      "1",
      undefined,
    ]);
  });
});

describe("nextProjectCommandId", () => {
  test.each([
    ["Run Tests", [], "run-tests"],
    ["Run Tests", ["run-tests"], "run-tests-2"],
    ["Run Tests", ["run-tests", "run-tests-2"], "run-tests-3"],
    ["!!!", [], "script"],
  ])("%j with %j taken -> %s", (name, taken, expected) => {
    expect(nextProjectCommandId(name, taken)).toBe(expected);
  });
});

describe("buildProjectCommand", () => {
  const base = {
    name: "Bootstrap",
    command: "npm ci",
    icon: "build",
    previewUrl: null,
    autoOpenPreview: false,
  } as const;

  test.each([
    [true, true, true],
    [true, false, false],
    [false, true, false],
    [false, false, false],
  ])(
    "runOnWorktreeCreate=%s waitForSetup=%s -> records async:false: %s",
    (runOnWorktreeCreate, waitForSetup, blocks) => {
      const script = buildProjectCommand("setup", { ...base, runOnWorktreeCreate, waitForSetup });
      if (blocks) expect(script).toMatchObject({ async: false });
      else expect(script).not.toHaveProperty("async");
    },
  );

  test("without a preview URL the preview fields are left out", () => {
    expect(
      buildProjectCommand("test", {
        name: "Unit tests",
        command: "vitest run",
        icon: "lint",
        previewUrl: null,
        autoOpenPreview: false,
        runOnWorktreeCreate: false,
        waitForSetup: false,
      }),
    ).toEqual({
      id: "test",
      name: "Unit tests",
      command: "vitest run",
      icon: "lint",
      runOnWorktreeCreate: false,
    });
  });

  test("with a preview URL the preview fields are kept", () => {
    expect(
      buildProjectCommand("dev", {
        name: "Preview server",
        command: "vite --port 5733",
        icon: "play",
        previewUrl: "http://localhost:5733",
        autoOpenPreview: true,
        runOnWorktreeCreate: false,
        waitForSetup: false,
      }),
    ).toEqual({
      id: "dev",
      name: "Preview server",
      command: "vite --port 5733",
      icon: "play",
      runOnWorktreeCreate: false,
      previewUrl: "http://localhost:5733",
      autoOpenPreview: true,
    });
  });
});
