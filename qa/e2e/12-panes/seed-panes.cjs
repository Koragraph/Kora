// Seeds three empty threads ("Pane A/B/C") into a QA stack's home without any privileged RPC.
//   KORA_QA_DIR=<dir> node qa/e2e/12-panes/seed-panes.cjs <N>      (stack N's daemon should be stopped while this runs)
const fs = require("fs"),
  path = require("path"),
  crypto = require("crypto"),
  cp = require("child_process");
const n = Number(process.argv[2] || process.env.KORA_QA_STACK || 3);
const base = path.join(process.env.KORA_QA_DIR || "/private/tmp/kora-qa", `stack${n}`);
const repo = path.join(base, "repos", "panes-lib");
fs.mkdirSync(repo, { recursive: true });
if (!fs.existsSync(path.join(repo, ".git"))) {
  fs.writeFileSync(path.join(repo, "a.js"), "x\n");
  cp.execSync("git init -q && git add -A && git -c user.email=a@b -c user.name=q commit -qm init", {
    cwd: repo,
  });
}
const dd = path.join(base, "home", "kora-daemon");
fs.mkdirSync(path.join(dd, "threads"), { recursive: true });
const pid = crypto.randomUUID(),
  now = Date.now(),
  iso = (t) => new Date(t).toISOString();
fs.writeFileSync(
  path.join(dd, "projects.json"),
  JSON.stringify([
    {
      id: pid,
      title: "panes-lib",
      workspaceRoot: repo,
      defaultModelSelection: null,
      scripts: [],
      createdAt: iso(now - 1e7),
      updatedAt: iso(now - 1e7),
    },
  ]),
);
const out = [];
for (const [i, title] of ["Pane A", "Pane B", "Pane C"].entries()) {
  const id = crypto.randomUUID();
  const t0 = now - (i + 1) * 6e4;
  fs.writeFileSync(
    path.join(dd, "threads", id + ".json"),
    JSON.stringify({
      threadId: id,
      koraThreadId: crypto.randomUUID(),
      projectId: pid,
      cwd: repo,
      title,
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      agentMode: "chat",
      branch: null,
      worktreePath: null,
      createdAt: iso(t0),
      updatedAt: iso(t0),
      messages: [],
      activities: [],
      session: null,
      latestTurn: null,
      latestUserMessageAt: null,
      koraSessionId: null,
      providerDriver: "claude",
    }),
  );
  out.push({ id, title });
}
fs.writeFileSync(
  path.join(base, "seed.json"),
  JSON.stringify(
    { stack: n, projects: [{ id: pid, title: "panes-lib", dir: repo }], threads: out },
    null,
    1,
  ),
);
console.log(out);
