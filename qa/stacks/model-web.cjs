#!/usr/bin/env node
"use strict";
// Web UI for the model tests: the swarm-e2e daemon (:8798, the user's real Claude login, isolated KORA_HOME) gets
// one UI project (a scratch repo) and a Vite dev server on :5798. Usage: node qa/stacks/model-web.cjs <up|down>
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");
const { ROOT, NODE_BIN } = require("./env.cjs");
const E2E = path.join(ROOT, "packages/runtime/scripts/swarm-e2e");
const { HOME, BASE, childEnv } = require(path.join(E2E, "env.cjs"));
const PORT = 5798;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const up = (url) =>
  new Promise((res) => {
    const q = http.get(url, (r) => {
      r.resume();
      res(r.statusCode < 500);
    });
    q.on("error", () => res(false));
  });
const daemon = (cmd) =>
  execFileSync("bash", [path.join(E2E, "daemon.sh"), cmd], { encoding: "utf8" });

async function main(cmd) {
  const pidFile = path.join(BASE, "qa-web.pid");
  if (cmd === "down") {
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        /* gone */
      }
      fs.rmSync(pidFile);
    }
    console.log("model web down");
    return;
  }
  const projects = path.join(HOME, "kora-daemon", "projects.json");
  if (!fs.existsSync(projects) || JSON.parse(fs.readFileSync(projects, "utf8")).length === 0) {
    const dir = path.join(BASE, "repos", "model-lib");
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src/index.js"), "export const x = 1;\n");
    const g = (...a) =>
      execFileSync("git", ["-c", "user.email=qa@kora.local", "-c", "user.name=Kora QA", ...a], {
        cwd: dir,
        stdio: "ignore",
      });
    if (!fs.existsSync(path.join(dir, ".git"))) {
      g("init", "-q", "-b", "main");
      g("add", ".");
      g("commit", "-qm", "init");
    }
    console.log(daemon("stop"));
    const now = new Date().toISOString();
    fs.mkdirSync(path.dirname(projects), { recursive: true });
    fs.writeFileSync(
      projects,
      JSON.stringify([
        {
          id: crypto.randomUUID(),
          title: "model-lib",
          workspaceRoot: dir,
          defaultModelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      ]),
    );
    console.log(daemon("start"));
    for (let i = 0; i < 60 && !(await up("http://127.0.0.1:8798/")); i++) await sleep(500);
  }
  if (await up(`http://localhost:${PORT}`)) {
    console.log("model web already up");
    return;
  }
  const out = fs.openSync(path.join(BASE, "qa-web.out"), "a");
  const env = { ...childEnv(), KORA_SINGLE_ORIGIN_DEV: "1", KORA_PORT: "8798" };
  const p = spawn(
    fs.existsSync(path.join(NODE_BIN, "pnpm")) ? path.join(NODE_BIN, "pnpm") : "pnpm",
    ["vp", "dev", "--port", String(PORT), "--strictPort"],
    { cwd: path.join(ROOT, "apps/web"), env, detached: true, stdio: ["ignore", out, out] },
  );
  p.unref();
  fs.writeFileSync(pidFile, String(p.pid));
  for (let i = 0; i < 240 && !(await up(`http://localhost:${PORT}`)); i++) await sleep(500);
  console.log(`model web up at http://localhost:${PORT}`);
}
main(process.argv[2] || "up").catch((e) => {
  console.error(e.message);
  process.exit(1);
});
