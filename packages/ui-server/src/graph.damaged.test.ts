/* oxlint-disable kora/namespace-node-imports -- a plain node:test file; matches graph.test.ts */
// @effect-diagnostics nodeBuiltinImport:off -- a plain node:test file building a scratch store and git repo on disk.
// A store SQLite cannot open must read as DAMAGED (the chip offers Rebuild), never as "Not indexed · Index?".
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kora-graph-damaged-")));
const dbFile = path.join(tmp, "store.db");
fs.writeFileSync(dbFile, "this is not a sqlite database, just bytes ".repeat(40));
process.env.KORAGRAPH_DB = dbFile;
process.env.KORA_HOME = path.join(tmp, "kora-home");
const { buildGraphStatus } = await import("./graph.ts");

test("a damaged store reads as storeDamaged, and a rebuilt one is picked up on the next poll", () => {
  const repo = path.join(tmp, "code", "app");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  const st = buildGraphStatus(repo);
  assert.equal(st.storeDamaged, true);
  assert.equal(st.indexed, false);
  assert.equal(st.isGitRepo, true, "the git facts survive a store that cannot be read");
  fs.rmSync(dbFile); // moved aside by the next ingest; a fresh (empty) store follows
  const after = buildGraphStatus(repo);
  assert.equal(after.storeDamaged, undefined);
});

test("a failed index recorded by the runtime reaches the chip (ingest-errors/<sha1>.json under KORA_HOME)", async () => {
  const { createHash } = await import("node:crypto");
  const repo = path.join(tmp, "code", "failing");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  const dir = path.join(process.env.KORA_HOME as string, "ingest-errors");
  fs.mkdirSync(dir, { recursive: true });
  const key = createHash("sha1").update(path.resolve(repo)).digest("hex").slice(0, 16);
  fs.writeFileSync(
    path.join(dir, `${key}.json`),
    JSON.stringify({ root: repo, at: "2026-10-02T00:00:00Z", error: "boom" }),
  );
  assert.equal(buildGraphStatus(repo).ingestError?.message, "boom");
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
