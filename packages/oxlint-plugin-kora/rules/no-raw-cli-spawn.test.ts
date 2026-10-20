import { describe } from "@effect/vitest";

import { lintRule } from "../test/utils.ts";

const rule = lintRule("kora/no-raw-cli-spawn");

describe("kora/no-raw-cli-spawn", () => {
  rule.allows(
    "allows a winCommand target and real executables",
    `
      import { spawn, execFileSync } from "node:child_process";
      declare const winCommand: (c: string, a: string[]) => { command: string; args: string[] };
      const t = winCommand("codex", ["--version"]);
      spawn(t.command, t.args);
      execFileSync("git", ["status"]);
    `,
  );

  rule.reports(
    "reports a shimmed CLI spawned by name",
    `
      import { spawn } from "node:child_process";
      spawn("codex", ["exec"]);
    `,
  );

  rule.reports(
    "reports a shell line that starts with a shimmed CLI",
    `
      import * as cp from "node:child_process";
      cp.execSync("claude --version");
    `,
  );

  rule.reports(
    "reports a .sh script",
    `
      import { execFile } from "node:child_process";
      execFile("scripts/build.sh", []);
    `,
  );
});
