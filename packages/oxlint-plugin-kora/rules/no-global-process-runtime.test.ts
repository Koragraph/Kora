import { expect } from "vite-plus/test";

import { lintRule } from "../test/utils.ts";

const rule = lintRule("kora/no-global-process-runtime");

rule.allows("the injected platform", `const os = yield* MachinePlatform;`);
rule.allows("other process fields", `const home = process.env.HOME; const id = process.pid;`);
rule.allows(
  "os functions that are not the host's platform",
  `import * as NodeOS from "node:os"; NodeOS.tmpdir();`,
);
rule.allows("a property called platform on something else", `const p = config.platform;`);

rule.reports("process.platform", `if (process.platform === "darwin") open();`, (output) =>
  expect(output).toContain("Use MachinePlatform instead of process.platform"),
);
rule.reports("process.arch", `const cpu = process.arch;`, (output) =>
  expect(output).toContain("Use MachineArchitecture instead of process.arch"),
);
rule.reports("globalThis.process.platform", `const os = globalThis.process.platform;`);
rule.reports("a bracket read", `const os = process["platform"];`);
rule.reports(
  "os.platform() from a namespace import",
  `import * as os from "node:os"; os.platform();`,
);
rule.reports("arch() as a named import", `import { arch } from "os"; arch();`);
rule.reports("a renamed named import", `import { platform as hostOs } from "node:os"; hostOs();`);
