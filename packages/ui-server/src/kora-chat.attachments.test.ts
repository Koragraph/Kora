// @effect-diagnostics globalDate:off -- the engine under test uses plain timestamps.
// @effect-diagnostics nodeBuiltinImport:off -- a throwaway KORA_HOME for the engine's persisted projection + attachment store.
// Composer attachments: `turn.start` stores uploads under `<KORA_HOME>/attachments/<threadId>/<id>/…`, the
// bubble gets MessageAttachment metadata ONLY (no dataUrl, no path), and the session driver gets a resolved path.
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { setHost, type UiHost } from "./host.ts";

const KORA_HOME = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-chat-attach-test-"));
process.env.KORA_HOME = KORA_HOME;

type Turn = {
  threadId: string;
  text?: string;
  attachments?: Array<{ type: string; path: string; mimeType?: string; name?: string }>;
};

function fakeHost() {
  const notifyListeners: Array<(m: string, p: unknown) => void> = [];
  const turns: Turn[] = [];
  let n = 0;
  const sessions = {
    create: (p: { agent: string; cwd: string }) => ({
      id: `k${++n}`,
      title: "t",
      agent: p.agent,
      cwd: p.cwd,
    }),
    setPermissionMode: () => {},
    setOrchestrator: async () => ({}),
    changeModel: async () => {},
    setAgentMode: async (id: string, mode: string) => ({
      thread: { id, title: "t", agent: "claude", cwd: "/r" },
      notice: null,
    }),
    takeModeNotice: () => null,
    sendTurn: async (p: Turn) => {
      turns.push(p);
      return { turnId: `turn_${turns.length}` };
    },
    interrupt: async () => {},
    delete: async () => {},
    respondApproval: async () => {},
    respondUserInput: async () => {},
  };
  const runtime = {
    panes: new Map(),
    graph: {
      callTool: async () => ({ text: "", data: null, ms: 0 }),
      status: async () => ({ indexed: false }),
    },
    noteSource: null,
    on: (_e: string, fn: (m: string, p: unknown) => void) => {
      notifyListeners.push(fn);
    },
  };
  const fleetOps = {
    list: () => [],
    prompt: async () => ({}),
    wait: async () => ({}),
    read: () => "",
    kill: () => {},
    mergeVerify: async () => ({ pairs: [], order: [] }),
    merge: () => ({
      ok: true,
      merged: null,
      into: null,
      conflicts: [],
      message: "",
      commitsMerged: 0,
    }),
    setPlan: () => {},
    getPlan: () => "",
  };
  const h = {
    runtime,
    sessions,
    managerRuntime: { notify: () => {} },
    makeFleetOps: () => fleetOps,
    proxyPaneId: (id: string) => `chat:${id}`,
    listClaudeModels: async () => null,
    version: "test",
    log: () => {},
    swarm: {},
  } as unknown as UiHost;
  return { h, turns };
}

const fake = fakeHost();
setHost(fake.h);
const { chatEngine } = await import("./kora-chat.ts");
const engine = chatEngine();
const internals = engine as unknown as {
  threads: Map<
    string,
    { koraThreadId: string; messages: Array<{ text: string; role: string; attachments?: unknown }> }
  >;
};

let seq = 0;
async function newThread() {
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
  return threadId;
}

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

NodeTest.test(
  "an image upload is written once, the bubble gets metadata only, the driver gets a path",
  async () => {
    const threadId = await newThread();
    await engine.dispatch({
      type: "turn.start",
      threadId,
      message: {
        messageId: `m_${++seq}`,
        text: "look at this",
        attachments: [
          {
            type: "image",
            id: "img1",
            name: "pic.png",
            mimeType: "image/png",
            sizeBytes: 100,
            dataUrl: `data:image/png;base64,${PNG_BASE64}`,
          },
        ],
      },
      createdAt: new Date().toISOString(),
    } as never);

    const bubble = internals.threads.get(threadId)!.messages.at(-1)! as {
      text: string;
      attachments?: Array<Record<string, unknown>>;
    };
    NodeAssert.equal(bubble.attachments?.length, 1);
    const stored = bubble.attachments![0]!;
    NodeAssert.equal(stored.id, "img1");
    NodeAssert.equal(stored.name, "pic.png");
    NodeAssert.equal(stored.mimeType, "image/png");
    NodeAssert.equal("dataUrl" in stored, false, "the bubble never carries the raw bytes");
    NodeAssert.equal("path" in stored, false, "the bubble never carries a filesystem path");

    const turn = fake.turns.at(-1)!;
    NodeAssert.equal(turn.attachments?.length, 1);
    const runtimeAttachment = turn.attachments![0]!;
    NodeAssert.equal(runtimeAttachment.type, "image");
    NodeAssert.equal(runtimeAttachment.mimeType, "image/png");
    NodeAssert.ok(runtimeAttachment.path.startsWith(KORA_HOME), "an absolute path under KORA_HOME");
    NodeAssert.ok(NodeFS.existsSync(runtimeAttachment.path), "the file was actually written");
    NodeAssert.deepEqual(
      NodeFS.readFileSync(runtimeAttachment.path),
      Buffer.from(PNG_BASE64, "base64"),
      "exact bytes round-trip",
    );
  },
);

NodeTest.test("an attachment id/name cannot escape its directory via path traversal", async () => {
  const threadId = await newThread();
  await engine.dispatch({
    type: "turn.start",
    threadId,
    message: {
      messageId: `m_${++seq}`,
      text: "x",
      attachments: [
        {
          type: "file",
          name: "../../evil.txt",
          mimeType: "text/plain",
          sizeBytes: 3,
          dataUrl: "data:text/plain;base64,aGk=",
        },
      ],
    },
    createdAt: new Date().toISOString(),
  } as never);
  const runtimeAttachment = fake.turns.at(-1)!.attachments![0]!;
  NodeAssert.ok(
    runtimeAttachment.path.startsWith(KORA_HOME),
    "sanitized name keeps the file inside the attachment directory",
  );
  NodeAssert.ok(!runtimeAttachment.path.includes(".."));
});

NodeTest.test(
  "getAttachment: the HTTP route's backing lookup resolves a stored file by id, and 404s on unknown",
  async () => {
    const threadId = await newThread();
    await engine.dispatch({
      type: "turn.start",
      threadId,
      message: {
        messageId: `m_${++seq}`,
        text: "x",
        attachments: [
          {
            type: "image",
            id: "lookup1",
            name: "pic.png",
            mimeType: "image/png",
            sizeBytes: 100,
            dataUrl: `data:image/png;base64,${PNG_BASE64}`,
          },
        ],
      },
      createdAt: new Date().toISOString(),
    } as never);

    const found = await engine.getAttachment(threadId, "lookup1");
    NodeAssert.ok(found, "resolves the stored attachment");
    NodeAssert.equal(found!.mimeType, "image/png");
    NodeAssert.equal(found!.name, "pic.png");
    NodeAssert.deepEqual(NodeFS.readFileSync(found!.filePath), Buffer.from(PNG_BASE64, "base64"));

    NodeAssert.equal(await engine.getAttachment(threadId, "no-such-id"), null);
    NodeAssert.equal(await engine.getAttachment("no-such-thread", "lookup1"), null);
  },
);

NodeTest.test(
  "attachments-only turn (empty composer text) still sends a prompt the agent can act on",
  async () => {
    const threadId = await newThread();
    await engine.dispatch({
      type: "turn.start",
      threadId,
      message: {
        messageId: `m_${++seq}`,
        text: "",
        attachments: [
          {
            type: "file",
            name: "a.txt",
            mimeType: "text/plain",
            sizeBytes: 2,
            dataUrl: "data:text/plain;base64,aGk=",
          },
        ],
      },
      createdAt: new Date().toISOString(),
    } as never);
    const turn = fake.turns.at(-1)!;
    NodeAssert.ok(turn.text && turn.text.length > 0, "the agent gets a non-empty prompt");
    const bubble = internals.threads.get(threadId)!.messages.at(-1)! as { text: string };
    NodeAssert.equal(bubble.text, "", "the bubble keeps the user's real (empty) text");
  },
);

// Security sweep 2026-10-04: the thread id names files (`<threads>/<id>.json`, `<attachments>/<id>/…`) and the wire
// schema only says "non-blank" — a client-chosen `../…` id wrote (and on delete, unlinked) outside Kora's home.
NodeTest.test("a thread id that is not one safe path segment is refused", async () => {
  for (const threadId of ["../../escape", "a/b", "..", "x".repeat(129), "a b"]) {
    await NodeAssert.rejects(
      engine.dispatch({
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
      } as never),
      /Invalid thread id/,
    );
  }
  NodeAssert.equal(NodeFS.existsSync(NodePath.join(KORA_HOME, "..", "escape.json")), false);
  // A client UUID is fine.
  await engine.dispatch({
    type: "createThread",
    threadId: "0b6f7f8e-2c1d-4a8e-9a4b-3f2e1d0c9b8a",
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
  NodeAssert.ok(internals.threads.has("0b6f7f8e-2c1d-4a8e-9a4b-3f2e1d0c9b8a"));
});

// 2B item 6: every command (not only thread.create) refuses a malformed thread id up front with the same clean error.
NodeTest.test(
  "any chat command with a malformed thread id gets the clean 'Invalid thread id.' error",
  async () => {
    for (const command of [
      { type: "deleteThread", threadId: "../../x" },
      { type: "archiveThread", threadId: "a/b" },
      { type: "thread.turn.interrupt", threadId: "..", createdAt: new Date().toISOString() },
      { type: "updateThreadMeta", threadId: 42, title: "t" },
    ]) {
      await NodeAssert.rejects(
        engine.dispatch(command as never),
        /^Error: Invalid thread id\.$/,
        JSON.stringify(command),
      );
    }
  },
);
