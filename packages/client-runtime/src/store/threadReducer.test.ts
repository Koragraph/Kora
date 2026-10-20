import { describe, expect, it } from "vite-plus/test";

import * as C from "@kora/contracts";
import type { ChatThread } from "@kora/contracts";

import { applyThreadDetailEvent } from "./threadReducer.ts";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

type DetailEvent = Parameters<typeof applyThreadDetailEvent>[1];
type Outcome = ReturnType<typeof applyThreadDetailEvent>;
type Message = ChatThread["messages"][number];
type Activity = ChatThread["activities"][number];

const THREAD_ID = C.ThreadId.make("th-main");
const PROJECT_ID = C.ProjectId.make("pj-main");
const turn = (n: number) => C.TurnId.make(`tu-${n}`);
const item = (raw: string) => C.ItemId.make(raw);

/** `2025-05-01T<hh>:<mm>:00.000Z` */
const at = (hour: number, minute = 0) =>
  `2025-05-01T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;

/** Fields a fresh thread starts without. */
const UNSET = [
  "latestTurn",
  "session",
  "branch",
  "worktreePath",
  "settledAt",
  "settledOverride",
  "archivedAt",
  "deletedAt",
] as const;
/** Collections a fresh thread starts empty. */
const EMPTY = ["checkpoints", "activities", "proposedPlans", "messages", "pullRequests"] as const;

const thread = (overrides: Partial<ChatThread> = {}): ChatThread =>
  ({
    ...Object.fromEntries(UNSET.map((field) => [field, null])),
    ...Object.fromEntries(EMPTY.map((field) => [field, []])),
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Reducer thread",
    modelSelection: { instanceId: C.AgentProfileId.make("codex"), model: "gpt-5.5" },
    agentMode: "chat",
    interactionMode: "default",
    runtimeMode: "full-access",
    createdAt: at(0),
    updatedAt: at(0),
    ...overrides,
  }) as ChatThread;

let nextSequence = 1;
/** A thread event with the standard envelope; payload gets `threadId` unless it brings one. */
function event(type: string, payload: Record<string, unknown>, when = at(1)): DetailEvent {
  return {
    sequence: nextSequence++,
    eventId: C.EventId.make(`ev-${nextSequence}`),
    type,
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    occurredAt: when,
    metadata: {},
    ...{ correlationId: null, causationEventId: null, commandId: null },
    payload: { threadId: THREAD_ID, ...payload },
  } as never;
}

/** Asserts an `updated` outcome and returns the new thread. */
function updatedThread(outcome: Outcome): ChatThread {
  expect(outcome.kind).toBe("updated");
  if (outcome.kind !== "updated") throw new Error(`expected an update, got ${outcome.kind}`);
  return outcome.thread;
}

const apply = (state: ChatThread, ...events: DetailEvent[]): Outcome => {
  let outcome: Outcome = { kind: "unchanged" } as Outcome;
  let current = state;
  for (const next of events) {
    outcome = applyThreadDetailEvent(current, next);
    if (outcome.kind === "updated") current = outcome.thread;
  }
  return outcome;
};

const message = (
  id: string,
  role: Message["role"],
  text: string,
  extra: Partial<Message> = {},
): Message => ({
  id: item(id),
  role,
  text,
  turnId: null,
  streaming: false,
  createdAt: at(1),
  updatedAt: at(1),
  ...extra,
});

/** Payload for thread.message-sent built from a message. */
const sent = (m: Message) => {
  const { id, ...rest } = m;
  return { messageId: id, ...rest };
};

const session = (status: string, activeTurn: number | null, providerName = "claude") =>
  ({
    threadId: THREAD_ID,
    status,
    providerName,
    runtimeMode: "full-access",
    activeTurnId: activeTurn === null ? null : turn(activeTurn),
    lastError: null,
    updatedAt: at(6, 59),
  }) as ChatThread["session"];

const runningTurn = (
  n: number,
  assistantMessageId: string | null = null,
): NonNullable<ChatThread["latestTurn"]> => ({
  turnId: turn(n),
  state: "running",
  requestedAt: at(6, 59),
  startedAt: at(6, 59),
  completedAt: null,
  assistantMessageId: assistantMessageId === null ? null : item(assistantMessageId),
});

const checkpoint = (n: number, assistantMessageId: string | null, completedAt = at(6, 30)) => ({
  turnId: turn(n),
  checkpointTurnCount: n,
  checkpointRef: C.TurnCheckpointRef.make(`ref-${n}`),
  status: "ready" as const,
  files: [],
  assistantMessageId: assistantMessageId === null ? null : item(assistantMessageId),
  completedAt,
});

const activity = (
  id: string,
  sequence: number | null,
  extra: Partial<Activity> = {},
): Activity => ({
  id: C.EventId.make(id),
  tone: "tool",
  kind: "command",
  summary: `ran ${id}`,
  payload: {},
  turnId: turn(1),
  ...(sequence === null ? {} : { sequence }),
  createdAt: at(11),
  ...extra,
});
const appended = (a: Activity) => event("threadActivityAppended", { activity: a });
const ids = (list: ReadonlyArray<{ id: string }>) => list.map(({ id }) => id);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("thread detail reducer", () => {
  describe("lifecycle", () => {
    it("ignores project events", () => {
      const created = {
        ...(event("projectCreated", {}) as object),
        aggregateKind: "project",
        aggregateId: PROJECT_ID,
        payload: {
          projectId: PROJECT_ID,
          title: "Proj",
          workspaceRoot: "/work",
          scripts: [],
          defaultModelSelection: null,
          repositoryIdentity: null,
          createdAt: at(1),
          updatedAt: at(1),
          deletedAt: null,
        },
      } as never;
      expect(applyThreadDetailEvent(thread(), created).kind).toBe("unchanged");
    });

    it("builds a fresh thread from thread.created", () => {
      const otherId = C.ThreadId.make("th-other");
      const fresh = updatedThread(
        applyThreadDetailEvent(
          thread(),
          event("threadCreated", {
            threadId: otherId,
            projectId: PROJECT_ID,
            title: "Brand new",
            modelSelection: { instanceId: C.AgentProfileId.make("codex"), model: "gpt-5.5" },
            runtimeMode: "full-access",
            interactionMode: "default",
            agentMode: "chat",
            branch: "trunk",
            worktreePath: null,
            createdAt: at(1),
            updatedAt: at(1),
          }),
        ),
      );
      expect([fresh.id, fresh.title, fresh.branch, fresh.session]).toEqual([
        otherId,
        "Brand new",
        "trunk",
        null,
      ]);
      expect(fresh.messages).toEqual([]);
    });

    it("signals deletion", () => {
      expect(
        applyThreadDetailEvent(thread(), event("threadDeleted", { deletedAt: at(2) })).kind,
      ).toBe("deleted");
    });

    it("archiving stamps archivedAt and drops a pending title regeneration; unarchiving clears it", () => {
      const regenerating = thread({
        titleRegeneration: { requestId: C.DispatchCommandId.make("regen-1"), startedAt: at(2) },
      });
      const archived = updatedThread(
        applyThreadDetailEvent(
          regenerating,
          event("threadArchived", { archivedAt: at(3), updatedAt: at(3) }),
        ),
      );
      expect(archived.archivedAt).toBe(at(3));
      expect(archived.titleRegeneration).toBeNull();

      const restored = updatedThread(
        applyThreadDetailEvent(
          thread({ archivedAt: at(3) }),
          event("threadUnarchived", { updatedAt: at(4) }),
        ),
      );
      expect(restored.archivedAt).toBeNull();
    });
  });

  describe("settling and pinning", () => {
    it("settling sets the override and time and leaves the active order", () => {
      const settled = updatedThread(
        applyThreadDetailEvent(
          thread({ activeOrderKey: "k" }),
          event("threadSettled", { settledAt: at(5), updatedAt: at(5) }, at(5)),
        ),
      );
      expect([settled.settledOverride, settled.settledAt, settled.activeOrderKey]).toEqual([
        "settled",
        at(5),
        null,
      ]);
    });

    it.each([
      ["user", "active"],
      ["activity", null],
    ] as const)("unsettling for %s leaves override %s and no settledAt", (reason, override) => {
      const unsettled = updatedThread(
        applyThreadDetailEvent(
          thread({ settledOverride: "settled", settledAt: at(5) }),
          event("threadUnsettled", { reason, updatedAt: at(6) }, at(6)),
        ),
      );
      expect([unsettled.settledOverride, unsettled.settledAt]).toEqual([override, null]);
    });

    it("pinning sets pinnedAt and keeps the active key; unpinning clears it", () => {
      const pinned = updatedThread(
        applyThreadDetailEvent(
          thread({ activeOrderKey: "k" }),
          event("threadPinned", { pinnedAt: at(5), updatedAt: at(5) }, at(5)),
        ),
      );
      expect([pinned.pinnedAt, pinned.activeOrderKey]).toEqual([at(5), "k"]);

      const unpinned = updatedThread(
        applyThreadDetailEvent(
          thread({ pinnedAt: at(5) }),
          event("threadUnpinned", { updatedAt: at(6) }, at(6)),
        ),
      );
      expect(unpinned.pinnedAt).toBeNull();
    });
  });

  describe("metadata", () => {
    it.each(["b", null] as const)(
      "moves the active key to %s without touching updatedAt",
      (key) => {
        const base = thread({ activeOrderKey: "k" });
        const next = updatedThread(
          applyThreadDetailEvent(
            base,
            event("threadMetaUpdated", { activeOrderKey: key, updatedAt: base.updatedAt }),
          ),
        );
        expect([next.activeOrderKey, next.updatedAt]).toEqual([key, base.updatedAt]);
      },
    );

    it("patches only the fields it carries", () => {
      const base = thread({ activeOrderKey: "k" });
      const next = updatedThread(
        applyThreadDetailEvent(
          base,
          event("threadMetaUpdated", { title: "Renamed", branch: "topic/x", updatedAt: at(5) }),
        ),
      );
      expect([next.title, next.branch, next.activeOrderKey]).toEqual(["Renamed", "topic/x", "k"]);
      expect(next.modelSelection).toEqual(base.modelSelection);
    });

    it.each(["linkedPullRequest", "branchPullRequest"] as const)(
      "sets and clears %s while the other link stays",
      (field) => {
        const other = field === "linkedPullRequest" ? "branchPullRequest" : "linkedPullRequest";
        const pr = (n: number) => ({
          projectId: PROJECT_ID,
          repository: "octo/site",
          number: n,
          url: `https://github.com/octo/site/pull/${n}`,
        });
        const set = updatedThread(
          applyThreadDetailEvent(
            thread({ [other]: pr(8) }),
            event("threadMetaUpdated", { [field]: pr(7), updatedAt: at(5) }),
          ),
        );
        expect([set[field], set[other]]).toEqual([pr(7), pr(8)]);

        const cleared = updatedThread(
          applyThreadDetailEvent(
            set,
            event("threadMetaUpdated", { [field]: null, updatedAt: at(6) }),
          ),
        );
        expect([cleared[field], cleared[other]]).toEqual([null, pr(8)]);
      },
    );
  });

  describe("pull request links", () => {
    const key = { host: "github.com", repository: "octo/site", number: 7 };
    const link = {
      ...key,
      url: "https://github.com/octo/site/pull/7",
      source: "manual" as const,
      linkedAt: at(5),
      snapshot: null,
      stack: null,
    };
    const linked = () =>
      updatedThread(
        applyThreadDetailEvent(thread(), event("pullRequestLinked", { link, updatedAt: at(5) })),
      );

    it("adds a link without filling the legacy field, and re-linking replaces by key", () => {
      const first = linked();
      expect(first.pullRequests).toEqual([link]);
      expect(first.linkedPullRequest).toBeNull();

      const again = updatedThread(
        applyThreadDetailEvent(
          first,
          event("pullRequestLinked", {
            link: { ...link, host: "GITHUB.COM", source: "agent" },
            updatedAt: at(6),
          }),
        ),
      );
      expect(again.pullRequests.map(({ source }) => source)).toEqual(["agent"]);
    });

    it("syncs a snapshot onto the matching link and ignores an unknown one", () => {
      const snapshot = {
        state: "merged" as const,
        title: "Landed",
        headBranch: "topic",
        baseBranch: "trunk",
        isDraft: false,
        updatedAt: at(9),
        syncedAt: at(9, 1),
      };
      const synced = updatedThread(
        applyThreadDetailEvent(
          linked(),
          event("pullRequestSynced", {
            ...key,
            snapshot,
            stack: null,
            updatedAt: at(9, 1),
          }),
        ),
      );
      expect(synced.pullRequests[0]?.snapshot).toEqual(snapshot);

      const stray = applyThreadDetailEvent(
        synced,
        event("pullRequestSynced", {
          ...key,
          number: 404,
          snapshot,
          stack: null,
          updatedAt: at(9, 2),
        }),
      );
      expect(stray.kind).toBe("unchanged");
    });

    it("unlinks and leaves the legacy field empty", () => {
      const unlinked = updatedThread(
        applyThreadDetailEvent(
          linked(),
          event("pullRequestUnlinked", { ...key, updatedAt: at(6) }),
        ),
      );
      expect([unlinked.pullRequests, unlinked.linkedPullRequest]).toEqual([[], null]);
    });
  });

  describe("messages", () => {
    it.each([
      ["a", "a+ b c"],
      ["b", "a b+ c"],
      ["c", "a b c+"],
      ["d", "a b c +"],
    ])("a streaming delta for %s changes only that message (%s)", (target, texts) => {
      const messages = Object.freeze(
        ["a", "b", "c"].map((name) =>
          Object.freeze(message(name, "assistant", name, { createdAt: at(0), updatedAt: at(0) })),
        ),
      );
      const next = updatedThread(
        applyThreadDetailEvent(
          thread({ messages }),
          event(
            "threadMessageSent",
            sent(
              message(target, "assistant", "+", {
                streaming: true,
                createdAt: at(0),
                updatedAt: at(0),
              }),
            ),
          ),
        ),
      );
      expect(next.messages.map(({ text }) => text).join(" ")).toBe(texts);
      messages.forEach((original, index) => {
        if (original.id !== target) expect(next.messages[index]).toBe(original);
      });
    });

    it("appends a new user message", () => {
      const next = updatedThread(
        applyThreadDetailEvent(
          thread(),
          event("threadMessageSent", sent(message("u1", "user", "Hi there"))),
        ),
      );
      expect(next.messages.map(({ text }) => text)).toEqual(["Hi there"]);
    });

    it("keeps an imported reply turnless, even when it is delivered twice", () => {
      const reply = message("import:codex:s-1:000004", "assistant", "From history", {
        createdAt: "2025-04-01T00:00:00.000Z",
        updatedAt: "2025-04-01T00:00:00.000Z",
      });
      const base = thread();
      const once = updatedThread(
        applyThreadDetailEvent(base, event("threadMessageSent", sent(reply))),
      );
      const twice = updatedThread(
        applyThreadDetailEvent(once, event("threadMessageSent", sent(reply))),
      );
      for (const state of [once, twice]) {
        expect(state.latestTurn).toBeNull();
        expect(state.checkpoints).toBe(base.checkpoints);
      }
      expect(twice.messages).toEqual(once.messages);
    });

    it("keeps the structured context sent with a message", () => {
      const v1 = 1 as const;
      const context = {
        records: [
          {
            kind: "skill" as const,
            version: v1,
            contextId: C.ContextChipId.make("chip-lint"),
            label: "$lint",
            name: "lint",
          },
        ],
        version: v1,
      };
      const next = updatedThread(
        applyThreadDetailEvent(
          thread(),
          event("threadMessageSent", {
            ...sent(message("u2", "user", "Run [$lint](kora-context://v1/skill/chip-lint).")),
            context,
          }),
        ),
      );
      expect(next.messages[0]?.context).toEqual(context);
    });

    it("concatenates streaming text into the same message", () => {
      const streaming = message("a1", "assistant", "Good", { turnId: turn(1), streaming: true });
      const next = updatedThread(
        applyThreadDetailEvent(
          thread({ messages: [streaming] }),
          event("threadMessageSent", sent({ ...streaming, text: " morning", updatedAt: at(1, 1) })),
        ),
      );
      expect(next.messages.map(({ text }) => text)).toEqual(["Good morning"]);
    });

    it("completes the latest turn on a final assistant message", () => {
      const next = updatedThread(
        applyThreadDetailEvent(
          thread(),
          event(
            "threadMessageSent",
            sent(message("a3", "assistant", "All done.", { turnId: turn(1) })),
          ),
        ),
      );
      expect(next.latestTurn).toMatchObject({
        turnId: turn(1),
        state: "completed",
        assistantMessageId: item("a3"),
      });
    });

    it("keeps the turn running for interim messages while the session is still on it", () => {
      const next = updatedThread(
        applyThreadDetailEvent(
          thread({ session: session("running", 1), latestTurn: runningTurn(1) }),
          event(
            "threadMessageSent",
            sent(message("a3", "assistant", "Checking files next.", { turnId: turn(1) })),
          ),
        ),
      );
      expect([next.latestTurn?.state, next.latestTurn?.completedAt]).toEqual(["running", null]);
    });

    it("keeps latestTurn and checkpoints by reference across a plain delta", () => {
      const before = thread({
        session: session("running", 1),
        latestTurn: runningTurn(1, "a2"),
        messages: [message("a2", "assistant", "Good", { turnId: turn(1), streaming: true })],
        checkpoints: [checkpoint(1, "a2")],
      });
      const next = updatedThread(
        applyThreadDetailEvent(
          before,
          event(
            "threadMessageSent",
            sent(message("a2", "assistant", " morning", { turnId: turn(1), streaming: true })),
          ),
        ),
      );
      expect(next.messages).not.toBe(before.messages);
      expect(next.messages[0]?.text).toBe("Good morning");
      expect(next.latestTurn).toBe(before.latestTurn);
      expect(next.checkpoints).toBe(before.checkpoints);
    });

    it("binds the turn and its checkpoint to the first assistant message", () => {
      const before = thread({
        session: session("running", 1),
        latestTurn: runningTurn(1),
        checkpoints: [checkpoint(1, null)],
      });
      const next = updatedThread(
        applyThreadDetailEvent(
          before,
          event(
            "threadMessageSent",
            sent(message("a2", "assistant", "Good", { turnId: turn(1), streaming: true })),
          ),
        ),
      );
      expect(next.latestTurn).not.toBe(before.latestTurn);
      expect(next.checkpoints).not.toBe(before.checkpoints);
      expect([
        next.latestTurn?.assistantMessageId,
        next.checkpoints[0]?.assistantMessageId,
      ]).toEqual([item("a2"), item("a2")]);
    });
  });

  describe("sessions", () => {
    it("completes a running turn once the session stops running", () => {
      const next = updatedThread(
        applyThreadDetailEvent(
          thread({ latestTurn: runningTurn(1, "a3") }),
          event(
            "threadSessionSet",
            { session: { ...session("ready", null), updatedAt: at(8) } },
            at(8),
          ),
        ),
      );
      expect([next.latestTurn?.state, next.latestTurn?.completedAt]).toEqual(["completed", at(8)]);
    });

    it("starts a running turn from a running session", () => {
      const next = updatedThread(
        applyThreadDetailEvent(
          thread(),
          event("threadSessionSet", { session: session("running", 1, "codex") }, at(8)),
        ),
      );
      expect([next.session?.status, next.latestTurn?.turnId, next.latestTurn?.state]).toEqual([
        "running",
        turn(1),
        "running",
      ]);
    });

    it("a stop request marks the session stopped, and is a no-op without one", () => {
      const stop = () => event("sessionStopRequested", { createdAt: at(9) }, at(9));
      const stopped = updatedThread(
        applyThreadDetailEvent(thread({ session: session("running", 1, "codex") }), stop()),
      );
      expect([stopped.session?.status, stopped.session?.activeTurnId]).toEqual(["stopped", null]);
      expect(applyThreadDetailEvent(thread(), stop()).kind).toBe("unchanged");
    });
  });

  describe("plans", () => {
    it("adds an upserted plan", () => {
      const next = updatedThread(
        applyThreadDetailEvent(
          thread(),
          event("proposedPlanUpserted", {
            proposedPlan: {
              id: "pl-1",
              turnId: turn(1),
              planMarkdown: "1. read\n2. write",
              implementedAt: null,
              implementationThreadId: null,
              createdAt: at(10),
              updatedAt: at(10),
            },
          }),
        ),
      );
      expect(ids(next.proposedPlans)).toEqual(["pl-1"]);
    });
  });

  describe("activities", () => {
    it("appends one", () => {
      const next = updatedThread(
        applyThreadDetailEvent(
          thread(),
          appended(activity("act-1", null, { kind: "file-edit", summary: "Edited a.ts" })),
        ),
      );
      expect(next.activities.map(({ kind }) => kind)).toEqual(["file-edit"]);
    });

    it("keeps the full history when a live one arrives", () => {
      const history = Array.from({ length: 129 }, (_, n) => activity(`act-${n}`, n));
      const next = updatedThread(
        applyThreadDetailEvent(thread({ activities: history }), appended(activity("act-129", 129))),
      );
      expect(next.activities.length).toBe(130);
      expect(next.activities[0]?.id).toBe("act-0");
    });

    it("sorts an out-of-order arrival into place", () => {
      const next = updatedThread(
        applyThreadDetailEvent(
          thread({ activities: [activity("x1", 1), activity("x3", 3)] }),
          appended(activity("x2", 2)),
        ),
      );
      expect(ids(next.activities)).toEqual(["x1", "x2", "x3"]);
    });

    // A snapshot delivers sequence-less rows first (database order); they sort last, and an
    // in-order append must not freeze the wrong prefix.
    it("repairs a snapshot's order before taking the fast append path", () => {
      const next = updatedThread(
        applyThreadDetailEvent(
          thread({ activities: [activity("nos", null), activity("x1", 1)] }),
          appended(activity("x2", 2)),
        ),
      );
      expect(ids(next.activities)).toEqual(["x1", "x2", "nos"]);
    });

    it("replaces a re-delivered activity right after an in-order append", () => {
      const result = apply(
        thread({ activities: [activity("x1", 1)] }),
        appended(activity("x2", 2)),
        appended(activity("x3", 3)),
        appended(activity("x3", 4, { summary: "again" })),
      );
      const next = updatedThread(result);
      expect(ids(next.activities)).toEqual(["x1", "x2", "x3"]);
      expect(next.activities[2]?.summary).toBe("again");
    });

    it("replaces a re-delivered activity in the middle instead of duplicating it", () => {
      const next = updatedThread(
        applyThreadDetailEvent(
          thread({ activities: [activity("x1", 1), activity("x2", 2)] }),
          appended(activity("x2", 2, { summary: "updated" })),
        ),
      );
      expect(ids(next.activities)).toEqual(["x1", "x2"]);
      expect(next.activities[1]?.summary).toBe("updated");
    });

    describe("context-window updates", () => {
      const usage = (id: string, sequence: number, usedTokens: unknown, onTurn = 1) =>
        activity(id, sequence, {
          payload: { usedTokens },
          turnId: turn(onTurn),
          kind: "context-window.updated",
          tone: "info",
          summary: "Context window updated",
        });

      it("keep only the newest resolvable value per turn", () => {
        const before = [
          usage("cw-1", 1, 1_000),
          usage("cw-other", 2, 500, 0),
          // No usedTokens: kept, and never mistaken for the latest value.
          usage("cw-bad", 3, undefined),
          usage("cw-2", 4, 2_000),
        ];
        const next = updatedThread(
          applyThreadDetailEvent(thread({ activities: before }), appended(usage("cw-3", 5, 3_000))),
        );
        expect(ids(next.activities)).toEqual(["cw-other", "cw-bad", "cw-3"]);
      });

      it("do not collapse when the new value is malformed", () => {
        // The resolvable row has to stay so consumers can walk back past the broken one.
        const next = updatedThread(
          applyThreadDetailEvent(
            thread({ activities: [usage("cw-ok", 1, 1_000)] }),
            appended(usage("cw-nan", 2, Number.NaN)),
          ),
        );
        expect(ids(next.activities)).toEqual(["cw-ok", "cw-nan"]);
      });
    });
  });

  describe("turn diffs", () => {
    it.each([null, "interrupted"] as const)("add a checkpoint and keep a %s outcome", (prior) => {
      const latestTurn =
        prior === null ? null : { ...runningTurn(1), state: prior, completedAt: at(12) };
      const next = updatedThread(
        applyThreadDetailEvent(
          thread({ latestTurn }),
          event("turnDiffCompleted", { ...checkpoint(1, "a3", at(12)), turnId: turn(1) }, at(12)),
        ),
      );
      expect(next.checkpoints.length).toBe(1);
      expect([next.latestTurn?.turnId, next.latestTurn?.state]).toEqual([
        turn(1),
        prior ?? "completed",
      ]);
    });
  });

  describe("reverts", () => {
    it("compares message times as instants across UTC offsets", () => {
      const next = updatedThread(
        applyThreadDetailEvent(
          thread({
            messages: [
              // 08:30Z expressed in +02:00, earlier than 09:00Z.
              message("early", "user", "first", {
                createdAt: "2025-05-01T10:30:00.000+02:00",
                updatedAt: "2025-05-01T10:30:00.000+02:00",
              }),
              message("late", "user", "second", { createdAt: at(9), updatedAt: at(9) }),
            ],
          }),
          event("threadReverted", { turnCount: 1 }, at(10)),
        ),
      );
      expect(ids(next.messages)).toEqual(["early"]);
    });

    it("drops messages and checkpoints of later turns", () => {
      const next = updatedThread(
        applyThreadDetailEvent(
          thread({
            messages: [
              message("u", "user", "go", { createdAt: at(1), updatedAt: at(1) }),
              message("r1", "assistant", "one", {
                turnId: turn(1),
                createdAt: at(2),
                updatedAt: at(2),
              }),
              message("r2", "assistant", "two", {
                turnId: turn(2),
                createdAt: at(3),
                updatedAt: at(3),
              }),
            ],
            checkpoints: [checkpoint(1, "r1", at(2)), checkpoint(2, "r2", at(3))],
          }),
          event("threadReverted", { turnCount: 1 }, at(4)),
        ),
      );
      expect(next.checkpoints.map(({ turnId }) => turnId)).toEqual([turn(1)]);
      expect(ids(next.messages)).toEqual(["u", "r1"]);
      expect(next.latestTurn?.turnId).toBe(turn(1));
    });
  });

  it("ignores events that only matter to the server", () => {
    const approval = event("approvalResponseRequested", {
      requestId: "rq-1",
      decision: "approve",
      createdAt: at(13),
    });
    expect(applyThreadDetailEvent(thread(), approval).kind).toBe("unchanged");
  });
});
