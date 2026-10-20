/* oxlint-disable kora/namespace-node-imports -- a plain node:test file; matches graph.test.ts */
// @effect-diagnostics nodeBuiltinImport:off -- a plain node:test file building a scratch store and git repos on disk.
// The graph chip / explorer must agree with the graph TOOLS about which store, which nodes and whether an index is whole.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kora-graph-hard-")));
const dbFile = path.join(tmp, "elsewhere", "store.db"); // NOT ~/.koragraph: the chip must follow KORAGRAPH_DB
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
process.env.KORAGRAPH_DB = dbFile;
process.env.KORAGRAPH_HOME = path.join(tmp, "kgh");
process.env.KORA_HOME = path.join(tmp, "kora-home");
const { buildGraphStatus, buildGraphSnapshot } = await import("./graph.ts");

const here = path.dirname(fileURLToPath(import.meta.url));
const koragraph = path.resolve(here, "../../runtime/koragraph/bin/koragraph.js");
const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
const ingest = (dir: string) =>
  execFileSync("node", [koragraph, "ingest", dir, "--no-hooks"], {
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
  fs.writeFileSync(path.join(dir, "b.js"), "function gamma() { return 2; }\n");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

test("the chip reads the store named by KORAGRAPH_DB, and counts only live nodes", () => {
  const r = repo("live");
  ingest(r);
  assert.ok(fs.existsSync(dbFile), "the scratch store, not ~/.koragraph, was written");
  const before = buildGraphStatus(r);
  assert.equal(before.indexed, true);
  const liveBefore = before.nodes;
  git(r, "rm", "-q", "b.js");
  git(r, "commit", "-qm", "rm b");
  ingest(r);
  const after = buildGraphStatus(r);
  assert.ok(
    after.nodes < liveBefore,
    `archived nodes of the deleted file are not counted (${after.nodes} < ${liveBefore})`,
  );
  const snap = buildGraphSnapshot({ cwd: r });
  assert.ok(snap && snap.stats.totalNodes === after.nodes, "the picture and the chip agree");
  assert.ok(
    snap.nodes.every((n) => n.file !== "b.js"),
    "nothing of the deleted file is drawn",
  );
});

test("an index whose full run died reads as incomplete, is not drawn, and a finished one clears it", () => {
  const r = repo("half");
  ingest(r);
  assert.equal(buildGraphStatus(r).incomplete, undefined);
  const db = new DatabaseSync(dbFile);
  try {
    db.exec("PRAGMA busy_timeout = 4000");
    db.prepare(
      "UPDATE ingest_jobs SET status = 'FAILED' WHERE local_path = ? AND job_type = 'FULL'",
    ).run(r);
  } finally {
    db.close();
  }
  const s = buildGraphStatus(r);
  assert.equal(s.incomplete, true);
  assert.equal(s.indexed, false, "a partial graph is not 'indexed'");
  assert.equal(buildGraphSnapshot({ cwd: r }), null, "no misleading fragment is drawn");
  ingest(r); // `koragraph ingest` on an already-current repo takes the recovery path (previous run never finished)
  const healed = buildGraphStatus(r);
  assert.equal(healed.indexed, true);
  assert.equal(healed.incomplete, undefined);
});

test("a project whose folder is gone says so instead of reading Fresh", () => {
  const r = repo("vanish");
  ingest(r);
  assert.equal(buildGraphStatus(r).folderMissing, undefined);
  fs.rmSync(r, { recursive: true, force: true });
  const s = buildGraphStatus(r);
  assert.equal(s.folderMissing, true);
  assert.equal(s.indexed, false);
});

test("two folders named the same are two repositories: one never answers for the other", () => {
  const a = path.join(tmp, "x", "twin");
  const b = path.join(tmp, "y", "twin");
  for (const d of [a, b]) {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(d, "f.js"),
      `function only_${path.basename(path.dirname(d))}() { return 1; }\n`,
    );
    git(d, "init", "-q", "-b", "main");
    git(d, "add", "-A");
    git(d, "commit", "-qm", "i");
  }
  ingest(a);
  const c = buildGraphStatus(b); // b is not indexed: it must NOT resolve to a's row by the shared basename
  assert.equal(c.indexed, false);
  ingest(b);
  assert.equal(buildGraphStatus(a).repoRoot, a);
  assert.equal(buildGraphStatus(b).repoRoot, b);
});

test.after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
  } catch (e) {
    if (process.platform !== "win32") throw e; // Windows: the store handle is open until exit; the isolation base goes then
  }
});

test("an index matched only by name to a moved folder says where it came from (never caught up on its own)", () => {
  const r = repo("wander");
  ingest(r);
  assert.equal(buildGraphStatus(r).indexedFrom, undefined, "its own folder: no origin to report");
  const moved = path.join(tmp, "moved-to", "wander");
  fs.mkdirSync(path.dirname(moved), { recursive: true });
  fs.renameSync(r, moved);
  const s = buildGraphStatus(moved);
  assert.equal(s.indexed, true);
  assert.equal(s.indexedFrom, r, "the chip offers 'Index moved — re-index?'");
});
