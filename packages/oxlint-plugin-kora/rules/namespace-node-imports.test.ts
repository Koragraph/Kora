import { lintRule } from "../test/utils.ts";

const rule = lintRule("kora/namespace-node-imports");

rule.allows("node:path as NodePath", `import * as NodePath from "node:path";`);
rule.allows("node:fs as NodeFS", `import * as NodeFS from "node:fs";`);
rule.allows("node:fs/promises as NodeFSP", `import * as NodeFSP from "node:fs/promises";`);
rule.allows(
  "node:child_process as NodeChildProcess",
  `import * as NodeChildProcess from "node:child_process";`,
);
rule.allows(
  "node:assert/strict as NodeAssert",
  `import * as NodeAssert from "node:assert/strict";`,
);
rule.allows("node:url as NodeURL", `import * as NodeURL from "node:url";`);
rule.allows(
  "node:stream/web as NodeStreamWeb",
  `import * as NodeStreamWeb from "node:stream/web";`,
);
rule.allows("a package that is not node's", `import { join } from "pathe";`);

rule.reports("a named import", `import { readFile } from "node:fs/promises";`);
rule.reports("a default import", `import path from "node:path";`);
rule.reports("a namespace with another name", `import * as path from "node:path";`);
rule.reports("the wrong casing", `import * as NodeOs from "node:os";`);
rule.reports("a namespace next to a named import", `import Url, * as NodeURL from "node:url";`);
