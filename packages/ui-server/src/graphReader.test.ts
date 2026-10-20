// @effect-diagnostics globalDate:off globalTimers:off nodeBuiltinImport:off -- a plain node:test file forking real child processes.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kora-graphreader-")));
process.env.HOME = home;
process.env.KORAGRAPH_DB = path.join(home, "store", "graph.db"); // no store: the fresh-machine state
process.env.KORAGRAPH_HOME = path.join(home, "store");
process.env.KORA_HOME = path.join(home, ".kora");
const { createGraphReader } = await import("./graphReader.ts");
const { instrumentSlowSql, resetSlowSqlForTests, setSlowSqlSink } = await import("./graph.ts");

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const logs: string[] = [];
const log = (l: string) => logs.push(l);

// A stand-in child: answers like the real one unless `<home>/hang` exists, in which case it never answers (a stuck query).
const fake = path.join(home, "fake-child.cjs");
fs.writeFileSync(
  fake,
  `const fs = require("node:fs");
const hangFile = ${JSON.stringify(path.join(home, "hang"))};
process.on("disconnect", () => process.exit(0));
process.on("message", (m) => {
  if (fs.existsSync(hangFile)) { for (;;) {} } // synchronous spin, like a table scan
  process.send({ id: m.id, ok: true, result: m.op === "snapshot" ? null : { indexed: true, repo: "fake", cwd: m.cwd } });
});
process.send({ ready: true });
`,
);

test("the real child answers status / target / snapshot against a missing store (fresh machine)", async () => {
  const repo = path.join(home, "code", "app");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  const reader = createGraphReader({ log });
  try {
    const st = await reader.status(repo);
    assert.equal(st.busy, undefined);
    assert.equal(st.isGitRepo, true);
    assert.equal(st.indexed, false);
    assert.equal((await reader.target(repo))?.safeToIndex, true);
    assert.deepEqual(await reader.snapshot({ cwd: repo }), { kind: "none" });
    assert.equal(reader.stats().inProcess, false);
  } finally {
    reader.stop();
  }
});

test("a stuck child is killed at the timeout, the answer falls back to busy / last known, and the next call respawns", async () => {
  const reader = createGraphReader({
    script: fake,
    statusTimeoutMs: 400,
    snapshotTimeoutMs: 400,
    cooldownMs: 600,
    log,
  });
  const hang = path.join(home, "hang");
  try {
    const ok = await reader.status("/x");
    assert.equal(ok.indexed, true);
    assert.equal(ok.busy, undefined);
    assert.equal(reader.stats().spawns, 1);

    fs.writeFileSync(hang, "1");
    const t0 = Date.now();
    const busy = await reader.status("/x");
    assert.ok(Date.now() - t0 < 2000, "answered within the timeout, not after the spin");
    assert.equal(busy.busy, true);
    assert.equal(busy.repo, "fake", "the last known status is kept, flagged busy");
    const never = await reader.status("/never-seen");
    assert.equal(never.busy, true);
    assert.equal(never.indexed, false);
    assert.equal(reader.stats().kills >= 1, true);
    assert.ok(
      logs.some((l) => /did not answer status in 400 ms/.test(l)),
      "the kill is logged",
    );

    // Third consecutive timeout -> the lane stops respawning for a while.
    const again = await reader.status("/y");
    assert.equal(again.busy, true);
    const spawnsBefore = reader.stats().spawns;
    const cooled = await reader.status("/z");
    assert.equal(cooled.busy, true);
    assert.equal(reader.stats().spawns, spawnsBefore, "cooldown: no new child");

    fs.rmSync(hang);
    await new Promise((r) => setTimeout(r, 700));
    const back = await reader.status("/x");
    assert.equal(back.indexed, true);
    assert.equal(back.busy, undefined, "a fresh child answers normally after the cooldown");
  } finally {
    fs.rmSync(hang, { force: true });
    reader.stop();
  }
});

test("a stuck snapshot is 'busy' and does not starve status polls (separate lanes)", async () => {
  const reader = createGraphReader({
    script: fake,
    statusTimeoutMs: 1000,
    snapshotTimeoutMs: 300,
    log,
  });
  try {
    assert.equal((await reader.status("/a")).indexed, true);
    const hang = path.join(home, "hang");
    // Only the snapshot child hangs: it is a different process from the status child, which is already running.
    fs.writeFileSync(hang, "1");
    const snap = await reader.snapshot({ cwd: "/a" });
    assert.deepEqual(snap, { kind: "busy" });
    fs.rmSync(hang);
    assert.equal((await reader.status("/a")).indexed, true);
  } finally {
    fs.rmSync(path.join(home, "hang"), { force: true });
    reader.stop();
  }
});

test("the report lane has its own child and timeout: a stuck report is 'busy' (503 upstream), status polls carry on", async () => {
  const reader = createGraphReader({
    script: fake,
    statusTimeoutMs: 1000,
    reportTimeoutMs: 300,
    log,
  });
  const hang = path.join(home, "hang");
  try {
    assert.equal((await reader.status("/a")).indexed, true);
    const ok = await reader.report("/a");
    assert.equal(ok.kind, "ok", "the report op is answered by a child of its own");
    assert.equal(reader.stats().spawns, 2, "status child + report child");
    fs.writeFileSync(hang, "1");
    const t0 = Date.now();
    assert.deepEqual(await reader.report("/a"), { kind: "busy" });
    assert.ok(Date.now() - t0 < 2000, "answered busy at the report timeout");
    assert.ok(logs.some((l) => /reader \(report\) did not answer report in 300 ms/.test(l)));
    fs.rmSync(hang);
    assert.equal((await reader.status("/a")).indexed, true, "the status lane never noticed");
    assert.equal((await reader.report("/a")).kind, "ok", "a fresh report child after the kill");
  } finally {
    fs.rmSync(hang, { force: true });
    reader.stop();
  }
});

test("the real child answers `report` against a missing store with none (a fresh machine)", async () => {
  const repo = path.join(home, "code", "fresh");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  const reader = createGraphReader({ log });
  try {
    assert.deepEqual(await reader.report(repo), { kind: "none" });
  } finally {
    reader.stop();
  }
});

test("slow SQL is logged once with its query plan, and rate-limited", () => {
  resetSlowSqlForTests();
  const lines: string[] = [];
  setSlowSqlSink((l) => lines.push(l));
  const spin = (ms: number) => {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      /* spin */
    }
  };
  const raw = {
    prepare(sql: string) {
      return {
        all: () => (sql.startsWith("EXPLAIN") ? [{ detail: "SCAN nodes" }] : (spin(30), [])),
        get: () => (spin(30), undefined),
      };
    },
    exec: () => undefined,
    close: () => undefined,
  };
  const db = instrumentSlowSql(raw, 10);
  db.prepare("SELECT 1 FROM nodes WHERE x = ?").all(1);
  db.prepare("SELECT 1 FROM nodes WHERE x = ?").all(2); // same statement: not repeated
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /slow SQL \(\d+ ms\): SELECT 1 FROM nodes WHERE x = \?/);
  assert.match(lines[0]!, /plan: SCAN nodes/);
  for (let i = 0; i < 12; i++) db.prepare(`SELECT ${i} FROM nodes`).get();
  assert.ok(lines.length <= 6, `at most 6 reports a minute, got ${lines.length}`);
  // A fast statement and a disabled threshold stay silent.
  const before = lines.length;
  instrumentSlowSql(raw, 0).prepare("SELECT 99").get();
  assert.equal(lines.length, before);
  setSlowSqlSink(null);
});
