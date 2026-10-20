// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- a scratch KORA_HOME holding thread files that look like a daemon died mid-turn.
// Scenario: after a restart, a thread whose turn was cut off must tell the resumed agent that turn is over, so the next
// NEW message is answered rather than the old task. Blob threads get a "closed, answer only the new message" note
// (delivered once, agent-side only); fleet leads outside Blobs keep their worker-status note.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { setHost, type UiHost } from "./host.ts";

const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-restart-scenario-"));
process.env.KORA_HOME = scratch;
process.env.KORA_BLOBS_ROOT = NodePath.join(scratch, "Blobs");

const storeDir = NodePath.join(scratch, "kora-daemon");
const threadFiles = NodePath.join(storeDir, "threads");
const blobFolder = NodePath.join(scratch, "Blobs", "mimi");
const repoFolder = NodePath.join(scratch, "code", "site");
for (const dir of [threadFiles, blobFolder, repoFolder]) NodeFS.mkdirSync(dir, { recursive: true });

const stamp = "2026-10-12T08:30:00.000Z";

const projectRow = (id: string, title: string, workspaceRoot: string) => ({
  id,
  title,
  scripts: [],
  workspaceRoot,
  defaultModelSelection: null,
  createdAt: stamp,
  updatedAt: stamp,
});
NodeFS.writeFileSync(
  NodePath.join(storeDir, "projects.json"),
  JSON.stringify([
    projectRow("blob_mimi", "Mimi", blobFolder),
    projectRow("p-site", "site", repoFolder),
  ]),
);

interface CutThread {
  id: string;
  projectId: string;
  cwd: string;
  agentMode: "chat" | "swarm";
  request: string;
}

/** Writes a thread file as the daemon would have left it: a turn running, a half-written reply. */
function leaveThreadMidTurn(spec: CutThread, tweak?: (record: Record<string, unknown>) => void) {
  const record: Record<string, unknown> = {
    threadId: spec.id,
    koraThreadId: `k-${spec.id}`,
    projectId: spec.projectId,
    cwd: spec.cwd,
    title: spec.id,
    modelSelection: { instanceId: "claude", model: "sonnet" },
    runtimeMode: "auto",
    interactionMode: "default",
    agentMode: spec.agentMode,
    branch: null,
    worktreePath: null,
    createdAt: stamp,
    updatedAt: stamp,
    messages: [
      {
        id: "m1",
        role: "user",
        text: spec.request,
        turnId: null,
        streaming: false,
        createdAt: stamp,
      },
      {
        id: "m2",
        role: "assistant",
        text: "Working…",
        turnId: "t1",
        streaming: true,
        createdAt: stamp,
      },
    ],
    activities: [],
    session: {
      status: "running",
      providerName: "claude",
      orchestrationStatus: "running",
      activeTurnId: "t1",
      createdAt: stamp,
      updatedAt: stamp,
    },
    latestTurn: {
      turnId: "t1",
      state: "running",
      requestedAt: stamp,
      startedAt: stamp,
      completedAt: null,
      assistantMessageId: "m2",
    },
    latestUserMessageAt: stamp,
    currentAssistant: null,
    koraSessionId: null,
    providerDriver: "claude",
  };
  tweak?.(record);
  NodeFS.writeFileSync(NodePath.join(threadFiles, `${spec.id}.json`), JSON.stringify(record));
}

leaveThreadMidTurn({
  id: "mimi-a",
  projectId: "blob_mimi",
  cwd: blobFolder,
  agentMode: "swarm",
  request: "Compare three espresso grinders and recommend one",
});
leaveThreadMidTurn({
  id: "mimi-b",
  projectId: "blob_mimi",
  cwd: blobFolder,
  agentMode: "chat",
  request: "Summarise the March meeting notes",
});
leaveThreadMidTurn({
  id: "site-chat",
  projectId: "p-site",
  cwd: repoFolder,
  agentMode: "chat",
  request: "Make the footer links work",
});
leaveThreadMidTurn({
  id: "site-lead",
  projectId: "p-site",
  cwd: repoFolder,
  agentMode: "swarm",
  request: "Split the stylesheet with workers",
});
// This one died with an approval and a question still open: it used to read "needs you" forever.
leaveThreadMidTurn(
  {
    id: "mimi-c",
    projectId: "blob_mimi",
    cwd: blobFolder,
    agentMode: "chat",
    request: "Wait 30 seconds, then save the file",
  },
  (record) => {
    record.activities = [
      {
        id: "act-approval",
        tone: "approval",
        kind: "approval.requested",
        summary: "Allow Bash?",
        payload: { requestId: "appr_9", blobThread: true },
        turnId: "t1",
        sequence: 1,
        createdAt: stamp,
      },
      {
        id: "act-question",
        tone: "approval",
        kind: "user-input.requested",
        summary: "Question",
        payload: { requestId: "q_9" },
        turnId: "t1",
        sequence: 2,
        createdAt: stamp,
      },
    ];
  },
);

type SentTurn = { threadId: string; text?: string; koraNotice?: string };
const deliveredTurns: SentTurn[] = [];

setHost({
  runtime: {
    panes: new Map(),
    graph: { callTool: async () => ({ text: "", data: null, ms: 0 }), status: async () => ({}) },
    noteSource: null,
    on: () => {},
  },
  sessions: {
    create: () => ({ id: "kx", title: "t", agent: "claude", cwd: "/r" }),
    setPermissionMode: () => {},
    setOrchestrator: async () => ({}),
    changeModel: async () => {},
    takeModeNotice: () => null,
    sendTurn: async (turn: SentTurn) => {
      deliveredTurns.push(turn);
      return { turnId: "n" };
    },
    interrupt: async () => {},
    delete: async () => {},
    respondApproval: async () => {},
    respondUserInput: async () => {},
  },
  managerRuntime: { notify: () => {} },
  makeFleetOps: () => ({ list: () => [] }),
  proxyPaneId: (id: string) => `chat:${id}`,
  listClaudeModels: async () => null,
  version: "test",
  log: () => {},
  swarm: { getStatus: async () => null, onStatus: () => () => {} },
} as unknown as UiHost);

const { chatEngine, FLEET_RESTART_NOTE, restartClosedNote } = await import("./kora-chat.ts");
const engine = chatEngine();
const hydrated = engine as unknown as { threads: Map<string, { restartNote?: string }> };
const noteOf = (threadId: string) => hydrated.threads.get(threadId)!.restartNote;

const sayToThread = (threadId: string, text: string) =>
  engine.dispatch({
    type: "turn.start",
    threadId,
    commandId: `cmd-${threadId}-${text}`,
    message: { messageId: `msg-${threadId}-${text.length}`, role: "user", text, attachments: [] },
    runtimeMode: "auto",
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  } as never);

NodeTest.after(() => NodeFS.rmSync(scratch, { recursive: true, force: true }));

NodeTest.describe("a blob thread whose turn was cut by a restart", () => {
  NodeTest.it(
    "hands the agent a one-shot 'closed' note on the next message, never the user",
    async () => {
      const note = noteOf("mimi-a");
      NodeAssert.ok(note, "set while hydrating, even though this blob thread is in swarm mode");
      NodeAssert.notEqual(
        note,
        FLEET_RESTART_NOTE,
        "a blob answers the new message, it does not check on workers",
      );
      NodeAssert.match(note, /CLOSED/);
      NodeAssert.match(note, /Answer ONLY the person's new message/);
      NodeAssert.match(note, /espresso grinders/, "quotes the interrupted request");

      await sayToThread("mimi-a", "What day is it in Lisbon?");
      const delivered = deliveredTurns.at(-1)!;
      NodeAssert.equal(delivered.text, "What day is it in Lisbon?");
      NodeAssert.equal(delivered.koraNotice, note);
      NodeAssert.equal(
        engine.getThreadDetail("mimi-a")!.thread.messages.at(-1)!.text,
        "What day is it in Lisbon?",
        "the chat bubble holds only what the person typed",
      );

      await sayToThread("mimi-a", "ok thanks");
      NodeAssert.equal(
        deliveredTurns.at(-1)!.koraNotice,
        undefined,
        "the note is spent after one delivery",
      );
    },
  );

  NodeTest.it("applies to every cut blob thread, while code threads keep the worker note", () => {
    NodeAssert.match(noteOf("mimi-b")!, /March meeting notes/);
    NodeAssert.equal(noteOf("site-chat"), FLEET_RESTART_NOTE);
    NodeAssert.equal(noteOf("site-lead"), FLEET_RESTART_NOTE);
  });

  NodeTest.it("has its pending approval and question closed, and is flagged as interrupted", () => {
    const activities = engine.getThreadDetail("mimi-c")!.thread.activities;
    const payloadOf = (a: { payload: unknown }) =>
      a.payload as { requestId?: string; decision?: string };

    NodeAssert.ok(
      activities.some(
        (a) =>
          a.kind === "approval.resolved" &&
          payloadOf(a).requestId === "appr_9" &&
          payloadOf(a).decision === "cancel",
      ),
      "the approval is cancelled",
    );
    NodeAssert.ok(
      activities.some((a) => a.kind === "user-input.resolved" && payloadOf(a).requestId === "q_9"),
      "the question is resolved",
    );

    const snapshot = engine.blobThreadSnapshot("mimi-c")!;
    NodeAssert.notEqual(snapshot.state, "needs-you");
    NodeAssert.equal(snapshot.interrupted, true, "what it has is half an answer");
    NodeAssert.equal(engine.blobThreadSnapshot("mimi-b")!.interrupted, true);
  });
});

NodeTest.describe("restartClosedNote", () => {
  NodeTest.it("stays short even for a huge request", () => {
    NodeAssert.ok(restartClosedNote("y".repeat(500)).length < 900);
  });

  NodeTest.it("quotes nothing when the request is unknown", () => {
    NodeAssert.doesNotMatch(restartClosedNote(null), /\(".*"\)/);
  });

  NodeTest.it("keeps only the first line of a multi-line request", () => {
    NodeAssert.doesNotMatch(restartClosedNote("first\nsecond\n\nthird"), /first\nsecond/);
  });
});
