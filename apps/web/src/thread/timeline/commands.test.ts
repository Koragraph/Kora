import { describe, expect, it } from "vite-plus/test";

import { rawOutputSummary, splitExitCode, toolCommand, unwrapShell } from "./commands";

describe("unwrapping a shell wrapper", () => {
  it.each([
    ["bash -lc 'pnpm test'", "pnpm test"],
    ['/bin/zsh -c "git status"', "git status"],
    ["sh -c ls", "ls"],
    ["cmd.exe /c dir", "dir"],
    ["pwsh -Command 'bun run lint'", "bun run lint"],
    ["\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -NoLogo -Command 'rg -n x .'", "rg -n x ."],
  ])("%s runs %s", (line, inner) => {
    expect(unwrapShell(line)).toBe(inner);
  });

  it.each([
    ["no wrapper flag", "bash script.sh"],
    ["not a shell", "python -c 'print(1)'"],
    [
      "a quote that does not close at the end",
      "/bin/zsh -lc 'git status\nsed -n '\"'1,20p' a.tsx\"",
    ],
    ["nothing after the flag", "bash -c "],
    ["a program quote that never closes", '"C:\\pwsh.exe -Command x'],
  ])("is left alone with %s", (_, line) => {
    expect(unwrapShell(line)).toBe(line);
  });
});

describe("the command a row ran", () => {
  it("joins an argv array, quoting the arguments that need it, and unwraps it", () => {
    const argv = ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-Command", "rg -n foo ."];
    expect(toolCommand({ data: { item: { command: argv } } })).toEqual({
      command: "rg -n foo .",
      rawCommand: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "rg -n foo ."',
    });
  });

  it("has no raw form when nothing was unwrapped", () => {
    expect(toolCommand({ data: { item: { command: ["git", "status"] } } })).toEqual({
      command: "git status",
      rawCommand: null,
    });
  });

  it("is looked for in the item, its input and result, then the data", () => {
    expect(toolCommand({ data: { item: { input: { command: "a" } } } }).command).toBe("a");
    expect(toolCommand({ data: { item: { result: { command: "b" } } } }).command).toBe("b");
    expect(toolCommand({ data: { command: "c" } }).command).toBe("c");
  });

  it("falls back to a command row's detail, exit-code marker removed", () => {
    const detail = "pwsh -Command 'rg -F x .' <exited with exit code 0>";
    expect(toolCommand({ itemType: "command_execution", detail })).toEqual({
      command: "rg -F x .",
      rawCommand: "pwsh -Command 'rg -F x .'",
    });
    expect(toolCommand({ itemType: "dynamic_tool_call", detail }).command).toBeNull();
  });
});

it.each([
  ["ok\n<exited with exit code 0>", { output: "ok", exitCode: 0 }],
  ["boom  <Exited With Exit Code 2>  ", { output: "boom", exitCode: 2 }],
  ["<exited with exit code 1>", { output: null, exitCode: 1 }],
  ["no marker", { output: "no marker" }],
  ["   ", { output: null }],
])("splitExitCode(%j)", (raw, expected) => {
  expect(splitExitCode(raw)).toEqual(expected);
});

describe("a summary of a tool's raw output", () => {
  const summary = (rawOutput: unknown) => rawOutputSummary({ data: { rawOutput } });
  it.each([
    [{ totalFiles: 1 }, "1 file"],
    [{ totalFiles: 1234, truncated: true }, "1,234 files+"],
    [{ content: "\n\n  first   line  \nsecond" }, "first line"],
    [{ stdout: "```\n```" }, "2 lines"],
    [{ content: "x".repeat(100) }, `${"x".repeat(83)}…`],
    [{}, null],
  ])("%j reads %j", (raw, expected) => {
    expect(summary(raw)).toBe(expected);
  });
});
