"use strict";
// Seed one QA stack: 3 scratch repos, 3 projects, shared fixture threads (Chat / Team·Swarm / Team·Orchestrator,
// archived, a 520-message thread, a rich markdown/tool thread) and 5 namespaced threads per area on the stack.
//
// Projects and thread projections are the ui-server's read model (KORA_HOME/kora-daemon/{projects.json,threads/*.json}).
// The web "Add project" uses the native folder picker, so we create the daemon-side thread over the socket
// (chat.thread.create → a real koraThreadId), stop the daemon, write the projection, and start it again.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { RT } = require("./env.cjs");

const MODEL = { instanceId: "claude", model: "claude-sonnet-5" };
const uuid = () => crypto.randomUUID();

function seedAreas(n) {
  const spec = process.env.KORA_QA_SEED_AREAS;
  if (!spec) return Array.from({ length: 5 }, (_, i) => (n - 1) * 5 + 1 + i);
  const areas = new Set();
  for (const part of spec.split(",").filter(Boolean)) {
    const [lo, hi = lo] = part.split("-").map(Number);
    for (let a = lo; a <= hi; a++) areas.add(a);
  }
  return [...areas].sort((x, y) => x - y);
}

function git(dir, ...args) {
  return execFileSync(
    "git",
    [
      "-c",
      "user.email=qa@kora.local",
      "-c",
      "user.name=Kora QA",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function makeRepos(s) {
  fs.rmSync(s.repos, { recursive: true, force: true });
  fs.mkdirSync(s.repos, { recursive: true });
  // 1) a tiny Node lib with tests, pushed to a local bare remote (git action flows)
  const lib = path.join(s.repos, "tiny-lib");
  write(
    path.join(lib, "package.json"),
    JSON.stringify(
      { name: "tiny-lib", version: "0.1.0", type: "module", scripts: { test: "node --test" } },
      null,
      2,
    ) + "\n",
  );
  write(
    path.join(lib, "src/strings.js"),
    "export function slugify(s) {\n  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');\n}\n\nexport function titleCase(s) {\n  return String(s).split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');\n}\n",
  );
  write(
    path.join(lib, "src/numbers.js"),
    "export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));\nexport const sum = (a) => a.reduce((x, y) => x + y, 0);\n",
  );
  write(
    path.join(lib, "src/index.js"),
    "export * from './strings.js';\nexport * from './numbers.js';\n",
  );
  write(
    path.join(lib, "test/strings.test.js"),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slugify, titleCase } from '../src/strings.js';\ntest('slugify', () => assert.equal(slugify(' Hello World! '), 'hello-world'));\ntest('titleCase', () => assert.equal(titleCase('hello wORLD'), 'Hello World'));\n",
  );
  write(
    path.join(lib, "test/numbers.test.js"),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { clamp, sum } from '../src/numbers.js';\ntest('clamp', () => assert.equal(clamp(5, 0, 3), 3));\ntest('sum', () => assert.equal(sum([1, 2, 3]), 6));\n",
  );
  write(path.join(lib, "README.md"), "# tiny-lib\n\nString and number helpers. `node --test`.\n");
  write(path.join(lib, ".gitignore"), "node_modules\n");
  git(lib, "init", "-q", "-b", "main");
  git(lib, "add", ".");
  git(lib, "commit", "-qm", "initial tiny-lib");
  write(
    path.join(lib, "src/numbers.js"),
    "export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));\nexport const sum = (a) => a.reduce((x, y) => x + y, 0);\nexport const mean = (a) => (a.length ? sum(a) / a.length : NaN);\n",
  );
  git(lib, "commit", "-qam", "add mean");
  const remote = path.join(s.repos, "tiny-lib-remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  git(lib, "remote", "add", "origin", remote);
  git(lib, "push", "-q", "-u", "origin", "main");

  // 2) a repo with a dirty tree and a feature branch
  const dirty = path.join(s.repos, "dirty-app");
  write(
    path.join(dirty, "package.json"),
    JSON.stringify({ name: "dirty-app", version: "1.0.0" }, null, 2) + "\n",
  );
  write(path.join(dirty, "src/app.js"), "export function main() {\n  console.log('hello');\n}\n");
  write(
    path.join(dirty, "src/config.js"),
    'export const PORT = 3000;\nexport const HOST = "localhost";\n',
  );
  write(path.join(dirty, "docs/notes.md"), "# Notes\n\nFirst line.\n");
  git(dirty, "init", "-q", "-b", "main");
  git(dirty, "add", ".");
  git(dirty, "commit", "-qm", "initial dirty-app");
  git(dirty, "checkout", "-q", "-b", "feature/login");
  write(path.join(dirty, "src/login.js"), "export const login = (u) => Boolean(u);\n");
  git(dirty, "add", ".");
  git(dirty, "commit", "-qm", "login stub");
  git(dirty, "checkout", "-q", "main");
  write(
    path.join(dirty, "src/app.js"),
    "export function main() {\n  console.log('hello, world');\n  return 0;\n}\n",
  ); // modified
  write(path.join(dirty, "src/config.js"), "export const PORT = 4000;\n"); // modified (deletion + change)
  write(path.join(dirty, "src/untracked.js"), "export const draft = true;\n"); // untracked
  write(
    path.join(dirty, "docs/notes.md"),
    "# Notes\n\nFirst line.\n\n  trailing whitespace line   \n",
  ); // whitespace-only-ish change
  fs.rmSync(path.join(dirty, "package.json")); // deleted

  // 3) a repo with 200+ files
  const big = path.join(s.repos, "big-repo");
  for (let d = 0; d < 12; d++) {
    for (let f = 0; f < 18; f++) {
      write(
        path.join(big, `pkg${String(d).padStart(2, "0")}`, `mod${String(f).padStart(2, "0")}.ts`),
        `// module ${d}.${f}\nexport function fn${d}_${f}(x: number): number {\n  return x * ${f + 1} + ${d};\n}\n`,
      );
    }
  }
  write(
    path.join(big, "README.md"),
    "# big-repo\n\n216 generated modules for file-tree and search tests.\n",
  );
  git(big, "init", "-q", "-b", "main");
  git(big, "add", ".");
  git(big, "commit", "-qm", "generated modules");
  return { lib, dirty, big };
}

// ── transcript content ─────────────────────────────────────────────────────────
const RICH_ANSWER = [
  "## Summary",
  "",
  "I ran the tests and read `src/strings.js`. Two helpers exist; **both pass**. Here is what I found:",
  "",
  "1. `slugify` collapses runs of non-alphanumerics",
  "2. `titleCase` lowercases the tail of each word",
  "   - nested bullet with a [link to the README](README.md)",
  "",
  "| Helper | Tests | Status |",
  "| --- | --- | --- |",
  "| slugify | 1 | pass |",
  "| titleCase | 1 | pass |",
  "",
  "```js",
  "export function slugify(s) {",
  "  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');",
  "}",
  "```",
  "",
  "```bash",
  "node --test  # a very long line follows to exercise wrapping ——————————————————————————————————————————————————————————————————————————————————————",
  "```",
  "",
  "> [!WARNING]",
  "> `titleCase` splits on single spaces only.",
  "",
  "Inline math-ish text: 2 < 3 && 3 > 2, and a path `src/numbers.js:2`.",
].join("\n");

function thread({
  threadId,
  koraThreadId,
  projectId,
  cwd,
  title,
  agentMode = "chat",
  createdAt,
  messages = [],
  activities = [],
  archivedAt = null,
  runtimeMode = "approval-required",
}) {
  const last = messages[messages.length - 1];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const lastTurn = last?.turnId ?? null;
  return {
    threadId,
    koraThreadId,
    projectId,
    cwd,
    title,
    modelSelection: MODEL,
    runtimeMode,
    interactionMode: "default",
    agentMode,
    branch: null,
    worktreePath: null,
    createdAt,
    updatedAt: last?.updatedAt ?? createdAt,
    messages,
    activities,
    session: null,
    latestTurn: lastTurn
      ? {
          turnId: lastTurn,
          state: "completed",
          requestedAt: lastUser?.createdAt ?? createdAt,
          startedAt: lastUser?.createdAt ?? createdAt,
          completedAt: last.updatedAt,
          assistantMessageId: last.role === "assistant" ? last.id : null,
        }
      : null,
    latestUserMessageAt: lastUser?.createdAt ?? null,
    koraSessionId: null,
    providerDriver: "claude",
    ...(archivedAt ? { archivedAt } : {}),
  };
}

function conversation(pairs, t0) {
  const messages = [];
  let t = t0;
  for (const [q, a] of pairs) {
    const turnId = uuid();
    const at = new Date(t).toISOString();
    t += 4_000;
    const at2 = new Date(t).toISOString();
    t += 60_000;
    messages.push({
      id: `msg_u_${uuid()}`,
      role: "user",
      text: q,
      turnId: null,
      streaming: false,
      createdAt: at,
      updatedAt: at,
    });
    messages.push({
      id: `msg_a_${uuid()}`,
      role: "assistant",
      text: a,
      turnId,
      streaming: false,
      createdAt: at2,
      updatedAt: at2,
    });
  }
  return messages;
}

let SEQ = 1000;
function toolActivities(turnId, t0) {
  const out = [];
  const mk = (tone, kind, summary, payload, dt) =>
    out.push({
      id: uuid(),
      tone,
      kind,
      summary,
      payload,
      turnId,
      sequence: ++SEQ,
      createdAt: new Date(t0 + dt).toISOString(),
    });
  const a = uuid(),
    b = uuid(),
    c = uuid();
  mk(
    "tool",
    "command_execution",
    "Run the tests",
    { itemId: a, toolName: "Bash", input: { command: "node --test" } },
    1000,
  );
  mk(
    "tool",
    "tool_result",
    "tool completed",
    { itemId: a, status: "completed", output: "# tests 4\n# pass 4\n# fail 0\n" },
    2000,
  );
  mk(
    "tool",
    "file_read",
    "Read src/strings.js",
    { itemId: b, toolName: "Read", input: { file_path: "src/strings.js" } },
    2500,
  );
  mk(
    "tool",
    "tool_result",
    "tool completed",
    { itemId: b, status: "completed", output: "export function slugify(s) { … }" },
    2800,
  );
  mk(
    "tool",
    "command_execution",
    "Run a failing command",
    { itemId: c, toolName: "Bash", input: { command: "node missing.js" } },
    3000,
  );
  mk(
    "tool",
    "tool_result",
    "tool failed",
    { itemId: c, status: "failed", output: "Error: Cannot find module 'missing.js'" },
    3200,
  );
  return out;
}

/** The README's demo project: a small HTTP API, enough files for the sidebar and the graph chip to look real. */
function makeDemoRepo(s) {
  const dir = path.join(s.repos, "acme-api");
  write(
    path.join(dir, "package.json"),
    JSON.stringify(
      { name: "acme-api", version: "1.4.0", type: "module", scripts: { test: "node --test" } },
      null,
      2,
    ) + "\n",
  );
  write(
    path.join(dir, "src/server.ts"),
    "import { routes } from './routes.ts';\nexport function start(port = 8080) {\n  return routes.listen(port);\n}\n",
  );
  write(
    path.join(dir, "src/routes.ts"),
    "export const routes = { listen: (port: number) => port };\n",
  );
  write(
    path.join(dir, "src/middleware/auth.ts"),
    "export function auth(req: { token?: string }) {\n  return Boolean(req.token);\n}\n",
  );
  write(path.join(dir, "test/auth.test.ts"), "import test from 'node:test';\n");
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "API skeleton");
  return dir;
}

function addDemoThreads(add) {
  add("demo", "Ship rate limiting for the public API", "orchestrator", {
    pairs: [
      [
        "Add per-key rate limiting to the public API: token bucket, configurable per route, 429 with Retry-After. Split it up.",
        "I mapped the edit sites with the graph: the limiter is new middleware beside `auth.ts`, the per-route limits live in `routes.ts`, and the 429 path needs tests. Three independent slices, no shared files, so they can run at once.\n\nI've proposed three workers below; approve them and I'll start each in its own worktree.",
      ],
    ],
    ageMin: 6,
    picker: [
      {
        title: "Token-bucket limiter middleware (src/middleware/rateLimit.ts)",
        agent: "claude",
        model: "claude-sonnet-5-5",
        effort: "medium",
        why: "New module with a clear contract; normal coding.",
      },
      {
        title: "Per-route limits in routes.ts + config schema",
        agent: "codex",
        model: "gpt-6-luna",
        effort: "low",
        why: "Small, planned edit at two known sites.",
      },
      {
        title: "Tests for 429 + Retry-After",
        agent: "opencode",
        model: "opencode/big-pickle",
        effort: "",
        why: "Bounded test writing: free model first.",
      },
    ],
  });
  add("demo", "Rate limiting: three workers running", "orchestrator", {
    pairs: [
      [
        "Go ahead with the three workers.",
        "All three are running in their own worktrees: the limiter on Claude, the route limits on Codex, the tests on a free OpenCode model. I'll merge through the gate once their reports are in.",
      ],
    ],
    ageMin: 3,
  });
  add("demo", "Why do webhook retries double-charge?", "chat", {
    pairs: [
      [
        "Webhook retries sometimes charge twice. Where's the idempotency check?",
        "There isn't one on the retry path: `retryDelivery` calls `chargeOnce` without the event id, so the dedupe key is empty on every retry.",
      ],
    ],
    ageMin: 55,
  });
  add("demo", "Upgrade to Node 24 in CI", "chat", {
    pairs: [
      [
        "Move CI to Node 24.",
        "Done: `.github/workflows/ci.yml` now uses Node 24.11 and the cache key includes the pnpm version.",
      ],
    ],
    ageMin: 180,
  });
  add("demo", "Document the auth middleware", "chat", {
    pairs: [
      [
        "Write docs for auth.ts.",
        "Added `docs/auth.md`: what a token is, where it is checked, and the two error responses.",
      ],
    ],
    ageMin: 1500,
  });
}

/** A pending worker picker on a lead thread (what `kora_ask_workers` leaves before the user answers). */
function pickerActivity(turnId, at, picks) {
  const models = (ids) =>
    ids.map((id, i) => ({ id, name: id, efforts: ["low", "medium", "high"], isDefault: i === 0 }));
  return {
    id: uuid(),
    tone: "info",
    kind: "worker-picker.requested",
    summary: "Proposed 3 workers",
    payload: {
      requestId: `wp_${uuid()}`,
      picks,
      catalog: {
        claude: {
          installed: true,
          models: models(["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"]),
        },
        codex: { installed: true, models: models(["gpt-6-luna", "gpt-6.1-sol"]) },
        opencode: {
          installed: true,
          models: models(["opencode/big-pickle", "opencode/mimo-v2.6-flash"]),
        },
        antigravity: { installed: true, models: models(["gemini-3.8-flash-high"]) },
      },
    },
    turnId,
    sequence: ++SEQ,
    createdAt: new Date(at).toISOString(),
  };
}

async function seed(s, { start, stop }) {
  const repos = makeRepos(s);
  await start(s);
  const { KoraClient } = require(path.join(RT, "dist/protocol/client.js"));
  // The client reads the control token from KORA_HOME (privileged calls such as chat.thread.create need it): point it at
  // the stack's home, never the user's ~/.kora.
  process.env.KORA_HOME = s.env.KORA_HOME;
  // KORA_QA_SEED_OFFLINE=1: UI-projection threads only (each gets a placeholder runtime thread id). For a seeder that
  // runs inside a Kora agent session, which never holds the control token chat.thread.create needs; fine for specs that
  // only render seeded threads (or fake the daemon side), not for ones that send turns.
  const offline = process.env.KORA_QA_SEED_OFFLINE === "1";
  const client = offline ? null : new KoraClient(s.env.KORA_SOCKET_PATH);
  await client?.connect();
  const koraThread = async (cwd, title, agentMode) => {
    if (offline) return uuid();
    const th = await client.call("chat.thread.create", {
      agent: "claude",
      cwd,
      agentMode,
      model: { model: MODEL.model },
      title,
    });
    return th.id ?? th.threadId;
  };

  const now = Date.now();
  // KORA_QA_SEED_DEMO=1: a realistic project for the README screenshots (qa/e2e/99-visual/readme.spec.mjs) instead of the
  // fixtures. Same projection format, nothing else differs.
  const demo = process.env.KORA_QA_SEED_DEMO === "1";
  if (demo) repos.demo = makeDemoRepo(s);
  const projects = demo
    ? [{ key: "demo", dir: repos.demo, title: "acme-api" }].map((p) => ({
        ...p,
        id: uuid(),
        createdAt: new Date(now - 20 * 86_400_000).toISOString(),
      }))
    : [
        { key: "lib", dir: repos.lib, title: "tiny-lib" },
        { key: "dirty", dir: repos.dirty, title: "dirty-app" },
        { key: "big", dir: repos.big, title: "big-repo" },
      ].map((p, i) => ({
        ...p,
        id: uuid(),
        createdAt: new Date(now - (30 - i) * 86_400_000).toISOString(),
      }));
  const P = Object.fromEntries(projects.map((p) => [p.key, p]));

  const specs = [];
  const add = (project, title, agentMode, opts = {}) =>
    specs.push({ project, title, agentMode, ...opts });
  if (demo) addDemoThreads(add);
  else {
    // shared fixtures (read-only by convention: areas mutate only their own [aNN] threads)
    add("lib", "Fixture: rich transcript (markdown, code, tools)", "chat", {
      rich: true,
      ageMin: 30,
    });
    add("lib", "Fixture: long thread (520 messages)", "chat", { long: 260, ageMin: 60 });
    add("lib", "Fixture: swarm thread", "swarm", {
      pairs: [
        [
          "Split the helpers into two worker tasks.",
          "I delegated two tasks to the swarm. Reports will arrive in the Tasks panel.",
        ],
      ],
      ageMin: 90,
    });
    add("lib", "Fixture: orchestrator thread", "orchestrator", {
      pairs: [["Spawn a worker to add a `mean` test.", "Spawning one worker for the test."]],
      ageMin: 120,
    });
    add("lib", "Fixture: archived thread", "chat", {
      archived: true,
      pairs: [["old question", "old answer"]],
      ageMin: 3000,
    });
    add("dirty", "Fixture: dirty tree review", "chat", {
      pairs: [
        [
          "What changed in the working tree?",
          "Four files changed: `src/app.js`, `src/config.js`, `docs/notes.md` modified, `package.json` deleted, and `src/untracked.js` is new.",
        ],
      ],
      ageMin: 45,
    });
    add("big", "Fixture: big repo tour", "chat", {
      pairs: [["How is this repo laid out?", "12 packages (`pkg00`–`pkg11`), 18 modules each."]],
      ageMin: 200,
    });
    // per-area namespaces: 3 chat + 1 swarm + 1 orchestrator each. KORA_QA_SEED_AREAS ("1-5,14,17") seeds other areas'
    // namespaces onto this stack, for running those specs pinned to it (KORA_QA_STACK).
    for (const a of seedAreas(s.n)) {
      const ns = `a${String(a).padStart(2, "0")}`;
      add("lib", `[${ns}] chat one`, "chat", {
        pairs: [[`${ns} first question`, `${ns} first answer with \`code\`.`]],
        ageMin: 300 + a,
      });
      add("lib", `[${ns}] chat two`, "chat", {
        pairs: [[`${ns} second question`, `${ns} second answer.`]],
        ageMin: 400 + a,
      });
      add("dirty", `[${ns}] chat three`, "chat", {
        pairs: [[`${ns} third question`, `${ns} third answer.`]],
        ageMin: 500 + a,
      });
      add("lib", `[${ns}] swarm`, "swarm", {
        pairs: [[`${ns} swarm task`, `${ns} delegated.`]],
        ageMin: 600 + a,
      });
      add("big", `[${ns}] orchestrator`, "orchestrator", {
        pairs: [[`${ns} orchestrate`, `${ns} spawning.`]],
        ageMin: 700 + a,
      });
    }
  }
  const records = [];
  for (const sp of specs) {
    const p = P[sp.project];
    const koraThreadId = await koraThread(p.dir, sp.title, sp.agentMode);
    const t0 = now - sp.ageMin * 60_000;
    let messages = [];
    let activities = [];
    if (sp.rich) {
      messages = conversation(
        [
          ["Run the tests and explain `src/strings.js`.", RICH_ANSWER],
          [
            "Thanks. One more: what does `clamp` do?",
            "`clamp(n, lo, hi)` bounds `n` to `[lo, hi]`.",
          ],
        ],
        t0,
      );
      activities = toolActivities(messages[1].turnId, Date.parse(messages[0].createdAt));
    } else if (sp.long) {
      const pairs = [];
      for (let i = 1; i <= sp.long; i++) {
        pairs.push([
          `Question ${i}: what is ${i} squared?`,
          i % 25 === 0
            ? `Checkpoint ${i}.\n\n\`\`\`ts\nconst square = (n: number) => n * n;\nsquare(${i}); // ${i * i}\n\`\`\`\n\n- item one\n- item two`
            : `${i} squared is **${i * i}**.`,
        ]);
      }
      messages = conversation(pairs, t0 - sp.long * 64_000);
    } else if (sp.pairs) {
      messages = conversation(sp.pairs, t0);
    }
    if (sp.picker)
      activities = [
        ...activities,
        pickerActivity(messages.at(-1)?.turnId ?? null, t0 + 70_000, sp.picker),
      ];
    records.push(
      thread({
        threadId: uuid(),
        koraThreadId,
        projectId: p.id,
        cwd: p.dir,
        title: sp.title,
        agentMode: sp.agentMode,
        createdAt: new Date(t0 - 1000).toISOString(),
        messages,
        activities,
        archivedAt: sp.archived ? new Date(t0 + 3_600_000).toISOString() : null,
      }),
    );
  }
  client?.close();
  await stop(s);

  const dataDir = path.join(s.home, "kora-daemon");
  fs.mkdirSync(path.join(dataDir, "threads"), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "projects.json"),
    JSON.stringify(
      projects.map((p) => ({
        id: p.id,
        title: p.title,
        workspaceRoot: p.dir,
        defaultModelSelection: null,
        scripts: [],
        createdAt: p.createdAt,
        updatedAt: p.createdAt,
      })),
    ),
  );
  for (const r of records)
    fs.writeFileSync(path.join(dataDir, "threads", `${r.threadId}.json`), JSON.stringify(r));
  const manifest = {
    stack: s.n,
    repos,
    projects: projects.map(({ key, id, title, dir }) => ({ key, id, title, dir })),
    threads: records.map((r) => ({
      id: r.threadId,
      title: r.title,
      agentMode: r.agentMode,
      projectId: r.projectId,
      archived: !!r.archivedAt,
      messages: r.messages.length,
    })),
  };
  fs.writeFileSync(path.join(s.base, "seed.json"), JSON.stringify(manifest, null, 2));
  await start(s);
  console.log(
    `stack${s.n}: seeded ${projects.length} projects, ${records.length} threads → ${path.join(s.base, "seed.json")}`,
  );
}

module.exports = { seed };
