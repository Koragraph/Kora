import { describe } from "@effect/vitest";

import { lintRule } from "../test/utils.ts";

const rule = lintRule("kora/no-posix-only-paths");

describe("kora/no-posix-only-paths", () => {
  rule.allows(
    "allows POSIX paths under a win32 branch and in wrapReadDeny",
    `
      declare const gitBash: () => string;
      declare const wrapReadDeny: (k: string, c: string, a: string[]) => void;
      export const sh = process.platform === "win32" ? gitBash() : "/bin/sh";
      wrapReadDeny("check", "/bin/sh", ["-c", "true"]);
      declare const shell: string | undefined;
      wrapReadDeny("check", shell ?? "/bin/sh", ["-c", "true"]);
    `,
  );

  rule.reports(
    "reports /bin/sh",
    `
      export const sh = "/bin/sh";
    `,
  );

  rule.reports(
    "reports a /tmp template",
    `
      declare const name: string;
      export const dir = \`/tmp/\${name}\`;
    `,
  );
});
