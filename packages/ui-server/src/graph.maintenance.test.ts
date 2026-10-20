// @effect-diagnostics globalDate:off nodeBuiltinImport:off -- a plain node:test file with a scratch store on disk.
// Windows store maintenance (runtime graph/store-maintenance.ts): while `<db>.maintenance` is there the reader closes
// its connection and answers busy; once it is gone the next read reopens. Simulated on every OS with the marker file.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kora-graph-maint-")));
const dbFile = path.join(tmp, "graph.db");
process.env.KORAGRAPH_DB = dbFile;
process.env.KORAGRAPH_HOME = tmp;
process.env.KORA_HOME = path.join(tmp, ".kora");
new DatabaseSync(dbFile).close(); // an empty store: snapshot reads find no tables and answer null
const { buildGraphSnapshot, StoreMaintenanceError, storeMaintenanceActive } =
  await import("./graph.ts");
const { createGraphReader } = await import("./graphReader.ts");
const marker = `${dbFile}.maintenance`;

test("a maintenance marker makes reads answer busy; removing it reopens", async () => {
  assert.equal(buildGraphSnapshot(), null, "an ordinary read before maintenance");
  fs.writeFileSync(marker, "{}");
  try {
    assert.equal(storeMaintenanceActive(), true);
    assert.throws(() => buildGraphSnapshot(), StoreMaintenanceError);
    const reader = createGraphReader({ script: null, log: () => {} });
    assert.deepEqual(
      await reader.snapshot({}),
      { kind: "busy" },
      "the in-process fallback says busy",
    );
    assert.equal((await reader.status(tmp)).busy, true);
  } finally {
    fs.rmSync(marker, { force: true });
  }
  assert.equal(buildGraphSnapshot(), null, "reads again once the maintainer is done");
});

test("a stale marker (a maintainer that died) is ignored", () => {
  fs.writeFileSync(marker, "{}");
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(marker, old, old);
  try {
    assert.equal(storeMaintenanceActive(), false);
    assert.equal(buildGraphSnapshot(), null);
  } finally {
    fs.rmSync(marker, { force: true });
  }
});
