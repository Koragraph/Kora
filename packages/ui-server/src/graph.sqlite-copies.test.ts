// @effect-diagnostics nodeBuiltinImport:off -- a plain node:test file building a scratch store and git repos on disk.
// pl3 S1-1: the chip froze on an old snapshot once the daemon's better-sqlite3 graph workers closed their last
// connection (two SQLite copies in one process: the closer unlinks the -wal/-shm the other copy still reads).
// The ui-server now reads through the runtime's better-sqlite3 (UiHost.openGraphDb), so writers and the chip share
// one SQLite copy, and it reopens when the store's files are swapped under it.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kora-graph-copies-")));
const dbFile = path.join(tmp, "store", "graph.db");
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
process.env.KORAGRAPH_DB = dbFile;
process.env.KORAGRAPH_HOME = path.join(tmp, "kgh");
process.env.KORA_HOME = path.join(tmp, "kora-home");
const { buildGraphStatus, setGraphDbOpener } = await import("./graph.ts");

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeRequire = createRequire(path.resolve(here, "../../runtime/package.json"));
const Database = runtimeRequire("better-sqlite3");
const koragraph = path.resolve(here, "../../runtime/koragraph/bin/koragraph.js");
const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
const ingest = (dir: string) =>
  execFileSync("node", ["--liftoff-only", koragraph, "ingest", dir, "--no-hooks"], {
    env: { ...process.env },
    encoding: "utf8",
    stdio: "pipe",
  });
function repo(name: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "a.js"),
    "function alpha() { return beta(); }\nfunction beta() { return 1; }\n",
  );
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

test("a repo indexed after an in-process better-sqlite3 writer closed is still seen by the chip", () => {
  setGraphDbOpener((file) => {
    const db = new Database(file, { timeout: 4000 });
    db.pragma("query_only = ON");
    return db;
  });
  const a = repo("first");
  ingest(a);
  assert.equal(buildGraphStatus(a).indexed, true);
  // A graph worker in the daemon: opens the store with better-sqlite3, writes, and closes its last connection.
  const w = new Database(dbFile, { timeout: 4000 });
  w.exec(
    "CREATE TABLE IF NOT EXISTS kora_test_touch (x INTEGER); INSERT INTO kora_test_touch VALUES (1);",
  );
  w.close();
  const b = repo("second");
  ingest(b);
  const st = buildGraphStatus(b);
  assert.equal(
    st.indexed,
    true,
    "the index made after the writer closed is visible without a restart",
  );
  assert.equal(buildGraphStatus(a).indexed, true);
});

// Windows cannot delete a file a connection holds open: there a store is replaced only through the maintenance protocol
// (holders close first; runtime graph/store-maintenance.ts, tested in graph.maintenance.test.ts), never under an open one.
test(
  "a store replaced under the open connection is reopened, not read from the dead snapshot",
  { skip: process.platform === "win32" },
  () => {
    const c = repo("third");
    ingest(c);
    assert.equal(buildGraphStatus(c).indexed, true);
    // Move the store aside (a rebuild / prune --vacuum swap) and index into a brand-new file at the same path.
    for (const sfx of ["", "-wal", "-shm"]) fs.rmSync(dbFile + sfx, { force: true });
    const d = repo("fourth");
    ingest(d);
    assert.equal(buildGraphStatus(d).indexed, true, "the new file is read");
    assert.equal(buildGraphStatus(c).indexed, false, "the old snapshot is gone");
    setGraphDbOpener(null);
  },
);
