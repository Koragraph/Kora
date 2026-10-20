// @effect-diagnostics nodeBuiltinImport:off -- a plain node:test file with a throwaway sqlite DB on disk.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { opencodeDbPath, SwarmTokenReader } from "./swarm-tokens.ts";

function fakeOpencodeDb(): { dir: string; db: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kora-swarm-tokens-"));
  const file = path.join(dir, "opencode.db");
  const db = new DatabaseSync(file);
  // The columns OpenCode 1.18 keeps per session (only the ones the reader touches).
  db.exec(`create table session (id text primary key, parent_id text, directory text not null,
    tokens_input integer default 0 not null, tokens_output integer default 0 not null,
    tokens_reasoning integer default 0 not null, tokens_cache_read integer default 0 not null)`);
  const ins = db.prepare("insert into session values (?, ?, ?, ?, ?, ?, ?)");
  ins.run("s1", null, "/wt/a", 1000, 200, 50, 5000);
  ins.run("s2", null, "/wt/a", 10, 1, 0, 0); // a failover attempt in the same worktree
  ins.run("s3", "s1", "/wt/a", 999, 999, 0, 999); // a child (subagent) session: not counted twice
  ins.run("s4", null, "/wt/b", 7, 3, 0, 0);
  db.close();
  return { dir, db: file };
}

test("sums a worktree's root OpenCode sessions (input w/o cache, cache reads, output + reasoning)", () => {
  const { dir, db } = fakeOpencodeDb();
  try {
    const reader = new SwarmTokenReader(db);
    assert.deepEqual(reader.forWorktree("/wt/a"), { input: 1010, cached: 5000, output: 251 });
    assert.deepEqual(reader.forWorktree("/wt/b"), { input: 7, cached: 0, output: 3 });
    assert.equal(reader.forWorktree("/wt/none"), null, "no session → not measured");
    reader.dispose();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("memoizes per worktree for a few seconds, then re-reads", () => {
  const { dir, db } = fakeOpencodeDb();
  try {
    let now = 1_000_000;
    const reader = new SwarmTokenReader(db, () => now);
    assert.equal(reader.forWorktree("/wt/b")!.input, 7);
    const w = new DatabaseSync(db);
    w.prepare("update session set tokens_input = 70 where id = 's4'").run();
    w.close();
    assert.equal(reader.forWorktree("/wt/b")!.input, 7, "cached");
    now += 11_000;
    assert.equal(reader.forWorktree("/wt/b")!.input, 70, "re-read after the TTL");
    reader.dispose();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing or foreign DB reads as not measured, never throws", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kora-swarm-tokens-"));
  try {
    assert.equal(new SwarmTokenReader(path.join(dir, "absent.db")).forWorktree("/wt/a"), null);
    const odd = path.join(dir, "odd.db");
    const db = new DatabaseSync(odd);
    db.exec("create table session (id text)");
    db.close();
    const r = new SwarmTokenReader(odd);
    assert.equal(r.forWorktree("/wt/a"), null);
    r.dispose();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the DB path follows XDG_DATA_HOME like OpenCode does", () => {
  assert.equal(opencodeDbPath({ XDG_DATA_HOME: "/x" }), path.join("/x", "opencode", "opencode.db"));
  assert.match(opencodeDbPath({}), /\.local[/\\]share[/\\]opencode[/\\]opencode\.db$/);
});
