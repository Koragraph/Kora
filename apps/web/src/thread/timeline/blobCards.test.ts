import { EventId, TurnId, type ChatThreadActivity } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveActivityRows } from "./index";

let n = 0;
function activity(over: {
  id?: string;
  kind: string;
  at: string;
  payload?: unknown;
  summary?: string;
  turnId?: string;
  sequence?: number;
}): ChatThreadActivity {
  n += 1;
  return {
    id: EventId.make(over.id ?? `act-${n}`),
    tone: "info",
    kind: over.kind,
    summary: over.summary ?? "summary",
    payload: over.payload ?? {},
    turnId: over.turnId ? TurnId.make(over.turnId) : null,
    createdAt: over.at,
    ...(over.sequence !== undefined ? { sequence: over.sequence } : {}),
  } as ChatThreadActivity;
}

const memoryCard = (cardId: string, version: number, extra: Record<string, unknown> = {}) => ({
  cardKind: "memory",
  cardId,
  version,
  receipts: [
    {
      id: "r1",
      kind: "added",
      scope: "you",
      text: "you live in Dallas",
      previousText: null,
      factId: "f1",
      undone: false,
      reason: null,
      ...extra,
    },
  ],
});

describe("blob.card activities in the work log", () => {
  it("become a work entry carrying the card, never a generic tool row", () => {
    const entries = deriveActivityRows([
      activity({
        id: "c1",
        kind: "blob.card",
        at: "2026-10-09T10:00:00.000Z",
        payload: memoryCard("card-1", 1),
        summary: "Remembered: you live in Dallas",
      }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.blobCard?.cardId).toBe("card-1");
    expect(entries[0]?.blobCard?.version).toBe(1);
    expect(entries[0]?.label).toBe("Remembered: you live in Dallas");
    expect(entries[0]?.sourceActivityKind).toBe("blob.card");
  });

  it("keeps the highest version per cardId, at the position of the first emission", () => {
    const entries = deriveActivityRows([
      activity({
        id: "c1",
        kind: "blob.card",
        at: "2026-10-09T10:00:00.000Z",
        payload: memoryCard("card-1", 1),
      }),
      activity({
        id: "t1",
        kind: "tool.completed",
        at: "2026-10-09T10:00:05.000Z",
        payload: { itemType: "command_execution", title: "ls", status: "completed" },
      }),
      activity({
        id: "c2",
        kind: "blob.card",
        at: "2026-10-09T10:00:10.000Z",
        payload: memoryCard("card-1", 2, { undone: true }),
      }),
    ]);
    const cards = entries.filter((entry) => entry.blobCard);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.id).toBe("c1");
    expect(cards[0]?.createdAt).toBe("2026-10-09T10:00:00.000Z");
    expect(cards[0]?.blobCard?.version).toBe(2);
    expect((cards[0]?.blobCard?.payload.receipts as Array<{ undone: boolean }>)[0]?.undone).toBe(
      true,
    );
    expect(entries.map((entry) => entry.id)).toEqual(["c1", "t1"]);
  });

  it("does not let an older version overwrite a newer one that arrived first", () => {
    const entries = deriveActivityRows([
      activity({
        id: "c2",
        kind: "blob.card",
        at: "2026-10-09T10:00:10.000Z",
        sequence: 2,
        payload: memoryCard("card-1", 3),
      }),
      activity({
        id: "c1",
        kind: "blob.card",
        at: "2026-10-09T10:00:00.000Z",
        sequence: 1,
        payload: memoryCard("card-1", 1),
      }),
    ]);
    expect(entries.filter((entry) => entry.blobCard)[0]?.blobCard?.version).toBe(3);
  });

  it("keeps separate cards separate", () => {
    const entries = deriveActivityRows([
      activity({
        kind: "blob.card",
        at: "2026-10-09T10:00:00.000Z",
        payload: memoryCard("card-1", 1),
      }),
      activity({
        kind: "blob.card",
        at: "2026-10-09T10:00:01.000Z",
        payload: memoryCard("card-2", 1),
      }),
    ]);
    expect(entries.map((entry) => entry.blobCard?.cardId)).toEqual(["card-1", "card-2"]);
  });

  it("tolerates a malformed payload (falls back to the activity id, empty payload)", () => {
    const entries = deriveActivityRows([
      activity({ id: "weird", kind: "blob.card", at: "2026-10-09T10:00:00.000Z", payload: "nope" }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.blobCard).toEqual({ cardId: "weird", version: 0, payload: {} });
  });
});

// ── live QA #2: a blob's approval is a transcript card; its helpers are one quiet row ─────────────────────────────────────
const approval = (requestId: string, at: string, extra: Record<string, unknown> = {}) =>
  activity({
    id: `req-${requestId}`,
    kind: "approval.requested",
    at,
    summary: "Allow Bash?",
    turnId: "t1",
    payload: {
      requestId,
      requestKind: "command",
      toolName: "Bash",
      args: { command: "sleep 40" },
      cwd: "/Users/me/Blobs/Popo",
      blobThread: true,
      alwaysLabel: "Run sleep",
      options: [{ decision: "accept", label: "Allow once" }],
      ...extra,
    },
  });

describe("a blob's approval request in the work log", () => {
  it("becomes a card at the position it was asked, open until an answer arrives", () => {
    const entries = deriveActivityRows([
      activity({
        id: "tool",
        kind: "tool.completed",
        at: "2026-10-09T10:00:00.000Z",
        summary: "Ran something",
      }),
      approval("a1", "2026-10-09T10:00:05.000Z"),
    ]);
    const card = entries.find((e) => e.blobCard?.cardId === "approval:a1")!;
    expect(card.blobCard!.payload).toMatchObject({
      cardKind: "approval",
      requestId: "a1",
      state: "open",
      toolName: "Bash",
      cwd: "/Users/me/Blobs/Popo",
      alwaysLabel: "Run sleep",
    });
    expect(entries.indexOf(card)).toBeGreaterThan(0);
  });

  it("each way it ends is one state on the same card (and the resolved row itself adds nothing)", () => {
    const state = (decision: string) =>
      deriveActivityRows([
        approval("a1", "2026-10-09T10:00:05.000Z"),
        activity({
          kind: "approval.resolved",
          at: "2026-10-09T10:00:09.000Z",
          payload: { requestId: "a1", decision },
        }),
      ]);
    const one = (decision: string) => {
      const entries = state(decision);
      expect(entries).toHaveLength(1);
      return entries[0]!.blobCard!.payload.state;
    };
    expect(one("accept")).toBe("allowed");
    expect(one("acceptForSession")).toBe("allowed");
    expect(one("acceptAlways")).toBe("always");
    expect(one("decline")).toBe("denied");
    expect(one("cancel")).toBe("cancelled");
    const stale = deriveActivityRows([
      approval("a1", "2026-10-09T10:00:05.000Z"),
      activity({
        kind: "provider.approval.respond.failed",
        at: "2026-10-09T10:00:09.000Z",
        payload: { requestId: "a1", detail: "stale pending approval request" },
      }),
    ]);
    expect(stale[0]!.blobCard!.payload.state).toBe("expired");
  });

  it("a Code thread's request stays out of the transcript (the composer strip owns it)", () => {
    const entries = deriveActivityRows([
      approval("c1", "2026-10-09T10:00:05.000Z", { blobThread: undefined }),
    ]);
    expect(entries).toHaveLength(0);
  });

  it("derives the same entry object while nothing changed (no re-render churn)", () => {
    const acts = [approval("a1", "2026-10-09T10:00:05.000Z")];
    expect(deriveActivityRows(acts)[0]).toBe(deriveActivityRows(acts)[0]);
  });
});

describe("a blob's helper activity in the work log", () => {
  const w = (
    kind: string,
    id: string,
    at: string,
    payload: Record<string, unknown>,
    turnId = "t1",
  ) => activity({ id, kind, at, turnId, payload: { blobThread: true, ...payload } });
  it("collapses every worker.* row of a turn into ONE 'helpers' card, counted by pane", () => {
    const entries = deriveActivityRows([
      w("worker.attached", "w1", "2026-10-09T10:00:01.000Z", {
        paneId: "p1",
        title: "Read the pricing pages",
      }),
      w("worker.attached", "w2", "2026-10-09T10:00:02.000Z", {
        paneId: "p2",
        title: "Check the claims",
      }),
      w("worker.idle", "w3", "2026-10-09T10:00:30.000Z", { paneId: "p1" }),
      w("worker.detached", "w4", "2026-10-09T10:00:40.000Z", { paneId: "p2" }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.blobCard!.payload).toEqual({
      cardKind: "helpers",
      count: 2,
      working: 0,
      titles: ["Read the pricing pages", "Check the claims"],
    });
  });
  it("tracks who is still working, one card per turn, and leaves a Code thread's worker rows alone", () => {
    const working = deriveActivityRows([
      w("worker.attached", "w1", "2026-10-09T10:00:01.000Z", { paneId: "p1", title: "A" }),
      w("worker.attached", "w2", "2026-10-09T10:00:02.000Z", { paneId: "p2", title: "B" }),
      w("worker.done", "w3", "2026-10-09T10:00:30.000Z", { paneId: "p1" }),
    ]);
    expect(working[0]!.blobCard!.payload).toMatchObject({ count: 2, working: 1 });
    const twoTurns = deriveActivityRows([
      w("worker.attached", "a", "2026-10-09T10:00:01.000Z", { paneId: "p1", title: "A" }, "t1"),
      w("worker.attached", "b", "2026-10-09T10:05:01.000Z", { paneId: "p1", title: "B" }, "t2"),
    ]);
    expect(twoTurns.map((e) => e.blobCard?.cardId)).toHaveLength(2);
    const code = deriveActivityRows([
      activity({
        kind: "worker.attached",
        at: "2026-10-09T10:00:01.000Z",
        turnId: "t1",
        payload: { paneId: "p1", title: "A" },
      }),
    ]);
    expect(code[0]!.blobCard).toBeUndefined();
    expect(code[0]!.sourceActivityKind).toBe("worker.attached");
  });
});
