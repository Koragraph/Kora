import { ItemId, TurnId } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TranscriptItem, WorkLogEntry } from "../../thread/timeline";
import type { ChatMessage } from "../../types";
import * as Logic from "./ThreadTranscript.logic";
import type { TranscriptRowEntry } from "./ThreadTranscript.logic";

// ---- builders -----------------------------------------------------------------------------------

/** Seconds past a fixed minute, as ISO strings. */
const t = (seconds: number) => new Date(Date.UTC(2026, 4, 2, 10, 0, seconds)).toISOString();

const TURN_A = TurnId.make("turn-a");
const TURN_B = TurnId.make("turn-b");

const chat = (
  id: string,
  role: ChatMessage["role"],
  text: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage => ({
  text,
  role,
  id: ItemId.make(id),
  turnId: null,
  streaming: false,
  createdAt: t(0),
  updatedAt: t(0),
  ...extra,
});

const said = (message: ChatMessage): TranscriptItem => {
  const { id, createdAt } = message;
  return { kind: "message", message, createdAt, id };
};

const did = (id: string, fields: Partial<WorkLogEntry> = {}, at = t(1)): TranscriptItem => ({
  kind: "work",
  id: `item-${id}`,
  createdAt: at,
  entry: { id, createdAt: at, label: "Tool call", tone: "tool", ...fields } as WorkLogEntry,
});

/** A shell command row in the given lifecycle state. */
const ran = (
  id: string,
  status: NonNullable<WorkLogEntry["toolLifecycleStatus"]>,
  extra: Partial<WorkLogEntry> = {},
  at = t(1),
) =>
  did(
    id,
    { itemType: "command_execution", command: "pnpm test", toolLifecycleStatus: status, ...extra },
    at,
  );

const IDLE = { activeTurnStartedAt: null, isWorking: false };
type Input = Parameters<typeof Logic.deriveTranscriptRows>[0];
const rowsOf = (timelineEntries: TranscriptItem[], extra: Partial<Input> = {}) =>
  Logic.deriveTranscriptRows({ ...IDLE, ...extra, timelineEntries });

/** Rows as "kind:id" for order checks. */
const shape = (rows: TranscriptRowEntry[]) => rows.map((row) => `${row.kind}:${row.id}`);
const only = <K extends TranscriptRowEntry["kind"]>(rows: TranscriptRowEntry[], kind: K) =>
  rows.filter((row): row is Extract<TranscriptRowEntry, { kind: K }> => row.kind === kind);

const runningTurn = (turnId: TurnId) => ({
  isWorking: true,
  runningTurnId: turnId,
  activeTurnStartedAt: t(0),
  latestTurn: { turnId, state: "running" as const, startedAt: t(0), completedAt: null },
});
const finishedTurn = (
  turnId: TurnId,
  state: "completed" | "interrupted" | "error" = "completed",
) => ({
  latestTurn: { turnId, state, startedAt: t(0), completedAt: t(42) },
});

// ---- labels -------------------------------------------------------------------------------------

describe("work entry labels", () => {
  const command = (status?: WorkLogEntry["toolLifecycleStatus"]) =>
    ({
      id: "c",
      createdAt: t(0),
      label: "Tool call",
      tone: "tool",
      command: "/bin/zsh -lc 'vp test run src/a.test.ts'",
      ...(status === undefined ? {} : { toolLifecycleStatus: status }),
    }) as WorkLogEntry;

  // Status -> [label while the turn runs, label once it settled]. A finished call in a running turn
  // still reads in the present tense; failures and refusals read the same either way.
  const wording: Array<[WorkLogEntry["toolLifecycleStatus"], string, string]> = [
    [undefined, "Running", "Ran"],
    ["completed", "Running", "Ran"],
    ["inProgress", "Running", "Running"],
    ["stopped", "Stopped", "Stopped"],
    ["declined", "Declined", "Declined"],
    ["failed", "Failed", "Failed"],
  ];
  for (const [status, whileLive, afterwards] of wording) {
    it(`labels a ${status ?? "status-less"} command by its program`, () => {
      const labels = [true, false].map((live) =>
        Logic.liveWorkEntryLabel(command(status), undefined, live),
      );
      expect(labels).toEqual([`${whileLive} vp`, `${afterwards} vp`]);
    });
  }

  it("shows the whole command, wrapper included, in the expanded label", () => {
    expect(Logic.activityRowLabel(command("completed"), undefined)).toBe(command().command);
  });

  it("falls back to output, then changed files, then the tool title", () => {
    const plain = { id: "p", createdAt: t(0), tone: "tool", label: "Tool call" } as WorkLogEntry;
    expect(Logic.activityRowLabel({ ...plain, detail: "3 matches" }, undefined)).toBe("3 matches");

    const edit = {
      ...plain,
      itemType: "file_change",
      detail: "diff text",
      changedFiles: ["/repo/src/a.ts", "/repo/src/b.ts", "/repo/c.ts"],
    } as WorkLogEntry;
    expect(Logic.activityRowLabel(edit, "/repo")).toBe("repo/src/a.ts +2 more");
    expect(Logic.activityRowLabel({ ...edit, changedFiles: ["/repo/src/a.ts"] }, "/repo")).toBe(
      "repo/src/a.ts",
    );

    expect(Logic.activityRowLabel({ ...plain, toolTitle: "mcp__tracker__find" }, undefined)).toBe(
      "Mcp__tracker__find",
    );
  });

  it("uses Kora's tool wording in both the live and the settled label", () => {
    const click = {
      id: "k",
      createdAt: t(0),
      tone: "tool",
      label: "Tool call",
      toolTitle: "Kora-code.preview_click",
    } as WorkLogEntry;
    expect(Logic.liveWorkEntryLabel(click, undefined, true)).toBe(
      "Clicking in the preview browser",
    );
    expect(Logic.liveWorkEntryLabel(click, undefined, false)).toBe(
      "Clicked in the preview browser",
    );
    expect(Logic.activityRowLabel({ ...click, toolLifecycleStatus: "failed" }, undefined)).toBe(
      "Failed to click in the preview browser",
    );
  });

  it("re-exports the compact label normaliser", () => {
    expect(Logic.normalizeCompactToolLabel).toBeTypeOf("function");
  });

  it("hides neutral, still-running entries unless the live group is expanded", () => {
    const running =
      ran("r", "inProgress").kind === "work"
        ? (ran("r", "inProgress") as Extract<TranscriptItem, { kind: "work" }>).entry
        : null;
    expect(Logic.workEntryIsVisibleInGroup(running!)).toBe(false);
    expect(Logic.workEntryIsVisibleInGroup(running!, true)).toBe(true);
    const done = (ran("d", "completed") as Extract<TranscriptItem, { kind: "work" }>).entry;
    expect(Logic.workEntryIsVisibleInGroup(done)).toBe(true);
  });
});

// ---- small helpers ------------------------------------------------------------------------------

describe("scroll helpers", () => {
  const ids = (...list: string[]) => list.map((id) => ({ id }));

  it("turns a saved anchor into a list index and a negative view offset", () => {
    expect(
      Logic.resolveWorkGroupScrollIndex(ids("a", "b", "c"), { entryId: "b", offset: 30 }),
    ).toEqual({
      index: 1,
      viewOffset: -30,
    });
    expect(
      Logic.resolveWorkGroupScrollIndex(ids("a"), { entryId: "gone", offset: 1 }),
    ).toBeUndefined();
    expect(Logic.resolveWorkGroupScrollIndex(ids("a"), undefined)).toBeUndefined();
  });

  it("follows only a pure append while the group sits at its end", () => {
    const follow = Logic.shouldFollowWorkGroupAppend;
    expect(follow(ids("a"), ids("a", "b"), 0)).toBe(true);
    expect(follow(ids("a"), ids("a", "b"), 1)).toBe(true);
    expect(follow(ids("a"), ids("a", "b"), 5)).toBe(false);
    expect(follow(ids("a"), ids("x", "b"), 0)).toBe(false);
    expect(follow(ids("a", "b"), ids("a", "b"), 0)).toBe(false);
    expect(follow([], ids("a"), 0)).toBe(false);
  });

  it("calls the list at its end within a 40px band of the bottom", () => {
    const atEnd = Logic.resolveTranscriptIsAtEnd;
    const box = { contentLength: 1_000, scrollLength: 500 };
    expect(atEnd({ ...box, scroll: 460, isAtEnd: false })).toBe(true);
    expect(atEnd({ ...box, scroll: 459, isAtEnd: true })).toBe(false);
    expect(atEnd({ isAtEnd: true })).toBe(true);
    expect(atEnd(undefined)).toBeUndefined();
  });
});

describe("assistant line breaks", () => {
  it.each([
    [
      "a short verse",
      "Tide:\n\nLow light on the pier\nNets dry on the warm planks\nThe gulls go quiet",
      true,
    ],
    ["an insight banner", "★ Insight ─────\nOne point\n─────", true],
    ["a bullet list", "- one\n- two", false],
    ["a fenced block", "```\nx\ny\n```", false],
    ["wide prose", `${"word ".repeat(20)}\n${"more ".repeat(20)}`, false],
    ["a single line", "Just one line.", false],
  ])("%s -> %s", (_case, text, keep) => {
    expect(Logic.shouldPreserveAssistantLineBreaks(text)).toBe(keep);
  });
});

describe("message timing and copy", () => {
  it("times an answer from the prompt, or from the previous finished answer", () => {
    const starts = Logic.computeMessageDurationStart([
      { id: "u1", role: "user", streaming: false, createdAt: t(1), updatedAt: t(1) },
      { id: "a1", role: "assistant", streaming: false, createdAt: t(3), updatedAt: t(5) },
      { id: "a2", role: "assistant", streaming: true, createdAt: t(7), updatedAt: t(8) },
      { id: "a3", role: "assistant", streaming: false, createdAt: t(9), updatedAt: t(9) },
      { id: "u2", role: "user", streaming: false, createdAt: t(10), updatedAt: t(10) },
    ]);
    expect(Object.fromEntries(starts)).toEqual({
      u1: t(1),
      a1: t(1),
      a2: t(5),
      a3: t(5),
      u2: t(10),
    });

    const orphan = Logic.computeMessageDurationStart([
      { id: "a", role: "assistant", streaming: false, createdAt: t(4), updatedAt: t(4) },
    ]);
    expect(orphan.get("a")).toBe(t(4));
  });

  it("offers copying only for finished, non-empty answers", () => {
    const copy = Logic.resolveAssistantMessageCopyState;
    expect(copy({ showCopyButton: true, streaming: false, text: "done" })).toEqual({
      visible: true,
      text: "done",
    });
    expect(copy({ showCopyButton: true, streaming: true, text: "half" })).toEqual({
      visible: false,
      text: "half",
    });
    expect(copy({ showCopyButton: false, streaming: false, text: "x" }).visible).toBe(false);
    expect(copy({ showCopyButton: true, streaming: false, text: "   " })).toEqual({
      visible: false,
      text: null,
    });
    expect(copy({ showCopyButton: true, streaming: false, text: null })).toEqual({
      visible: false,
      text: null,
    });
  });
});

// ---- row derivation -----------------------------------------------------------------------------

describe("deriveTranscriptRows: messages", () => {
  it("puts the meta footer on the last answer of each turn only, and not while it is live", () => {
    // The fold is opened so the earlier answer is on screen at all.
    const rows = rowsOf(
      [
        said(chat("u", "user", "go")),
        said(chat("a1", "assistant", "first", { turnId: TURN_A })),
        said(chat("a2", "assistant", "second", { turnId: TURN_A })),
      ],
      { expandedTurnIds: new Set([TURN_A]) },
    );
    const meta = only(rows, "message").map((row) => [row.id, row.showAssistantMeta]);
    expect(meta).toEqual([
      ["u", false],
      ["a1", false],
      ["a2", true],
    ]);

    const live = rowsOf(
      [said(chat("u", "user", "go")), said(chat("a", "assistant", "typing", { turnId: TURN_A }))],
      runningTurn(TURN_A),
    );
    const answer = only(live, "message").find((row) => row.id === "a")!;
    expect([answer.showAssistantMeta, answer.assistantCopyStreaming]).toEqual([false, true]);
  });

  it("treats answers without a turn as one response per prompt", () => {
    const rows = rowsOf([
      said(chat("u1", "user", "one")),
      said(chat("a1", "assistant", "r1")),
      said(chat("u2", "user", "two")),
      said(chat("a2", "assistant", "r2a")),
      said(chat("a3", "assistant", "r2b")),
    ]);
    const withMeta = only(rows, "message")
      .filter((row) => row.showAssistantMeta)
      .map((row) => row.id);
    expect(withMeta).toEqual(["a1", "a3"]);
  });

  it("turns notices and group notes into mode-notice rows", () => {
    const rows = rowsOf([
      said(
        chat("n1", "user", "[kora] switched", {
          notice: { kind: "agent-mode-switched", from: "chat", to: "swarm" },
        } as never),
      ),
      said(chat("n2", "system", "The group moved on.", { kind: "note" } as never)),
    ]);
    expect(
      only(rows, "mode-notice").map(({ noticeKind, from, to, text }) => ({
        noticeKind,
        from,
        to,
        text,
      })),
    ).toEqual([
      { noticeKind: "agent-mode-switched", from: "chat", to: "swarm", text: "[kora] switched" },
      { noticeKind: "group-note", from: null, to: null, text: "The group moved on." },
    ]);
  });

  it("keeps message fields like authorship untouched", () => {
    const reply = chat("a", "assistant", "hi", { authorBlobId: "blob_1" } as never);
    const [row] = only(rowsOf([said(reply)]), "message");
    expect(row?.message).toBe(reply);
  });

  it("appends queued prompts in order, marking the next one", () => {
    const queued = [
      { id: "q1", createdAt: t(50) },
      { id: "q2", createdAt: t(51) },
    ] as never;
    const rows = rowsOf([said(chat("u", "user", "go"))], { queuedMessages: queued });
    expect(only(rows, "queued-message").map((row) => [row.id, row.isNext])).toEqual([
      ["queued-message:q1", true],
      ["queued-message:q2", false],
    ]);
  });

  it("passes proposed plans and blob cards through as their own rows", () => {
    const plan = {
      kind: "proposed-plan",
      id: "plan-1",
      createdAt: t(2),
      proposedPlan: { id: "p", turnId: null },
    } as unknown as TranscriptItem;
    const card = did("card", { blobCard: { version: 1, payload: "{}" } as never, label: "Card" });
    expect(shape(rowsOf([plan, card]))).toEqual(["proposed-plan:plan-1", "blob-card:item-card"]);
  });
});

describe("deriveTranscriptRows: settled work", () => {
  it("shows a single finished tool call as one work row with a settled label", () => {
    const rows = rowsOf([ran("one", "completed")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "work",
      id: "item-one",
      isExpandedToolGroup: false,
      displayLabel: "pnpm test",
    });
  });

  it("collapses consecutive calls into one toggle that can be expanded", () => {
    const items = [ran("x", "completed", {}, t(1)), ran("y", "failed", {}, t(2))];
    const [toggle] = rowsOf(items);
    expect(toggle).toMatchObject({
      kind: "work-toggle",
      id: "work-toggle:item-x",
      groupId: "work-group:item-x",
      hiddenCount: 2,
      expanded: false,
      summary: "Ran 2 commands",
      hasFailure: true,
    });

    const opened = rowsOf(items, { expandedWorkGroupIds: new Set(["work-group:item-x"]) });
    expect(shape(opened)).toEqual([
      "work-toggle:work-toggle:item-x",
      "work:work-group:item-x:details",
    ]);
  });

  it("names a group after the tool call id when there is one", () => {
    const [toggle] = rowsOf([
      ran("x", "completed", { toolCallId: "call-1" }),
      ran("y", "completed"),
    ]);
    expect(toggle).toMatchObject({ groupId: "work-group:tool:no-turn:call-1" });
  });

  it("gives compaction, errors, spawns and answers their own rows", () => {
    const rows = rowsOf([
      ran("a", "completed"),
      did("compact", {
        tone: "info",
        label: "Compacted",
        sourceActivityKind: "context-compaction",
      }),
      did("oops", { tone: "error", label: "Provider failed" }),
      ran("b", "completed"),
    ]);
    expect(shape(rows)).toEqual([
      "work:item-a",
      "context-compaction:item-compact",
      "work:item-oops",
      "work:item-b",
    ]);
  });

  it("moves the answer footer after the tools that trail it in the same turn", () => {
    const rows = rowsOf(
      [
        said(chat("u", "user", "go")),
        said(chat("a", "assistant", "on it", { turnId: TURN_A })),
        ran("late", "completed", { turnId: TURN_A }),
      ],
      { ...finishedTurn(TURN_A), expandedTurnIds: new Set([TURN_A]) },
    );
    const answer = only(rows, "message").find((row) => row.id === "a")!;
    expect(answer.showAssistantMeta).toBe(false);
    expect(shape(rows).at(-1)).toBe("assistant-meta:assistant-meta:a");
  });
});

describe("deriveTranscriptRows: turn folds", () => {
  const turnItems = () => [
    said(chat("u", "user", "go", { createdAt: t(0) })),
    ran("w1", "completed", { turnId: TURN_A }, t(5)),
    said(chat("a", "assistant", "done", { turnId: TURN_A, createdAt: t(9), updatedAt: t(30) })),
  ];

  it("folds a finished turn's work behind a Worked-for row, keeping the answer", () => {
    const rows = rowsOf(turnItems(), finishedTurn(TURN_A));
    expect(shape(rows)).toEqual(["message:u", `turn-fold:turn-fold:${TURN_A}`, "message:a"]);
    expect(only(rows, "turn-fold")[0]).toMatchObject({ label: "Worked for 42s", expanded: false });
  });

  it("shows the work again once the fold is opened", () => {
    const rows = rowsOf(turnItems(), {
      ...finishedTurn(TURN_A),
      expandedTurnIds: new Set([TURN_A]),
    });
    expect(shape(rows)).toEqual([
      "message:u",
      `turn-fold:turn-fold:${TURN_A}`,
      "work:item-w1",
      "message:a",
    ]);
  });

  it("says the user stopped an interrupted turn", () => {
    const [fold] = only(rowsOf(turnItems(), finishedTurn(TURN_A, "interrupted")), "turn-fold");
    expect(fold?.label).toBe("You stopped after 42s");
  });

  it("times older turns from their prompt to their last item", () => {
    const items = [...turnItems(), said(chat("u2", "user", "again", { createdAt: t(40) }))];
    const [fold] = only(rowsOf(items, finishedTurn(TURN_B)), "turn-fold");
    expect(fold?.label).toBe("Worked for 30s");
  });

  it("does not fold a live, streaming or compaction-only turn", () => {
    expect(only(rowsOf(turnItems(), runningTurn(TURN_A)), "turn-fold")).toEqual([]);

    const streaming = turnItems();
    streaming[2] = said(chat("a", "assistant", "still", { turnId: TURN_A, streaming: true }));
    expect(only(rowsOf(streaming, finishedTurn(TURN_B)), "turn-fold")).toEqual([]);

    const compactOnly = [
      did("c", {
        turnId: TURN_A,
        sourceActivityKind: "context-compaction",
        tone: "info",
        label: "Compacted",
      }),
      said(chat("a", "assistant", "ok", { turnId: TURN_A })),
    ];
    expect(only(rowsOf(compactOnly, finishedTurn(TURN_A)), "turn-fold")).toEqual([]);
  });

  it("never folds away answers to questions or spawned agents", () => {
    const items = [
      did("q", {
        turnId: TURN_A,
        questionAnswer: { question: "?", answer: "!" } as never,
        label: "Asked",
      }),
      said(chat("a", "assistant", "done", { turnId: TURN_A })),
    ];
    expect(only(rowsOf(items, finishedTurn(TURN_A)), "turn-fold")).toEqual([]);
  });
});

describe("deriveTranscriptRows: the live turn", () => {
  const prompt = said(chat("u", "user", "go", { createdAt: t(0) }));

  it("shows the working row right after the prompt, then a thinking row at the tail", () => {
    const rows = rowsOf(
      [prompt, said(chat("a", "assistant", "partial", { turnId: TURN_A }))],
      runningTurn(TURN_A),
    );
    expect(shape(rows)).toEqual([
      "message:u",
      "working:working-indicator-row",
      "message:a",
      "thinking:live-activity-row",
    ]);
    // The blob only bounces on the last row.
    expect(only(rows, "working")[0]?.showBlob).toBe(false);
  });

  it("bounces the blob on the working row when nothing came yet", () => {
    const rows = rowsOf([prompt], runningTurn(TURN_A));
    expect(shape(rows)).toEqual(["message:u", "working:working-indicator-row"]);
    expect(only(rows, "working")[0]).toMatchObject({ showBlob: true, createdAt: t(0) });
  });

  it("shows the tail tool run as one live row", () => {
    const rows = rowsOf(
      [
        prompt,
        ran("w1", "completed", { turnId: TURN_A }),
        ran("w2", "inProgress", { turnId: TURN_A }),
      ],
      runningTurn(TURN_A),
    );
    const [live] = only(rows, "work-live");
    expect(live).toMatchObject({
      id: "live-activity-row",
      active: true,
      groupId: "work-group:item-w1",
    });
    expect(live?.entry.id).toBe("w2");
    expect(live?.groupedEntries.map(({ id }) => id)).toEqual(["w1", "w2"]);
    expect(only(rows, "thinking")).toEqual([]);
  });

  it("adds the details row under an expanded live group", () => {
    const rows = rowsOf([prompt, ran("w1", "inProgress", { turnId: TURN_A })], {
      ...runningTurn(TURN_A),
      expandedWorkGroupIds: new Set(["work-group:item-w1"]),
    });
    expect(shape(rows)).toContain("work:work-group:item-w1:details");
  });

  it("drops the live row when the newest tool failed, leaving the working blob at the tail", () => {
    const rows = rowsOf([prompt, ran("bad", "failed", { turnId: TURN_A })], runningTurn(TURN_A));
    expect(only(rows, "work-live")).toEqual([]);
    expect(shape(rows)).toEqual(["message:u", "working:working-indicator-row"]);
    expect(only(rows, "working")[0]?.showBlob).toBe(true);
  });

  it("adds a thinking row after a failed tool once other output followed it", () => {
    const rows = rowsOf(
      [
        prompt,
        said(chat("a", "assistant", "trying", { turnId: TURN_A })),
        ran("bad", "failed", { turnId: TURN_A }),
      ],
      runningTurn(TURN_A),
    );
    expect(shape(rows).at(-1)).toBe("thinking:live-activity-row");
  });

  it("keeps a spawn row live only while its agents run", () => {
    const spawn = did("spawn", {
      turnId: TURN_A,
      label: "Spawned",
      agentSpawn: { agentTaskIds: ["task-1"] } as never,
    });
    const alive = rowsOf([prompt, spawn], {
      ...runningTurn(TURN_A),
      liveAgentTaskIds: new Set(["task-1"]),
    });
    expect(only(alive, "work-live")[0]).toMatchObject({ id: "live-activity-row", active: true });

    const quiet = rowsOf([prompt, spawn], { ...runningTurn(TURN_A), liveAgentTaskIds: new Set() });
    expect(only(quiet, "work-live")[0]).toMatchObject({
      id: "work-live:item-spawn",
      active: false,
    });
  });

  it("starts the working row at the latest prompt when the response spans turns", () => {
    const rows = rowsOf(
      [
        prompt,
        said(chat("a", "assistant", "x", { turnId: TURN_B })),
        ran("w", "inProgress", { turnId: TURN_A }),
      ],
      runningTurn(TURN_A),
    );
    expect(only(rows, "working")[0]?.createdAt).toBe(t(0));
  });
});

// ---- streaming reuse and stable rows ------------------------------------------------------------

describe("deriveTranscriptRowsWithState", () => {
  const streamingAnswer = (text: string, updatedAt = t(3)) =>
    said(chat("a", "assistant", text, { turnId: TURN_A, streaming: true, updatedAt }));
  // Unchanged items must be the same objects between derivations, as in the app.
  const promptItem = said(chat("u", "user", "go"));
  const input = (answer: TranscriptItem, extra: Partial<Input> = {}): Input => ({
    timelineEntries: [promptItem, answer],
    ...runningTurn(TURN_A),
    ...extra,
  });

  it("swaps only the message when streaming text grows", () => {
    const first = Logic.deriveTranscriptRowsWithState(input(streamingAnswer("Hel")));
    const nextAnswer = streamingAnswer("Hello", t(4));
    const second = Logic.deriveTranscriptRowsWithState(input(nextAnswer), first);

    expect(second.rows).not.toBe(first.rows);
    expect(second.rows.map((row) => row.id)).toEqual(first.rows.map((row) => row.id));
    const updated = only(second.rows, "message").find((row) => row.id === "a")!;
    expect(updated.message).toBe(
      (nextAnswer as Extract<TranscriptItem, { kind: "message" }>).message,
    );
    expect(second.rows[0]).toBe(first.rows[0]);
  });

  it("returns the same rows when nothing changed", () => {
    const same = input(streamingAnswer("x"));
    const first = Logic.deriveTranscriptRowsWithState(same);
    expect(Logic.deriveTranscriptRowsWithState({ ...same }, first).rows).toBe(first.rows);
  });

  it("re-derives when the context or the item list changed", () => {
    const first = Logic.deriveTranscriptRowsWithState(input(streamingAnswer("x")));
    const stopped = Logic.deriveTranscriptRowsWithState(
      input(streamingAnswer("xy"), { isWorking: false }),
      first,
    );
    expect(shape(stopped.rows)).not.toContain("working:working-indicator-row");

    const longer = Logic.deriveTranscriptRowsWithState(
      {
        ...input(streamingAnswer("x")),
        timelineEntries: [...input(streamingAnswer("x")).timelineEntries, ran("w", "completed")],
      },
      first,
    );
    expect(longer.rows.length).toBeGreaterThan(first.rows.length);

    const finished = said(chat("a", "assistant", "x", { turnId: TURN_A, streaming: false }));
    const done = Logic.deriveTranscriptRowsWithState(input(finished), first);
    expect(only(done.rows, "message").find((row) => row.id === "a")?.message.streaming).toBe(false);
  });
});

describe("computeStableTranscriptRows", () => {
  const empty = { byId: new Map(), result: [] };

  it("keeps the previous state object when every row is unchanged", () => {
    const items = [said(chat("u", "user", "go")), ran("w", "completed"), ran("v", "completed")];
    const first = Logic.computeStableTranscriptRows(rowsOf(items), empty);
    const again = Logic.computeStableTranscriptRows(rowsOf(items), first);
    expect(again).toBe(first);
  });

  it("reuses unchanged rows by id and replaces changed ones", () => {
    const greeting = said(chat("u", "user", "go"));
    const first = Logic.computeStableTranscriptRows(
      rowsOf([greeting, ran("w", "completed")]),
      empty,
    );
    const after = rowsOf([greeting, ran("w", "failed")]);
    const next = Logic.computeStableTranscriptRows(after, first);

    expect(next).not.toBe(first);
    expect(next.result[0]).toBe(first.result[0]);
    expect(next.result[1]).not.toBe(first.result[1]);
    expect(next.byId.get("item-w")).toBe(next.result[1]);
  });

  it("treats a new message object as a change even with equal text", () => {
    const first = Logic.computeStableTranscriptRows(rowsOf([said(chat("u", "user", "go"))]), empty);
    const next = Logic.computeStableTranscriptRows(rowsOf([said(chat("u", "user", "go"))]), first);
    expect(next.result[0]).not.toBe(first.result[0]);
  });
});
