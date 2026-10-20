// @effect-diagnostics globalTimers:off -- a short real wait for the fire-and-forget turn to settle.
// @effect-diagnostics globalDate:off -- the engine under test uses plain timestamps.
// @effect-diagnostics nodeBuiltinImport:off -- a throwaway KORA_HOME for the engine's persisted projection.
// B3 (night 2026-10-04): a turn the daemon could not run (folder gone, spawn failed, a Codex error) showed its reason
// as a banner AND one or two "Turn failed: …" rows. It now ends the turn with ONE reply carrying the reason, and the
// session error equals it (the client then shows it once, inline, with Retry).
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { setHost, type UiHost } from "./host.ts";

process.env.KORA_HOME = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-chat-failure-"));

const notifyListeners: Array<(m: string, p: unknown) => void> = [];
let failWith: { message: string; driverSaid?: string } | null = null;
let n = 0;
const host = {
  runtime: {
    panes: new Map(),
    graph: { callTool: async () => ({ text: "", data: null, ms: 0 }), status: async () => ({}) },
    noteSource: null,
    on: (_e: string, fn: (m: string, p: unknown) => void) => notifyListeners.push(fn),
  },
  sessions: {
    create: (p: { agent: string; cwd: string }) => ({
      id: `k${++n}`,
      title: "t",
      agent: p.agent,
      cwd: p.cwd,
    }),
    setPermissionMode: () => {},
    changeModel: async () => {},
    takeModeNotice: () => null,
    sendTurn: async (p: { threadId: string }) => {
      if (!failWith) return { turnId: "turn_ok" };
      // A driver that reports its start failure first (claude-driver: "failed to start Claude: …"), then throws.
      if (failWith.driverSaid)
        for (const l of notifyListeners)
          l("chat.event", {
            threadId: p.threadId,
            seq: 0,
            at: Date.now(),
            type: "runtime.error",
            errorClass: "provider",
            message: failWith.driverSaid,
          });
      throw new Error(failWith.message);
    },
    interrupt: async () => {},
  },
  managerRuntime: { notify: () => {} },
  makeFleetOps: () => ({ list: () => [] }),
  proxyPaneId: (id: string) => `chat:${id}`,
  listClaudeModels: async () => null,
  version: "test",
  log: () => {},
  swarm: {},
} as unknown as UiHost;
setHost(host);

const { chatEngine } = await import("./kora-chat.ts");
const engine = chatEngine();
const settle = () => new Promise((r) => setTimeout(r, 30));

let seq = 0;
async function failedTurn(fail: { message: string; driverSaid?: string }) {
  const threadId = `th${++seq}`;
  await engine.dispatch({
    type: "createThread",
    threadId,
    projectId: "p1",
    title: "t",
    modelSelection: { instanceId: "claude", model: "m" },
    runtimeMode: "full-access",
    interactionMode: "default",
    agentMode: "chat",
    branch: null,
    worktreePath: "/r",
    createdAt: new Date().toISOString(),
  } as never);
  failWith = fail;
  await engine.dispatch({
    type: "turn.start",
    threadId,
    message: { messageId: `m_${seq}`, text: "say hi", attachments: [] },
    createdAt: new Date().toISOString(),
  } as never);
  await settle();
  failWith = null;
  return engine.getThreadDetail(threadId)!.thread;
}

NodeTest.test(
  "a turn the daemon cannot start ends with one reply that says why — no 'Turn failed' row",
  async () => {
    const gone =
      "This thread's folder is gone: /r. It was moved, renamed or deleted. Put it back, or open the folder from its new place and start a new thread there.";
    const t = await failedTurn({ message: gone });
    const replies = t.messages.filter((m) => m.role === "assistant");
    NodeAssert.equal(replies.length, 1);
    NodeAssert.equal(replies[0]!.text, gone);
    NodeAssert.equal(
      t.activities.filter((a) => /runtime_error|runtime\.error/.test(String(a.kind))).length,
      0,
    );
    NodeAssert.equal(
      t.session?.lastError,
      gone,
      "the session error equals the reply (the client matches them)",
    );
  },
);

NodeTest.test("a start failure the driver already reported is said once", async () => {
  const t = await failedTurn({
    message: "spawn ENOTDIR",
    driverSaid: "failed to start Claude: spawn ENOTDIR",
  });
  const replies = t.messages.filter((m) => m.role === "assistant");
  NodeAssert.deepEqual(
    replies.map((m) => m.text),
    ["failed to start Claude: spawn ENOTDIR"],
  );
  NodeAssert.equal(t.session?.lastError, "failed to start Claude: spawn ENOTDIR");
});

// B1 (night 2026-10-04): the browser's typed-path prompt accepted a file or a mistyped path as a project.
NodeTest.test(
  "a Code project must be an existing folder: a file or a missing path is refused with the reason",
  async () => {
    const { assertProjectFolder } = await import("./kora-chat.ts");
    const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-project-folder-"));
    const file = NodePath.join(base, "notes.txt");
    NodeFS.writeFileSync(file, "x");
    NodeAssert.doesNotThrow(() => assertProjectFolder(base));
    NodeAssert.throws(() => assertProjectFolder(file), /is a file, not a folder/);
    NodeAssert.throws(
      () => assertProjectFolder(NodePath.join(base, "typo")),
      /There is no folder at .*typo/,
    );
    assertProjectFolder(NodePath.join(base, "new"), true);
    NodeAssert.ok(
      NodeFS.statSync(NodePath.join(base, "new")).isDirectory(),
      "createWorkspaceRootIfMissing still works",
    );
    await NodeAssert.rejects(
      engine.dispatch({
        type: "createProject",
        projectId: "pf",
        title: "notes",
        workspaceRoot: file,
        createdAt: new Date().toISOString(),
      } as never),
      /is a file, not a folder/,
    );
  },
);
