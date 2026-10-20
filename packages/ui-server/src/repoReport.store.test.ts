// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalConsole:off -- a plain node:test file building a scratch store and git repos on disk.
// The loader half of the repo code map: SQL over a (small, hand-built) graph store, the repo resolver and "index died part-way"
// rules it shares with the chip, the cache, the reader child's `report` op, and a cold build on a store the size of a big repo.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kora-report-store-")));
process.env.HOME = tmp;
if (process.platform === "win32") process.env.USERPROFILE = tmp;
const dbFile = path.join(tmp, "store", "graph.db");
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
process.env.KORAGRAPH_DB = dbFile;
process.env.KORAGRAPH_HOME = path.join(tmp, "kgh");
process.env.KORA_HOME = path.join(tmp, "kora-home");

const { buildRepoReportForCwd, resetReportCacheForTests } = await import("./repoReport.ts");
const { createGraphReader } = await import("./graphReader.ts");
const { setSlowSqlSink } = await import("./graph.ts");

test.after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
  } catch (e) {
    if (process.platform !== "win32") throw e; // Windows: the store handle is open until exit
  }
});

const DDL = `
CREATE TABLE repositories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, full_path TEXT NOT NULL, is_archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE repository_branches (id INTEGER PRIMARY KEY AUTOINCREMENT, repository_id INTEGER, branch_name TEXT NOT NULL, last_commit_sha TEXT);
CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, repository_branch_id INTEGER, path TEXT NOT NULL, index_status TEXT DEFAULT 'PENDING', last_indexed_at TEXT);
CREATE TABLE nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, repository_branch_id INTEGER, file_id INTEGER, node_type TEXT NOT NULL, name TEXT NOT NULL, summary TEXT, approval_status TEXT DEFAULT 'APPROVED', properties TEXT DEFAULT '{}', start_line INTEGER, end_line INTEGER);
CREATE TABLE edges (id INTEGER PRIMARY KEY AUTOINCREMENT, from_node_id INTEGER, to_node_id INTEGER, edge_type TEXT NOT NULL, confidence_tier TEXT NOT NULL DEFAULT 'INFERRED', resolution_tier INTEGER);
CREATE TABLE ingest_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL DEFAULT 'PENDING', job_type TEXT NOT NULL DEFAULT 'FULL', local_path TEXT, updated_at TEXT, started_at TEXT);
CREATE TABLE ingest_generations (id INTEGER PRIMARY KEY AUTOINCREMENT, repository_branch_id INTEGER, status TEXT DEFAULT 'PENDING');
CREATE INDEX idx_nodes_branch_id ON nodes (repository_branch_id);
CREATE INDEX idx_nodes_file_id ON nodes (file_id);
CREATE INDEX idx_nodes_branch_type ON nodes (repository_branch_id, node_type);
CREATE INDEX idx_edges_from_node ON edges (from_node_id);
CREATE INDEX idx_edges_to_node ON edges (to_node_id);
CREATE INDEX idx_files_branch_id ON files (repository_branch_id);
`;
const db = new DatabaseSync(dbFile);
db.exec("PRAGMA journal_mode = WAL");
db.exec(DDL);

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();

/** A scratch repo on disk (the loader reads its manifests and git history) and its rows in the store. */
function repo(name: string, files: string[]): { dir: string; repoId: number; branchId: number } {
  const dir = path.join(tmp, "code", name);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), `// ${f}\n`);
  }
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  const sha = git(dir, "rev-parse", "HEAD");
  const repoId = Number(
    db.prepare("INSERT INTO repositories (name, full_path) VALUES (?, ?)").run(name, dir)
      .lastInsertRowid,
  );
  const branchId = Number(
    db
      .prepare(
        "INSERT INTO repository_branches (repository_id, branch_name, last_commit_sha) VALUES (?, 'main', ?)",
      )
      .run(repoId, sha).lastInsertRowid,
  );
  db.prepare(
    "INSERT INTO ingest_jobs (status, job_type, local_path, updated_at) VALUES ('COMPLETE', 'FULL', ?, ?)",
  ).run(dir, new Date().toISOString());
  db.prepare(
    "INSERT INTO ingest_generations (repository_branch_id, status) VALUES (?, 'ACTIVE')",
  ).run(branchId);
  return { dir, repoId, branchId };
}

interface Ins {
  file(branchId: number, p: string): number;
  node(
    branchId: number,
    fileId: number,
    type: string,
    name: string,
    line: number | null,
    props?: object,
    summary?: string,
  ): number;
  edge(from: number, to: number, type: string, tier?: number): void;
}
const ins: Ins = {
  file: (branchId, p) =>
    Number(
      db
        .prepare(
          "INSERT INTO files (repository_branch_id, path, index_status, last_indexed_at) VALUES (?, ?, 'COMPLETE', '2026-10-15T00:00:00Z')",
        )
        .run(branchId, p).lastInsertRowid,
    ),
  node: (branchId, fileId, type, name, line, props = {}, summary) =>
    Number(
      db
        .prepare(
          "INSERT INTO nodes (repository_branch_id, file_id, node_type, name, summary, properties, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          branchId,
          fileId,
          type,
          name,
          summary ?? null,
          JSON.stringify(props),
          line,
          line === null ? null : line + 5,
        ).lastInsertRowid,
    ),
  edge: (from, to, type, tier = 5) => {
    db.prepare(
      "INSERT INTO edges (from_node_id, to_node_id, edge_type, resolution_tier) VALUES (?, ?, ?, ?)",
    ).run(from, to, type, tier);
  },
};

const SHOP_FILES: string[] = [];
for (const area of ["cart", "billing"])
  for (let i = 0; i < 6; i += 1) SHOP_FILES.push(`src/${area}/${area}_${i}.ts`);
SHOP_FILES.push("bin/shop.js", "tests/cart.test.ts", "package.json", "README.md", "dist/bundle.js");

/** Two dense areas, a hub with a docstring, a `bin` entry, a main(), a test file, a NOTE, three commits of history. */
const shop = (() => {
  const r = repo("shop", SHOP_FILES);
  fs.writeFileSync(
    path.join(r.dir, "package.json"),
    JSON.stringify({ name: "shop", bin: { shop: "bin/shop.js" } }),
  );
  const fileIds = new Map<string, number>();
  const fns = new Map<string, number[]>();
  for (const f of SHOP_FILES) {
    const fid = ins.file(r.branchId, f);
    fileIds.set(f, fid);
    ins.node(r.branchId, fid, "FILE", f, 1);
  }
  for (const area of ["cart", "billing"]) {
    for (let i = 0; i < 6; i += 1) {
      const f = `src/${area}/${area}_${i}.ts`;
      fns.set(
        f,
        [0, 1].map((j) =>
          ins.node(r.branchId, fileIds.get(f)!, "METHOD", `${area}_task_${i}_${j}`, 10 + j * 10),
        ),
      );
    }
    for (let i = 0; i < 6; i += 1)
      for (let j = 0; j < 2; j += 1)
        for (const d of [1, 2])
          ins.edge(
            fns.get(`src/${area}/${area}_${i}.ts`)![j]!,
            fns.get(`src/${area}/${area}_${(i + d) % 6}.ts`)![j]!,
            "CALLS",
          );
  }
  // The hub: a price formatter in billing_0 that every cart file calls, with a docstring above it.
  const hub = ins.node(
    r.branchId,
    fileIds.get("src/billing/billing_0.ts")!,
    "METHOD",
    "formatPrice_cents",
    40,
  );
  ins.node(
    r.branchId,
    fileIds.get("src/billing/billing_0.ts")!,
    "RATIONALE",
    "Formats a price for display. Rounds half up.",
    37,
    { kind: "docstring" },
    "Formats a price for display. Rounds half up.",
  );
  ins.node(
    r.branchId,
    fileIds.get("src/cart/cart_2.ts")!,
    "RATIONALE",
    "NOTE: totals are cached per request.",
    12,
    { kind: "docstring" },
    "NOTE: totals are cached per request.",
  );
  for (let i = 0; i < 6; i += 1) ins.edge(fns.get(`src/cart/cart_${i}.ts`)![0]!, hub, "CALLS");
  // A guessed edge that must count as a name-matched guess, not a dependency of the same weight.
  ins.edge(fns.get("src/cart/cart_0.ts")![1]!, hub, "HEURISTIC_CALLS", 8);
  // bin/shop.js and a main().
  const main = ins.node(r.branchId, fileIds.get("bin/shop.js")!, "METHOD", "main", 3);
  ins.edge(main, fns.get("src/cart/cart_0.ts")![0]!, "CALLS");
  ins.edge(
    ins.node(r.branchId, fileIds.get("bin/shop.js")!, "FILE", "bin/shop.js#x", 1),
    fns.get("src/cart/cart_1.ts")![0]!,
    "CALLS",
  );
  // A test file that reaches into cart, and a built file (left out).
  const t = ins.node(r.branchId, fileIds.get("tests/cart.test.ts")!, "METHOD", "cart_suite", 2);
  ins.edge(t, fns.get("src/cart/cart_3.ts")![0]!, "CALLS");
  ins.node(r.branchId, fileIds.get("dist/bundle.js")!, "METHOD", "bundled_everything", 1);
  // History: after the first commit, cart_1 and cart_2 change together twice; cart_1 once more alone.
  const touch = (msg: string, ...fs_: string[]) => {
    for (const f of fs_) fs.appendFileSync(path.join(r.dir, f), `// ${msg}\n`);
    git(r.dir, "add", "-A");
    git(r.dir, "commit", "-qm", msg);
  };
  touch("one", "src/cart/cart_1.ts", "src/cart/cart_2.ts");
  touch("two", "src/cart/cart_1.ts", "src/cart/cart_2.ts");
  touch("three", "src/cart/cart_1.ts");
  db.prepare("UPDATE repository_branches SET last_commit_sha = ? WHERE id = ?").run(
    git(r.dir, "rev-parse", "HEAD"),
    r.branchId,
  );
  return { ...r, hub };
})();

test("the report of a small indexed repo: areas, hub with its docstring, entry points from disk, history, notes, tests", () => {
  resetReportCacheForTests();
  const report = buildRepoReportForCwd(shop.dir)!;
  assert.ok(report, "an indexed repo has a report");
  assert.equal(report.repo, "shop");
  assert.equal(report.branch, "main");
  assert.equal(report.stale, false);
  assert.equal(report.indexedSha, git(shop.dir, "rev-parse", "HEAD"));
  // Built output and the test file are left out; the package.json / README are not source.
  assert.equal(report.stats.files, 13, "12 shop files + bin/shop.js");
  assert.equal(report.stats.testFiles, 1);
  assert.deepEqual(report.areas.map((a) => a.name).sort(), ["billing", "cart"]);
  const cart = report.areas.find((a) => a.name === "cart")!;
  assert.equal(cart.testFiles, 1);
  assert.equal(
    cart.files,
    7,
    "the six cart files, and bin/shop.js, which calls into them, joins them",
  );
  assert.ok(report.fileAreas["bin/shop.js"] === cart.id);
  const hub = report.hubs[0]!;
  assert.equal(hub.name, "formatPrice_cents");
  assert.equal(hub.file, "src/billing/billing_0.ts");
  assert.equal(hub.line, 40);
  assert.equal(hub.dependents, 7, "six resolved callers and one name-matched guess");
  assert.equal(hub.heuristicShare, 0.14);
  assert.equal(hub.doc, "Formats a price for display.");
  assert.equal(hub.areasReached, 1);
  const bin = report.entryPoints.find((e) => e.why === "package-bin")!;
  assert.equal(bin.file, "bin/shop.js");
  assert.equal(bin.name, "shop");
  assert.ok(
    report.entryPoints.some(
      (e) => e.why === "main-function" && e.file === "bin/shop.js" && e.line === 3,
    ),
  );
  assert.deepEqual(
    report.hotspots.slice(0, 2).map((h) => [h.file, h.commits]),
    [
      ["src/cart/cart_1.ts", 4], // the first commit and the three after it
      ["src/cart/cart_2.ts", 3],
    ],
  );
  assert.deepEqual(report.hotspots[0]!.changesWith, ["src/cart/cart_2.ts"]);
  assert.deepEqual(
    report.notes.map((n) => [n.tag, n.file, n.text]),
    [["NOTE", "src/cart/cart_2.ts", "totals are cached per request."]],
  );
  assert.ok(report.questions.some((q) => q.kind === "callers" && q.target === "formatPrice_cents"));
  assert.ok(
    Object.keys(report.fileAreas).every((f) => !f.startsWith("tests/") && !f.startsWith("dist/")),
  );
  // Wire safety: it survives JSON unchanged (no undefined anywhere).
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
});

test("cached per branch and index generation: a second call is the same object, a re-index or a new commit is a new report", () => {
  resetReportCacheForTests();
  const first = buildRepoReportForCwd(shop.dir)!;
  assert.equal(
    buildRepoReportForCwd(shop.dir),
    first,
    "opening the panel twice does not recompute",
  );
  db.prepare(
    "UPDATE files SET last_indexed_at = '2026-10-16T00:00:00Z' WHERE id = (SELECT MIN(id) FROM files WHERE repository_branch_id = ?)",
  ).run(shop.branchId);
  const second = buildRepoReportForCwd(shop.dir)!;
  assert.notEqual(second, first, "a re-index (a file indexed later) yields a fresh report");
  assert.equal(buildRepoReportForCwd(shop.dir), second);
  // HEAD moves past the indexed commit: stale, and a new report that says so.
  fs.appendFileSync(path.join(shop.dir, "src/cart/cart_0.ts"), "// later\n");
  git(shop.dir, "add", "-A");
  git(shop.dir, "commit", "-qm", "later");
  const stale = buildRepoReportForCwd(shop.dir)!;
  assert.equal(stale.stale, true);
  assert.ok(
    stale.caveats.some((c) => /1 commit behind HEAD/.test(c)),
    stale.caveats.join(" | "),
  );
  db.prepare("UPDATE repository_branches SET last_commit_sha = ? WHERE id = ?").run(
    git(shop.dir, "rev-parse", "HEAD"),
    shop.branchId,
  );
  assert.equal(buildRepoReportForCwd(shop.dir)!.stale, false);
});

test("archived nodes are not in the report; a cwd that is not indexed, and an index that died part-way, have none", () => {
  resetReportCacheForTests();
  const before = buildRepoReportForCwd(shop.dir)!;
  assert.ok(before.hubs.some((h) => h.name === "formatPrice_cents"));
  db.prepare("UPDATE nodes SET approval_status = 'ARCHIVED' WHERE id = ?").run(shop.hub);
  const after = buildRepoReportForCwd(shop.dir)!;
  assert.ok(
    !after.hubs.some((h) => h.name === "formatPrice_cents"),
    "a soft-deleted declaration is gone",
  );
  db.prepare("UPDATE nodes SET approval_status = 'APPROVED' WHERE id = ?").run(shop.hub);

  assert.equal(buildRepoReportForCwd(path.join(tmp, "not-indexed")), null);
  const other = repo("halfway", ["a.ts"]);
  const fid = ins.file(other.branchId, "a.ts");
  ins.node(other.branchId, fid, "METHOD", "halfwayThing", 1);
  assert.ok(buildRepoReportForCwd(other.dir), "a whole index has a report");
  db.prepare("UPDATE ingest_jobs SET status = 'FAILED' WHERE local_path = ?").run(other.dir);
  assert.equal(buildRepoReportForCwd(other.dir), null, "a partial graph draws no misleading map");
});

test("a repo whose folder is gone still has a report from the store, and says what it could not read", () => {
  const gone = repo("vanished", ["a.ts", "b.ts"]);
  for (const f of ["a.ts", "b.ts"]) {
    const fid = ins.file(gone.branchId, f);
    ins.node(gone.branchId, fid, "METHOD", `vanished_${f[0]}`, 1);
  }
  const dir = gone.dir;
  fs.rmSync(dir, { recursive: true, force: true });
  resetReportCacheForTests();
  const report = buildRepoReportForCwd(dir)!;
  assert.ok(report, "the graph is in the store whether or not the folder is there");
  assert.deepEqual(report.entryPoints, []);
  assert.deepEqual(report.hotspots, []);
  assert.ok(report.caveats.some((c) => /not on disk/.test(c)));
});

test("the reader child answers the `report` op with the same report, and `none` for a repo it does not know", async () => {
  resetReportCacheForTests();
  const logs: string[] = [];
  const reader = createGraphReader({ log: (l) => logs.push(l) });
  try {
    const r = await reader.report(shop.dir);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    const local = buildRepoReportForCwd(shop.dir)!;
    assert.equal(r.report.repo, "shop");
    assert.deepEqual(
      { ...r.report, generatedAt: "" },
      { ...JSON.parse(JSON.stringify(local)), generatedAt: "" },
    );
    const again = await reader.report(shop.dir);
    assert.equal(again.kind, "ok");
    if (again.kind === "ok")
      assert.equal(
        again.report.generatedAt,
        r.report.generatedAt,
        "cached in the child per index generation",
      );
    assert.deepEqual(await reader.report(path.join(tmp, "nope")), { kind: "none" });
    assert.equal(reader.stats().inProcess, false);
  } finally {
    reader.stop();
  }
});

test("cold build on a store the size of a big repo (5k files, 50k declarations, 150k dependencies, another repo beside it): under 5 s", () => {
  const files: string[] = [];
  for (let i = 0; i < 5000; i += 1)
    files.push(`src/mod${String(Math.floor(i / 50)).padStart(3, "0")}/file${i}.ts`);
  const noise = repo("noise", ["n.ts"]);
  const big = repo("big", ["README.md"]);
  let s = 11;
  const rnd = (n: number) => (s = (s * 1103515245 + 12345) & 0x7fffffff) % n;
  db.exec("BEGIN");
  try {
    // A second repo in the same store: the planner must not wander into its nodes.
    const nf = ins.file(noise.branchId, "n.ts");
    const noiseNodes: number[] = [];
    for (let i = 0; i < 20_000; i += 1)
      noiseNodes.push(ins.node(noise.branchId, nf, "METHOD", `noise_${i}`, i));
    for (let i = 0; i < 60_000; i += 1)
      ins.edge(noiseNodes[rnd(noiseNodes.length)]!, noiseNodes[rnd(noiseNodes.length)]!, "CALLS");
    const fns: number[][] = [];
    for (let i = 0; i < files.length; i += 1) {
      const fid = ins.file(big.branchId, files[i]!);
      ins.node(big.branchId, fid, "FILE", files[i]!, 1);
      fns.push(
        Array.from({ length: 10 }, (_, j) =>
          ins.node(big.branchId, fid, "METHOD", `fn_${i}_${j}`, 10 + j * 8),
        ),
      );
    }
    for (let i = 0; i < files.length; i += 1) {
      const mod = Math.floor(i / 50);
      for (let j = 0; j < 10; j += 1)
        for (let k = 0; k < 3; k += 1) {
          const target = rnd(100) < 85 ? mod * 50 + rnd(50) : rnd(files.length);
          if (target !== i) ins.edge(fns[i]![j]!, fns[target]![rnd(10)]!, "CALLS");
        }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  const slow: string[] = [];
  setSlowSqlSink((l) => slow.push(l));
  resetReportCacheForTests();
  const t0 = performance.now();
  const report = buildRepoReportForCwd(big.dir);
  const ms = performance.now() - t0;
  setSlowSqlSink(null);
  console.log(
    `# cold report on ${report?.stats.files} files / ${report?.stats.declarations} declarations / ${report?.stats.edges} edges: ${Math.round(ms)} ms (${slow.length} slow statements)`,
  );
  assert.ok(report, "built");
  assert.equal(report.stats.files, 5000);
  assert.equal(report.stats.declarations, 50_000);
  assert.ok(ms < 5000, `cold build took ${Math.round(ms)} ms`);
  assert.equal(slow.length, 0, `no statement over 1 s:\n${slow.join("\n")}`);
  const t1 = performance.now();
  assert.equal(buildRepoReportForCwd(big.dir), report);
  assert.ok(performance.now() - t1 < 500, "a cached report costs a few cheap lookups");
});
