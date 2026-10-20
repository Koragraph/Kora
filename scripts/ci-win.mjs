#!/usr/bin/env node
// Read-only helpers for the Windows CI job (.github/workflows/windows.yml). It never triggers, re-runs, cancels or
// pushes anything: every call is `gh run list|view` or a GET through `gh api`. Usage (docs/windows/DEV.md):
//
//   pnpm ci:win [status]            latest Windows run for the current branch: commit, state, every step
//   pnpm ci:win wait                poll until that run finishes (step changes as they happen), then `failures`
//   pnpm ci:win failures            per failed step: failing tests with file:line and the assertion, tsc errors, …
//   pnpm ci:win log --step <text>   the tail of one step's log (--tail N, --grep <regex>)
//
// Options: --run <id> (instead of the latest), --branch <name>, --step <text> (filter failures), --max <n> (failures
// shown per step, default 25), --interval <s> (wait, default 30), --timeout <min> (wait, default 150).
// Logs of finished jobs are cached under <tmp>/kora-ci-win/.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WORKFLOW = "windows.yml";
const CACHE = path.join(os.tmpdir(), "kora-ci-win");
const WIDTH = 220;

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith("-") ? argv.shift() : "status";
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

function gh(args) {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const msg = String(err.stderr || err.message)
      .trim()
      .split("\n")[0];
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${msg}`);
  }
}
const ghJson = (args) => JSON.parse(gh(args));
const git = (args) => {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
};
const clip = (s, n = WIDTH) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const ago = (iso) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 60
    ? `${m}m ago`
    : m < 2880
      ? `${Math.round(m / 60)}h ago`
      : `${Math.round(m / 1440)}d ago`;
};
const mark = (s) =>
  s.status !== "completed"
    ? s.status === "in_progress"
      ? "…"
      : "·"
    : ({ success: "✓", failure: "✗", skipped: "-", cancelled: "⊘" }[s.conclusion] ?? "?");

// ---- run selection ------------------------------------------------------------------------------------------------

function findRun() {
  const id = opt("run");
  if (id) return id;
  const branch = opt("branch", git(["branch", "--show-current"]));
  const runs = ghJson([
    "run",
    "list",
    "--workflow",
    WORKFLOW,
    "--branch",
    branch,
    "-L",
    "1",
    "--json",
    "databaseId",
  ]);
  if (!runs.length) {
    const any = ghJson([
      "run",
      "list",
      "--workflow",
      WORKFLOW,
      "-L",
      "1",
      "--json",
      "databaseId,headBranch",
    ]);
    const hint = any.length
      ? ` Latest run is on '${any[0].headBranch}' (pass --branch ${any[0].headBranch}).`
      : "";
    throw new Error(
      `No Windows runs for branch '${branch}'. The workflow runs on pushes to its trigger branches only.${hint}`,
    );
  }
  return String(runs[0].databaseId);
}

const viewRun = (id) =>
  ghJson([
    "run",
    "view",
    id,
    "--json",
    "databaseId,status,conclusion,headSha,headBranch,displayTitle,createdAt,updatedAt,url,event,jobs",
  ]);

function printStatus(run) {
  const head = git(["rev-parse", "HEAD"]);
  const sha = run.headSha.slice(0, 7);
  const state = run.status === "completed" ? run.conclusion : run.status;
  console.log(
    `Windows run ${run.databaseId}  ${state}  ${run.headBranch}@${sha}  ${run.event}, started ${ago(run.createdAt)}`,
  );
  console.log(`  ${clip(run.displayTitle, 120)}`);
  console.log(`  ${run.url}`);
  if (
    head &&
    !head.startsWith(run.headSha) &&
    run.headBranch === git(["branch", "--show-current"])
  ) {
    const behind = git(["rev-list", "--count", `${run.headSha}..HEAD`]);
    console.log(
      `  note: local HEAD ${head.slice(0, 7)} is not this run's commit${behind ? ` (${behind} commit(s) ahead of it)` : ""}`,
    );
  }
  for (const job of run.jobs) {
    console.log(
      `  job ${job.name} (${job.databaseId}): ${job.status === "completed" ? job.conclusion : job.status}`,
    );
    for (const s of userSteps(job)) {
      const secs =
        s.startedAt && s.completedAt
          ? Math.round((Date.parse(s.completedAt) - Date.parse(s.startedAt)) / 1000)
          : null;
      console.log(
        `    ${mark(s)} ${s.name}${secs !== null && s.status === "completed" && s.conclusion !== "skipped" ? `  ${secs}s` : ""}`,
      );
    }
  }
}

// The steps that print a `##[group]Run …` header, in order: everything but the runner's own set-up/tear-down.
const userSteps = (job) =>
  (job.steps ?? []).filter(
    (s) => s.name !== "Set up job" && s.name !== "Complete job" && !s.name.startsWith("Post "),
  );

// ---- logs -----------------------------------------------------------------------------------------------------------

function jobLog(job) {
  const file = path.join(CACHE, `${job.databaseId}.log`);
  if (job.status === "completed" && fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  const text = gh(["api", `repos/{owner}/{repo}/actions/jobs/${job.databaseId}/logs`]);
  if (job.status === "completed") {
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(file, text);
  }
  return text;
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const STAMP = /^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z ?/;

/** The job log cut into one array of clean lines per step that ran (keyed by step name). */
function stepLogs(job) {
  const ran = userSteps(job).filter(
    (s) => s.conclusion !== "skipped" && s.status !== "pending" && s.status !== "queued",
  );
  const out = new Map();
  let i = -1;
  for (const raw of jobLog(job).split(/\r?\n/)) {
    const line = raw.replace(STAMP, "").replace(ANSI, "");
    if (line.startsWith("##[group]Run ")) i++;
    if (i < 0 || i >= ran.length) continue;
    const name = ran[i].name;
    if (!out.has(name)) out.set(name, []);
    out.get(name).push(line);
  }
  return out;
}

// ---- failure extraction -----------------------------------------------------------------------------------------------

// `pnpm -r` prefixes every line with "<workspace dir> <script>: ".
const PNPM_PREFIX = /^((?:apps|packages|scripts|services)\/[\w.-]+) [\w:-]+: /;
const splitPrefix = (line) => {
  const m = PNPM_PREFIX.exec(line);
  return m ? [m[1], line.slice(m[0].length)] : ["", line];
};
const shortPath = (p) =>
  p
    .replace(/^file:\/\/\/?/, "")
    .replace(/^[A-Z]:[\\/]a[\\/][^\\/]+[\\/][^\\/]+[\\/]/i, "")
    .replace(/\\/g, "/");
// The runtime's tests run from tsc output: name the source file, keep the compiled line (tsc keeps lines close).
const sourceOf = (file, line) => {
  const m = /^(packages\/runtime)\/dist\/(.+)\.js$/.exec(file);
  return m ? `${m[1]}/src/${m[2]}.ts (dist line ${line})` : `${file}:${line}`;
};
const TEST_FRAME = /\(?((?:file:\/\/\/)?[^\s()]*?\.(?:test|spec)\.[cm]?[jt]sx?):(\d+):\d+\)?/;

/** node --test: the "✖ failing tests:" summary — `test at <file:line>`, `✖ <name> (<ms>)`, then the error. */
function nodeTestFailures(lines) {
  const found = [];
  const byPkg = new Map();
  for (const line of lines) {
    const [pkg, text] = splitPrefix(line);
    if (!byPkg.has(pkg)) byPkg.set(pkg, []);
    byPkg.get(pkg).push(text);
  }
  for (const [pkg, text] of byPkg) {
    const start = text.findIndex((l) => /^✖ failing tests:/.test(l.trim()));
    const body = start >= 0 ? text.slice(start + 1) : [];
    let cur = null;
    let loc = "";
    const flush = () => {
      if (cur && !/^\d+ subtests? failed$/.test(cur.message[0] ?? "")) found.push(cur);
      cur = null;
    };
    for (const l of body) {
      const t = l.trim();
      const at = /^test at (.+)$/.exec(t);
      if (at) {
        flush();
        loc = shortPath(at[1]).replace(/:\d+$/, "");
        continue;
      }
      const fail = /^✖ (.+?)(?: \([\d.]+m?s\))?$/.exec(t);
      if (fail) {
        flush();
        cur = { pkg, loc, name: fail[1], message: [], frame: "" };
        loc = "";
        continue;
      }
      if (!cur || !t) continue;
      const frame = TEST_FRAME.exec(t);
      if (t.startsWith("at ")) {
        if (frame && !cur.frame) cur.frame = sourceOf(shortPath(frame[1]), frame[2]);
        continue;
      }
      if (
        /^(generatedMessage|code|actual|expected|operator|diff|failureType|cause):|^[{}]$/.test(t)
      )
        continue;
      if (cur.message.length < 4) cur.message.push(t);
    }
    flush();
    // No summary (the run was cut off): every ✖ line still names a failure.
    if (start < 0) {
      for (const l of text) {
        const fail = /^\s*✖ (.+?)(?: \([\d.]+m?s\))?$/.exec(l);
        if (fail && fail[1] !== "failing tests:")
          found.push({ pkg, loc: "", name: fail[1], message: [], frame: "" });
      }
    }
  }
  return found;
}

/** vitest: `FAIL  <file> > <suite> > <name>`, then the error and a `❯ <file>:<line>:<col>` frame. */
function vitestFailures(lines) {
  const found = [];
  const seen = new Set();
  let cur = null;
  for (const line of lines) {
    const [pkg, text] = splitPrefix(line);
    const t = text.trim();
    const fail = /^FAIL\s+(\S+)\s+>\s+(.+)$/.exec(t);
    if (fail) {
      const key = `${pkg} ${fail[1]} ${fail[2]}`;
      cur = seen.has(key) ? null : { pkg, loc: fail[1], name: fail[2], message: [], frame: "" };
      if (cur) {
        seen.add(key);
        found.push(cur);
      }
      continue;
    }
    if (!cur) continue;
    if (/^⎯{3,}/.test(t)) {
      cur = null;
      continue;
    }
    const frame = /❯\s+(\S+?):(\d+):\d+/.exec(t);
    if (frame) {
      if (!cur.frame && /\.(test|spec)\./.test(frame[1])) cur.frame = `${frame[1]}:${frame[2]}`;
      continue;
    }
    if (
      t &&
      cur.message.length < 3 &&
      /Error|expected|Expected|assert|!==|to (be|equal|match|have)/.test(t)
    )
      cur.message.push(t);
  }
  return found;
}

/** tsc / tsgo diagnostics and any `##[error]` lines besides the step's exit code. */
function otherErrors(lines) {
  const out = [];
  for (const line of lines) {
    const [pkg, t] = splitPrefix(line);
    if (/error TS\d+:/.test(t)) out.push(`${pkg ? `${pkg}: ` : ""}${t.trim()}`);
    else if (t.startsWith("##[error]") && !/^##\[error\]Process completed with exit code/.test(t))
      out.push(t.slice(9));
  }
  return [...new Set(out)];
}

function printStepFailures(name, lines, max) {
  const tests = [...nodeTestFailures(lines), ...vitestFailures(lines)];
  const errors = otherErrors(lines);
  console.log(
    `\n✗ ${name}${tests.length ? `: ${tests.length} failing test(s)` : ""}${errors.length ? `, ${errors.length} error line(s)` : ""}`,
  );
  for (const f of tests.slice(0, max)) {
    const where = f.frame || f.loc;
    console.log(
      `  • ${clip(`${f.pkg ? `[${f.pkg.replace(/^(apps|packages)\//, "")}] ` : ""}${where ? `${where}  ` : ""}${f.name}`)}`,
    );
    if (f.message.length) console.log(`      ${clip(f.message.join(" ⏎ "))}`);
  }
  if (tests.length > max) console.log(`  … ${tests.length - max} more (--max ${tests.length})`);
  for (const e of errors.slice(0, max)) console.log(`  ! ${clip(e)}`);
  if (errors.length > max) console.log(`  … ${errors.length - max} more error lines`);
  if (!tests.length && !errors.length) {
    // Nothing recognisable: the last lines before the exit code usually say why.
    const end = lines.findLastIndex((l) => l.startsWith("##[error]Process completed"));
    const tail = lines
      .slice(Math.max(0, (end < 0 ? lines.length : end) - 12), end < 0 ? lines.length : end)
      .filter((l) => l.trim());
    for (const l of tail) console.log(`  | ${clip(l)}`);
  }
}

function failures(run) {
  const filter = opt("step")?.toLowerCase();
  const max = Number(opt("max", "25"));
  let any = false;
  for (const job of run.jobs) {
    if (job.status !== "completed") {
      console.log(
        `job ${job.name} is still ${job.status}; its log is complete only when it finishes (pnpm ci:win wait).`,
      );
    }
    const failed = userSteps(job).filter(
      (s) => s.conclusion === "failure" && (!filter || s.name.toLowerCase().includes(filter)),
    );
    if (!failed.length) continue;
    any = true;
    const logs = stepLogs(job);
    for (const s of failed) printStepFailures(s.name, logs.get(s.name) ?? [], max);
  }
  if (!any)
    console.log(
      run.conclusion === "cancelled"
        ? "Run was cancelled (a newer push replaced it); no failed steps."
        : "No failed steps.",
    );
}

function log(run) {
  const filter = opt("step")?.toLowerCase();
  if (!filter) throw new Error("log needs --step <part of a step name>");
  const tail = Number(opt("tail", "60"));
  const grep = opt("grep") ? new RegExp(opt("grep"), "i") : null;
  for (const job of run.jobs) {
    for (const [name, lines] of stepLogs(job)) {
      if (!name.toLowerCase().includes(filter)) continue;
      const picked = (grep ? lines.filter((l) => grep.test(l)) : lines).slice(-tail);
      console.log(`== ${name} (${picked.length} of ${lines.length} lines)`);
      for (const l of picked) console.log(clip(l, 300));
    }
  }
}

async function wait(id) {
  const interval = Number(opt("interval", "30")) * 1000;
  const deadline = Date.now() + Number(opt("timeout", "150")) * 60000;
  const seen = new Map();
  for (;;) {
    const run = viewRun(id);
    for (const job of run.jobs)
      for (const s of userSteps(job)) {
        const state = `${s.status}/${s.conclusion}`;
        if (seen.get(s.name) !== state && s.status !== "queued" && s.status !== "pending") {
          if (
            seen.size ||
            s.status !== "completed" ||
            s.conclusion !== "success" ||
            run.status === "completed"
          )
            console.log(`${new Date().toISOString().slice(11, 19)}  ${mark(s)} ${s.name}`);
        }
        seen.set(s.name, state);
      }
    if (run.status === "completed") {
      console.log("");
      printStatus(run);
      if (run.conclusion === "failure") failures(run);
      return run.conclusion === "success" ? 0 : 1;
    }
    if (Date.now() > deadline) {
      console.log(`Still ${run.status} after --timeout; stopped waiting (the run continues).`);
      return 2;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

try {
  const id = findRun();
  if (command === "status") printStatus(viewRun(id));
  else if (command === "failures") failures(viewRun(id));
  else if (command === "log") log(viewRun(id));
  else if (command === "wait") process.exitCode = await wait(id);
  else throw new Error(`unknown command '${command}' (status | wait | failures | log)`);
} catch (err) {
  console.error(`ci-win: ${err.message}`);
  process.exitCode = 1;
}
