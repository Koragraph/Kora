// @effect-diagnostics nodeBuiltinImport:off -- a throwaway KORA_HOME / Blobs root holding a legacy Chat store on disk.
// @effect-diagnostics globalDate:off globalTimers:off -- real timestamps; the engine under test writes plain ones.
// The Chat -> Kora migration against the REAL chat engine: it hydrates a seeded legacy store (General + a project, with
// transcripts that name files), the migration moves the threads under a new blob and under Kora, and the engine's read
// model, its persisted files and the runtime session heads all agree afterwards. The engine is a module singleton, so
// this file is its own process.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import type { BlobProfile } from "@kora/contracts";

import { setHost, type KoraBlobsLike, type UiHost } from "./host.ts";

const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-chatmig-engine-"));
const home = NodePath.join(tmp, "home");
const blobsRoot = NodePath.join(tmp, "Blobs");
process.env.KORA_HOME = home;
process.env.KORA_BLOBS_ROOT = blobsRoot;
NodeFS.mkdirSync(NodePath.join(home, "kora-daemon", "threads"), { recursive: true });

// ── a legacy Chat store ────────────────────────────────────────────────────────────────────────────────────────
const general = NodePath.join(home, "chats", "general");
const tripRoot = NodePath.join(home, "chats", "projects", "trip");
const write = (file: string, text: string) => {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, text);
};
write(NodePath.join(general, "outputs", "notes.md"), "# general notes");
write(NodePath.join(tripRoot, "PROJECT.md"), "# Trip\n\nPlan the trip.\n");
write(NodePath.join(tripRoot, "memory.md"), "- Likes window seats\n");
write(NodePath.join(tripRoot, "outputs", "plan.md"), "# plan");
write(NodePath.join(tripRoot, "schedules.json"), "[]");

const iso = (n: number) => new Date(Date.UTC(2026, 9, 1, 10, n)).toISOString();
const legacyThread = (
  threadId: string,
  projectId: string,
  cwd: string,
  n: number,
  reply: string,
) => ({
  threadId,
  koraThreadId: `k-${threadId}`,
  projectId,
  cwd,
  title: threadId,
  modelSelection: { instanceId: "claude", model: "sonnet" },
  runtimeMode: "full-access",
  interactionMode: "default",
  agentMode: "swarm",
  branch: null,
  worktreePath: null,
  createdAt: iso(n),
  updatedAt: iso(n),
  messages: [
    {
      id: `${threadId}-u`,
      role: "user",
      text: "make a plan",
      turnId: null,
      streaming: false,
      createdAt: iso(n),
      updatedAt: iso(n),
    },
    {
      id: `${threadId}-a`,
      role: "assistant",
      text: reply,
      turnId: null,
      streaming: false,
      createdAt: iso(n),
      updatedAt: iso(n),
    },
  ],
  activities: [
    {
      id: `${threadId}-act`,
      tone: "tool",
      kind: "tool_result",
      summary: "wrote file",
      payload: { path: `${cwd}/outputs/${projectId === "chat-general" ? "notes" : "plan"}.md` },
      turnId: null,
      createdAt: iso(n),
    },
  ],
  session: null,
  latestTurn: null,
  latestUserMessageAt: iso(n),
  koraSessionId: `sess-${threadId}`,
  providerDriver: "claude",
});
const threadsDir = NodePath.join(home, "kora-daemon", "threads");
const seed = [
  legacyThread("t-gen", "chat-general", general, 1, `Saved to ${general}/outputs/notes.md`),
  legacyThread("t-trip", "p-trip", tripRoot, 2, `Plan: ${tripRoot}/outputs/plan.md`),
  legacyThread("t-code", "p-code", NodePath.join(tmp, "repo"), 3, "unrelated"),
];
for (const t of seed) write(NodePath.join(threadsDir, `${t.threadId}.json`), JSON.stringify(t));
const head = (id: string, title: string, root: string) => ({
  id,
  title,
  workspaceRoot: root,
  defaultModelSelection: null,
  scripts: [],
  createdAt: iso(0),
  updatedAt: iso(0),
});
write(
  NodePath.join(home, "kora-daemon", "projects.json"),
  JSON.stringify([
    { ...head("chat-general", "General", general), surface: "chat" },
    { ...head("p-trip", "Trip", tripRoot), surface: "chat" },
    head("p-code", "repo", NodePath.join(tmp, "repo")),
  ]),
);
NodeFS.mkdirSync(NodePath.join(tmp, "repo"), { recursive: true });
write(NodePath.join(home, "chat", "k-t-gen", "meta.json"), "{}");

// ── fakes ───────────────────────────────────────────────────────────────────────────────────────────────────────
const profiles = new Map<string, BlobProfile>();
const mkBlob = (
  id: string,
  name: string,
  role: "chief" | "member",
  engine: BlobProfile["engine"],
): BlobProfile => {
  const workspace = NodePath.join(blobsRoot, name.replace(/\W+/g, "-"));
  for (const d of ["files", "outputs", "scratch"])
    NodeFS.mkdirSync(NodePath.join(workspace, d), { recursive: true });
  return {
    id,
    version: 1,
    name,
    title: role === "chief" ? "Chief" : "Chat project",
    role,
    teamId: "default",
    engine,
    permission: "auto",
    outfit: null,
    toolGrants: {
      apps: { mode: "none", allow: [] },
      mcp: [],
      computer: { browser: false, vm: false },
    },
    slug: name,
    workspace,
    templateId: null,
    pinned: false,
    hidden: false,
    archivedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as unknown as BlobProfile;
};
profiles.set(
  "blob_kora",
  mkBlob("blob_kora", "Kora", "chief", { instanceId: "claude", model: "sonnet", effort: null }),
);
const facts: Array<{ blobId?: string; text: string }> = [];
const moved: Array<{ id: string; cwd: string }> = [];
let nBlob = 0;
const store = {
  list: () => [...profiles.values()],
  get: (id: string) => profiles.get(id) ?? null,
  create: (i: { name: string; title: string; engine: BlobProfile["engine"] }) => {
    const p = mkBlob(`blob_e${++nBlob}`, i.name, "member", i.engine);
    profiles.set(p.id, p);
    return p;
  },
  defaults: () => ({ engine: null, permission: "auto", soulTemplate: "" }),
  on: () => store,
  off: () => store,
};
const blobs = {
  store,
  memory: {
    listFacts: async () => [],
    addFact: async (a: { blobId?: string; text: string }) => {
      facts.push(a);
      return a;
    },
  },
  routines: { create: () => ({ ok: true as const, value: { id: "rt1" } }) },
} as unknown as KoraBlobsLike;

setHost({
  runtime: {
    panes: new Map(),
    graph: { callTool: async () => ({ text: "", data: null, ms: 0 }), status: async () => ({}) },
    noteSource: null,
    on: () => {},
  },
  sessions: {
    create: () => ({ id: "k-new", title: "t", agent: "claude", cwd: "/x" }),
    setPermissionMode: () => {},
    setOrchestrator: async () => ({}),
    changeModel: async () => {},
    setAgentMode: async () => ({ thread: {}, notice: null }),
    takeModeNotice: () => null,
    sendTurn: async () => ({ turnId: "x" }),
    interrupt: async () => {},
    delete: async () => {},
    respondApproval: async () => {},
    respondUserInput: async () => {},
    moveThread: async (id: string, cwd: string) => {
      moved.push({ id, cwd });
      return { transcriptCopied: id === "k-t-trip" };
    },
  },
  managerRuntime: { notify: () => {} },
  makeFleetOps: () => ({
    list: () => [],
    prompt: async () => ({}),
    wait: async () => ({}),
    read: () => "",
    kill: () => {},
    mergeVerify: async () => ({ pairs: [], order: [] }),
    merge: () => ({}),
    setPlan: () => {},
    getPlan: () => "",
  }),
  proxyPaneId: (id: string) => `chat:${id}`,
  listClaudeModels: async () => null,
  version: "test",
  log: () => {},
  swarm: { getStatus: async () => null, onStatus: () => () => {} },
  blobs,
} as unknown as UiHost);

const { chatEngine } = await import("./kora-chat.ts");
const { runChatMigration } = await import("./chatMigration.ts");

interface Internals {
  projects: Map<
    string,
    { project: { id: string; title: string; workspaceRoot: string; surface?: string } }
  >;
  threads: Map<
    string,
    {
      threadId: string;
      projectId: string;
      cwd: string;
      messages: Array<{ text: string }>;
      activities: Array<{ payload: { path?: string } }>;
    }
  >;
}
const engine = chatEngine();
const internals = engine as unknown as Internals;

NodeTest.test(
  "hydrate: the legacy store loads, and a stale 'chat' surface no longer exists",
  () => {
    NodeAssert.ok(internals.threads.has("t-gen") && internals.threads.has("t-trip"));
    NodeAssert.equal(
      internals.projects.has("chat-general"),
      true,
      "the General head is read from disk (and not re-created later)",
    );
    NodeAssert.notEqual(internals.projects.get("p-trip")!.project.surface, "chat");
    NodeAssert.deepEqual(
      engine
        .legacyThreads((cwd) => cwd.startsWith(NodePath.join(home, "chats")))
        .map((t) => t.threadId)
        .sort(),
      ["t-gen", "t-trip"],
    );
  },
);

// No Windows install ever had the Chat surface (removed 2026-10-10, before the port): the fixture's POSIX transcript
// paths do not apply there.
NodeTest.test(
  "migration moves General under Kora and the project under a new blob, rewriting file paths",
  { skip: process.platform === "win32" },
  async () => {
    const out = await runChatMigration({
      home,
      blobs,
      engine,
      mode: "run",
      now: () => Date.UTC(2026, 9, 10),
      timeZone: "UTC",
    });
    NodeAssert.equal(out.status, "done", JSON.stringify(out.report?.entries.map((e) => e.skipped)));

    const kora = profiles.get("blob_kora")!;
    const trip = [...profiles.values()].find((b) => b.name === "Trip")!;
    NodeAssert.ok(trip, "the project became a blob");

    // read model
    const gen = internals.threads.get("t-gen")!;
    NodeAssert.equal(gen.projectId, "blob_kora");
    NodeAssert.equal(gen.cwd, kora.workspace);
    NodeAssert.equal(gen.messages[1]!.text, `Saved to ${kora.workspace}/outputs/notes.md`);
    NodeAssert.equal(gen.activities[0]!.payload.path, `${kora.workspace}/outputs/notes.md`);
    NodeAssert.equal(gen.messages[0]!.text, "make a plan", "transcripts are otherwise untouched");
    const tr = internals.threads.get("t-trip")!;
    NodeAssert.equal(tr.projectId, trip.id);
    NodeAssert.equal(tr.messages[1]!.text, `Plan: ${trip.workspace}/outputs/plan.md`);
    NodeAssert.equal(
      internals.threads.get("t-code")!.projectId,
      "p-code",
      "a code thread is not touched",
    );

    // runtime heads
    NodeAssert.deepEqual(moved.map((m) => m.id).sort(), ["k-t-gen", "k-t-trip"]);
    NodeAssert.equal(moved.find((m) => m.id === "k-t-trip")!.cwd, trip.workspace);

    // projects: the legacy heads are gone, the blob's exists
    NodeAssert.equal(internals.projects.has("chat-general"), false);
    NodeAssert.equal(internals.projects.has("p-trip"), false);
    NodeAssert.equal(internals.projects.get(trip.id)?.project.surface, "blobs");
    NodeAssert.equal(internals.projects.has("p-code"), true);

    // files + memory
    NodeAssert.equal(
      NodeFS.readFileSync(NodePath.join(trip.workspace, "outputs", "plan.md"), "utf8"),
      "# plan",
    );
    NodeAssert.equal(
      NodeFS.readFileSync(NodePath.join(kora.workspace, "outputs", "notes.md"), "utf8"),
      "# general notes",
    );
    NodeAssert.deepEqual(
      facts.map((f) => f.text),
      ["Likes window seats"],
    );

    // persisted: a restart would load exactly this
    const persisted = JSON.parse(
      NodeFS.readFileSync(NodePath.join(threadsDir, "t-trip.json"), "utf8"),
    );
    NodeAssert.equal(persisted.projectId, trip.id);
    NodeAssert.equal(persisted.cwd, trip.workspace);
    const projects = JSON.parse(
      NodeFS.readFileSync(NodePath.join(home, "kora-daemon", "projects.json"), "utf8"),
    ) as Array<{ id: string }>;
    NodeAssert.ok(!projects.some((p) => p.id === "chat-general" || p.id === "p-trip"));

    // the notice is a thread in Kora with one assistant message
    const noticeId = JSON.parse(
      NodeFS.readFileSync(NodePath.join(home, "chat-migration.json"), "utf8"),
    ).noticeThreadId as string;
    const notice = internals.threads.get(noticeId)!;
    NodeAssert.equal(notice.projectId, "blob_kora");
    NodeAssert.match(notice.messages[0]!.text, /Chat is now part of Kora/);
    NodeAssert.match(notice.messages[0]!.text, /\*\*Trip\*\*/);

    // the old folder is a dated backup; the second run is a no-op
    NodeAssert.ok(
      NodeFS.existsSync(
        NodePath.join(home, "chats.migrated-2026-10-10", "projects", "trip", "PROJECT.md"),
      ),
    );
    NodeAssert.equal(
      (await runChatMigration({ home, blobs, engine, mode: "run" })).status,
      "already",
    );
  },
);
