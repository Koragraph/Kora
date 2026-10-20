// @effect-diagnostics nodeBuiltinImport:off -- a throwaway KORA_HOME holding a damaged read model on disk.
// B8 (night 2026-10-04): a projects.json that cannot be parsed read as "no projects" — every repo vanished from the
// sidebar and the file was overwritten a moment later. Now it is kept aside and the projects are rebuilt from the
// threads; a damaged thread projection is kept aside and logged instead of silently skipped.
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { setHost, type UiHost } from "./host.ts";

const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-chat-recover-"));
process.env.KORA_HOME = home;
const dataDir = NodePath.join(home, "kora-daemon");
const threadsDir = NodePath.join(dataDir, "threads");
NodeFS.mkdirSync(threadsDir, { recursive: true });
NodeFS.writeFileSync(NodePath.join(dataDir, "projects.json"), '[{"id":"p-app","title":"ap');

const app = NodePath.join(home, "code", "app");
const lib = NodePath.join(home, "code", "lib");
const worktree = NodePath.join(home, "worktrees", "app-wt-1");
function thread(threadId: string, projectId: string, cwd: string, createdAt: string) {
  return {
    threadId,
    koraThreadId: `k-${threadId}`,
    projectId,
    cwd,
    title: threadId,
    modelSelection: { instanceId: "claude", model: "m" },
    runtimeMode: "full-access",
    interactionMode: "default",
    agentMode: "chat",
    branch: null,
    worktreePath: cwd,
    createdAt,
    updatedAt: createdAt,
    messages: [],
    activities: [],
    session: null,
    latestTurn: null,
    latestUserMessageAt: null,
    currentAssistant: null,
  };
}
const write = (rec: ReturnType<typeof thread>) =>
  NodeFS.writeFileSync(NodePath.join(threadsDir, `${rec.threadId}.json`), JSON.stringify(rec));
// p-app: its first thread ran in a Kora worker worktree; the project folder is the other thread's cwd.
write(thread("t1", "p-app", worktree, "2026-10-01T10:00:00.000Z"));
write(thread("t2", "p-app", app, "2026-10-01T11:00:00.000Z"));
write(thread("t9", "p-lib", lib, "2026-10-02T09:00:00.000Z"));
NodeFS.writeFileSync(NodePath.join(threadsDir, "t4.json"), '{"threadId":"t4", "messa');

const host = {
  runtime: {
    panes: new Map(),
    graph: { callTool: async () => ({ text: "", data: null, ms: 0 }), status: async () => ({}) },
    noteSource: null,
    on: () => {},
  },
  sessions: {},
  managerRuntime: { notify: () => {} },
  makeFleetOps: () => ({ list: () => [] }),
  proxyPaneId: (id: string) => `chat:${id}`,
  listClaudeModels: async () => null,
  version: "test",
  log: () => {},
  swarm: {},
} as unknown as UiHost;
setHost(host);

const errors: string[] = [];
const realError = console.error;
console.error = (...args: unknown[]) => {
  errors.push(args.map(String).join(" "));
};
const { chatEngine } = await import("./kora-chat.ts");
const engine = chatEngine();
console.error = realError;
const internals = engine as unknown as {
  projects: Map<string, { project: { id: string; title: string; workspaceRoot: string } }>;
  threads: Map<string, unknown>;
};

NodeTest.test(
  "a damaged projects.json is kept aside and every thread gets its project back",
  () => {
    const appProject = internals.projects.get("p-app")?.project;
    NodeAssert.equal(appProject?.workspaceRoot, app, "the project folder is the non-worktree cwd");
    NodeAssert.equal(appProject?.title, "app");
    NodeAssert.equal(internals.projects.get("p-lib")?.project.workspaceRoot, lib);

    const files = NodeFS.readdirSync(dataDir);
    const aside = files.find((f) => f.startsWith("projects.json.damaged-"));
    NodeAssert.ok(aside, `the damaged bytes are kept: ${files.join(", ")}`);
    NodeAssert.equal(
      NodeFS.readFileSync(NodePath.join(dataDir, aside!), "utf8"),
      '[{"id":"p-app","title":"ap',
    );
    const rebuilt = JSON.parse(
      NodeFS.readFileSync(NodePath.join(dataDir, "projects.json"), "utf8"),
    );
    NodeAssert.deepEqual(
      rebuilt.map((p: { id: string }) => p.id).sort(),
      ["p-app", "p-lib"],
      "the rebuilt list is persisted",
    );
    NodeAssert.ok(
      errors.some((e) => /projects\.json could not be read/.test(e)),
      errors.join("\n"),
    );
  },
);

NodeTest.test("a damaged thread projection is logged and kept aside, the rest still load", () => {
  NodeAssert.equal(internals.threads.size, 3);
  const files = NodeFS.readdirSync(threadsDir);
  NodeAssert.ok(!files.includes("t4.json"));
  NodeAssert.ok(
    files.some((f) => f.startsWith("t4.json.damaged-")),
    files.join(", "),
  );
  NodeAssert.ok(
    errors.some((e) => /thread t4 could not be read/.test(e)),
    errors.join("\n"),
  );
});

NodeTest.after(() => NodeFS.rmSync(home, { recursive: true, force: true }));
