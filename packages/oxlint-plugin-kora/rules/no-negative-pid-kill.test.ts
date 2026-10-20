import { describe } from "@effect/vitest";

import { lintRule } from "../test/utils.ts";

const rule = lintRule("kora/no-negative-pid-kill");

describe("kora/no-negative-pid-kill", () => {
  rule.allows(
    "allows a group kill in a function with a Windows branch",
    `
      declare const killTreeWindows: (pid: number) => void;
      export function stop(pid: number) {
        if (process.platform === "win32") return killTreeWindows(pid);
        process.kill(-pid, "SIGTERM");
      }
    `,
  );

  rule.reports(
    "reports a bare group kill",
    `
      export function stop(pid: number) {
        process.kill(-pid, "SIGTERM");
      }
    `,
  );
});
