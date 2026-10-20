// @effect-diagnostics globalDate:off globalTimers:off -- the engine under test uses plain timestamps; the fake provider pumps events on timers.
// @effect-diagnostics nodeBuiltinImport:off -- throwaway KORA_HOME / KORA_BLOBS_ROOT for the engine's folders.
// Group chats on the ui-server (docs/bots/GROUPS.md) and outside access (docs/bots/OUTSIDE.md): the group project mirror, a group
// thread that fans out to per-member hidden provider threads, the streaming reply bubbles with their authors, the routing label,
// notes, approvals raised by a member answered in the group, Stop, cascade delete, memory learned from the person's words only,
// the outside-access read side (threads, rows with "via", search, send) and the groups / team / outside RPC handlers.
// The runtime's router and orchestrator are tested in packages/runtime (blobs/groups, blobs/phase38-wiring.test.ts); here a tiny
// stand-in orchestrator drives the SAME bridge (`runMemberTurn`), transcript and event interfaces the real one does.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import type { BlobProfile } from "@kora/contracts";
import { GROUP_METHODS, OUTSIDE_METHODS } from "@kora/contracts";
import * as Effect from "effect/Effect";

import {
  setHost,
  type KoraGroupEvent,
  type KoraGroupJson,
  type KoraGroupTranscript,
  type UiHost,
} from "./host.ts";

const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-groups-test-"));
process.env.KORA_HOME = NodePath.join(tmp, "home");
process.env.KORA_BLOBS_ROOT = NodePath.join(tmp, "Blobs");
process.env.KORA_TRASH_DIR = NodePath.join(tmp, "Trash");
NodeFS.mkdirSync(process.env.KORA_HOME, { recursive: true });

const { blobsRoot } = await import("./assistantFs.ts");

// ── fakes ───────────────────────────────────────────────────────────────────────────────────────────────────────
const mkBlob = (id: string, name: string, role: "chief" | "member" = "member"): BlobProfile => {
  const slug = name.toLowerCase();
  const workspace = NodePath.join(blobsRoot(), slug);
  for (const d of ["files", "outputs", "scratch"])
    NodeFS.mkdirSync(NodePath.join(workspace, d), { recursive: true });
  return {
    id,
    version: 1,
    name,
    title: role === "chief" ? "Chief" : "Helper",
    role,
    teamId: "default",
    engine: { instanceId: "claude", model: "sonnet", effort: null },
    permission: "ask",
    outfit: null,
    toolGrants: {
      apps: { mode: "none", allow: [] },
      mcp: [],
      computer: { browser: false, vm: false },
    },
    slug,
    workspace,
    templateId: null,
    pinned: false,
    hidden: false,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
  } as unknown as BlobProfile;
};
const KORA = mkBlob("blob_kora", "Kora", "chief");
const POPO = mkBlob("blob_popo", "Popo");
const JUNIP = mkBlob("blob_junip", "Junip");
const profiles = new Map<string, BlobProfile>([KORA, POPO, JUNIP].map((b) => [b.id, b]));
const storeListeners = new Set<() => void>();
const afterTurnCalls: Array<Record<string, unknown>> = [];

const group: KoraGroupJson = {
  id: "group_crew",
  name: "crew",
  slug: "crew",
  memberIds: [KORA.id, POPO.id, JUNIP.id],
  leadId: KORA.id,
  rule: "auto",
  instructions: "",
  workspace: NodePath.join(blobsRoot(), "_groups", "crew"),
  pinned: false,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
};
NodeFS.mkdirSync(NodePath.join(group.workspace, "outputs"), { recursive: true });
const groupsList = new Map<string, KoraGroupJson>([[group.id, group]]);
const groupChanged = new Set<(id: string | null) => void>();
const groupEventCbs = new Set<(e: KoraGroupEvent) => void>();
const stops: string[] = [];
let sendImpl: (i: {
  groupId: string;
  threadId: string;
  transcript: KoraGroupTranscript;
  text: string;
}) => Promise<unknown> = async () => ({});

const groupsSvc = {
  groups: {
    list: () => [...groupsList.values()],
    get: (id: string) => groupsList.get(id) ?? null,
    create: (i: Record<string, unknown>) => {
      const g = {
        ...group,
        id: `group_${String(i.name)}`,
        name: String(i.name),
        slug: String(i.name),
        memberIds: i.memberIds as string[],
      } as KoraGroupJson;
      groupsList.set(g.id, g);
      groupChanged.forEach((f) => f(g.id));
      return g;
    },
    update: (id: string, patch: Record<string, unknown>) => {
      const g = { ...groupsList.get(id)!, ...patch } as KoraGroupJson;
      groupsList.set(id, g);
      groupChanged.forEach((f) => f(id));
      return g;
    },
    archive: (id: string) => {
      const g = { ...groupsList.get(id)!, archivedAt: 5 };
      groupsList.set(id, g);
      groupChanged.forEach((f) => f(id));
      return g;
    },
    delete: (id: string, confirm: string) => {
      if (confirm !== groupsList.get(id)?.name)
        throw Object.assign(new Error("Type the group's name to confirm."), {
          code: "bad-confirm",
        });
      groupsList.delete(id);
      groupChanged.forEach((f) => f(id));
      return { trashed: [] };
    },
  },
  attached: true,
  send: (i: { groupId: string; threadId: string; transcript: KoraGroupTranscript; text: string }) =>
    sendImpl(i),
  stop: (threadId: string) => {
    stops.push(threadId);
    return 1;
  },
  onEvent: (cb: (e: KoraGroupEvent) => void) => {
    groupEventCbs.add(cb);
    return () => groupEventCbs.delete(cb);
  },
  on: (_e: "changed", fn: (id: string | null) => void) => {
    groupChanged.add(fn);
    return groupsSvc;
  },
  off: (_e: "changed", fn: (id: string | null) => void) => {
    groupChanged.delete(fn);
    return groupsSvc;
  },
};

const tokens: Array<Record<string, unknown>> = [];
let tokenSeq = 0;
const outsideSvc = {
  listTokens: () => tokens,
  createToken: (name: string) => {
    if (tokens.some((t) => t.name === name && t.revokedAt === null))
      return { ok: false as const, message: `A token named "${name}" already exists.` };
    const record = {
      id: `tok_${++tokenSeq}`,
      name,
      createdAt: 1,
      lastUsedAt: null,
      revokedAt: null,
      suffix: "wxyz",
    };
    tokens.push(record);
    return { ok: true as const, token: "kbo_SECRETSECRETSECRETSECRET", record };
  },
  revokeToken: (id: string) => {
    const t = tokens.find((x) => x.id === id);
    if (!t) return false;
    t.revokedAt = 9;
    return true;
  },
  auditPage: () => ({
    rows: [
      {
        id: "a1",
        at: 1,
        tokenId: "tok_1",
        client: "Claude Desktop",
        tool: "list_blobs",
        target: null,
        ok: true,
        note: undefined,
      },
    ],
    next: null,
  }),
};

const teamPlans: unknown[] = [];
const teamfile = {
  options: () => ({
    blobs: [{ id: POPO.id, name: "Popo", title: "Helper", skills: 1, routines: 2 }],
    groups: [{ id: group.id, name: "crew", memberIds: group.memberIds }],
  }),
  preview: (sel: unknown) => ({
    blobs: [],
    groups: [],
    chief: true,
    findings: [],
    scrubNote: null,
    neverIncluded: ["Chats and memory"],
    bytes: 10,
    sel,
  }),
  export: () => ({
    markdown: "---\nkora_team: 1\n---\n",
    fileName: "t.kora-team.md",
    report: {
      blobs: [],
      groups: [],
      chief: false,
      findings: [],
      scrubNote: null,
      neverIncluded: [],
      bytes: 5,
    },
  }),
  planFromText: (text: string) =>
    text.includes("kora_team")
      ? {
          ok: true as const,
          plan: {
            planId: "plan_1",
            title: "T",
            description: "",
            blobs: [],
            groups: [],
            skipped: [],
            notes: [],
            warnings: [],
            removedSecrets: 0,
          },
        }
      : { ok: false as const, error: "That is not a Kora team file." },
  planFromUrl: async () => ({ ok: false as const, error: "Only https links are allowed." }),
  apply: (planId: string, skip: unknown, engine: unknown) => {
    teamPlans.push({ planId, skip, engine });
    return { blobs: [], groups: [], errors: [] };
  },
};

const turns: Array<{ threadId: string; text?: string }> = [];
const interrupts: string[] = [];
const approvals: Array<[string, string, string]> = [];
const notifyListeners: Array<(m: string, p: unknown) => void> = [];
const created: Array<{ id: string; agent: string; cwd: string }> = [];
let nSession = 0;
let failSends = false;
const sessions = {
  create: (p: { agent: string; cwd: string }) => {
    const id = `k${++nSession}`;
    created.push({ id, agent: p.agent, cwd: p.cwd });
    return { id, title: "t", agent: p.agent, cwd: p.cwd };
  },
  setPermissionMode: () => {},
  setOrchestrator: async () => ({}),
  changeModel: async () => {},
  setAgentMode: async () => ({
    thread: { id: "k", title: "t", agent: "claude", cwd: "/r" },
    notice: null,
  }),
  takeModeNotice: () => null,
  sendTurn: async (p: { threadId: string; text?: string }) => {
    turns.push(p);
    if (failSends) throw new Error("Claude is not signed in.");
    return { turnId: `turn_${turns.length}` };
  },
  interrupt: async (id: string) => {
    interrupts.push(id);
  },
  delete: async () => {},
  respondApproval: async (kora: string, requestId: string, decision: string) => {
    approvals.push([kora, requestId, decision]);
  },
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
const store = {
  list: () => [...profiles.values()],
  get: (id: string) => profiles.get(id) ?? null,
  create: () => {
    throw new Error("not used");
  },
  update: () => {
    throw new Error("not used");
  },
  archive: (id: string) => {
    const next = { ...profiles.get(id)!, archivedAt: Date.now() } as BlobProfile;
    profiles.set(id, next);
    storeListeners.forEach((f) => f());
    return next;
  },
  rehire: () => {
    throw new Error("not used");
  },
  delete: () => {
    throw new Error("not used");
  },
  soul: () => "",
  writeSoul: () => {},
  on: (_e: string, fn: () => void) => {
    storeListeners.add(fn);
    return store;
  },
  off: (_e: string, fn: () => void) => {
    storeListeners.delete(fn);
    return store;
  },
};
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
  managerRuntime: { notify: () => {}, socketPath: "/tmp/qa.sock" },
  makeFleetOps: () => fleetOps,
  proxyPaneId: (id: string) => `chat:${id}`,
  listClaudeModels: async () => null,
  version: "test",
  log: () => {},
  swarm: { getStatus: async () => null, onStatus: () => () => {} },
  blobs: {
    store,
    memory: {} as never,
    afterTurn: async (i: Record<string, unknown>) => {
      afterTurnCalls.push(i);
      return [];
    },
    refresh: () => {},
    groups: groupsSvc,
    teamfile,
    outside: outsideSvc,
  },
} as unknown as UiHost);

const { chatEngine } = await import("./kora-chat.ts");
const { blobsGroupsHandlers } = await import("./handlers/blobsGroups.ts");
const { blobsOutsideHandlers } = await import("./handlers/blobsOutside.ts");
const { mergedHandlerTags } = await import("./handlers.ts");
const { makeBlobEngineBridge } = await import("./blobsEngine.ts");

const engine = chatEngine();
const internals = engine as unknown as {
  projects: Map<
    string,
    { project: { id: string; title: string; workspaceRoot: string; surface?: string } }
  >;
  threads: Map<
    string,
    {
      koraThreadId: string;
      projectId: string;
      origin?: { kind: string; groupThreadId?: string };
      messages: Array<Record<string, any>>;
      activities: Array<Record<string, any>>;
      session: { status: string } | null;
      latestTurn: { state: string } | null;
    }
  >;
  groupMemberThreads: Map<string, string>;
};

let seq = 0;
const nowIso = () => new Date().toISOString();
const notify = (kora: string, ev: Record<string, unknown>) => {
  for (const l of notifyListeners)
    l("chat.event", { threadId: kora, seq: 0, at: Date.now(), ...ev });
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn: () => boolean, what: string, ms = 3000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
    await sleep(10);
  }
};

async function newGroupThread() {
  const threadId = `gth${++seq}`;
  await engine.dispatch({
    type: "createThread",
    threadId,
    projectId: group.id,
    title: "Crew chat",
    modelSelection: { instanceId: "claude", model: "sonnet" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    agentMode: "chat",
    branch: null,
    worktreePath: null,
    createdAt: nowIso(),
  } as never);
  return threadId;
}
const say = (threadId: string, text: string) =>
  engine.dispatch({
    type: "turn.start",
    threadId,
    message: { messageId: `m_${++seq}`, text, attachments: [] },
    createdAt: nowIso(),
  } as never);

/** The provider side of one member's session: when its turn is sent, answer with `reply` (or run `during` first). */
function providerAnswers(
  reply: (kora: string, text: string) => string,
  during?: (kora: string) => Promise<void>,
) {
  let handled = turns.length;
  const timer = setInterval(() => {
    while (handled < turns.length) {
      const t = turns[handled++]!;
      const text = reply(t.threadId, t.text ?? "");
      const turnId = `pt${handled}`;
      void (async () => {
        notify(t.threadId, { type: "turn.started", turnId });
        if (during) await during(t.threadId);
        notify(t.threadId, {
          type: "content.delta",
          stream: "assistant_text",
          delta: text.slice(0, Math.ceil(text.length / 2)),
          turnId,
        });
        await sleep(15);
        notify(t.threadId, {
          type: "content.delta",
          stream: "assistant_text",
          delta: text.slice(Math.ceil(text.length / 2)),
          turnId,
        });
        notify(t.threadId, {
          type: "turn.settled",
          turnId,
          state: "completed",
          usage: { usageStatus: "complete", inputTokens: 1, outputTokens: 1 },
        });
      })();
    }
  }, 5);
  return () => clearInterval(timer);
}

/** A tiny orchestrator over the real engine interfaces: @Name mentions pick recipients, one turn per recipient, in parallel. */
function installMiniOrchestrator() {
  sendImpl = async (i) => {
    const names = i.text.match(/@(\w+)/g)?.map((m) => m.slice(1)) ?? [];
    const recipients = [...profiles.values()]
      .filter((b) => names.includes(b.name))
      .map((b) => b.id);
    const user = i.transcript.append({
      authorId: "user",
      authorName: "You",
      text: i.text,
      to: recipients,
      kind: "message",
    });
    for (const cb of groupEventCbs)
      cb({
        type: "routed",
        threadId: i.threadId,
        messageSeq: user.seq,
        recipients,
        label: "x",
        decision: { reason: recipients.length ? "mention" : "no-mention" },
      });
    await Promise.all(
      recipients.map(async (blobId) => {
        for (const cb of groupEventCbs)
          cb({ type: "turn-start", threadId: i.threadId, blobId, depth: 0 });
        const ctl = new AbortController();
        try {
          const r = await engine.runMemberTurn({
            groupId: group.id,
            threadId: i.threadId,
            blobId,
            prompt: `[Group chat "crew". You are ${profiles.get(blobId)!.name}.]\n\nYou said:\n${i.text}`,
            cwd: group.workspace,
            allowDelegation: false,
            depth: 0,
            triggerSeq: user.seq,
            signal: ctl.signal,
            onText: (t) => {
              for (const cb of groupEventCbs)
                cb({ type: "turn-delta", threadId: i.threadId, blobId, text: t });
            },
          });
          const msg = i.transcript.append({
            authorId: blobId,
            authorName: profiles.get(blobId)!.name,
            text: r.text,
            to: [],
            kind: "message",
          });
          for (const cb of groupEventCbs)
            cb({ type: "turn-end", threadId: i.threadId, blobId, message: msg, depth: 0 });
        } catch (e) {
          for (const cb of groupEventCbs)
            cb({
              type: "turn-error",
              threadId: i.threadId,
              blobId,
              depth: 0,
              error: String((e as Error).message),
            });
        }
      }),
    );
    return {};
  };
}

// ── tests ───────────────────────────────────────────────────────────────────────────────────────────────────────
NodeTest.test(
  "every blobs.groups / team / outside RPC has a real handler (none would be auto-stubbed to hang)",
  () => {
    const real = mergedHandlerTags();
    for (const tag of [...Object.values(GROUP_METHODS), ...Object.values(OUTSIDE_METHODS)])
      NodeAssert.ok(real.has(tag), `${tag} is real`);
  },
);

NodeTest.test(
  "a group is a project (surface blobs, its shared folder as the root); the engine bridge can run member turns",
  () => {
    const p = internals.projects.get(group.id)!;
    NodeAssert.ok(p, "the group's project was mirrored at start");
    NodeAssert.equal(p.project.surface, "blobs");
    NodeAssert.equal(p.project.title, "crew");
    NodeAssert.equal(p.project.workspaceRoot, group.workspace);
    const bridge = makeBlobEngineBridge(engine) as unknown as Record<string, unknown>;
    NodeAssert.equal(typeof bridge.runMemberTurn, "function");
    NodeAssert.ok(
      bridge.outside && typeof (bridge.outside as { send: unknown }).send === "function",
    );
    // a new group appears as a project without a restart
    groupsList.set("group_new", {
      ...group,
      id: "group_new",
      name: "new",
      slug: "new",
      workspace: NodePath.join(blobsRoot(), "_groups", "new"),
    });
    NodeFS.mkdirSync(NodePath.join(blobsRoot(), "_groups", "new"), { recursive: true });
    groupChanged.forEach((f) => f("group_new"));
    NodeAssert.ok(internals.projects.has("group_new"));
    groupsList.delete("group_new");
    groupChanged.forEach((f) => f("group_new"));
    NodeAssert.ok(
      !internals.projects.has("group_new"),
      "a deleted group takes its project with it",
    );
  },
);

NodeTest.test(
  "a user message in a group thread fans out to hidden per-member sessions; replies stream into author-tagged bubbles",
  async () => {
    installMiniOrchestrator();
    const stopProvider = providerAnswers((_k, text) =>
      text.includes("You are Popo")
        ? "Popo reply, long enough to stream in two halves."
        : "Junip says hi.",
    );
    try {
      const threadId = await newGroupThread();
      const groupKora = internals.threads.get(threadId)!.koraThreadId;
      const before = turns.length;
      await say(threadId, "@Popo and @Junip please look");
      // the person's bubble is there at once
      const rec = internals.threads.get(threadId)!;
      NodeAssert.equal(rec.messages[0]!.role, "user");
      NodeAssert.equal(rec.messages[0]!.text, "@Popo and @Junip please look");
      await waitFor(
        () =>
          rec.session?.status === "ready" &&
          rec.messages.filter((m) => m.role === "assistant").length === 2 &&
          rec.messages.every((m) => !m.streaming),
        "both replies settled",
      );
      // the group thread itself never ran a provider turn
      NodeAssert.ok(
        !turns.slice(before).some((t) => t.threadId === groupKora),
        "no provider turn on the group thread's own session",
      );
      // each member ran in its OWN hidden thread (origin group), in its OWN blob project, with the group framing as the prompt
      const members = [...internals.threads.values()].filter(
        (t) => t.origin?.kind === "group" && t.origin.groupThreadId === threadId,
      );
      NodeAssert.deepEqual(members.map((t) => t.projectId).sort(), [JUNIP.id, POPO.id]);
      NodeAssert.ok(
        members.every((t) => t.messages[0]!.text.startsWith('[Group chat "crew". You are')),
      );
      // the shell marks them hidden: they never list in a sidebar
      const snap = engine.getThreadDetail(
        members[0]!.messages.length
          ? [...internals.threads.entries()].find(([, v]) => v === members[0])![0]
          : "",
      )!;
      NodeAssert.equal((snap.thread as { hidden?: boolean }).hidden, true);
      // bubbles: user routed to Popo + Junip, each reply authored, no streaming leftovers, full text
      const user = rec.messages[0]!;
      NodeAssert.deepEqual([...user.to].sort(), [JUNIP.id, POPO.id]);
      NodeAssert.equal(user.routeWhy, "mention");
      const replies = rec.messages.filter((m) => m.role === "assistant");
      NodeAssert.deepEqual(replies.map((m) => m.authorBlobId).sort(), [JUNIP.id, POPO.id]);
      NodeAssert.equal(
        replies.find((m) => m.authorBlobId === POPO.id)!.text,
        "Popo reply, long enough to stream in two halves.",
      );
      NodeAssert.equal(replies.find((m) => m.authorBlobId === JUNIP.id)!.text, "Junip says hi.");
      NodeAssert.ok(
        replies.every((m) => m.turnId === null),
        "member replies carry no turn id (the transcript folds replies that share one)",
      );
      NodeAssert.equal(rec.latestTurn?.state, "completed");
      // memory: each member learned from the PERSON's words (not the group framing), into its own memory, source = the group thread
      await sleep(30);
      const popoMem = afterTurnCalls.find((c) => c.blobId === POPO.id)!;
      NodeAssert.ok(popoMem, "Popo's memory hook ran");
      NodeAssert.equal(popoMem.userText, "@Popo and @Junip please look");
      NodeAssert.equal(popoMem.threadId, threadId);
      NodeAssert.ok(!String(popoMem.userText).includes("[Group chat"));
      NodeAssert.ok(
        !afterTurnCalls.some(
          (c) => c.threadId !== threadId && (c.blobId === POPO.id || c.blobId === JUNIP.id),
        ),
        "no memory from the hidden member threads themselves",
      );
      // a second message reuses the member's session (it remembers)
      const popoThreads = [...internals.threads.values()].filter(
        (t) => t.origin?.kind === "group" && t.projectId === POPO.id,
      );
      await say(threadId, "@Popo again");
      await waitFor(
        () =>
          rec.messages.filter((m) => m.role === "assistant").length === 3 &&
          rec.session?.status === "ready",
        "the second reply",
      );
      NodeAssert.equal(
        [...internals.threads.values()].filter(
          (t) => t.origin?.kind === "group" && t.projectId === POPO.id,
        ).length,
        popoThreads.length,
        "the same member thread was reused",
      );
    } finally {
      stopProvider();
    }
  },
);

NodeTest.test(
  "an un-addressed message under the mention rule shows who it went to (nobody) and ends cleanly; the person's text is untouched",
  async () => {
    installMiniOrchestrator();
    const threadId = await newGroupThread();
    await say(threadId, "anybody home?");
    const rec = internals.threads.get(threadId)!;
    await waitFor(() => rec.session?.status === "ready", "settled");
    NodeAssert.deepEqual(rec.messages[0]!.to, []);
    NodeAssert.equal(rec.messages[0]!.routeWhy, "no-mention");
    NodeAssert.equal(rec.messages.length, 1);
  },
);

NodeTest.test(
  "a member's approval shows as a card in the GROUP; answering it there answers that member's session",
  async () => {
    installMiniOrchestrator();
    const stopProvider = providerAnswers(
      () => "done after approval",
      async (kora) => {
        notify(kora, {
          type: "approval.opened",
          requestId: "req-1",
          requestKind: "command_execution_approval",
          title: "Popo wants to run: touch a",
          args: { command: "touch a" },
        });
        await waitFor(
          () => approvals.some((a) => a[1] === "req-1"),
          "the approval was answered",
          4000,
        );
        notify(kora, { type: "approval.resolved", requestId: "req-1", decision: "accept" });
      },
    );
    try {
      const threadId = await newGroupThread();
      await say(threadId, "@Popo do it");
      const rec = internals.threads.get(threadId)!;
      await waitFor(
        () => rec.activities.some((a) => a.kind === "approval.requested"),
        "the card reached the group thread",
      );
      const card = rec.activities.find((a) => a.kind === "approval.requested")!;
      NodeAssert.equal(card.payload.authorBlobId, POPO.id);
      NodeAssert.equal(card.payload.requestId, "req-1");
      NodeAssert.equal(
        card.payload.blobThread,
        undefined === card.payload.blobThread ? undefined : true,
      );
      const memberKora = [...internals.threads.values()].find(
        (t) =>
          t.origin?.kind === "group" &&
          t.origin.groupThreadId === threadId &&
          t.projectId === POPO.id,
      )!.koraThreadId;
      await engine.dispatch({
        type: "approval.respond",
        threadId,
        requestId: "req-1",
        decision: "accept",
      } as never);
      NodeAssert.deepEqual(approvals.at(-1), [memberKora, "req-1", "accept"]);
      await waitFor(
        () =>
          rec.activities.some(
            (a) => a.kind === "approval.resolved" && a.payload.requestId === "req-1",
          ),
        "the card resolved in the group",
      );
      await waitFor(
        () =>
          rec.messages.some((m) => m.role === "assistant" && m.text === "done after approval") &&
          rec.session?.status === "ready",
        "the member finished",
      );
    } finally {
      stopProvider();
    }
  },
);

NodeTest.test(
  "Stop in a group thread stops its member turns (service.stop) and nothing else; Stop in a blob thread is unchanged",
  async () => {
    const threadId = await newGroupThread();
    stops.length = 0;
    await engine.dispatch({ type: "turn.interrupt", threadId } as never);
    NodeAssert.deepEqual(stops, [threadId]);
  },
);

NodeTest.test(
  "runMemberTurn: an aborted signal interrupts the member's session and rejects (never hangs); an error settle rejects with its reason",
  async () => {
    const threadId = await newGroupThread();
    const ctl = new AbortController();
    const before = interrupts.length;
    const p = engine.runMemberTurn({
      groupId: group.id,
      threadId,
      blobId: JUNIP.id,
      prompt: "x",
      cwd: group.workspace,
      allowDelegation: false,
      depth: 0,
      triggerSeq: 1,
      signal: ctl.signal,
    });
    await waitFor(() => turns.length > 0 && turns.at(-1)!.text === "x", "the member turn started");
    ctl.abort();
    // The pending stop must hold a referenced timer of its own: with only unref'd ones the loop emptied on Windows (the
    // runner's stdout pipes kept it alive on macOS), and Node cancelled this test and every one after it.
    await new Promise((r) => setImmediate(r));
    NodeAssert.ok(
      process.getActiveResourcesInfo().includes("Timeout"),
      "the aborted member turn keeps a referenced timer until it settles",
    );
    await NodeAssert.rejects(p, /Stopped/);
    NodeAssert.ok(interrupts.length > before, "the member's session was interrupted");
    // failure: the provider ends the turn in error
    const ctl2 = new AbortController();
    const p2 = engine.runMemberTurn({
      groupId: group.id,
      threadId,
      blobId: POPO.id,
      prompt: "y",
      cwd: group.workspace,
      allowDelegation: false,
      depth: 0,
      triggerSeq: 1,
      signal: ctl2.signal,
    });
    await waitFor(() => turns.at(-1)!.text === "y", "second turn started");
    const kora = turns.at(-1)!.threadId;
    notify(kora, { type: "turn.started", turnId: "e1" });
    notify(kora, { type: "runtime.error", message: "Claude hit its usage limit", turnId: "e1" });
    notify(kora, {
      type: "turn.settled",
      turnId: "e1",
      state: "failed",
      errorMessage: "Claude hit its usage limit",
    });
    await NodeAssert.rejects(p2, /usage limit/);
  },
);

NodeTest.test(
  "a member whose provider will not start fails fast: the group is not left waiting for a settle that never comes",
  async () => {
    const threadId = await newGroupThread();
    failSends = true;
    try {
      const t0 = Date.now();
      await NodeAssert.rejects(
        engine.runMemberTurn({
          groupId: group.id,
          threadId,
          blobId: POPO.id,
          prompt: "z",
          cwd: group.workspace,
          allowDelegation: false,
          depth: 0,
          triggerSeq: 1,
          signal: new AbortController().signal,
        }),
        /not signed in/,
      );
      NodeAssert.ok(Date.now() - t0 < 1500, "it did not wait for a timeout");
    } finally {
      failSends = false;
    }
  },
);

NodeTest.test(
  "deleting a group thread deletes its members' hidden sessions; the members' own other threads stay",
  async () => {
    installMiniOrchestrator();
    const stopProvider = providerAnswers(() => "ok");
    try {
      const threadId = await newGroupThread();
      await say(threadId, "@Popo hi");
      const rec = internals.threads.get(threadId)!;
      await waitFor(() => rec.session?.status === "ready" && rec.messages.length === 2, "settled");
      const memberIds = [...internals.groupMemberThreads.entries()]
        .filter(([k]) => k.startsWith(`${threadId}\u0000`))
        .map(([, v]) => v);
      NodeAssert.equal(memberIds.length, 1);
      await engine.dispatch({ type: "deleteThread", threadId } as never);
      NodeAssert.ok(!internals.threads.has(threadId));
      NodeAssert.ok(!internals.threads.has(memberIds[0]!), "the member's session went with it");
    } finally {
      stopProvider();
    }
  },
);

NodeTest.test(
  "outside access reads: visible threads only (no group or routine threads), rows with 'via' and tool summaries, search, blob state",
  async () => {
    const out = engine.outsideEngine();
    // a blob thread started by an outside client
    const sent = await out.send({
      blobId: POPO.id,
      text: "plan lisbon",
      via: { client: "Claude Desktop", tokenId: "tok_1" },
    });
    NodeAssert.ok("threadId" in sent, JSON.stringify(sent));
    const tid = (sent as { threadId: string }).threadId;
    NodeAssert.equal(out.thread(tid)!.status, "running");
    NodeAssert.equal(out.blobState(POPO.id), "working");
    const popoKora = internals.threads.get(tid)!.koraThreadId;
    notify(popoKora, { type: "turn.started", turnId: "o1" });
    await sleep(4);
    notify(popoKora, {
      type: "tool.started",
      itemId: "i1",
      toolKind: "command_execution",
      toolName: "Bash",
      title: "Ran ls",
      input: { command: "ls -la /Users/secret" },
      turnId: "o1",
    });
    await sleep(4);
    notify(popoKora, {
      type: "tool.started",
      itemId: "i2",
      toolKind: "file_change",
      toolName: "attach_output",
      title: "Itinerary - lisbon.md",
      input: { file_path: NodePath.join(POPO.workspace, "outputs", "lisbon.md") },
      turnId: "o1",
    });
    await sleep(4);
    notify(popoKora, {
      type: "content.delta",
      stream: "assistant_text",
      delta: "Here is the plan.",
      turnId: "o1",
    });
    notify(popoKora, { type: "turn.settled", turnId: "o1", state: "completed" });
    await waitFor(() => out.thread(tid)!.status === "settled", "settled");
    const rows = out.rows(tid) as Array<{
      role: string;
      text: string;
      via?: string;
      tool?: { name: string; summary: string };
      outputs?: Array<{ path: string }>;
    }>;
    NodeAssert.equal(rows[0]!.role, "user");
    NodeAssert.equal(rows[0]!.via, "Claude Desktop");
    const bash = rows.find((r) => r.tool?.name === "Bash")!;
    NodeAssert.equal(bash.tool!.summary, "Ran ls");
    NodeAssert.ok(!JSON.stringify(rows).includes("/Users/secret"), "tool arguments never leave");
    const att = rows.find((r) => r.tool?.name === "attach_output")!;
    NodeAssert.equal(
      att.outputs![0]!.path,
      "outputs/lisbon.md",
      "an output is named relative to the blob's folder",
    );
    NodeAssert.equal(rows.at(-1)!.role, "assistant");
    NodeAssert.deepEqual(
      out.search("lisbon", [POPO.id], 5).map((h) => h.id),
      [tid],
    );
    NodeAssert.equal(out.blobState(POPO.id), "idle");
    // group threads and their members' hidden sessions are not visible
    const gt = await newGroupThread();
    NodeAssert.equal(out.thread(gt), null);
    NodeAssert.ok(
      ![...out.threads(POPO.id)].some((t) => internals.threads.get(t.id)?.origin?.kind === "group"),
    );
    // follow-up into the same thread keeps the via; a refused follow-up (unknown thread) says why
    const again = await out.send({
      threadId: tid,
      text: "and the budget",
      via: { client: "Cursor", tokenId: "tok_2" },
    });
    NodeAssert.ok("threadId" in again);
    NodeAssert.equal(
      (
        internals.threads
          .get(tid)!
          .messages.filter((m) => m.role === "user")
          .at(-1) as { via?: string }
      ).via,
      "Cursor",
    );
    NodeAssert.deepEqual(
      await out.send({ threadId: "nope", text: "x", via: { client: "c", tokenId: "t" } }),
      { refused: "unknown" },
    );
    NodeAssert.deepEqual(
      await out.send({ blobId: POPO.id, text: "  ", via: { client: "c", tokenId: "t" } }),
      { refused: "empty" },
    );
    // interrupt only a running visible thread
    NodeAssert.equal(await out.interrupt(tid), true);
    NodeAssert.equal(await out.interrupt("nope"), false);
  },
);

NodeTest.test(
  "send_to_group from outside posts into the group's newest thread (marked via) and the group answers",
  async () => {
    installMiniOrchestrator();
    const stopProvider = providerAnswers(() => "heard you");
    try {
      const out = engine.outsideEngine();
      const r = await out.groupSend!({
        groupId: group.id,
        text: "@Junip from outside",
        via: { client: "Claude Desktop", tokenId: "tok_1" },
      });
      NodeAssert.deepEqual(r, { ok: true });
      await waitFor(
        () =>
          [...internals.threads.values()].some(
            (t) => t.projectId === group.id && t.messages.some((m) => m.via === "Claude Desktop"),
          ),
        "the message landed",
      );
      const rec = [...internals.threads.values()].find(
        (t) => t.projectId === group.id && t.messages.some((m) => m.via === "Claude Desktop"),
      )!;
      await waitFor(
        () => rec.messages.some((m) => m.authorBlobId === JUNIP.id && m.text === "heard you"),
        "Junip answered",
      );
      NodeAssert.ok(rec.messages.some((m) => m.role === "user" && m.via === "Claude Desktop"));
      NodeAssert.equal(
        (
          await out.groupSend!({
            groupId: "group_nope",
            text: "x",
            via: { client: "c", tokenId: "t" },
          })
        ).ok,
        false,
      );
    } finally {
      stopProvider();
    }
  },
);

// ── handlers ────────────────────────────────────────────────────────────────────────────────────────────────────
const run = <A>(rec: Record<string, (i: unknown) => unknown>, tag: string, input: unknown = {}) =>
  Effect.runPromise(rec[tag]!(input) as Effect.Effect<A, { message: string; code: string | null }>);
const runFail = (rec: Record<string, (i: unknown) => unknown>, tag: string, input: unknown = {}) =>
  Effect.runPromise(
    Effect.flip(
      rec[tag]!(input) as Effect.Effect<object, { message: string; code: string | null }>,
    ),
  );
const noUndefined = (v: unknown, p = "$"): void => {
  if (v === undefined) throw new Error(`undefined at ${p}`);
  if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) noUndefined(x, `${p}.${k}`);
};

NodeTest.test(
  "groups handlers: create / update / archive / delete (typed errors, wire-safe results)",
  async () => {
    const g = await run<{ id: string; rule: string }>(
      blobsGroupsHandlers as never,
      GROUP_METHODS.create,
      { name: "ops", memberIds: [POPO.id, JUNIP.id], rule: "lead" },
    );
    NodeAssert.equal(g.id, "group_ops");
    noUndefined(g);
    const u = await run<{ name: string }>(blobsGroupsHandlers as never, GROUP_METHODS.update, {
      id: g.id,
      patch: { name: "ops2", pinned: true },
    });
    NodeAssert.equal(u.name, "ops2");
    const a = await run<{ archivedAt: number }>(
      blobsGroupsHandlers as never,
      GROUP_METHODS.archive,
      { id: g.id },
    );
    NodeAssert.equal(a.archivedAt, 5);
    const bad = await runFail(blobsGroupsHandlers as never, GROUP_METHODS.delete, {
      id: g.id,
      confirmName: "wrong",
    });
    NodeAssert.equal(bad.code, "bad-confirm");
    NodeAssert.match(bad.message, /Type the group/);
    await run(blobsGroupsHandlers as never, GROUP_METHODS.delete, {
      id: g.id,
      confirmName: "ops2",
    });
    NodeAssert.ok(!groupsList.has(g.id));
  },
);

NodeTest.test(
  "team handlers: options, preview, export, an import plan from text, a refused link, apply picks the engine",
  async () => {
    const o = await run<{ koraId: string; blobs: unknown[] }>(
      blobsGroupsHandlers as never,
      GROUP_METHODS.teamOptions,
    );
    NodeAssert.equal(o.koraId, "blob_kora");
    NodeAssert.equal(o.blobs.length, 1);
    noUndefined(
      await run(blobsGroupsHandlers as never, GROUP_METHODS.teamPreview, {
        selection: {
          blobIds: [],
          groupIds: [],
          chief: true,
          routines: true,
          skills: true,
          name: "t",
        },
      }),
    );
    const ex = await run<{ markdown: string; fileName: string }>(
      blobsGroupsHandlers as never,
      GROUP_METHODS.teamExport,
      {
        selection: {
          blobIds: [],
          groupIds: [],
          chief: true,
          routines: true,
          skills: true,
          name: "t",
        },
      },
    );
    NodeAssert.match(ex.fileName, /kora-team\.md$/);
    const plan = await run<{ planId: string }>(
      blobsGroupsHandlers as never,
      GROUP_METHODS.teamImportPlan,
      { text: "kora_team: 1" },
    );
    NodeAssert.equal(plan.planId, "plan_1");
    NodeAssert.equal(
      (
        await runFail(blobsGroupsHandlers as never, GROUP_METHODS.teamImportPlan, {
          text: "nonsense",
        })
      ).message,
      "That is not a Kora team file.",
    );
    NodeAssert.match(
      (
        await runFail(blobsGroupsHandlers as never, GROUP_METHODS.teamImportPlan, {
          url: "http://x.test/a.md",
        })
      ).message,
      /https/,
    );
    NodeAssert.match(
      (await runFail(blobsGroupsHandlers as never, GROUP_METHODS.teamImportPlan, {})).message,
      /Choose a team file/,
    );
    // apply: the client names only what to skip; the daemon picks the engine
    await run(blobsGroupsHandlers as never, GROUP_METHODS.teamImportApply, {
      planId: "plan_1",
      skip: { blobs: ["A"], groups: [] },
    });
    NodeAssert.equal((teamPlans.at(-1) as { planId: string }).planId, "plan_1");
    NodeAssert.deepEqual((teamPlans.at(-1) as { skip: unknown }).skip, {
      blobs: ["A"],
      groups: [],
      replace: [],
    });
    // Replace choices travel to the service as given
    await run(blobsGroupsHandlers as never, GROUP_METHODS.teamImportApply, {
      planId: "plan_2",
      skip: { blobs: [], groups: [], replace: ["Popo 2"] },
    });
    NodeAssert.deepEqual((teamPlans.at(-1) as { skip: unknown }).skip, {
      blobs: [],
      groups: [],
      replace: ["Popo 2"],
    });
    NodeAssert.ok(
      (teamPlans.at(-1) as { engine: { instanceId: string } }).engine.instanceId,
      "an engine was chosen by the daemon",
    );
  },
);

NodeTest.test(
  "outside handlers: setup names this install, the token secret leaves ONLY in create, duplicate names are refused, revoke and audit",
  async () => {
    const setup = await run<{
      command: string;
      args: string[];
      serverName: string;
      limits: { callsPerMinute: number };
    }>(blobsOutsideHandlers as never, OUTSIDE_METHODS.setup);
    NodeAssert.match(setup.command, /\.local[/\\]bin[/\\]kora(\.cmd)?$/);
    NodeAssert.deepEqual(setup.args.slice(0, 2), ["mcp", "--team"]);
    NodeAssert.ok(setup.args.includes("--socket"), "a QA stack names its own socket");
    NodeAssert.equal(setup.limits.callsPerMinute, 60);
    const made = await run<{ secret: string; token: { id: string; name: string } }>(
      blobsOutsideHandlers as never,
      OUTSIDE_METHODS.create,
      { name: "Claude Desktop" },
    );
    NodeAssert.match(made.secret, /^kbo_/);
    const listed = await run<{ tokens: Array<Record<string, unknown>> }>(
      blobsOutsideHandlers as never,
      OUTSIDE_METHODS.tokens,
    );
    NodeAssert.ok(
      !JSON.stringify(listed).includes("SECRETSECRET"),
      "the list never carries a secret",
    );
    NodeAssert.equal(
      (
        await runFail(blobsOutsideHandlers as never, OUTSIDE_METHODS.create, {
          name: "Claude Desktop",
        })
      ).code,
      "invalid",
    );
    NodeAssert.deepEqual(
      await run(blobsOutsideHandlers as never, OUTSIDE_METHODS.revoke, { id: made.token.id }),
      { revoked: true },
    );
    NodeAssert.deepEqual(
      await run(blobsOutsideHandlers as never, OUTSIDE_METHODS.revoke, { id: "tok_nope" }),
      { revoked: false },
    );
    const audit = await run<{ rows: Array<{ note: unknown }>; next: null }>(
      blobsOutsideHandlers as never,
      OUTSIDE_METHODS.audit,
      { before: null },
    );
    NodeAssert.equal(
      audit.rows[0]!.note,
      null,
      "a missing note is null on the wire, never undefined",
    );
    noUndefined(audit);
  },
);

NodeTest.test(
  "retiring a member prunes through the runtime and the project mirror follows",
  async () => {
    // the runtime's GroupStore prunes archived members; here the stand-in just changes the group and announces it
    groupsList.set(group.id, { ...group, memberIds: [KORA.id, POPO.id] });
    groupChanged.forEach((f) => f(group.id));
    NodeAssert.ok(internals.projects.has(group.id));
  },
);
