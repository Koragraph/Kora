#!/usr/bin/env node
// `pnpm qa` — the Kora UI regression suite. Brings up the 4 isolated QA stacks (seeding any that are missing), runs
// every spec under qa/e2e/<area>/ (not the real-model specs in qa/e2e/model), at most 4 at a time (the harness caps
// Chromium at 4), and prints a per-area summary. Options:
//   --round <name>   results under qa/runs/<name> (default: qa-<timestamp>)
//   --areas 02,06    only these area prefixes
//   --keep           leave the stacks running afterwards (default: stop daemons + web servers)
//   --fresh          reset + reseed every stack first
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const QA = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(QA, "..");
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i === -1 ? d : args[i + 1];
};
const round = opt("--round", `qa-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
const only = opt("--areas", "").split(",").filter(Boolean);
const keep = args.includes("--keep");
const fresh = args.includes("--fresh");
const NODE = process.execPath;
const stackCli = (cmd, which) =>
  execFileSync(NODE, [path.join(QA, "stacks/stack.cjs"), cmd, which], {
    stdio: "inherit",
    cwd: ROOT,
  });
const require = (await import("node:module")).createRequire(import.meta.url);
const { stack } = require("./stacks/env.cjs");

const areas = fs
  .readdirSync(path.join(QA, "e2e"))
  .filter((d) => /^\d\d-/.test(d) && d !== "00-smoke")
  .filter((d) => only.length === 0 || only.some((p) => d.startsWith(p)))
  .sort();
// Five areas per stack; the areas past 19 run on the stack their specs pin (20-blobs: 2, 21-graph-report: 4, 99-visual: 1).
const PINNED = { 20: 2, 21: 4, 99: 1 };
const stackOfArea = (a) =>
  PINNED[Number(a.slice(0, 2))] ?? Math.min(4, Math.ceil(Number(a.slice(0, 2)) / 5));
const stacks = [...new Set(areas.map(stackOfArea))].sort();

if (fresh) for (const n of stacks) stackCli("reset", String(n));
for (const n of stacks) {
  if (!fs.existsSync(path.join(stack(n).base, "seed.json"))) stackCli("seed", String(n));
}
stackCli("up", stacks.join(","));

const jobs = [];
for (const a of areas)
  for (const f of fs
    .readdirSync(path.join(QA, "e2e", a))
    .filter((x) => x.endsWith(".spec.mjs"))
    .sort())
    jobs.push({ area: a, file: path.join(QA, "e2e", a, f) });
console.log(`\nqa: ${jobs.length} spec files across ${areas.length} areas, round ${round}\n`);

const results = [];
const PAR = Number(process.env.KORA_QA_PARALLEL || 4);
// One spec at a time per stack: specs on a stack share its daemon settings (16-settings-swarm's default-model and
// setup-wizard specs flipped each other's state when two ran at once), so parallelism is across stacks only.
const busyStacks = new Set();
function takeJob() {
  const i = jobs.findIndex((j) => !busyStacks.has(stackOfArea(j.area)));
  return i === -1 ? null : jobs.splice(i, 1)[0];
}
async function worker() {
  while (jobs.length > 0) {
    const j = takeJob();
    if (!j) {
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }
    busyStacks.add(stackOfArea(j.area));
    const t0 = Date.now();
    const code = await new Promise((resolve) => {
      const p = spawn(NODE, [j.file], {
        cwd: ROOT,
        env: { ...process.env, KORA_QA_ROUND: round },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      p.stdout.on("data", (d) => {
        out += d;
      });
      p.stderr.on("data", (d) => {
        out += d;
      });
      p.on("close", (c) => {
        j.out = out;
        resolve(c);
      });
    });
    const line =
      j.out
        .trim()
        .split("\n")
        .filter((l) => l.startsWith(j.area))
        .pop() || j.out.trim().split("\n").pop();
    results.push({ ...j, code, secs: Math.round((Date.now() - t0) / 1000), line });
    busyStacks.delete(stackOfArea(j.area));
    console.log(
      `${code === 0 ? "PASS" : "FAIL"}  ${path.relative(QA, j.file)}  (${Math.round((Date.now() - t0) / 1000)} s)  ${code === 0 ? "" : line}`,
    );
  }
}
await Promise.all(Array.from({ length: PAR }, worker));

// Summary from each area's results.json files (the harness writes one per spec file run; the last one wins per area),
// so count tests from the printed "<area> [round] x/y passed" lines instead.
const byArea = {};
for (const r of results) {
  const m = /(\d+)\/(\d+) passed/.exec(r.line || "");
  const a = (byArea[r.area] ||= { pass: 0, total: 0, files: 0, failedFiles: 0 });
  a.files++;
  if (r.code !== 0) a.failedFiles++;
  if (m) {
    a.pass += Number(m[1]);
    a.total += Number(m[2]);
  }
}
console.log("\n── summary ─────────────────────────────────────");
let P = 0,
  T = 0;
for (const [a, s] of Object.entries(byArea).sort()) {
  P += s.pass;
  T += s.total;
  console.log(
    `${a.padEnd(28)} ${String(s.pass).padStart(4)}/${String(s.total).padEnd(4)} tests   ${s.failedFiles ? `${s.failedFiles} file(s) failing` : "ok"}`,
  );
}
console.log(
  `${"TOTAL".padEnd(28)} ${String(P).padStart(4)}/${T} tests passed; findings in qa/findings/, screenshots in qa/runs/${round}/`,
);
fs.mkdirSync(path.join(QA, "runs", round), { recursive: true });
fs.writeFileSync(
  path.join(QA, "runs", round, "summary.json"),
  JSON.stringify({ round, byArea, results: results.map(({ out, ...r }) => r) }, null, 2),
);
if (!keep) stackCli("down", stacks.join(","));
process.exitCode = P === T && results.every((r) => r.code === 0) ? 0 : 1;
