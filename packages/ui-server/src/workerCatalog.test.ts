// @effect-diagnostics nodeBuiltinImport:off -- the test writes a fake managed OpenCode under a temp KORA_HOME.
import * as NodeAssert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as NodeTest from "node:test";

import { applyOpencodeFreeModels } from "./blobsEngine.ts";
import { buildWorkerCatalog } from "./workerCatalog.ts";

NodeTest.test(
  "Kora's managed OpenCode counts as an installed worker CLI even when it is not on PATH",
  () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "kora-wc-"));
    const savedPath = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      NodeAssert.equal(
        buildWorkerCatalog(home).agents.opencode,
        undefined,
        "nothing installed → not listed",
      );
      const bin = path.join(home, "tools", "opencode", "current");
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, "opencode"), "#!/bin/sh\n", { mode: 0o755 });
      NodeAssert.equal(buildWorkerCatalog(home).agents.opencode?.installed, true);
    } finally {
      process.env.PATH = savedPath;
      fs.rmSync(home, { recursive: true, force: true });
    }
  },
);

NodeTest.test("OpenCode workers list the swarm's free models", () => {
  applyOpencodeFreeModels({
    ready: true,
    models: {
      available: [
        { id: "opencode/b-free", label: "B Free", rank: 2 },
        { id: "opencode/a-free", label: "A Free", rank: 1 },
      ],
      cooling: [],
    },
  } as unknown as Parameters<typeof applyOpencodeFreeModels>[0]);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kora-wc-"));
  const bin = path.join(home, "tools", "opencode", "current");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "opencode"), "#!/bin/sh\n", { mode: 0o755 });
  const models = buildWorkerCatalog(home).agents.opencode?.models ?? [];
  fs.rmSync(home, { recursive: true, force: true });
  NodeAssert.deepEqual(
    models.map((m) => [m.id, m.isDefault === true]),
    [
      ["opencode/a-free", true],
      ["opencode/b-free", false],
    ],
  );
});
