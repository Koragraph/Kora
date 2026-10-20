// @effect-diagnostics nodeBuiltinImport:off -- a plain node:test file building a temp home and git repo on disk.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A fresh machine: no ~/.koragraph at all. graph.ts reads its store path from the home dir at
// import time, so point HOME at an empty temp dir before importing it.
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kora-graph-home-")));
process.env.HOME = home;
if (process.platform === "win32") process.env.USERPROFILE = home; // os.homedir() reads USERPROFILE there
const { buildGraphStatus } = await import("./graph.ts");

test("with no graph store yet, a git repo still reads as a git repo the chip may index", () => {
  const repo = path.join(home, "code", "app");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  const status = buildGraphStatus(repo);
  assert.equal(status.indexed, false);
  assert.equal(status.isGitRepo, true);
  assert.equal(status.safeToIndex, true);
  assert.equal(status.indexRoot, repo);
});

test("a plain folder reads as not a git repo, and is not offered for indexing", () => {
  const plain = path.join(home, "notes");
  fs.mkdirSync(plain, { recursive: true });
  const status = buildGraphStatus(plain);
  assert.equal(status.isGitRepo, false);
  assert.equal(status.safeToIndex, false);
  assert.equal(status.systemFolder, false, "a plain project folder may still be indexed anyway");
});

test("a repo opened through a symlinked path resolves to the real checkout (where the graph keys it)", () => {
  const repo = path.join(home, "code", "linked-target");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  const link = path.join(home, "link-to-repo");
  fs.symlinkSync(repo, link);
  const status = buildGraphStatus(link);
  assert.equal(status.indexRoot, fs.realpathSync(repo));
  assert.equal(status.isGitRepo, true);
  const plainLink = path.join(home, "link-to-notes");
  fs.mkdirSync(path.join(home, "notes2"), { recursive: true });
  fs.symlinkSync(path.join(home, "notes2"), plainLink);
  assert.equal(
    buildGraphStatus(plainLink).isGitRepo,
    false,
    "a symlinked plain folder is still not a repo",
  );
});

test("the home dir is a system folder: never offered for indexing, not even anyway", () => {
  const status = buildGraphStatus(home);
  assert.equal(status.safeToIndex, false);
  assert.equal(status.systemFolder, true);
  assert.equal(buildGraphStatus("/").systemFolder, true);
});

test.after(() => {
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  } catch (e) {
    if (process.platform !== "win32") throw e; // Windows: the store handle is open until exit; the isolation base goes then
  }
});

test("initGitRepo: a plain folder becomes a repo with a first commit and a default .gitignore; a repo is left alone; home is refused", async () => {
  const { initGitRepo } = await import("./graph.ts");
  const { execFileSync } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kora-gitinit-"));
  fs.writeFileSync(path.join(dir, "notes.md"), "hi");
  fs.mkdirSync(path.join(dir, "node_modules"));
  fs.writeFileSync(path.join(dir, "node_modules", "big.js"), "x");
  assert.deepEqual(await initGitRepo(dir), { ok: true, created: true });
  const tracked = execFileSync("git", ["-C", dir, "ls-files"], { encoding: "utf8" })
    .trim()
    .split("\n")
    .sort();
  assert.deepEqual(tracked, [".gitignore", "notes.md"]);
  assert.equal(
    execFileSync("git", ["-C", dir, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim(),
    "1",
  );
  assert.deepEqual(await initGitRepo(dir), { ok: true, created: false });
  assert.deepEqual(await initGitRepo(os.homedir()), { ok: false, reason: "unsafe-root" });
  assert.deepEqual(await initGitRepo(path.join(dir, "nope")), {
    ok: false,
    reason: "folder not found",
  });
});

// B2 (night 2026-10-04): a bare repo's common dir is the repo itself, so "its parent is the checkout" pointed the
// chip's Index at the folder the bare repo sits in (every repo beside it). It is a bare repo: nothing to index.
test("a bare repository reads as bare (no index offer), never as its parent folder", () => {
  const parent = path.join(home, "remotes");
  const bare = path.join(parent, "app.git");
  fs.mkdirSync(parent, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  const status = buildGraphStatus(bare);
  assert.equal(status.bareRepo, true);
  assert.equal(status.indexRoot, bare, "never the parent folder");
  assert.equal(status.safeToIndex, false);
  assert.equal(status.isGitRepo, false);
});

test("a linked worktree and a subfolder still resolve to the main checkout", () => {
  const repo = path.join(home, "code", "wt-main");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  fs.writeFileSync(path.join(repo, "src", "a.js"), "export const a = 1;\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-qm",
    "init",
  ]);
  const wt = path.join(home, "code", "wt-linked");
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", wt, "-b", "side"]);
  assert.equal(buildGraphStatus(wt).indexRoot, repo);
  assert.equal(buildGraphStatus(path.join(repo, "src")).indexRoot, repo);
  assert.equal(buildGraphStatus(wt).bareRepo, undefined);
});

test(
  "isSafeToIndex: macOS system and app-data trees are never offered; project folders still are",
  { skip: process.platform === "win32" },
  async () => {
    const { isSafeToIndex } = await import("./graph.ts");
    for (const p of [
      "/System/Library",
      "/Library/Developer",
      "/usr/local/lib",
      "/Applications/Xcode.app",
    ])
      assert.equal(isSafeToIndex(p), false, p);
    assert.equal(isSafeToIndex(path.join(home, "Library", "Caches")), false);
    assert.equal(isSafeToIndex(path.join(home, "code", "app")), true);
    assert.equal(isSafeToIndex("/Volumes/External/app"), true);
    const status = buildGraphStatus("/System/Library");
    assert.equal(status.systemFolder, true);
    assert.equal(status.safeToIndex, false);
  },
);

// B2 (night 2026-10-04): an empty repo's index finishes with 0 declarations and kept reading "Not indexed · Index?".
test("a repo whose completed index found nothing reads as indexed, not 'Index?' again", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(home, "empty-")));
  execFileSync("git", ["init", "-q", repo]);
  const dbFile = path.join(home, "empty-store.db");
  const db = new DatabaseSync(dbFile);
  db.exec(
    "CREATE TABLE ingest_jobs (id INTEGER PRIMARY KEY, status TEXT, job_type TEXT, local_path TEXT, files_done INT, files_total INT, updated_at TEXT, started_at TEXT);" +
      "CREATE TABLE repositories (id INTEGER PRIMARY KEY, name TEXT, full_path TEXT, is_archived INT);" +
      "CREATE TABLE repository_branches (id INTEGER PRIMARY KEY, repository_id INT, branch_name TEXT, last_commit_sha TEXT);" +
      "CREATE TABLE nodes (id INTEGER PRIMARY KEY, repository_branch_id INT, approval_status TEXT);" +
      "CREATE TABLE files (id INTEGER PRIMARY KEY, repository_branch_id INT, index_status TEXT);",
  );
  db.prepare(
    "INSERT INTO ingest_jobs (status, job_type, local_path) VALUES ('COMPLETE', 'FULL', ?)",
  ).run(repo);
  db.close();
  const prev = process.env.KORAGRAPH_DB;
  process.env.KORAGRAPH_DB = dbFile;
  try {
    // A second instance of the module (its store path is read at import time), pointed at this store.
    const url: string = "./graph.ts?empty-index";
    const { buildGraphStatus: fresh } = (await import(url)) as typeof import("./graph.ts");
    const st = fresh(repo);
    assert.equal(st.indexed, true, JSON.stringify(st));
    assert.equal(st.nodes, 0);
    assert.equal(st.stale, false);
    // The first real commit after that empty index: Stale (re-indexes on the next prompt), never "Fresh".
    fs.writeFileSync(path.join(repo, "a.js"), "export const a = 1;\n");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-qm",
      "first",
    ]);
    assert.equal(fresh(repo).stale, true);
  } finally {
    process.env.KORAGRAPH_DB = prev;
  }
});

// B6 stalls (night 2026-10-04): every chip poll ran up to three blocking `git` processes on the daemon's event loop.
test("HEAD is read from .git exactly as git reports it (loose, packed, detached, unborn); roots are cached per cwd", async () => {
  const { readHeadSha, resetRootCacheForTests } = await import("./graph.ts");
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(home, "head-")));
  execFileSync("git", ["init", "-q", repo]);
  assert.equal(readHeadSha(repo), null, "unborn");
  const g = (...a: string[]) =>
    execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...a], {
      encoding: "utf8",
    }).trim();
  fs.writeFileSync(path.join(repo, "a.js"), "1\n");
  g("add", ".");
  g("commit", "-qm", "one");
  assert.equal(readHeadSha(repo), g("rev-parse", "HEAD"), "loose ref");
  g("pack-refs", "--all");
  assert.equal(readHeadSha(repo), g("rev-parse", "HEAD"), "packed ref");
  g("checkout", "-q", "--detach");
  assert.equal(readHeadSha(repo), g("rev-parse", "HEAD"), "detached");

  resetRootCacheForTests();
  const plain = fs.realpathSync(fs.mkdtempSync(path.join(home, "plain-")));
  assert.equal(buildGraphStatus(plain).isGitRepo, false);
  execFileSync("git", ["init", "-q", plain]);
  assert.equal(
    buildGraphStatus(plain).isGitRepo,
    true,
    "a new .git is noticed at once, not after the cache expires",
  );
});

test(
  "a folder this user may not read says so, not 'not a git repo'",
  { skip: process.getuid?.() === 0 || process.platform === "win32" }, // no mode bits on Windows
  () => {
    const locked = fs.realpathSync(fs.mkdtempSync(path.join(home, "locked-")));
    execFileSync("git", ["init", "-q", locked]);
    fs.chmodSync(locked, 0o000);
    try {
      const st = buildGraphStatus(locked);
      assert.equal(st.folderUnreadable, true);
      assert.equal(st.safeToIndex, false);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  },
);

test("a repo bigger than the auto-index ceiling asks first: safeToIndex is false and largeRepo says why", () => {
  const repo = path.join(home, "code", "big");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  fs.writeFileSync(path.join(repo, "a.txt"), "x");
  execFileSync("git", ["-C", repo, "add", "."]);
  process.env.KORA_AUTO_INDEX_MAX_FILES = "0";
  try {
    const status = buildGraphStatus(repo);
    assert.equal(status.isGitRepo, true);
    assert.equal(status.safeToIndex, false);
    assert.equal(status.systemFolder, false);
    assert.equal(status.largeRepo?.limit, 0);
    process.env.KORA_AUTO_INDEX_MAX_FILES = "20000";
    assert.equal(buildGraphStatus(repo).safeToIndex, true);
  } finally {
    delete process.env.KORA_AUTO_INDEX_MAX_FILES;
  }
});

test(
  "Windows: system and program trees, AppData, the drive root and the temp dir are never offered; a project is",
  { skip: process.platform !== "win32" },
  async () => {
    const { isSafeToIndex } = await import("./graph.ts");
    const sys = process.env.SystemRoot || "C:\\Windows";
    const drive = path.parse(sys).root;
    for (const p of [
      drive,
      sys,
      path.join(sys, "System32"),
      path.join(drive, "Program Files", "Git"),
      path.join(home, "AppData", "Local"),
      os.tmpdir(),
    ])
      assert.equal(isSafeToIndex(p), false, p);
    assert.equal(isSafeToIndex(path.join(home, "code", "app")), true);
  },
);

test(
  "temp and volume roots are not offered for indexing; a repo below them is (pl3 S2-2)",
  { skip: process.platform === "win32" },
  async () => {
    const { isSafeToIndex } = await import("./graph.ts");
    for (const p of [
      "/private/tmp",
      "/tmp",
      "/private/var",
      "/var/folders/x1/abc123/T",
      "/Volumes/External",
      os.tmpdir(),
    ])
      assert.equal(isSafeToIndex(p), false, p);
    for (const p of ["/private/tmp/app", "/Volumes/External/app", path.join(os.tmpdir(), "proj")])
      assert.equal(isSafeToIndex(p), true, p);
  },
);
