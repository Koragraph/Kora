// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- a plain node:test harness driving a real loopback listener.
// GET /api/graph/report: JSON, Markdown, and the 400 / 404 / 503 answers, behind the same auth as every /api route.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as net from "node:net";
import os from "node:os";
import path from "node:path";

import { buildRepoReport } from "./repoReport.ts";
import { setGraphReaderForTests, type GraphReader } from "./graphReader.ts";
import { serveUi, type UiServerHandle } from "./server.ts";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

const report = buildRepoReport({
  repo: "demo",
  branch: "main",
  indexedSha: "abcdef1234567890",
  stale: false,
  behindCommits: null,
  generatedAt: "2026-10-15T00:00:00.000Z",
  files: ["src/a.ts", "src/b.ts"],
  nodes: [
    { id: 1, kind: "FILE", name: "src/a.ts", file: "src/a.ts", line: null, endLine: null },
    { id: 2, kind: "FILE", name: "src/b.ts", file: "src/b.ts", line: null, endLine: null },
    { id: 3, kind: "METHOD", name: "doThing_a", file: "src/a.ts", line: 3, endLine: 8 },
    { id: 4, kind: "METHOD", name: "doThing_b", file: "src/b.ts", line: 3, endLine: 8 },
  ],
  pairs: [{ from: 3, to: 4, resolved: 1, heuristic: 0, calls: 1, imports: 0 }],
  docs: [],
  noteRows: [],
  manifests: [],
  history: null,
  repoOnDisk: false,
});

let mode: "ok" | "none" | "busy" | "throw" = "ok";
const asked: string[] = [];
const stub = {
  status: async () => ({ indexed: false }),
  snapshot: async () => ({ kind: "none" }),
  target: async () => null,
  report: async (cwd: string) => {
    asked.push(cwd);
    if (mode === "throw") throw new Error("boom");
    return mode === "ok" ? { kind: "ok", report } : { kind: mode };
  },
  stats: () => ({ spawns: 0, kills: 0, timeouts: 0, inProcess: false }),
  stop: () => {},
} as unknown as GraphReader;

let ui: UiServerHandle;
let port: number;
let home: string;
let token: string;
const base = () => `http://127.0.0.1:${port}`;
const auth = () => ({ authorization: `Bearer ${token}` });

test.before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "kora-report-http-"));
  port = await freePort();
  ui = await serveUi({ host: "127.0.0.1", port, koraHome: home });
  token = fs.readFileSync(path.join(home, "ui-token"), "utf8").trim();
  setGraphReaderForTests(stub);
});

test.after(async () => {
  setGraphReaderForTests(null);
  await ui?.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test("200 JSON: the report, with the cwd handed to the reader untouched", async () => {
  mode = "ok";
  const res = await fetch(`${base()}/api/graph/report?cwd=${encodeURIComponent("/work/demo")}`, {
    headers: auth(),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  const body = (await res.json()) as typeof report;
  assert.equal(body.version, 1);
  assert.equal(body.repo, "demo");
  assert.equal(body.areas.length, report.areas.length);
  assert.deepEqual(body, JSON.parse(JSON.stringify(report)));
  assert.equal(asked.at(-1), "/work/demo");
});

test("200 Markdown with ?format=md: text/markdown, the rendered code map", async () => {
  mode = "ok";
  const res = await fetch(
    `${base()}/api/graph/report?cwd=${encodeURIComponent("/work/demo")}&format=md`,
    { headers: auth() },
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/markdown; charset=utf-8");
  const text = await res.text();
  assert.match(text, /^# demo: code map\n/);
  assert.match(text, /## Areas/);
});

test("404 when the repo has no whole index, as JSON even for format=md", async () => {
  mode = "none";
  for (const q of ["", "&format=md"]) {
    const res = await fetch(
      `${base()}/api/graph/report?cwd=${encodeURIComponent("/work/none")}${q}`,
      { headers: auth() },
    );
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
    assert.equal(((await res.json()) as { reason: string }).reason, "no indexed graph");
  }
});

test("503 {busy:true} when the reader is busy or timed out: never a verdict about the repo", async () => {
  mode = "busy";
  for (const q of ["", "&format=md"]) {
    const res = await fetch(
      `${base()}/api/graph/report?cwd=${encodeURIComponent("/work/demo")}${q}`,
      { headers: auth() },
    );
    assert.equal(res.status, 503);
    const body = (await res.json()) as { reason: string; busy: boolean };
    assert.equal(body.busy, true);
    assert.equal(body.reason, "graph busy, try again");
  }
});

test("a reader that throws answers like no graph, a missing cwd is a 400, and the route needs the daemon secret", async () => {
  mode = "throw";
  assert.equal(
    (await fetch(`${base()}/api/graph/report?cwd=%2Fx`, { headers: auth() })).status,
    404,
  );
  mode = "ok";
  assert.equal((await fetch(`${base()}/api/graph/report`, { headers: auth() })).status, 400);
  const bare = await fetch(`${base()}/api/graph/report?cwd=%2Fx`);
  assert.ok(bare.status === 401 || bare.status === 403, `without the token: ${bare.status}`);
  const evil = await fetch(`${base()}/api/graph/report?cwd=%2Fx`, {
    headers: { ...auth(), origin: "https://evil.example" },
  });
  assert.equal(evil.status, 403);
});
