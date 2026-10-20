// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- a plain node:test harness on throwaway trees.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { RPC_METHODS } from "@kora/contracts";
import * as Effect from "effect/Effect";

import { grepInWorker } from "./grepWorker.ts";
import { workspaceHandlers } from "./workspace.ts";

function tree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kora-grep-"));
  fs.writeFileSync(path.join(root, "a.txt"), "Hello world\nhello there\nnothing\n");
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "sub", "b.ts"), "const hello = 1; // hello\n");
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.writeFileSync(path.join(root, "node_modules", "skip.txt"), "hello\n");
  fs.writeFileSync(path.join(root, "bin.dat"), Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00]));
  return root;
}

const base = { limit: 50, caseSensitive: false, wholeWord: false, useRegex: false };

test("grep worker: same results as the old in-process search (case, ranges, skips)", async () => {
  const root = tree();
  try {
    const r = await grepInWorker({ ...base, cwd: root, query: "hello" });
    const got = r.matches
      .map((m) => `${m.path}:${m.lineNumber}:${JSON.stringify(m.matchRanges)}`)
      .sort();
    assert.deepEqual(got, [
      'a.txt:1:[{"start":0,"end":5}]',
      'a.txt:2:[{"start":0,"end":5}]',
      'sub/b.ts:1:[{"start":6,"end":11},{"start":20,"end":25}]',
    ]);
    assert.equal(r.truncated, false);
    assert.equal(r.timedOut, false);

    const cs = await grepInWorker({ ...base, cwd: root, query: "Hello", caseSensitive: true });
    assert.equal(cs.matches.length, 1);

    const lim = await grepInWorker({ ...base, cwd: root, query: "hello", limit: 2 });
    assert.equal(lim.matches.length, 2);
    assert.equal(lim.truncated, true);

    const bad = await grepInWorker({ ...base, cwd: root, query: "hel(lo", useRegex: true });
    assert.ok(bad.regexFallbackError, "invalid regex reports the fallback");
    assert.equal(bad.matches.length, 0);

    const ww = await grepInWorker({ ...base, cwd: root, query: "hell", wholeWord: true });
    assert.equal(ww.matches.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("grep worker: a ReDoS pattern is cut off by the wall-clock budget and the event loop stays live", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kora-grep-"));
  try {
    fs.writeFileSync(path.join(root, "evil.txt"), `${"a".repeat(40)}!\n`);
    let maxGap = 0;
    let last = Date.now();
    const tick = setInterval(() => {
      const now = Date.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 20);
    const t0 = Date.now();
    const r = await grepInWorker(
      { ...base, cwd: root, query: "(a+)+$", useRegex: true },
      { timeoutMs: 600 },
    );
    const took = Date.now() - t0;
    clearInterval(tick);
    assert.equal(r.timedOut, true);
    assert.equal(r.truncated, true);
    assert.ok(took < 3000, `returned at the budget, took ${took} ms`);
    assert.ok(maxGap < 300, `main loop never stalled (max gap ${maxGap} ms)`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("grep worker: abort terminates the search", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kora-grep-"));
  try {
    fs.writeFileSync(path.join(root, "evil.txt"), `${"a".repeat(40)}!\n`);
    const ac = new AbortController();
    const p = grepInWorker(
      { ...base, cwd: root, query: "(a+)+$", useRegex: true },
      { signal: ac.signal },
    );
    setTimeout(() => ac.abort(new Error("user typed again")), 100);
    const t0 = Date.now();
    await assert.rejects(p, /user typed again/);
    assert.ok(Date.now() - t0 < 2000);
    // Slots are released: a normal search still runs afterwards.
    fs.writeFileSync(path.join(root, "ok.txt"), "needle\n");
    const r = await grepInWorker({ ...base, cwd: root, query: "needle" });
    assert.equal(r.matches.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("grep worker: a FIFO in the tree is skipped, not read (no wedged thread)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kora-grep-"));
  try {
    execFileSync("mkfifo", [path.join(root, "pipe")]);
    fs.writeFileSync(path.join(root, "x.txt"), "needle\n");
    const r = await grepInWorker({ ...base, cwd: root, query: "needle" }, { timeoutMs: 3000 });
    assert.equal(r.timedOut, false);
    assert.deepEqual(
      r.matches.map((m) => m.path),
      ["x.txt"],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace.grep handler returns the wire shape from the worker", async () => {
  const root = tree();
  try {
    const handler = workspaceHandlers[RPC_METHODS.filesGrep]!;
    const out = (await Effect.runPromise(
      handler({ ...base, cwd: root, query: "there" }) as Effect.Effect<unknown>,
    )) as { matches: Array<{ path: string }>; truncated: boolean; timedOut?: boolean };
    assert.deepEqual(
      out.matches.map((m) => m.path),
      ["a.txt"],
    );
    assert.equal(out.truncated, false);
    assert.equal("timedOut" in out, false, "no extra wire field");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace.find handler: the picker walk runs in a worker with the old filters", async () => {
  const root = tree();
  try {
    fs.writeFileSync(path.join(root, "pic.png"), "x");
    fs.writeFileSync(path.join(root, ".env"), "x");
    const handler = workspaceHandlers[RPC_METHODS.filesFind]!;
    const run = (input: Record<string, unknown>) =>
      Effect.runPromise(
        handler({ cwd: root, limit: 50, ...input }) as Effect.Effect<unknown>,
      ) as Promise<{
        entries: Array<{ path: string; kind: string; ignored?: boolean }>;
        truncated: boolean;
      }>;
    const all = await run({ query: "" });
    assert.deepEqual(
      all.entries.map((e) => `${e.kind}:${e.path}${e.ignored ? "!" : ""}`).sort(),
      [".env!", "a.txt", "bin.dat", "pic.png", "sub", "sub/b.ts"]
        .map((p) => (p === "sub" ? "directory:sub" : `file:${p}`))
        .sort(),
    );
    assert.deepEqual(
      (await run({ query: "B.T" })).entries.map((e) => e.path),
      ["sub/b.ts"],
    );
    assert.deepEqual(
      (await run({ query: "", kind: "directory" })).entries.map((e) => e.path),
      ["sub"],
    );
    assert.deepEqual(
      (await run({ query: "", imageOnly: true })).entries.map((e) => e.path),
      ["pic.png"],
    );
    const capped = await run({ query: "", limit: 2 });
    assert.equal(capped.entries.length, 2);
    assert.equal(capped.truncated, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
