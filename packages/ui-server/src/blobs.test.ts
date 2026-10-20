// @effect-diagnostics globalDate:off globalTimers:off -- the engine under test uses plain timestamps; one test waits on a real timer.
// @effect-diagnostics nodeBuiltinImport:off -- throwaway KORA_HOME / KORA_BLOBS_ROOT / Trash for the engine's folders.
// Blobs on the ui-server (docs/bots/ARCH.md section 8, Slice B): the blob <-> project mirror, surface derivation, the
// three-running-threads cap, the once-per-turn memory hook + its single `blob.card`, "continue on a free model", the
// about-me / defaults / flags files and the blobs.* handlers (typed errors, JSON-safe results). Follows the fakeHost
// pattern of the old chatSurface tests (a throwaway KORA_HOME + a SessionManager double); the engine is a module singleton, so
// this whole file runs as one process.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { BLOB_METHODS, type BlobError, type BlobProfile } from "@kora/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { toWireReceipt } from "./blobsWire.ts";
import { setHost, type KoraBlobsLike, type UiHost } from "./host.ts";

const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-blobs-test-"));
process.env.KORA_HOME = NodePath.join(tmp, "home");
process.env.KORA_BLOBS_ROOT = NodePath.join(tmp, "Blobs");
process.env.KORA_TRASH_DIR = NodePath.join(tmp, "Trash");
NodeFS.mkdirSync(process.env.KORA_HOME, { recursive: true });

type Turn = { threadId: string; text?: string; koraNotice?: string };

// ── fakes ───────────────────────────────────────────────────────────────────────────────────────────────────────
const { blobsRoot } = await import("./assistantFs.ts");

function fakeBlobRuntime() {
  const profiles = new Map<string, BlobProfile>();
  const souls = new Map<string, string>();
  const changed = new Set<() => void>();
  const afterTurnCalls: Array<Parameters<KoraBlobsLike["afterTurn"]>[0]> = [];
  const forgotten: string[] = [];
  const undone: string[] = [];
  const deleteCalls: Array<[string, string]> = [];
  const facts = new Map<string, Record<string, unknown>>([
    [
      "f1",
      {
        id: "f1",
        scope: "you",
        text: "x",
        since: 1,
        confidence: 0.9,
        important: false,
        source: { threadId: "x", messageId: "y" },
      },
    ],
  ]);
  let n = 0;
  let receipts: unknown[] = [
    {
      id: "rcpt1",
      kind: "added",
      scope: "you",
      text: "Lives in Dallas",
      factId: "f1",
      source: { threadId: "x", messageId: "y" },
    },
  ];
  const emit = () => changed.forEach((fn) => fn());
  const store: KoraBlobsLike["store"] = {
    list: () => [...profiles.values()],
    get: (id) => profiles.get(id) ?? null,
    create: (i) => {
      const id = `blob_t${++n}`;
      const slug = i.name.toLowerCase().replace(/\W+/g, "-");
      const workspace = NodePath.join(blobsRoot(), slug);
      for (const d of ["files", "outputs", "scratch", "downloads"])
        NodeFS.mkdirSync(NodePath.join(workspace, d), { recursive: true });
      const now = Date.now();
      const profile = {
        id,
        version: 1,
        name: i.name,
        title: i.title,
        role: "member",
        teamId: "default",
        engine: i.engine,
        permission: i.permission,
        outfit: i.outfit,
        toolGrants: i.toolGrants ?? {
          apps: { mode: "none", allow: [] },
          mcp: [],
          computer: { browser: false, vm: false },
        },
        slug,
        workspace,
        templateId: i.templateId,
        pinned: false,
        hidden: false,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
        // an optional field the wire must drop, not die on
        extra: undefined,
      } as unknown as BlobProfile;
      profiles.set(id, profile);
      souls.set(id, i.soul);
      emit();
      return profile;
    },
    update: (id, patch) => {
      const next = { ...profiles.get(id)!, ...patch, updatedAt: Date.now() } as BlobProfile;
      profiles.set(id, next);
      emit();
      return next;
    },
    archive: (id) => {
      const next = { ...profiles.get(id)!, archivedAt: Date.now() } as BlobProfile;
      profiles.set(id, next);
      emit();
      return next;
    },
    rehire: (id) => {
      const next = { ...profiles.get(id)!, archivedAt: null } as BlobProfile;
      profiles.set(id, next);
      emit();
      return next;
    },
    delete: (id, confirmName) => {
      deleteCalls.push([id, confirmName]);
      profiles.delete(id);
      emit();
    },
    soul: (id) => souls.get(id) ?? "",
    writeSoul: (id, text) => {
      souls.set(id, text);
    },
    // an EventEmitter-style `on`: returns the store, not an unsubscribe (the runtime BlobStore does)
    on: (_event, fn) => {
      changed.add(fn);
      return store;
    },
    off: (_event, fn) => {
      changed.delete(fn);
      return store;
    },
  };
  const runtime: KoraBlobsLike = {
    store,
    memory: {
      listFacts: async (a) => [...facts.values()].filter((f) => !a?.scope || f.scope === a.scope),
      getFact: async (id) => facts.get(id),
      getCore: async () => ({ you: "core you", blob: "core blob" }),
      getTeamCore: async () => "core team",
      setCore: async () => undefined,
      editFact: async (id, patch) => {
        const f = facts.get(id);
        if (!f) return undefined;
        const next = { ...f, ...patch };
        facts.set(id, next);
        return next;
      },
      forgetFact: async (id) => facts.delete(id),
      markImportant: async (id, on = true) => {
        const f = facts.get(id);
        if (f) facts.set(id, { ...f, important: on });
        return !!f;
      },
      undo: async (id) => {
        undone.push(id);
        return true; // the memory module's own `undo` answers a boolean
      },
      approvePending: async () => ({
        id: "rnew",
        kind: "added",
        factId: "f2",
        text: "Has a rash",
        blobId: "b",
      }),
      rejectPending: async () => true,
      listReceipts: async () => [
        {
          id: "r-held",
          kind: "pending",
          factId: "",
          pendingId: "pend1",
          text: "Has a rash",
          blobId: "b",
          undone: false,
        },
      ],
      searchEpisodes: async () => [
        { threadId: "t", blobId: "b", text: "full", snippet: "snip", at: 3, score: 0.5 },
      ],
      forgetBlob: async (id) => {
        forgotten.push(id);
      },
    },
    afterTurn: async (i) => {
      afterTurnCalls.push(i);
      return receipts;
    },
    refresh: () => {},
  };
  return {
    runtime,
    profiles,
    afterTurnCalls,
    forgotten,
    undone,
    deleteCalls,
    facts,
    setReceipts: (r: unknown[]) => (receipts = r),
    listenerCount: () => changed.size,
  };
}

const turns: Turn[] = [];
const permissionCalls: Array<[string, string]> = [];
const interrupts: string[] = [];
const created: Array<{ id: string; agent: string; cwd: string }> = [];
const notifyListeners: Array<(m: string, p: unknown) => void> = [];
let nSession = 0;
const blobRt = fakeBlobRuntime();
let swarmStatus: unknown = null;
let swarmStatusReads = 0;
const sessions = {
  create: (p: { agent: string; cwd: string }) => {
    const id = `k${++nSession}`;
    created.push({ id, agent: p.agent, cwd: p.cwd });
    return { id, title: "t", agent: p.agent, cwd: p.cwd };
  },
  setPermissionMode: (id: string, mode: string) => {
    permissionCalls.push([id, mode]);
  },
  setOrchestrator: async () => ({}),
  changeModel: async () => {},
  setAgentMode: async () => ({
    thread: { id: "k", title: "t", agent: "claude", cwd: "/r" },
    notice: null,
  }),
  takeModeNotice: () => null,
  sendTurn: async (p: Turn) => {
    turns.push(p);
    return { turnId: `turn_${turns.length}` };
  },
  interrupt: async (id: string) => {
    interrupts.push(id);
  },
  delete: async () => {},
  respondApproval: async () => {},
  respondUserInput: async () => {},
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
const attached: unknown[] = [];
setHost({
  runtime: {
    panes: new Map(),
    fleetGet: () => ({ plan: "", events: [] }),
    graph: {
      callTool: async () => ({ text: "", data: null, ms: 0 }),
      status: async () => ({ indexed: false }),
    },
    noteSource: null,
    on: (_e: string, fn: (m: string, p: unknown) => void) => {
      notifyListeners.push(fn);
    },
  },
  sessions,
  managerRuntime: { notify: () => {} },
  makeFleetOps: () => fleetOps,
  proxyPaneId: (id: string) => `chat:${id}`,
  listClaudeModels: async () => null,
  version: "test",
  log: () => {},
  swarm: {
    getStatus: async () => {
      swarmStatusReads += 1;
      return swarmStatus;
    },
    onStatus: () => () => {},
  },
  blobs: {
    ...blobRt.runtime,
    attachEngine: (b: unknown) => {
      attached.push(b);
    },
  },
  // These tests exercise Kora itself: the daemon's switch is on (koraSurface.test.ts covers coming soon).
  koraSurface: () => "on" as const,
} as unknown as UiHost);

const { chatEngine, deriveProjectSurface, BLOB_MAX_RUNNING_THREADS } =
  await import("./kora-chat.ts");
const { blobsHandlers } = await import("./handlers/blobs.ts");
const { mergedHandlerTags } = await import("./handlers.ts");
const { isBlobsCwd, blobWorkspaceRootOf } = await import("./assistantFs.ts");
const { buildContinueSeed, makeBlobEngineBridge } = await import("./blobsEngine.ts");
const { jsonSafe } = await import("./handlers/shared.ts");
const { memoryModelFromStatus } = await import("./blobsEngine.ts");
const { blobFileVersionHeaders } = await import("./blobsFs.ts");

const engine = chatEngine();
const internals = engine as unknown as {
  projects: Map<
    string,
    {
      project: {
        id: string;
        title: string;
        workspaceRoot: string;
        surface?: string;
        defaultModelSelection: unknown;
      };
    }
  >;
  threads: Map<
    string,
    {
      koraThreadId: string;
      projectId: string;
      origin?: unknown;
      messages: Array<{ id: string; text: string; role: string }>;
    }
  >;
};

const run = <A>(tag: string, input: unknown = {}) =>
  Effect.runPromise(blobsHandlers[tag]!(input) as Effect.Effect<A, BlobError>);
const runFail = (tag: string, input: unknown = {}) =>
  Effect.runPromise(Effect.flip(blobsHandlers[tag]!(input) as Effect.Effect<object, BlobError>));

const draft = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  title: "Researcher",
  job: "research",
  howItWorks: [],
  soul: "Be kind.",
  engine: { instanceId: "claude", model: "sonnet", effort: null },
  permission: "auto",
  outfit: null,
  apps: [],
  skills: [],
  routines: [],
  templateId: null,
  ...over,
});
const hire = (name: string, over: Record<string, unknown> = {}) =>
  run<BlobProfile>(BLOB_METHODS.create, { draft: draft(name, over), proposalId: null });

let seq = 0;
async function newBlobThread(blobId: string, runtimeMode = "auto") {
  const threadId = `bth${++seq}`;
  await engine.dispatch({
    type: "createThread",
    threadId,
    projectId: blobId,
    title: "t",
    modelSelection: { instanceId: "claude", model: "sonnet" },
    runtimeMode,
    interactionMode: "default",
    agentMode: "chat",
    branch: null,
    worktreePath: null,
    createdAt: new Date().toISOString(),
  } as never);
  return { threadId, kora: internals.threads.get(threadId)!.koraThreadId };
}
const userTurn = (threadId: string, text: string) =>
  engine.dispatch({
    type: "turn.start",
    threadId,
    message: { messageId: `m_${++seq}`, text, attachments: [] },
    createdAt: new Date().toISOString(),
  } as never);
const notify = (kora: string, ev: Record<string, unknown>) => {
  for (const l of notifyListeners)
    l("chat.event", { threadId: kora, seq: 0, at: Date.now(), ...ev });
};
const activities = (threadId: string) => engine.getThreadDetail(threadId)!.thread.activities;
const cards = (threadId: string) => activities(threadId).filter((a) => a.kind === "blob.card");
/** A full exchange: user turn, assistant text, settle. */
async function exchange(threadId: string, kora: string, text: string, reply: string) {
  await userTurn(threadId, text);
  notify(kora, { type: "turn.started", turnId: `t${seq}` });
  notify(kora, {
    type: "content.delta",
    stream: "assistant_text",
    delta: reply,
    turnId: `t${seq}`,
  });
  notify(kora, {
    type: "turn.settled",
    turnId: `t${seq}`,
    state: "completed",
    usage: { usageStatus: "complete", inputTokens: 10, cachedInputTokens: 100, outputTokens: 5 },
  });
  await new Promise((r) => setImmediate(r)); // let the fire-and-forget memory hook resolve
}

const every = (v: unknown, path = "$"): void => {
  if (v === undefined) throw new Error(`undefined at ${path}`);
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) every(x, `${path}.${k}`);
};

// ── tests ───────────────────────────────────────────────────────────────────────────────────────────────────────
NodeTest.test("every blobs.* RPC has a real handler (none would be auto-stubbed to hang)", () => {
  const real = mergedHandlerTags();
  for (const tag of Object.values(BLOB_METHODS)) NodeAssert.ok(real.has(tag), `${tag} is real`);
});

NodeTest.test(
  "startUiServer-style wiring: the engine bridge has the full BlobEngineBridge surface",
  () => {
    const bridge = makeBlobEngineBridge(engine);
    for (const key of [
      "startThread",
      "sendToThread",
      "snapshot",
      "runningCount",
      "appendCard",
      "queueNote",
      "onSettled",
    ] as const)
      NodeAssert.equal(typeof bridge[key], "function", key);
    void attached;
  },
);

NodeTest.test(
  "surface derivation: a blob workspace is blobs (and an assistant folder), everything else is code",
  () => {
    const ws = NodePath.join(blobsRoot(), "popo");
    NodeFS.mkdirSync(NodePath.join(ws, "outputs"), { recursive: true });
    NodeAssert.equal(deriveProjectSurface(ws), "blobs");
    NodeAssert.equal(deriveProjectSurface(NodePath.join(ws, "outputs")), "blobs");
    NodeAssert.ok(isBlobsCwd(ws), "no graph / no worktree lane applies");
    NodeAssert.equal(blobWorkspaceRootOf(NodePath.join(ws, "outputs")), NodeFS.realpathSync(ws));
    NodeAssert.equal(
      isBlobsCwd(blobsRoot()),
      false,
      "the Blobs folder itself is nobody's workspace",
    );
    NodeAssert.equal(deriveProjectSurface(NodeOS.tmpdir()), "code");
  },
);

NodeTest.test("project mirror: create -> archive -> rehire -> update -> delete", async () => {
  const popo = await hire("Popo");
  every(popo);
  const mirrored = internals.projects.get(popo.id)!.project;
  NodeAssert.equal(mirrored.surface, "blobs");
  NodeAssert.equal(mirrored.title, "Popo");
  NodeAssert.equal(mirrored.workspaceRoot, popo.workspace);
  NodeAssert.deepEqual(mirrored.defaultModelSelection, { instanceId: "claude", model: "sonnet" });

  const retired = await run<BlobProfile>(BLOB_METHODS.archive, { blobId: popo.id });
  NodeAssert.ok(retired.archivedAt != null);
  NodeAssert.ok(internals.projects.has(popo.id), "archive keeps the project (and its threads)");

  const back = await run<BlobProfile>(BLOB_METHODS.rehire, { blobId: popo.id });
  NodeAssert.equal(back.archivedAt, null);

  await run(BLOB_METHODS.update, {
    blobId: popo.id,
    patch: {
      name: "Popo II",
      engine: { instanceId: "codex", model: "gpt-5-codex", effort: "high" },
    },
  });
  const renamed = internals.projects.get(popo.id)!.project;
  NodeAssert.equal(renamed.title, "Popo II", "the project follows the blob's name");
  NodeAssert.deepEqual(renamed.defaultModelSelection, {
    instanceId: "codex",
    model: "gpt-5-codex",
    options: [{ id: "effort", value: "high" }],
  });
  NodeAssert.equal(renamed.workspaceRoot, popo.workspace, "a rename never moves the folder");

  const { threadId } = await newBlobThread(popo.id);
  const wrong = await runFail(BLOB_METHODS.delete, { blobId: popo.id, confirmName: "nope" });
  NodeAssert.equal(wrong.code, "confirm_mismatch");
  NodeAssert.ok(NodeFS.existsSync(popo.workspace), "a refused delete touches nothing");

  await run(BLOB_METHODS.delete, { blobId: popo.id, confirmName: "Popo II" });
  NodeAssert.equal(internals.projects.has(popo.id), false);
  NodeAssert.equal(internals.threads.has(threadId), false, "its threads go with it");
  NodeAssert.equal(NodeFS.existsSync(popo.workspace), false);
  NodeAssert.ok(
    NodeFS.existsSync(
      NodePath.join(process.env.KORA_TRASH_DIR!, NodePath.basename(popo.workspace)),
    ),
    "folder moved to the Trash, not removed",
  );
  NodeAssert.deepEqual(blobRt.forgotten, [popo.id]);
  NodeAssert.equal(blobRt.profiles.has(popo.id), false);
  NodeAssert.deepEqual(
    blobRt.deleteCalls.at(-1),
    [popo.id, "Popo II"],
    "the runtime store gets the confirmed name",
  );
});

NodeTest.test(
  "names are unique among non-archived blobs; the Chief cannot be retired or deleted",
  async () => {
    const a = await hire("Bobble");
    const dup = await runFail(BLOB_METHODS.create, { draft: draft(" bobble "), proposalId: null });
    NodeAssert.equal(dup.code, "name_taken");
    const empty = await runFail(BLOB_METHODS.create, { draft: draft("  "), proposalId: null });
    NodeAssert.equal(empty.code, "name_required");
    const copy = await run<BlobProfile>(BLOB_METHODS.duplicate, { blobId: a.id });
    NodeAssert.equal(copy.name, "Bobble copy");
    const chief = await hire("Kora");
    blobRt.profiles.set(chief.id, { ...chief, role: "chief" } as BlobProfile);
    NodeAssert.equal(
      (await runFail(BLOB_METHODS.archive, { blobId: chief.id })).code,
      "chief_protected",
    );
    NodeAssert.equal(
      (await runFail(BLOB_METHODS.delete, { blobId: chief.id, confirmName: "Kora" })).code,
      "chief_protected",
    );
    NodeAssert.equal((await runFail(BLOB_METHODS.get, { blobId: "blob_nope" })).code, "not_found");
  },
);

NodeTest.test(
  "a blob runs at most three threads; the fourth send is refused, then allowed after one settles",
  async () => {
    const blob = await hire("Dimp");
    const ts = [];
    for (let i = 0; i < BLOB_MAX_RUNNING_THREADS; i++) ts.push(await newBlobThread(blob.id));
    const extra = await newBlobThread(blob.id);
    // Sends in the same tick (no turn.started yet) already hold their slot.
    for (const t of ts) await userTurn(t.threadId, "go");
    await NodeAssert.rejects(userTurn(extra.threadId, "and me"), /already running 3 threads/);
    NodeAssert.equal(engine.blobRunningCount(blob.id), 3);
    // A follow-up into a thread that is already running adds nothing.
    await userTurn(ts[0]!.threadId, "more");
    for (const t of ts) notify(t.kora, { type: "turn.started", turnId: "x" });
    await NodeAssert.rejects(userTurn(extra.threadId, "still no"), /already running 3 threads/);
    // Another blob is unaffected.
    const other = await hire("Junip");
    const o = await newBlobThread(other.id);
    await userTurn(o.threadId, "fine");
    // One settles: the fourth goes through.
    notify(ts[1]!.kora, { type: "turn.settled", turnId: "x", state: "completed" });
    await userTurn(extra.threadId, "now me");
    NodeAssert.equal(engine.blobRunningCount(blob.id), 3);
  },
);

NodeTest.test("a retired blob refuses new turns", async () => {
  const blob = await hire("Tibbo");
  const t = await newBlobThread(blob.id);
  await run(BLOB_METHODS.archive, { blobId: blob.id });
  await NodeAssert.rejects(userTurn(t.threadId, "hi"), /is retired/);
});

NodeTest.test("turn.settled calls afterTurn once and appends exactly one memory card", async () => {
  const blob = await hire("Zonk");
  const { threadId, kora } = await newBlobThread(blob.id);
  blobRt.afterTurnCalls.length = 0;
  await exchange(threadId, kora, "I live in Dallas", "Noted, Dallas it is.");
  NodeAssert.equal(blobRt.afterTurnCalls.length, 1);
  const call = blobRt.afterTurnCalls[0]!;
  NodeAssert.equal(call.blobId, blob.id);
  NodeAssert.equal(call.threadId, threadId);
  NodeAssert.equal(call.userText, "I live in Dallas");
  NodeAssert.equal(call.assistantText, "Noted, Dallas it is.");
  NodeAssert.ok(call.messageIds.user && call.messageIds.assistant);
  const memory = cards(threadId);
  NodeAssert.equal(memory.length, 1, "one card per turn");
  const card = memory[0]!.payload as {
    cardKind: string;
    version: number;
    receipts: Array<{ kind: string; scope: string; factId: string | null }>;
  };
  NodeAssert.equal(card.cardKind, "memory");
  NodeAssert.equal(card.version, 1);
  NodeAssert.equal(card.receipts.length, 1);
  NodeAssert.equal(card.receipts[0]!.kind, "added");
  NodeAssert.match(memory[0]!.summary, /Remembered: Lives in Dallas/);
  every(memory[0]!.payload);

  // a duplicate settle for the same turn learns nothing twice
  notify(kora, { type: "turn.settled", turnId: `t${seq}`, state: "completed" });
  await new Promise((r) => setImmediate(r));
  NodeAssert.equal(blobRt.afterTurnCalls.length, 1);
  NodeAssert.equal(cards(threadId).length, 1);
});

NodeTest.test(
  "no memory hook for failed, empty, or non-blob turns; no card when nothing was learned",
  async () => {
    const blob = await hire("Mibble");
    const { threadId, kora } = await newBlobThread(blob.id);
    blobRt.afterTurnCalls.length = 0;
    await userTurn(threadId, "hello");
    notify(kora, { type: "turn.started", turnId: "f" });
    notify(kora, {
      type: "content.delta",
      stream: "assistant_text",
      delta: "partial",
      turnId: "f",
    });
    notify(kora, { type: "turn.settled", turnId: "f", state: "failed" });
    await new Promise((r) => setImmediate(r));
    NodeAssert.equal(blobRt.afterTurnCalls.length, 0, "a failed turn is not learned from");

    blobRt.setReceipts([]);
    await exchange(threadId, kora, "thanks", "Anytime!");
    NodeAssert.equal(blobRt.afterTurnCalls.length, 1);
    NodeAssert.equal(cards(threadId).length, 0, "nothing learned -> no card");

    // a code-surface thread never reaches the hook
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-blobs-code-"));
    await engine.dispatch({
      type: "createProject",
      projectId: "codeproj",
      title: "Repo",
      workspaceRoot: dir,
      createdAt: new Date().toISOString(),
    } as never);
    await engine.dispatch({
      type: "createThread",
      threadId: "codeth",
      projectId: "codeproj",
      title: "t",
      modelSelection: { instanceId: "claude", model: "m" },
      runtimeMode: "full-access",
      interactionMode: "default",
      agentMode: "chat",
      branch: null,
      worktreePath: null,
      createdAt: new Date().toISOString(),
    } as never);
    const codeKora = internals.threads.get("codeth")!.koraThreadId;
    const before = blobRt.afterTurnCalls.length;
    await exchange("codeth", codeKora, "refactor", "done");
    NodeAssert.equal(blobRt.afterTurnCalls.length, before);
    blobRt.setReceipts([
      { id: "rcpt1", kind: "added", scope: "you", text: "Lives in Dallas", factId: "f1" },
    ]);
  },
);

NodeTest.test(
  "memory undo re-emits the card one version up with the receipt undone; the module's boolean undo is handled",
  async () => {
    const blob = await hire("Wobbo");
    const { threadId, kora } = await newBlobThread(blob.id);
    blobRt.setReceipts([
      { id: "r-undo", kind: "added", scope: "you", text: "Likes tea", factId: "f9" },
    ]);
    await exchange(threadId, kora, "I like tea", "Got it.");
    NodeAssert.equal(cards(threadId).length, 1);
    const receipt = await run<{ id: string; undone: boolean; kind: string }>(
      BLOB_METHODS.memoryUndo,
      { receiptId: "r-undo" },
    );
    NodeAssert.equal(receipt.id, "r-undo");
    NodeAssert.equal(receipt.undone, true);
    const all = cards(threadId);
    NodeAssert.equal(all.length, 2, "the card is re-emitted, not mutated");
    const latest = all.at(-1)!.payload as { version: number; receipts: Array<{ undone: boolean }> };
    NodeAssert.equal(latest.version, 2);
    NodeAssert.equal(latest.receipts[0]!.undone, true);
    NodeAssert.equal(blobRt.undone.at(-1), "r-undo");
    // The runtime answered true for an id no card carries: a typed error, never a hang.
    NodeAssert.equal(
      (await runFail(BLOB_METHODS.memoryUndo, { receiptId: "never-was" })).code,
      "not_found",
    );
  },
);

NodeTest.test("usage per blob sums its threads' leader tokens", async () => {
  const blob = await hire("Fizzle");
  const a = await newBlobThread(blob.id);
  await exchange(a.threadId, a.kora, "one", "ok");
  await exchange(a.threadId, a.kora, "two", "ok");
  const u = await run<{
    blobId: string;
    total: { input: number; cached: number; output: number; turns: number };
    byThread: Array<{ threadId: string }>;
  }>(BLOB_METHODS.usage, { blobId: blob.id });
  NodeAssert.deepEqual(u.total, { input: 20, cached: 200, output: 10, turns: 2 });
  NodeAssert.equal(u.byThread.length, 1);
  every(u);
});

NodeTest.test(
  "continue on a free model starts a seeded new thread on OpenCode and is not learned from",
  async () => {
    const blob = await hire("Plonk");
    const { threadId, kora } = await newBlobThread(blob.id);
    await exchange(threadId, kora, "write the report", "Working on it.");
    await userTurn(threadId, "and add a summary");
    const soon = Math.floor(Date.now() / 1000) + 3600;
    notify(kora, { type: "turn.started", turnId: "rl" });
    notify(kora, { type: "usage.rate-limit", message: "limit", resetsAt: soon });
    const rl = cards(threadId).filter(
      (a) => (a.payload as { cardKind: string }).cardKind === "rate-limit",
    );
    NodeAssert.equal(rl.length, 1, "one rate-limit card");
    notify(kora, { type: "usage.rate-limit", message: "limit again", resetsAt: soon });
    NodeAssert.equal(
      cards(threadId).filter((a) => (a.payload as { cardKind: string }).cardKind === "rate-limit")
        .length,
      1,
      "not repeated for the same reset",
    );
    notify(kora, { type: "turn.settled", turnId: "rl", state: "failed" });

    // No free model yet: a plain refusal.
    swarmStatus = null;
    const none = await runFail(BLOB_METHODS.continueOnFree, { threadId });
    NodeAssert.match(none.message, /No free model/);

    swarmStatus = {
      ready: true,
      models: {
        available: [
          {
            id: "opencode/big-pickle",
            provider: "zen",
            label: "big-pickle",
            rank: 1,
            maxConcurrent: null,
          },
        ],
        cooling: [],
      },
    };
    const turnsBefore = turns.length;
    const afterBefore = blobRt.afterTurnCalls.length;
    const out = await run<{ threadId: string }>(BLOB_METHODS.continueOnFree, { threadId });
    const fresh = internals.threads.get(out.threadId)!;
    NodeAssert.notEqual(out.threadId, threadId);
    NodeAssert.equal(fresh.projectId, blob.id);
    NodeAssert.deepEqual((fresh as unknown as { modelSelection: unknown }).modelSelection, {
      instanceId: "opencode",
      model: "opencode/big-pickle",
    });
    NodeAssert.equal(created.at(-1)!.agent, "opencode", "routed to the OpenCode chat driver");
    NodeAssert.deepEqual(fresh.origin, {
      kind: "continue",
      jobId: null,
      stepId: null,
      fromThreadId: threadId,
      fromBlobId: null,
    });
    const seed = turns[turnsBefore]!.text!;
    NodeAssert.match(seed, /big-pickle/);
    NodeAssert.match(seed, /write the report/);
    NodeAssert.match(seed, /and add a summary/);
    NodeAssert.match(seed, /has not been answered yet/);
    // the seed turn settles: nothing is learned from the digest
    notify(fresh.koraThreadId, { type: "turn.started", turnId: "s" });
    notify(fresh.koraThreadId, {
      type: "content.delta",
      stream: "assistant_text",
      delta: "Picking this up.",
      turnId: "s",
    });
    notify(fresh.koraThreadId, { type: "turn.settled", turnId: "s", state: "completed" });
    await new Promise((r) => setImmediate(r));
    NodeAssert.equal(blobRt.afterTurnCalls.length, afterBefore, "the seed turn is not extracted");
    const detail = engine.getThreadDetail(out.threadId)!.thread as unknown as {
      origin?: { kind: string };
    };
    NodeAssert.equal(detail.origin?.kind, "continue", "origin rides the thread wire");
  },
);

NodeTest.test(
  "a rate-limited FREE model gets the card too, and continue picks a different free model",
  async () => {
    const blob = await hire("Freebie", {
      engine: { instanceId: "opencode", model: "opencode/big-pickle", effort: null },
    });
    const threadId = `bth${++seq}`;
    await engine.dispatch({
      type: "createThread",
      threadId,
      projectId: blob.id,
      title: "t",
      modelSelection: { instanceId: "opencode", model: "opencode/big-pickle" },
      runtimeMode: "auto-accept-edits",
      interactionMode: "default",
      agentMode: "chat",
      branch: null,
      worktreePath: null,
      createdAt: new Date().toISOString(),
    } as never);
    const kora = internals.threads.get(threadId)!.koraThreadId;
    await exchange(threadId, kora, "find me flights", "Looking.");
    await userTurn(threadId, "go on");
    const reset = Date.now() + 15 * 60_000;
    notify(kora, { type: "turn.started", turnId: "rl-free" });
    notify(kora, {
      type: "usage.rate-limit",
      message: "big-pickle is rate-limited",
      resetsAt: reset,
    });
    notify(kora, { type: "turn.settled", turnId: "rl-free", state: "failed", errorMessage: "x" });
    const rl = cards(threadId).filter(
      (a) => (a.payload as { cardKind: string }).cardKind === "rate-limit",
    );
    NodeAssert.equal(rl.length, 1, "the free-model limit offers the card");
    NodeAssert.equal((rl[0]!.payload as { engine: string }).engine, "opencode");
    swarmStatus = {
      ready: true,
      models: {
        available: [
          {
            id: "opencode/big-pickle",
            provider: "zen",
            label: "big-pickle",
            rank: 1,
            maxConcurrent: null,
          },
        ],
        cooling: [],
      },
    };
    const only = await runFail(BLOB_METHODS.continueOnFree, { threadId });
    NodeAssert.match(only.message, /Every other free model/, "never back onto the limited one");
    (swarmStatus as { models: { available: unknown[] } }).models.available.push({
      id: "opencode/space-bunny-free",
      provider: "zen",
      label: "space-bunny",
      rank: 2,
      maxConcurrent: null,
    });
    const out = await run<{ threadId: string }>(BLOB_METHODS.continueOnFree, { threadId });
    NodeAssert.equal(
      (internals.threads.get(out.threadId) as unknown as { modelSelection: { model: string } })
        .modelSelection.model,
      "opencode/space-bunny-free",
    );
  },
);

NodeTest.test(
  "buildContinueSeed: last six real messages, notices dropped, the open request last",
  () => {
    const msgs = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      text: `m${i}`,
    })) as never[];
    const seed = buildContinueSeed({
      messages: [
        ...msgs,
        { role: "user", text: "[kora] note", notice: { kind: "fleet-note" } } as never,
      ],
      fromEngine: "claude",
      toModel: "free-x",
    });
    NodeAssert.ok(!seed.includes("m3") && seed.includes("m4"), "six messages: m4..m9");
    NodeAssert.ok(!seed.includes("[kora] note"));
    NodeAssert.match(seed, /Your last reply was the end/);
    const open = buildContinueSeed({
      messages: [
        { role: "assistant", text: "a" },
        { role: "user", text: "do it" },
      ] as never,
      fromEngine: "claude",
      toModel: "x",
    });
    NodeAssert.match(open, /Answer it now:\ndo it/);
  },
);

NodeTest.test(
  "about me, defaults and flags round-trip; an over-long about me is a typed error",
  async () => {
    NodeAssert.deepEqual(await run(BLOB_METHODS.getAboutMe), { text: "" });
    NodeAssert.deepEqual(await run(BLOB_METHODS.setAboutMe, { text: "I am Sam's cofounder." }), {
      text: "I am Sam's cofounder.",
    });
    NodeAssert.deepEqual(await run(BLOB_METHODS.getAboutMe), { text: "I am Sam's cofounder." });
    const tooLong = await runFail(BLOB_METHODS.setAboutMe, { text: "x".repeat(24_001) });
    NodeAssert.match(tooLong.message, /limit is 24,000/);
    NodeAssert.equal(
      (await run<{ text: string }>(BLOB_METHODS.getAboutMe)).text,
      "I am Sam's cofounder.",
      "a refused write keeps the old note",
    );

    const d0 = await run<{ engine: unknown; permission: string; soulTemplate: string }>(
      BLOB_METHODS.getDefaults,
    );
    NodeAssert.equal(d0.engine, null);
    NodeAssert.equal(d0.permission, "auto");
    const saved = await run<{ permission: string }>(BLOB_METHODS.setDefaults, {
      engine: { instanceId: "codex", model: "gpt-5-codex", effort: null },
      permission: "ask",
      soulTemplate: "Be brief.",
    });
    NodeAssert.equal(saved.permission, "ask");
    NodeAssert.equal(
      (await run<{ soulTemplate: string }>(BLOB_METHODS.getDefaults)).soulTemplate,
      "Be brief.",
    );
    NodeAssert.equal(
      (
        await runFail(BLOB_METHODS.setDefaults, {
          engine: { instanceId: "nope", model: "m", effort: null },
          permission: "ask",
          soulTemplate: "",
        })
      ).code,
      "unknown_engine",
    );
    // a new blob with no engine of its own takes the defaults' engine
    const viaDefaults = await hire("Tiki", { engine: null });
    NodeAssert.equal(viaDefaults.engine.instanceId, "codex");
    await run(BLOB_METHODS.setDefaults, { engine: null, permission: "auto", soulTemplate: "x" });

    const flags = await run<{
      concurrencyWarningDismissed: boolean;
      galleryDismissed: boolean;
      claudeMemoryFallback: boolean;
    }>(BLOB_METHODS.setFlag, { key: "concurrencyWarningDismissed", value: true });
    NodeAssert.deepEqual(flags, {
      concurrencyWarningDismissed: true,
      galleryDismissed: false,
      claudeMemoryFallback: false,
    });
  },
);

NodeTest.test(
  "memory RPCs adapt the memory module's shapes to the wire (no undefined)",
  async () => {
    const list = await run<{ facts: Array<Record<string, unknown>>; core: string }>(
      BLOB_METHODS.memoryList,
      { scope: "you", blobId: null, includeRetired: false },
    );
    NodeAssert.equal(list.core, "core you");
    NodeAssert.deepEqual(list.facts[0], {
      id: "f1",
      scope: "you",
      blobId: null,
      text: "x",
      since: 1,
      until: null,
      confidence: 0.9,
      important: false,
      sourceThreadId: "x",
      sourceMessageId: "y",
      lastUsedAt: null,
    });
    every(list);
    NodeAssert.equal(
      (
        await run<{ core: string }>(BLOB_METHODS.memoryList, {
          scope: "blob",
          blobId: "b",
          includeRetired: false,
        })
      ).core,
      "core blob",
    );
    const edited = await run<{ text: string }>(BLOB_METHODS.memoryEdit, {
      factId: "f1",
      text: "  y  ",
    });
    NodeAssert.equal(edited.text, "y");
    const star = await run<{ important: boolean }>(BLOB_METHODS.memoryImportant, {
      factId: "f1",
      important: true,
    });
    NodeAssert.equal(star.important, true);
    NodeAssert.equal(
      (await runFail(BLOB_METHODS.memoryEdit, { factId: "f1", text: "  " })).code,
      "empty",
    );
    NodeAssert.equal(
      (await runFail(BLOB_METHODS.memoryEdit, { factId: "nope", text: "z" })).code,
      "not_found",
    );
    const forgot = await run<{ until: number | null; text: string }>(BLOB_METHODS.memoryForget, {
      factId: "f1",
    });
    NodeAssert.ok(typeof forgot.until === "number", "a forgotten fact answers as retired");
    NodeAssert.equal(forgot.text, "y");
    NodeAssert.equal(blobRt.facts.has("f1"), false);
    const search = await run<{ episodes: Array<Record<string, unknown>> }>(
      BLOB_METHODS.memorySearch,
      { blobId: "b", query: "q", limit: 999 },
    );
    NodeAssert.deepEqual(search.episodes[0], {
      threadId: "t",
      title: "",
      summary: "snip",
      at: 3,
      score: 0.5,
    });
    NodeAssert.deepEqual(
      await run(BLOB_METHODS.memorySetCore, { scope: "you", blobId: null, text: " hi " }),
      { core: "hi" },
    );
    NodeAssert.equal(
      (await runFail(BLOB_METHODS.memorySetCore, { scope: "blob", blobId: null, text: "hi" })).code,
      "blob_required",
    );
  },
);

NodeTest.test(
  "a held memory is confirmed or declined from its card, which is re-emitted with the answer",
  async () => {
    const blob = await hire("Junip2");
    const { threadId, kora } = await newBlobThread(blob.id);
    blobRt.setReceipts([
      {
        id: "r-held",
        kind: "held",
        scope: "blob",
        text: "Has a rash",
        previousText: null,
        factId: null,
        undone: false,
        reason: "sensitive",
      },
    ]);
    await exchange(threadId, kora, "I have a rash", "Sorry to hear.");
    const saved = await run<{ kind: string; factId: string | null; id: string }>(
      BLOB_METHODS.memoryConfirm,
      { receiptId: "r-held", save: true },
    );
    NodeAssert.deepEqual(
      [saved.id, saved.kind, saved.factId],
      ["rnew", "added", "f2"],
      "the approval's own receipt (Undo works on it)",
    );
    const latest = cards(threadId).at(-1)!.payload as {
      version: number;
      receipts: Array<{ kind: string }>;
    };
    NodeAssert.deepEqual([latest.version, latest.receipts[0]!.kind], [2, "added"]);
    const declined = await run<{ undone: boolean }>(BLOB_METHODS.memoryConfirm, {
      receiptId: "r-held",
      save: false,
    });
    NodeAssert.equal(declined.undone, true);
    blobRt.setReceipts([
      { id: "rcpt1", kind: "added", scope: "you", text: "Lives in Dallas", factId: "f1" },
    ]);
  },
);

NodeTest.test(
  "files lists a blob's outputs/ and files/; blobs.list and blobs.subscribe carry a JSON-safe snapshot",
  async () => {
    const blob = await hire("Wumpy");
    NodeFS.writeFileSync(NodePath.join(blob.workspace, "outputs", "brief.md"), "# hi");
    NodeFS.writeFileSync(NodePath.join(blob.workspace, "files", "in.csv"), "a,b");
    const files = await run<{ files: Array<{ relPath: string }> }>(BLOB_METHODS.files, {
      blobId: blob.id,
      since: null,
    });
    NodeAssert.deepEqual(files.files.map((f) => f.relPath).sort(), [
      "files/in.csv",
      "outputs/brief.md",
    ]);
    const view = await run<{
      seq: number;
      blobs: Array<{ id: string }>;
      engines: { opencode: { ready: boolean } };
      koraReady: boolean;
    }>(BLOB_METHODS.list);
    NodeAssert.ok(view.blobs.some((b) => b.id === blob.id));
    every(view);
    NodeAssert.equal(view.koraReady, false, "no Chief seeded yet");
    blobRt.profiles.set("blob_kora", {
      ...blob,
      id: "blob_kora",
      role: "chief",
      name: "Kora",
    } as BlobProfile);
    swarmStatusReads = 0;
    NodeAssert.equal((await run<{ koraReady: boolean }>(BLOB_METHODS.list)).koraReady, true);
    NodeAssert.equal(
      swarmStatusReads,
      1,
      "one snapshot reads the swarm status once, not once per field",
    );
    NodeAssert.equal(
      view.engines.opencode.ready,
      true,
      "the free model from the swarm status counts",
    );

    const subscribeOnce = () =>
      Effect.runPromise(
        (
          blobsHandlers[BLOB_METHODS.subscribe]!({}) as Stream.Stream<{
            type: string;
            snapshot: { blobs: unknown[] };
          }>
        ).pipe(Stream.take(1), Stream.runCollect),
      );
    const listenersBefore = blobRt.listenerCount();
    const frames = await subscribeOnce();
    // every subscription frees its BlobStore listener when its stream ends (live QA #3: MaxListenersExceededWarning)
    for (let i = 0; i < 25; i++) await subscribeOnce();
    NodeAssert.equal(blobRt.listenerCount(), listenersBefore, "no BlobStore listener build-up");
    NodeAssert.equal(frames[0]!.type, "snapshot");
    NodeAssert.ok(frames[0]!.snapshot.blobs.length >= 1);
    every(frames[0]);
  },
);

NodeTest.test(
  "without a runtime blobs module every write answers a typed 'unavailable' error, never a hang",
  async () => {
    const keep = (await import("./host.ts")).host();
    setHost({ ...keep, blobs: undefined } as unknown as UiHost);
    try {
      const err = await runFail(BLOB_METHODS.create, { draft: draft("Ghost"), proposalId: null });
      NodeAssert.equal(err.code, "unavailable");
      const view = await run<{ blobs: unknown[]; koraReady: boolean }>(BLOB_METHODS.list);
      NodeAssert.deepEqual([view.blobs.length, view.koraReady], [0, false]);
      NodeAssert.equal((await runFail(BLOB_METHODS.jobGet, { jobId: "j" })).code, "unavailable");
    } finally {
      setHost(keep);
    }
  },
);

NodeTest.test(
  "toWireReceipt maps the memory module's pending receipt to a held wire receipt",
  () => {
    NodeAssert.deepEqual(
      toWireReceipt({
        id: "p1",
        kind: "pending",
        factId: "",
        pendingId: "p1",
        text: "Has a rash",
        blobId: "b",
      }),
      {
        id: "p1",
        kind: "held",
        scope: "blob",
        text: "Has a rash",
        previousText: null,
        factId: null,
        undone: false,
        reason: null,
      },
    );
  },
);

NodeTest.test(
  "when the runtime store owns about-me / defaults / flags the handlers use it (and its change event)",
  async () => {
    const keep = (await import("./host.ts")).host();
    const calls: string[] = [];
    const store = {
      ...keep.blobs!.store,
      aboutMe: () => "from the runtime",
      setAboutMe: (t: string) => {
        calls.push(`about:${t}`);
        return t.slice(0, 5);
      },
      defaults: () => ({ engine: null, permission: "ask" as const, soulTemplate: "rt" }),
      setDefaults: (d: unknown) => {
        calls.push("defaults");
        return d as never;
      },
      flags: () => ({
        concurrencyWarningDismissed: false,
        galleryDismissed: true,
        claudeMemoryFallback: false,
      }),
      setFlag: (k: string, v: boolean) => {
        calls.push(`flag:${k}=${v}`);
        return {
          concurrencyWarningDismissed: v,
          galleryDismissed: true,
          claudeMemoryFallback: false,
        };
      },
    };
    setHost({ ...keep, blobs: { ...keep.blobs!, store } } as unknown as UiHost);
    try {
      NodeAssert.deepEqual(await run(BLOB_METHODS.getAboutMe), { text: "from the runtime" });
      NodeAssert.deepEqual(await run(BLOB_METHODS.setAboutMe, { text: "abcdefgh" }), {
        text: "abcde",
      });
      NodeAssert.equal(
        (await run<{ permission: string }>(BLOB_METHODS.getDefaults)).permission,
        "ask",
      );
      await run(BLOB_METHODS.setFlag, { key: "concurrencyWarningDismissed", value: true });
      NodeAssert.deepEqual(calls, ["about:abcdefgh", "flag:concurrencyWarningDismissed=true"]);
      const view = await run<{ flags: { galleryDismissed: boolean } }>(BLOB_METHODS.list);
      NodeAssert.equal(view.flags.galleryDismissed, true, "the snapshot shows the runtime's flags");
      NodeAssert.equal(
        (await runFail(BLOB_METHODS.setAboutMe, { text: "x".repeat(24_001) })).code,
        "too_large",
      );
    } finally {
      setHost(keep);
    }
  },
);

NodeTest.test(
  "a blob whose profile points outside the Blobs folder is neither mirrored nor moved to the Trash",
  async () => {
    const blob = await hire("Rogue");
    const outside = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-outside-"));
    blobRt.profiles.set(blob.id, { ...blob, workspace: outside } as BlobProfile);
    engine.upsertBlobProject({ ...blob, id: "blob_elsewhere", workspace: outside } as BlobProfile);
    NodeAssert.equal(internals.projects.has("blob_elsewhere"), false);
    const err = await runFail(BLOB_METHODS.delete, { blobId: blob.id, confirmName: "Rogue" });
    NodeAssert.equal(err.code, "outside_blobs_root");
    NodeAssert.ok(NodeFS.existsSync(outside));
    NodeAssert.ok(blobRt.profiles.has(blob.id));
  },
);

NodeTest.test("jsonSafe drops undefined leaves (the wire dies on them)", () => {
  NodeAssert.deepEqual(jsonSafe({ a: 1, b: undefined, c: { d: undefined, e: [undefined, 2] } }), {
    a: 1,
    c: { e: [null, 2] },
  });
});

NodeTest.test(
  "a blob thread starts in its profile's posture, and its origin rides the turn to the runtime",
  async () => {
    const ask = await hire("Cautious", { permission: "ask" });
    const { threadId } = await newBlobThread(ask.id); // the composer said "auto"
    NodeAssert.equal(
      (internals.threads.get(threadId) as unknown as { runtimeMode: string }).runtimeMode,
      "approval-required",
    );
    const full = await hire("Bold", { permission: "full" });
    const second = await newBlobThread(full.id, "full-access"); // the client now sends the blob's own posture
    NodeAssert.equal(
      (internals.threads.get(second.threadId) as unknown as { runtimeMode: string }).runtimeMode,
      "full-access",
    );

    const origin = {
      kind: "kora",
      jobId: null,
      stepId: null,
      fromThreadId: null,
      fromBlobId: null,
    };
    (internals.threads.get(threadId) as unknown as { origin: unknown }).origin = origin;
    await userTurn(threadId, "hello");
    NodeAssert.deepEqual((turns.at(-1) as unknown as { blobOrigin: unknown }).blobOrigin, origin);
    await userTurn(second.threadId, "hello again");
    NodeAssert.equal(
      "blobOrigin" in (turns.at(-1) as object),
      false,
      "a thread the user started has no origin to forward",
    );
  },
);

NodeTest.test(
  "blobs.selfChange.undo: runtime undo, then the receipt card flips to undone (new version)",
  async () => {
    const keep = (await import("./host.ts")).host();
    const undoCalls: string[] = [];
    setHost({
      ...keep,
      blobs: {
        ...keep.blobs!,
        undoSelfChange: (token: string) => {
          undoCalls.push(token);
          return token === "undo_good";
        },
      },
    } as unknown as UiHost);
    try {
      const blob = await hire("Editor");
      const { threadId } = await newBlobThread(blob.id);
      const rec = internals.threads.get(threadId)!;
      engine.appendBlobCard(rec as never, {
        cardKind: "self-change",
        cardId: "sc_1",
        version: 1,
        what: "Updated my soul",
        undoToken: "undo_good",
        undone: false,
      });
      NodeAssert.deepEqual(await run(BLOB_METHODS.undoSelfChange, { token: "undo_good" }), {
        undone: true,
      });
      const latest = cards(threadId)
        .map((a) => a.payload as { cardId: string; version: number; undone?: boolean })
        .filter((c) => c.cardId === "sc_1")
        .sort((a, b) => b.version - a.version)[0]!;
      NodeAssert.deepEqual([latest.version, latest.undone], [2, true]);
      const again = await runFail(BLOB_METHODS.undoSelfChange, { token: "undo_old" });
      NodeAssert.equal(again.code, "not_undoable");
      NodeAssert.deepEqual(undoCalls, ["undo_good", "undo_old"]);
    } finally {
      setHost(keep);
    }
  },
);

NodeTest.test(
  "resolveBlobFile: only real files inside the workspace (no .., absolute, symlink escape, directory); 413 when huge",
  async () => {
    const { resolveBlobFile, BLOB_FILE_MAX_BYTES } = await import("./blobsFs.ts");
    const ws = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-bf-ws-"));
    const outside = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-bf-out-"));
    NodeFS.mkdirSync(NodePath.join(ws, "outputs"));
    NodeFS.writeFileSync(NodePath.join(ws, "outputs", "a.csv"), "a,b\n1,2\n");
    NodeFS.writeFileSync(NodePath.join(outside, "secret.txt"), "nope");
    NodeFS.symlinkSync(outside, NodePath.join(ws, "link"));
    NodeFS.symlinkSync(NodePath.join(outside, "secret.txt"), NodePath.join(ws, "s.txt"));
    const ok = resolveBlobFile(ws, "outputs/a.csv");
    NodeAssert.ok(ok.ok && ok.mimeType === "text/csv" && ok.size === 8);
    for (const bad of [
      "../x",
      "outputs/../../x",
      NodePath.join(outside, "secret.txt"),
      "link/secret.txt",
      "s.txt",
      "outputs",
      "",
      "nope.txt",
      "a\0b",
    ])
      NodeAssert.deepEqual(
        resolveBlobFile(ws, bad),
        { ok: false, status: 404 },
        `refuses ${JSON.stringify(bad)}`,
      );
    const big = NodePath.join(ws, "big.bin");
    NodeFS.closeSync(NodeFS.openSync(big, "w"));
    NodeFS.truncateSync(big, BLOB_FILE_MAX_BYTES + 1);
    NodeAssert.deepEqual(resolveBlobFile(ws, "big.bin"), { ok: false, status: 413 });
  },
);

// ── Phase 2: Kora's team over the real engine bridge ─────────────────────────────────────────────────────────────
const asHost = async (extra: Record<string, unknown>) => {
  const keep = (await import("./host.ts")).host();
  setHost({ ...keep, blobs: { ...keep.blobs!, ...extra } } as unknown as UiHost);
  return () => setHost(keep);
};

NodeTest.test(
  "templates / templates.hire / create with a proposalId / proposal.dismiss / job.* / confirm.resolve call the runtime and re-sync the roster",
  async () => {
    const calls: unknown[][] = [];
    const store = blobRt.runtime.store;
    const mk = (name: string, templateId: string | null) =>
      store.create({
        name,
        title: "T",
        soul: "s",
        engine: { instanceId: "claude", model: "sonnet", effort: null },
        permission: "auto",
        outfit: null,
        templateId,
      }) as BlobProfile;
    const restore = await asHost({
      templates: () => [
        { id: "popo", draft: draft("Popo"), blurb: "b", exampleAsks: [], wants: [] },
      ],
      hireTemplates: async (ids: string[]) => {
        calls.push(["hireTemplates", ids]);
        return ids.map((id) => mk(`Tpl ${id}`, id));
      },
      hireDraft: async (d: { name: string; engine: unknown }, proposalId: string | null) => {
        calls.push(["hireDraft", d.name, d.engine, proposalId]);
        return mk(d.name, null);
      },
      proposalDismiss: async (id: string) => void calls.push(["dismiss", id]),
      jobGet: async (id: string) => ({
        cardKind: "job",
        cardId: id,
        version: 3,
        title: "J",
        status: "running",
        steps: [],
        createdAt: 1,
      }),
      jobCancel: async (id: string, step: string | null) => {
        calls.push(["cancel", id, step]);
        return {
          cardKind: "job",
          cardId: id,
          version: 4,
          title: "J",
          status: "cancelled",
          steps: [],
          createdAt: 1,
        };
      },
      jobFeedback: async (id: string, step: string, r: string) =>
        void calls.push(["feedback", id, step, r]),
      confirmResolve: async (cardId: string, accept: boolean) => {
        calls.push(["confirm", cardId, accept]);
        mk("FromConfirm", "plonk");
        return { ok: true, message: "FromConfirm joined", profiles: [] };
      },
    });
    try {
      const tpl = await run<{ templates: Array<{ id: string }> }>(BLOB_METHODS.templates);
      NodeAssert.deepEqual(
        tpl.templates.map((t) => t.id),
        ["popo"],
      );
      const hired = await run<{ profiles: BlobProfile[] }>(BLOB_METHODS.hireTemplates, {
        templateIds: ["a", "b"],
      });
      NodeAssert.equal(hired.profiles.length, 2);
      for (const p of hired.profiles)
        NodeAssert.ok(internals.projects.has(p.id), "project mirror follows the hire");
      const tweaked = await run<BlobProfile>(BLOB_METHODS.create, {
        draft: draft("Tweaked"),
        proposalId: "prop_1",
      });
      NodeAssert.deepEqual(calls.at(-1), [
        "hireDraft",
        "Tweaked",
        { instanceId: "claude", model: "sonnet", effort: null },
        "prop_1",
      ]);
      NodeAssert.ok(internals.projects.has(tweaked.id));
      await run(BLOB_METHODS.create, { draft: draft("Plain"), proposalId: null });
      NodeAssert.equal((calls.at(-1) as unknown[])[3], null);
      await run(BLOB_METHODS.proposalDismiss, { proposalId: "prop_1" });
      const job = await run<{ version: number }>(BLOB_METHODS.jobGet, { jobId: "job_1" });
      NodeAssert.equal(job.version, 3);
      const cancelled = await run<{ status: string }>(BLOB_METHODS.jobCancel, {
        jobId: "job_1",
        stepId: null,
      });
      NodeAssert.equal(cancelled.status, "cancelled");
      await run(BLOB_METHODS.jobFeedback, { jobId: "job_1", stepId: "s1", reaction: "redo" });
      const before = internals.projects.size;
      const conf = await run<{ ok: boolean; message: string }>(BLOB_METHODS.confirmResolve, {
        cardId: "conf_1",
        accept: true,
      });
      NodeAssert.deepEqual([conf.ok, conf.message], [true, "FromConfirm joined"]);
      NodeAssert.equal(
        internals.projects.size,
        before + 1,
        "a hire made by a click shows up in the sidebar at once",
      );
      NodeAssert.deepEqual(
        calls.filter((c) => ["dismiss", "cancel", "feedback"].includes(String(c[0]))),
        [
          ["dismiss", "prop_1"],
          ["cancel", "job_1", null],
          ["feedback", "job_1", "s1", "redo"],
        ],
      );
      every(job);
      every(conf);
    } finally {
      restore();
    }
    NodeAssert.equal(
      (await runFail(BLOB_METHODS.confirmResolve, { cardId: "c", accept: true })).code,
      "unavailable",
    );
  },
);

NodeTest.test(
  "the engine bridge drives a delegated job: startThread (from Kora), approval -> needs-you -> running, settle -> idle with the last answer, interrupt, cards, notes",
  async () => {
    const kora = await hire("KoraLike");
    const popo = await hire("PopoLike");
    const { threadId: koraTid, kora: koraKt } = await newBlobThread(kora.id);
    await exchange(koraTid, koraKt, "plan my week", "On it.");
    const bridge = makeBlobEngineBridge(engine);
    NodeAssert.equal(typeof bridge.interrupt, "function");
    const settled: Array<{ threadId: string; ok: boolean; koraThreadId: string }> = [];
    const off = bridge.onSettled((e) => settled.push(e));
    const attention: string[] = [];
    const offAttn = engine.onBlobAttention((e) =>
      attention.push(`${e.blobId === popo.id ? "popo" : "other"}:${e.kind}`),
    );
    const origin = {
      kind: "kora",
      jobId: "job_1",
      stepId: "s1",
      fromThreadId: koraKt,
      fromBlobId: kora.id,
    } as const;
    const started = await bridge.startThread({
      blobId: popo.id,
      title: "Research",
      prompt: "Goal: research X. Done: outputs/x.md.",
      origin,
      fromKoraThreadId: koraKt,
    });
    NodeAssert.ok("threadId" in started, JSON.stringify(started));
    if (!("threadId" in started)) return;
    const rec = internals.threads.get(started.threadId)!;
    NodeAssert.deepEqual(rec.origin, origin, "the thread is 'from Kora'");
    NodeAssert.equal(started.koraThreadId, rec.koraThreadId);
    NodeAssert.equal(rec.messages[0]?.text, "Goal: research X. Done: outputs/x.md.");
    NodeAssert.equal(bridge.snapshot(started.threadId)!.state, "running");
    NodeAssert.equal(bridge.runningCount(popo.id), 1);
    // an approval opens: watchers are poked (so the job card says "needs you"), the snapshot says needs-you
    const kt = rec.koraThreadId;
    notify(kt, { type: "turn.started", turnId: "d1" });
    notify(kt, {
      type: "approval.opened",
      requestId: "req1",
      requestKind: "command",
      title: "Run a command",
      turnId: "d1",
    });
    // (a turn that starts also pokes the watchers: a step waiting on the user is working again the moment they answer)
    NodeAssert.equal(settled.length, 2);
    NodeAssert.equal(bridge.snapshot(started.threadId)!.state, "needs-you");
    NodeAssert.deepEqual(attention, ["popo:needs-you"]);
    // the user approves: poked again, now running
    notify(kt, { type: "approval.resolved", requestId: "req1", decision: "accept" });
    NodeAssert.equal(settled.length, 3);
    NodeAssert.equal(bridge.snapshot(started.threadId)!.state, "running");
    // it answers and the turn settles
    notify(kt, {
      type: "content.delta",
      stream: "assistant_text",
      delta: "The brief is in outputs/x.md.",
      turnId: "d1",
    });
    notify(kt, { type: "turn.settled", turnId: "d1", state: "completed" });
    await new Promise((r) => setImmediate(r));
    const last = settled.at(-1)!;
    NodeAssert.deepEqual([last.threadId, last.ok, last.koraThreadId], [started.threadId, true, kt]);
    const session = bridge.snapshot(started.threadId)!;
    NodeAssert.deepEqual(
      [session.state, session.finalText],
      ["idle", "The brief is in outputs/x.md."],
    );
    NodeAssert.deepEqual(
      attention,
      ["popo:needs-you"],
      "a delegated step finishing is Kora's news, not the user's",
    );
    // a follow-up turn, then Cancel: the engine interrupts that blob thread's session
    await bridge.sendToThread(started.threadId, "One more thing", origin);
    notify(kt, { type: "turn.started", turnId: "d2" });
    interrupts.length = 0;
    await bridge.interrupt!(started.threadId);
    NodeAssert.deepEqual(interrupts, [kt]);
    notify(kt, { type: "turn.settled", turnId: "d2", state: "interrupted" });
    await new Promise((r) => setImmediate(r));
    NodeAssert.equal(settled.at(-1)!.ok, false, "an interrupted turn settles not-ok");
    await bridge.interrupt!("no-such-thread"); // unknown thread: quiet no-op
    // cards on Kora's thread: job v1 -> v2, a confirm card, a proposal; the latest version is what the wire keeps per id
    const job = (version: number, status: string) => ({
      cardKind: "job",
      cardId: "job_1",
      version,
      title: "J",
      status,
      steps: [],
      createdAt: 1,
    });
    bridge.appendCard(koraKt, job(1, "running") as never);
    bridge.appendCard(koraKt, job(2, "done") as never);
    bridge.appendCard(koraKt, {
      cardKind: "confirm",
      cardId: "conf_1",
      version: 1,
      action: "edit",
      blobId: popo.id,
      blobName: "PopoLike",
      summary: "Update PopoLike",
      details: ["Title: A -> B"],
      state: "open",
      result: null,
    } as never);
    bridge.appendCard(koraKt, {
      cardKind: "proposal",
      cardId: "prop_1",
      version: 1,
      draft: draft("Tiki"),
      state: "open",
      hiredBlobId: null,
    } as never);
    const payloads = cards(koraTid).map(
      (a) => a.payload as { cardKind: string; cardId: string; version: number },
    );
    for (const [k, id, n] of [
      ["job", "job_1", 2],
      ["confirm", "conf_1", 1],
      ["proposal", "prop_1", 1],
    ] as const) {
      const mine = payloads.filter((c) => c.cardId === id);
      NodeAssert.ok(mine.length >= 1 && mine.every((c) => c.cardKind === k), `${k} card`);
      NodeAssert.equal(Math.max(...mine.map((c) => c.version)), n);
    }
    NodeAssert.match(
      cards(koraTid).find((a) => (a.payload as { cardKind: string }).cardKind === "confirm")!
        .summary,
      /Update PopoLike/,
    );
    every(payloads);
    // a note for Kora is delivered as a Kora-authored turn when she is idle
    const t0 = turns.length;
    bridge.queueNote(koraKt, '[kora] PopoLike finished "Research".');
    await new Promise((r) => setTimeout(r, 450));
    NodeAssert.ok(
      turns.slice(t0).some((t) => /PopoLike finished/.test(`${t.text ?? ""}${t.koraNotice ?? ""}`)),
      "the note reached Kora",
    );
    off();
    offAttn();
  },
);

NodeTest.test(
  "attention events: a user thread that settles / fails / asks is announced; a refused startThread says why",
  async () => {
    const blob = await hire("Attn");
    const { threadId, kora: kt } = await newBlobThread(blob.id);
    const seen: string[] = [];
    const off = engine.onBlobAttention((e) => e.blobId === blob.id && seen.push(e.kind));
    await exchange(threadId, kt, "hello", "hi there");
    await userTurn(threadId, "again");
    notify(kt, { type: "turn.started", turnId: "x1" });
    notify(kt, {
      type: "user-input.requested",
      requestId: "q1",
      questions: [{ question: "Which?", options: [] }],
      turnId: "x1",
    });
    notify(kt, { type: "user-input.resolved", requestId: "q1", answers: {} });
    notify(kt, { type: "turn.settled", turnId: "x1", state: "failed", errorMessage: "boom" });
    NodeAssert.deepEqual(seen, ["settled", "needs-you", "failed"]);
    off();
    const bridge = makeBlobEngineBridge(engine);
    const r = await bridge.startThread({
      blobId: "blob_nope",
      title: "t",
      prompt: "p",
      origin: { kind: "kora", jobId: null, stepId: null, fromThreadId: null, fromBlobId: null },
      fromKoraThreadId: null,
    });
    NodeAssert.deepEqual(r, { refused: "unknown" });
  },
);

NodeTest.test(
  "macOS notifier: silent while any UI client is connected, quiet generic text, rate limited, switchable",
  async () => {
    const { makeBlobNotifier, notificationText } = await import("./blobsNotify.ts");
    const { wsClientCount, wsClientOpened, wsClientClosed } = await import("./wsClients.ts");
    const posted: Array<[string, string]> = [];
    let t = 1_000_000;
    let enabled = true;
    const notify1 = makeBlobNotifier({
      clients: wsClientCount,
      nameOf: (id) => (id === "b1" ? "Popo" : id === "b2" ? 'Evil "name"\\ \n' : null),
      post: (title, body) => posted.push([title, body]),
      now: () => t,
      enabled: () => enabled,
    });
    // a connected client: nothing
    wsClientOpened();
    NodeAssert.equal(notify1({ threadId: "t1", blobId: "b1", kind: "settled" }), false);
    wsClientClosed();
    NodeAssert.equal(wsClientCount(), 0);
    // nobody looking: one quiet line, no thread title / text, same event not repeated
    NodeAssert.equal(notify1({ threadId: "t1", blobId: "b1", kind: "settled" }), true);
    NodeAssert.deepEqual(posted, [["Kora", "Popo is done."]]);
    t += 60_000;
    NodeAssert.equal(
      notify1({ threadId: "t1", blobId: "b1", kind: "settled" }),
      false,
      "same thread + kind within 2 minutes",
    );
    NodeAssert.equal(
      notify1({ threadId: "t1", blobId: "b1", kind: "needs-you" }),
      true,
      "a different kind is news",
    );
    NodeAssert.equal(posted.at(-1)![1], "Popo needs you.");
    t += 1_000;
    NodeAssert.equal(
      notify1({ threadId: "t9", blobId: "b1", kind: "failed" }),
      false,
      "global gap: two notifications are never within 8 seconds",
    );
    t += 10_000;
    NodeAssert.equal(notify1({ threadId: "t9", blobId: "b1", kind: "failed" }), true);
    NodeAssert.equal(posted.at(-1)![1], "Popo hit a problem.");
    NodeAssert.equal(
      notify1({ threadId: "tx", blobId: "gone", kind: "settled" }),
      false,
      "unknown blob",
    );
    enabled = false;
    t += 600_000;
    NodeAssert.equal(
      notify1({ threadId: "t2", blobId: "b1", kind: "settled" }),
      false,
      "switched off (QA stacks)",
    );
    enabled = true;
    // text is built from the blob name only, with quotes and control characters stripped
    const text = notificationText('Evil "name"\\ \n', "settled");
    NodeAssert.ok(!/["\\\n]/.test(text.body), text.body);
    // burst cap: at most 6 per ten minutes
    const burst = makeBlobNotifier({
      clients: () => 0,
      nameOf: () => "Popo",
      post: () => {},
      now: () => t,
      perThreadGapMs: 0,
      globalGapMs: 0,
    });
    let sent = 0;
    for (let i = 0; i < 10; i++) {
      t += 1000;
      if (burst({ threadId: `b${i}`, blobId: "b1", kind: "settled" })) sent++;
    }
    NodeAssert.equal(sent, 6);
  },
);

NodeTest.describe("a blob thread's posture comes from the blob, not the client", () => {
  const send = (threadId: string, blobId: string, runtimeMode: string, text = "hi") =>
    engine.dispatch({
      type: "turn.start",
      commandId: `c${++seq}`,
      threadId,
      message: { messageId: `m_${++seq}`, role: "user", text, attachments: [] },
      modelSelection: { instanceId: "claude", model: "sonnet" },
      runtimeMode,
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: blobId,
          title: "t",
          modelSelection: { instanceId: "claude", model: "sonnet" },
          runtimeMode,
          interactionMode: "default",
          agentMode: "chat",
          branch: null,
          worktreePath: null,
          createdAt: new Date().toISOString(),
        },
      },
      createdAt: new Date().toISOString(),
    } as never);
  const modeOf = (threadId: string) => engine.getThreadDetail(threadId)!.thread.runtimeMode;
  const lastKoraMode = (threadId: string) =>
    permissionCalls
      .filter(([id]) => id === internals.threads.get(threadId)!.koraThreadId)
      .at(-1)?.[1];

  NodeTest.test(
    "the composer's Full default (bootstrap create + turn.start) cannot widen an Ask or Auto blob",
    async () => {
      const ask = await hire("PostureAsk", { permission: "ask" });
      const auto = await hire("PostureAuto", { permission: "auto" });
      await send("bp-ask", ask.id, "full-access");
      await send("bp-auto", auto.id, "full-access");
      NodeAssert.equal(modeOf("bp-ask"), "approval-required");
      NodeAssert.equal(
        lastKoraMode("bp-ask"),
        "supervised",
        "the runtime session is told the same",
      );
      NodeAssert.equal(modeOf("bp-auto"), "auto");
      NodeAssert.equal(lastKoraMode("bp-auto"), "auto");
    },
  );

  NodeTest.test(
    "a create command never sets the posture: not wider, not narrower; the permission menu does",
    async () => {
      const auto = await hire("PostureNarrow", { permission: "auto" });
      await send("bp-narrow", auto.id, "approval-required");
      NodeAssert.equal(
        modeOf("bp-narrow"),
        "auto",
        "a stale narrower default is not a deliberate pick either",
      );
      await engine.dispatch({
        type: "createThread",
        threadId: "bp-create",
        projectId: auto.id,
        title: "t",
        modelSelection: { instanceId: "claude", model: "sonnet" },
        runtimeMode: "full-access",
        interactionMode: "default",
        agentMode: "chat",
        branch: null,
        worktreePath: null,
        createdAt: new Date().toISOString(),
      } as never);
      NodeAssert.equal(modeOf("bp-create"), "auto");
      await engine.dispatch({
        type: "setThreadRuntimeMode",
        commandId: `c${++seq}`,
        threadId: "bp-narrow",
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      } as never);
      NodeAssert.equal(
        modeOf("bp-narrow"),
        "approval-required",
        "the menu can narrow, and it sticks",
      );
    },
  );

  NodeTest.test(
    "a later turn.start carrying full-access does not escalate an existing blob thread",
    async () => {
      const ask = await hire("PostureLater", { permission: "ask" });
      await send("bp-later", ask.id, "approval-required");
      await userTurn("bp-later", "again");
      await engine.dispatch({
        type: "turn.start",
        commandId: `c${++seq}`,
        threadId: "bp-later",
        message: { messageId: `m_${++seq}`, role: "user", text: "x", attachments: [] },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: new Date().toISOString(),
      } as never);
      NodeAssert.equal(modeOf("bp-later"), "approval-required");
      NodeAssert.equal(lastKoraMode("bp-later"), "supervised");
    },
  );

  NodeTest.test("a Full blob runs Full; Codex on Auto is the workspace-write sandbox", async () => {
    const full = await hire("PostureFull", { permission: "full" });
    await send("bp-full2", full.id, "approval-required");
    NodeAssert.equal(modeOf("bp-full2"), "full-access");
    const codex = await hire("PostureCodex", {
      permission: "auto",
      engine: { instanceId: "codex", model: "gpt-5.5", effort: null },
    });
    await engine.dispatch({
      type: "turn.start",
      commandId: `c${++seq}`,
      threadId: "bp-codex",
      message: { messageId: `m_${++seq}`, role: "user", text: "hi", attachments: [] },
      modelSelection: { instanceId: "codex", model: "gpt-5.5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: codex.id,
          title: "t",
          modelSelection: { instanceId: "codex", model: "gpt-5.5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          agentMode: "chat",
          branch: null,
          worktreePath: null,
          createdAt: new Date().toISOString(),
        },
      },
      createdAt: new Date().toISOString(),
    } as never);
    NodeAssert.equal(modeOf("bp-codex"), "auto-accept-edits");
  });

  NodeTest.test(
    "the permission menu is the only way up: runtime-mode.set sticks, survives a profile change",
    async () => {
      const ask = await hire("PostureMenu", { permission: "ask" });
      await send("bp-menu", ask.id, "approval-required");
      await engine.dispatch({
        type: "setThreadRuntimeMode",
        commandId: `c${++seq}`,
        threadId: "bp-menu",
        runtimeMode: "full-access",
        createdAt: new Date().toISOString(),
      } as never);
      NodeAssert.equal(modeOf("bp-menu"), "full-access");
      await run(BLOB_METHODS.update, { blobId: ask.id, patch: { permission: "auto" } });
      await userTurn("bp-menu", "next");
      NodeAssert.equal(modeOf("bp-menu"), "full-access", "an explicit pick is the thread's own");
      // an untouched thread follows the profile: Ask -> Auto applies to old threads too
      const ask2 = await hire("PostureFollow", { permission: "ask" });
      await send("bp-follow", ask2.id, "approval-required");
      NodeAssert.equal(modeOf("bp-follow"), "approval-required");
      await run(BLOB_METHODS.update, { blobId: ask2.id, patch: { permission: "full" } });
      await userTurn("bp-follow", "go");
      NodeAssert.equal(modeOf("bp-follow"), "full-access");
    },
  );

  NodeTest.test("a thread outside Blobs keeps whatever the composer sent", async () => {
    const proj = [...internals.projects.values()].find((p) => p.project.surface !== "blobs");
    if (!proj) return; // no non-blob project in this file's world
    await engine.dispatch({
      type: "createThread",
      threadId: "plain-1",
      projectId: proj.project.id,
      title: "t",
      modelSelection: { instanceId: "claude", model: "sonnet" },
      runtimeMode: "full-access",
      interactionMode: "default",
      agentMode: "chat",
      branch: null,
      worktreePath: null,
      createdAt: new Date().toISOString(),
    } as never);
    NodeAssert.equal(modeOf("plain-1"), "full-access");
  });
});

NodeTest.test(
  "memory disclosure names the model that really answered, and when the chain is resting",
  () => {
    const t = new Date(2026, 9, 9, 14, 20).getTime();
    NodeAssert.equal(
      memoryModelFromStatus(
        { lastModel: "opencode/ling-3.1-flash-free", retryAt: null },
        "Big Pickle · free",
        t,
      ),
      "Ling 3.1 Flash · free",
      "the real model, not the prediction",
    );
    NodeAssert.equal(
      memoryModelFromStatus({ lastModel: "claude-haiku-4-5" }, null, t),
      "Claude Haiku 4.5",
    );
    NodeAssert.equal(
      memoryModelFromStatus({ lastModel: "claude-haiku-5-5" }, null, t),
      "Claude Haiku 5.5",
    );
    NodeAssert.equal(memoryModelFromStatus(null, "Big Pickle · free", t), "Big Pickle · free");
    NodeAssert.match(
      memoryModelFromStatus({ lastModel: null, retryAt: t + 600_000 }, null, t) ?? "",
      /^resting until .*free models are rate limited$/,
    );
    NodeAssert.match(
      memoryModelFromStatus({ lastModel: "opencode/big-pickle", retryAt: t + 1 }, null, t) ?? "",
      /^Big Pickle · free \(resting until/,
    );
  },
);

NodeTest.test(
  "a blob file answers with an etag + last-modified that change when the file does",
  () => {
    const f = NodePath.join(tmp, "versioned.xlsx");
    NodeFS.writeFileSync(f, "one");
    const a = blobFileVersionHeaders(f);
    NodeAssert.match(a.etag!, /^"3-\d+"$/);
    NodeAssert.ok(a["last-modified"]);
    NodeFS.writeFileSync(f, "three!");
    NodeAssert.notEqual(blobFileVersionHeaders(f).etag, a.etag);
    NodeAssert.deepEqual(blobFileVersionHeaders(NodePath.join(tmp, "missing")), {});
  },
);

// ── Phase 4 / 5: routines + connected apps over the real engine bridge ──────────────────────────────────────────────
const { blobsRoutinesHandlers } = await import("./handlers/blobsRoutines.ts");
const { blobsAppsHandlers } = await import("./handlers/blobsApps.ts");
const runRoutine = <A>(tag: string, input: unknown = {}) =>
  Effect.runPromise(blobsRoutinesHandlers[tag]!(input) as Effect.Effect<A, BlobError>);
const runRFail = (tag: string, input: unknown = {}) =>
  Effect.runPromise(
    Effect.flip(blobsRoutinesHandlers[tag]!(input) as Effect.Effect<object, BlobError>),
  );
const runA = <A>(tag: string, input: unknown = {}) =>
  Effect.runPromise(blobsAppsHandlers[tag]!(input) as Effect.Effect<A, BlobError>);
const runAFail = (tag: string, input: unknown = {}) =>
  Effect.runPromise(
    Effect.flip(blobsAppsHandlers[tag]!(input) as Effect.Effect<object, BlobError>),
  );

NodeTest.test(
  "a routine run's thread is hidden and quiet, reachable by id; its results thread is a normal visible thread that takes the report card",
  async () => {
    const blob = await hire("Routiner");
    const bridge = makeBlobEngineBridge(engine) as Required<
      ReturnType<typeof makeBlobEngineBridge>
    >;
    const attention: unknown[] = [];
    const off = engine.onBlobAttention((e) => attention.push(e));
    const started = await bridge.startHiddenThread({
      blobId: blob.id,
      title: "Morning brief · Mon 9:00",
      prompt: "Do the brief.",
      origin: {
        kind: "routine",
        jobId: null,
        stepId: null,
        fromThreadId: null,
        fromBlobId: null,
        routineId: "rt_1",
        runId: "run_1",
      },
    });
    NodeAssert.ok("threadId" in started);
    const hiddenId = (started as { threadId: string }).threadId;
    const rec = internals.threads.get(hiddenId)!;
    NodeAssert.equal((rec.origin as { kind: string; runId: string }).runId, "run_1");
    NodeAssert.equal(bridge.threadExists(hiddenId), true);
    // a user thread of the same blob is listed; the routine run is not
    const { threadId: userThread } = await newBlobThread(blob.id);
    const choices = engine.blobThreadChoices(blob.id).map((c) => c.id);
    NodeAssert.ok(choices.includes(userThread));
    NodeAssert.ok(!choices.includes(hiddenId), "a routine run is never a place to post a report");
    // the wire: head and detail carry `hidden`, a plain thread does not
    const shellOf = (r: unknown) =>
      (
        engine as unknown as { buildThreadShell: (r: unknown) => { hidden?: boolean } }
      ).buildThreadShell(r);
    NodeAssert.equal(shellOf(rec).hidden, true);
    NodeAssert.equal(
      shellOf(internals.threads.get(userThread)).hidden,
      undefined,
      "a user thread carries no hidden flag",
    );
    // an approval inside the run does not raise the generic notification (the routine service notifies once)
    (engine as unknown as { emitBlobAttention: (r: unknown, k: string) => void }).emitBlobAttention(
      rec,
      "needs-you",
    );
    NodeAssert.deepEqual(attention, []);
    off();

    const results = await bridge.createResultsThread({
      blobId: blob.id,
      title: "Morning brief · results",
    });
    NodeAssert.ok(results);
    NodeAssert.ok(
      engine.blobThreadChoices(blob.id).some((c) => c.id === results!.threadId),
      "results threads are visible",
    );
    const ok = await bridge.postRoutineReport(results!.threadId, {
      cardKind: "routine-report",
      cardId: "rr_1",
      version: 1,
      routineId: "rt_1",
      runId: "run_1",
      blobId: blob.id,
      title: "Morning brief",
      status: "completed",
      ranAt: 1,
      text: "All good.",
      outputs: [],
      executionThreadId: hiddenId,
      resultsThreadId: results!.threadId,
    } as never);
    NodeAssert.equal(ok, true);
    NodeAssert.equal(
      await bridge.postRoutineReport("no-such-thread", {
        cardKind: "routine-report",
        cardId: "x",
        version: 1,
      } as never),
      false,
    );
    // hidden-thread starts refuse a non-routine origin and an unknown blob
    NodeAssert.deepEqual(
      await bridge.startHiddenThread({
        blobId: blob.id,
        title: "x",
        prompt: "x",
        origin: { kind: "user", jobId: null, stepId: null, fromThreadId: null, fromBlobId: null },
      }),
      { refused: "unknown" },
    );
    NodeAssert.deepEqual(
      await bridge.startHiddenThread({
        blobId: "nope",
        title: "x",
        prompt: "x",
        origin: {
          kind: "routine",
          jobId: null,
          stepId: null,
          fromThreadId: null,
          fromBlobId: null,
        },
      }),
      { refused: "unknown" },
    );
  },
);

NodeTest.test(
  "blobs.routines.*: snapshot never carries a webhook body, save maps create / update, errors are typed, the secret leaves only on create / rotate",
  async () => {
    const blob = await hire("Hooker");
    const calls: unknown[][] = [];
    const live = {
      id: "run_live",
      routineId: "rt_1",
      status: "active",
      eventPayload: "UNTRUSTED BODY {{ignore previous}}",
      threadId: "t1",
    };
    const routine = {
      id: "rt_1",
      blobId: blob.id,
      title: "R",
      triggers: [],
      live,
      lastRun: { ...live, id: "run_old", status: "completed" },
    };
    const restore = await asHost({
      routines: {
        list: () => [routine],
        runs: () => [live],
        status: () => ({ webhookPort: 8800, receiverUp: true, baseUrl: "http://127.0.0.1:8800" }),
        view: (r: unknown) => r,
        preview: (c: { kind: string }) =>
          c.kind === "cron"
            ? { ok: false, message: "A cron rule has 5 fields" }
            : { ok: true, value: { words: "Weekdays at 8:00 AM", next: [1, 2, 3] } },
        create: (i: unknown, by: string) => {
          calls.push(["create", i, by]);
          return { ok: true, value: routine };
        },
        update: (id: string, p: unknown) => {
          calls.push(["update", id, p]);
          return { ok: true, value: routine };
        },
        remove: (id: string) =>
          id === "rt_1" ? { ok: true, value: routine } : { ok: false, message: "No such routine" },
        get: () => routine,
        runNow: async (id: string) =>
          id === "rt_1"
            ? { ok: true, runId: "run_9" }
            : { ok: false, reason: "A run is already in progress" },
        cancelRun: async (id: string) => id === "run_live",
        createTrigger: (rid: string, label: string) => ({
          ok: true,
          value: {
            trigger: {
              id: "wh_1",
              label,
              url: "http://127.0.0.1:8800/hooks/wh_1",
              createdAt: 1,
              rotatedAt: null,
              lastEventAt: null,
            },
            secret: "whsec_ONCE",
          },
        }),
        rotateTrigger: () => ({
          ok: true,
          value: {
            trigger: {
              id: "wh_1",
              label: "x",
              url: "u",
              createdAt: 1,
              rotatedAt: 2,
              lastEventAt: null,
            },
            secret: "whsec_NEW",
          },
        }),
        deleteTrigger: () => ({ ok: true, value: true }),
        confirm: (token: string) =>
          token === "rc_1"
            ? {
                ok: true,
                value: {
                  cardKind: "routine-confirm",
                  cardId: "c",
                  version: 2,
                  token,
                  blobId: blob.id,
                  summary: "s",
                  details: [],
                  state: "confirmed",
                  result: "done",
                },
              }
            : { ok: false, message: "This request expired. Ask again." },
        on: () => undefined,
        off: () => undefined,
      },
    });
    try {
      const view = await runRoutine<{ routines: any[]; runs: any[]; webhook: { port: number } }>(
        BLOB_METHODS.routinesSnapshot,
        { blobId: blob.id },
      );
      NodeAssert.ok(
        !JSON.stringify(view).includes("UNTRUSTED BODY"),
        "the untrusted body never reaches the client",
      );
      NodeAssert.ok(
        !("eventPayload" in view.runs[0]) &&
          !("eventPayload" in view.routines[0].live) &&
          !("eventPayload" in view.routines[0].lastRun),
      );
      NodeAssert.equal(view.webhook.port, 8800);
      NodeAssert.equal(
        (await runRFail(BLOB_METHODS.routinesSnapshot, { blobId: "ghost" })).code,
        "not_found",
      );

      const input = {
        id: null,
        blobId: blob.id,
        title: "R",
        prompt: "p",
        cadence: { kind: "weekly", days: [1], time: "08:00", tz: "Asia/Calcutta" },
        results: { mode: "dedicated", threadId: null },
        rememberLastRun: false,
        maxRunMinutes: null,
        catchUp: "one",
        paused: false,
      };
      await runRoutine(BLOB_METHODS.routinesSave, input);
      NodeAssert.equal((calls.at(-1) as unknown[])[0], "create");
      NodeAssert.equal((calls.at(-1) as unknown[])[2], "user");
      await runRoutine(BLOB_METHODS.routinesSave, { ...input, id: "rt_1" });
      NodeAssert.equal((calls.at(-1) as unknown[])[0], "update");
      await runRoutine(BLOB_METHODS.routinesSetPaused, { routineId: "rt_1", paused: true });
      NodeAssert.deepEqual((calls.at(-1) as unknown[])[2], { paused: true });

      NodeAssert.match(
        (
          await runRFail(BLOB_METHODS.routinesPreview, {
            cadence: { kind: "cron", expr: "x", tz: "UTC" },
          })
        ).message,
        /5 fields/,
      );
      NodeAssert.deepEqual(
        (
          await runRoutine<{ next: number[] }>(BLOB_METHODS.routinesPreview, {
            cadence: { kind: "weekly", days: [1], time: "08:00", tz: "UTC" },
          })
        ).next,
        [1, 2, 3],
      );
      NodeAssert.equal(
        (await runRFail(BLOB_METHODS.routinesRunNow, { routineId: "rt_2" })).code,
        "cannot_run",
      );
      NodeAssert.equal(
        (await runRoutine<{ runId: string }>(BLOB_METHODS.routinesRunNow, { routineId: "rt_1" }))
          .runId,
        "run_9",
      );
      NodeAssert.equal(
        (await runRFail(BLOB_METHODS.routinesCancelRun, { runId: "gone" })).code,
        "not_running",
      );
      NodeAssert.equal(
        (await runRFail(BLOB_METHODS.routinesRemove, { routineId: "nope" })).code,
        "not_found",
      );

      const created = await runRoutine<{ secret: string }>(BLOB_METHODS.routinesCreateTrigger, {
        routineId: "rt_1",
        label: "Deploys",
      });
      NodeAssert.equal(created.secret, "whsec_ONCE");
      NodeAssert.equal(
        (
          await runRoutine<{ secret: string }>(BLOB_METHODS.routinesRotateTrigger, {
            routineId: "rt_1",
            triggerId: "wh_1",
          })
        ).secret,
        "whsec_NEW",
      );
      NodeAssert.ok(
        !JSON.stringify(
          await runRoutine(BLOB_METHODS.routinesSnapshot, { blobId: blob.id }),
        ).includes("whsec_"),
        "a snapshot never carries a secret",
      );
      NodeAssert.equal(
        (await runRFail(BLOB_METHODS.routinesConfirm, { token: "stale", accept: true })).code,
        "expired",
      );
      NodeAssert.equal(
        (
          await runRoutine<{ state: string }>(BLOB_METHODS.routinesConfirm, {
            token: "rc_1",
            accept: true,
          })
        ).state,
        "confirmed",
      );
    } finally {
      restore();
    }
  },
);

NodeTest.test(
  "blobs.apps.*: AppsError codes reach the client as BlobError codes, secrets and raw errors never do, the log shows no arguments",
  async () => {
    const blob = await hire("Appy");
    class AppsError extends Error {
      override name = "AppsError";
      code: string;
      constructor(code: string, message: string) {
        super(message);
        this.code = code;
      }
    }
    const SECRET_KEY = "ak_super_secret_project_key_999";
    const state = { byo: false, failWith: null as Error | null };
    const status = () => ({
      mode: state.byo ? "byo" : "broker",
      byoKeySet: state.byo,
      brokerConfigured: true,
      secretStore: "keychain",
      usage: {
        mode: "broker",
        used: 750,
        limit: 750,
        month: "2026-10",
        resetsAt: 1,
        capReached: true,
      },
      error: null,
    });
    const restore = await asHost({
      apps: {
        status: async () => {
          if (state.failWith) throw state.failWith;
          return status();
        },
        setByoKey: async (k: string) => {
          if (!k.startsWith("ak_"))
            throw new AppsError(
              "bad_key",
              "That does not look like a Composio project key (it starts with ak_).",
            );
          if (k === "ak_wrong") throw new Error(`upstream said no to ${k} (raw)`);
          state.byo = true;
        },
        clearByoKey: async () => {
          state.byo = false;
        },
        resetBroker: async () => undefined,
        toolkits: async () => ({
          toolkits: [
            {
              slug: "gmail",
              name: "Gmail",
              description: "Email",
              logo: null,
              categories: ["Email"],
            },
          ],
          nextCursor: null,
        }),
        accounts: async () => [{ id: "ca1", toolkit: "gmail", alias: "work", status: "ACTIVE" }],
        connect: async (tk: string) => ({
          url: `https://connect.composio.dev/${tk}`,
          expiresAt: Date.now() + 600_000,
        }),
        assertLinkFresh: (l: { expiresAt: number }) => {
          if (l.expiresAt < Date.now()) throw new AppsError("link_expired", "expired");
          return l;
        },
        disconnect: async () => ({ removed: 1 }),
        ownerTools: async () => [
          {
            slug: "GMAIL_SEND_EMAIL",
            name: "Send email",
            description: "d",
            toolkit: "gmail",
            readOnly: null,
            outbound: true,
          },
        ],
        decisions: {
          recent: () => [
            {
              at: 1,
              kind: "decision",
              blobId: blob.id,
              threadId: null,
              tool: "GMAIL_FETCH_EMAILS",
              toolkit: "gmail",
              account: null,
              decision: "allow",
              reason: "granted",
              outbound: false,
              argKeys: ["q"],
              argHash: "abc",
            },
            {
              at: 2,
              kind: "decision",
              blobId: blob.id,
              threadId: "t",
              tool: "GMAIL_SEND_EMAIL",
              toolkit: "gmail",
              account: "work",
              decision: "deny",
              reason: "user_denied",
              outbound: true,
              argKeys: ["to", "body"],
              argHash: "def",
            },
          ],
        },
      },
    });
    try {
      const st = await runA<{ mode: string; usage: { capReached: boolean } }>(
        BLOB_METHODS.appsStatus,
      );
      NodeAssert.equal(st.usage.capReached, true);
      const bad = await runAFail(BLOB_METHODS.appsSetKey, { key: "nope" });
      NodeAssert.equal(bad.code, "bad_key");
      NodeAssert.match(bad.message, /starts with ak_/);
      const leaked = await runAFail(BLOB_METHODS.appsSetKey, { key: "ak_wrong" });
      NodeAssert.equal(leaked.code, "upstream");
      NodeAssert.ok(
        !leaked.message.includes("ak_wrong") && !leaked.message.includes("raw"),
        "an unexpected error never echoes its text (it can hold the key)",
      );
      const saved = await runA<{ byoKeySet: boolean }>(BLOB_METHODS.appsSetKey, {
        key: SECRET_KEY,
      });
      NodeAssert.equal(saved.byoKeySet, true);
      NodeAssert.ok(!JSON.stringify(saved).includes(SECRET_KEY), "the key is never sent back");
      NodeAssert.equal(
        (await runA<{ byoKeySet: boolean }>(BLOB_METHODS.appsClearKey)).byoKeySet,
        false,
      );
      const link = await runA<{ url: string }>(BLOB_METHODS.appsConnect, {
        toolkit: "gmail",
        alias: null,
      });
      NodeAssert.match(link.url, /^https:\/\/connect\.composio\.dev\/gmail$/);
      NodeAssert.equal(
        (await runA<{ accounts: unknown[] }>(BLOB_METHODS.appsAccounts, { toolkit: null })).accounts
          .length,
        1,
      );
      NodeAssert.equal(
        (
          await runA<{ tools: Array<{ outbound: boolean }> }>(BLOB_METHODS.appsTools, {
            toolkit: "gmail",
          })
        ).tools[0]!.outbound,
        true,
      );
      const log = await runA<{ decisions: Array<Record<string, unknown>> }>(
        BLOB_METHODS.appsDecisions,
        { blobId: blob.id, limit: 50 },
      );
      NodeAssert.deepEqual(
        log.decisions.map((d) => d.tool),
        ["GMAIL_SEND_EMAIL", "GMAIL_FETCH_EMAILS"],
        "newest first",
      );
      NodeAssert.ok(
        !JSON.stringify(log).includes("argKeys") && !JSON.stringify(log).includes("argHash"),
      );
      // a down broker is a coded error the page can branch on
      state.failWith = new AppsError("broker_down", "Connected apps are unreachable right now.");
      NodeAssert.equal((await runAFail(BLOB_METHODS.appsStatus)).code, "broker_down");
    } finally {
      restore();
    }
  },
);

NodeTest.test(
  "every routines and apps RPC has a handler (the merged table matches the contract group)",
  () => {
    const tags = mergedHandlerTags();
    for (const key of Object.keys(BLOB_METHODS) as Array<keyof typeof BLOB_METHODS>) {
      if (!/^(routines|apps)/.test(key)) continue;
      NodeAssert.ok(tags.has(BLOB_METHODS[key]), `${key} has no handler`);
    }
  },
);

// ── live QA #2 (2026-10-09) ─────────────────────────────────────────────────────────────────────────────────────────
NodeTest.test(
  "a Kora hand-off brief is flagged so memory never learns from it; the user's own follow-up in that thread is learned from",
  async () => {
    const blob = await hire("Briefed");
    const bridge = makeBlobEngineBridge(engine);
    const started = await bridge.startThread({
      blobId: blob.id,
      title: "Lisbon plan",
      prompt:
        "# Lisbon plan\n\nPlan three days for the user, who lives in Lisbon and is allergic to nuts.\n---\nWrite the deliverable to outputs/.",
      origin: {
        kind: "kora",
        jobId: "j1",
        stepId: "s1",
        fromThreadId: "kt",
        fromBlobId: "blob_kora",
      },
      fromKoraThreadId: "kt",
    });
    NodeAssert.ok("threadId" in started);
    const { threadId, koraThreadId } = started as { threadId: string; koraThreadId: string };
    blobRt.afterTurnCalls.length = 0;
    notify(koraThreadId, { type: "turn.started", turnId: "b1" });
    notify(koraThreadId, {
      type: "content.delta",
      stream: "assistant_text",
      delta: "Here is the plan.",
      turnId: "b1",
    });
    notify(koraThreadId, { type: "turn.settled", turnId: "b1", state: "completed" });
    await new Promise((r) => setImmediate(r));
    NodeAssert.equal(blobRt.afterTurnCalls.length, 1);
    NodeAssert.equal(blobRt.afterTurnCalls[0]!.brief, true, "the brief is Kora's words");
    await exchange(threadId, koraThreadId, "I actually live in Porto, not Lisbon", "Noted.");
    NodeAssert.equal(blobRt.afterTurnCalls.length, 2);
    NodeAssert.equal(
      blobRt.afterTurnCalls[1]!.brief,
      undefined,
      "the user's own message is learned from",
    );
    // an ordinary thread's first message is never a brief
    const plain = await newBlobThread(blob.id);
    await exchange(plain.threadId, plain.kora, "first message", "ok");
    NodeAssert.equal(blobRt.afterTurnCalls.at(-1)!.brief, undefined);
  },
);

NodeTest.test(
  "a blob's approval request carries what the transcript card needs (tool, args, folder, 'Always' label) and is flagged as a blob thread; a Code thread's is not",
  async () => {
    const blob = await hire("Asker");
    const { threadId, kora } = await newBlobThread(blob.id, "approval-required");
    notify(kora, { type: "turn.started", turnId: "ap1" });
    notify(kora, {
      type: "approval.opened",
      turnId: "ap1",
      requestId: "appr_x_1",
      requestKind: "command",
      toolName: "Bash",
      title: "Allow Bash?",
      args: { command: "sleep 40", description: "wait" },
      alwaysLabel: "Run sleep",
      options: [
        { decision: "accept", label: "Allow once" },
        { decision: "acceptAlways", label: "Always for this blob" },
        { decision: "decline", label: "Deny" },
      ],
    });
    const req = activities(threadId).find((a) => a.kind === "approval.requested")!;
    const p = req.payload as Record<string, unknown>;
    NodeAssert.equal(p.blobThread, true);
    NodeAssert.equal(p.blobId, blob.id);
    NodeAssert.equal(p.cwd, blob.workspace);
    NodeAssert.equal(p.toolName, "Bash");
    NodeAssert.equal(p.alwaysLabel, "Run sleep");
    NodeAssert.deepEqual(p.args, { command: "sleep 40", description: "wait" });
    NodeAssert.ok(
      (p.options as Array<{ decision: string }>).some((o) => o.decision === "acceptAlways"),
    );
    every(p);
    // a Code-surface thread's request stays a composer strip (no blob flag)
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-blobs-code2-"));
    await engine.dispatch({
      type: "createProject",
      projectId: "codeproj2",
      title: "Repo",
      workspaceRoot: dir,
      createdAt: new Date().toISOString(),
    } as never);
    await engine.dispatch({
      type: "createThread",
      threadId: "codeth2",
      projectId: "codeproj2",
      title: "t",
      modelSelection: { instanceId: "claude", model: "m" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      agentMode: "chat",
      branch: null,
      worktreePath: null,
      createdAt: new Date().toISOString(),
    } as never);
    const codeKora = internals.threads.get("codeth2")!.koraThreadId;
    notify(codeKora, {
      type: "approval.opened",
      requestId: "appr_c_1",
      requestKind: "command",
      title: "Allow Bash?",
      args: { command: "ls" },
    });
    const cp = activities("codeth2").find((a) => a.kind === "approval.requested")!
      .payload as Record<string, unknown>;
    NodeAssert.equal(cp.blobThread, undefined);
    NodeAssert.equal(cp.cwd, undefined);
  },
);

NodeTest.test(
  "a blob's helper (worker.*) activities are flagged for the one quiet 'used N helpers' row; a Code thread's are not",
  async () => {
    const blob = await hire("Helper");
    const { threadId, kora } = await newBlobThread(blob.id);
    notify(kora, { type: "turn.started", turnId: "h1" });
    notify(kora, {
      type: "worker.attached",
      paneId: "p1",
      workerAgent: "opencode",
      title: "Read the pricing pages",
      turnId: "h1",
    });
    notify(kora, { type: "worker.detached", paneId: "p1", reason: "done", turnId: "h1" });
    const rows = activities(threadId).filter((a) => a.kind.startsWith("worker."));
    NodeAssert.equal(rows.length, 2);
    for (const r of rows)
      NodeAssert.equal((r.payload as { blobThread?: boolean }).blobThread, true, r.kind);
    every(rows.map((r) => r.payload));
  },
);

NodeTest.test(
  "retention: only a FINISHED routine run's hidden thread can be deleted; a running one, a visible one and a Kora-delegated one never are",
  async () => {
    const blob = await hire("Cleaner");
    const bridge = makeBlobEngineBridge(engine) as Required<
      ReturnType<typeof makeBlobEngineBridge>
    >;
    const origin = {
      kind: "routine" as const,
      jobId: null,
      stepId: null,
      fromThreadId: null,
      fromBlobId: null,
      routineId: "rt_9",
      runId: "run_9",
    };
    const started = (await bridge.startHiddenThread({
      blobId: blob.id,
      title: "Brief",
      prompt: "Do it.",
      origin,
    })) as { threadId: string; koraThreadId: string };
    NodeAssert.equal(
      await bridge.deleteHiddenThread(started.threadId),
      false,
      "still running (its first turn just started)",
    );
    NodeAssert.ok(internals.threads.has(started.threadId));
    notify(started.koraThreadId, { type: "turn.started", turnId: "r1" });
    notify(started.koraThreadId, {
      type: "content.delta",
      stream: "assistant_text",
      delta: "Done.",
      turnId: "r1",
    });
    notify(started.koraThreadId, { type: "turn.settled", turnId: "r1", state: "completed" });
    await new Promise((r) => setImmediate(r));
    NodeAssert.equal(await bridge.deleteHiddenThread(started.threadId), true);
    NodeAssert.equal(internals.threads.has(started.threadId), false);
    NodeAssert.equal(bridge.threadExists(started.threadId), false);
    // not hidden routine threads: refused
    const visible = await newBlobThread(blob.id);
    NodeAssert.equal(await bridge.deleteHiddenThread(visible.threadId), false);
    const delegated = (await bridge.startThread({
      blobId: blob.id,
      title: "d",
      prompt: "x",
      origin: { kind: "kora", jobId: "j", stepId: "s", fromThreadId: "k", fromBlobId: "blob_kora" },
      fromKoraThreadId: "k",
    })) as { threadId: string; koraThreadId: string };
    notify(delegated.koraThreadId, { type: "turn.settled", turnId: "d1", state: "completed" });
    NodeAssert.equal(await bridge.deleteHiddenThread(delegated.threadId), false);
    NodeAssert.equal(await bridge.deleteHiddenThread("no-such-thread"), false);
    // a hidden thread parked on an approval is never deleted either
    const parked = (await bridge.startHiddenThread({
      blobId: blob.id,
      title: "Brief 2",
      prompt: "Do it.",
      origin: { ...origin, runId: "run_10" },
    })) as { threadId: string; koraThreadId: string };
    notify(parked.koraThreadId, { type: "turn.started", turnId: "r2" });
    notify(parked.koraThreadId, {
      type: "approval.opened",
      turnId: "r2",
      requestId: "appr_p_1",
      requestKind: "command",
      title: "Allow?",
      args: { command: "x" },
    });
    notify(parked.koraThreadId, { type: "turn.settled", turnId: "r2", state: "completed" });
    NodeAssert.equal(await bridge.deleteHiddenThread(parked.threadId), false);
  },
);

NodeTest.test(
  "approving a held memory is a real change: the card's line becomes the approval's own receipt (Undo works on it), and the Pending list drops the held one",
  async () => {
    const blob = await hire("Approver");
    const { threadId, kora } = await newBlobThread(blob.id);
    blobRt.setReceipts([
      {
        id: "r-held-b",
        kind: "pending",
        factId: "",
        pendingId: "pend1",
        text: "Has a rash",
        blobId: blob.id,
        undone: false,
      },
    ]);
    await exchange(threadId, kora, "I have a rash", "Sorry to hear.");
    const first = cards(threadId).at(-1)!.payload as {
      receipts: Array<{ id: string; kind: string }>;
    };
    NodeAssert.deepEqual(
      first.receipts.map((r) => [r.id, r.kind]),
      [["r-held-b", "held"]],
    );
    const saved = await run<{ id: string; kind: string; undone: boolean }>(
      BLOB_METHODS.memoryConfirm,
      { receiptId: "r-held-b", save: true },
    );
    NodeAssert.equal(saved.id, "rnew", "the approval's own receipt");
    NodeAssert.equal(saved.kind, "added");
    const latest = cards(threadId).at(-1)!.payload as {
      version: number;
      receipts: Array<{ id: string; kind: string; undone: boolean }>;
    };
    NodeAssert.deepEqual(
      latest.receipts.map((r) => [r.id, r.kind, r.undone]),
      [["rnew", "added", false]],
    );
    NodeAssert.equal(latest.version, 2);
    // and Undo on the new line works (it is a real receipt)
    const undone = await run<{ id: string; undone: boolean }>(BLOB_METHODS.memoryUndo, {
      receiptId: "rnew",
    });
    NodeAssert.equal(undone.undone, true);
    NodeAssert.equal(blobRt.undone.at(-1), "rnew");
  },
);
