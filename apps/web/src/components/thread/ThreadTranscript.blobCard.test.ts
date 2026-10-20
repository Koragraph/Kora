import { EventId, ItemId, TurnId, type ChatThreadActivity } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveTranscriptEntries, deriveActivityRows } from "../../thread/timeline";
import type { ChatMessage } from "../../types";
import { deriveTranscriptRows, type TranscriptRowEntry } from "./ThreadTranscript.logic";

const t = (second: number) => new Date(Date.UTC(2026, 9, 9, 10, 0, second)).toISOString();
const TURN = TurnId.make("turn-1");

function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  second: number,
  turnId: TurnId | null = null,
): ChatMessage {
  return {
    id: ItemId.make(id),
    role,
    text,
    turnId,
    createdAt: t(second),
    updatedAt: t(second),
    streaming: false,
  } as ChatMessage;
}

function activity(
  id: string,
  kind: string,
  second: number,
  payload: unknown,
  turnId: TurnId | null = TURN,
): ChatThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: id,
    payload,
    turnId,
    createdAt: t(second),
  } as ChatThreadActivity;
}

const memory = (cardId: string, version: number) => ({
  cardKind: "memory",
  cardId,
  version,
  receipts: [
    {
      id: "r",
      kind: "added",
      scope: "you",
      text: "x",
      previousText: null,
      factId: null,
      undone: false,
      reason: null,
    },
  ],
});
const toolDone = (id: string, second: number, turnId: TurnId | null = TURN) =>
  activity(
    id,
    "tool.completed",
    second,
    {
      itemType: "command_execution",
      title: "Ran ls",
      status: "completed",
      data: { item: { command: "ls" } },
    },
    turnId,
  );

function rowsFor(
  activities: ChatThreadActivity[],
  opts: { isWorking?: boolean } = {},
): TranscriptRowEntry[] {
  const messages = [
    message("u1", "user", "hi", 0),
    message("a1", "assistant", "Hello there", 20, TURN),
  ];
  const timelineEntries = deriveTranscriptEntries(messages, [], deriveActivityRows(activities));
  return deriveTranscriptRows({
    timelineEntries,
    latestTurn: {
      turnId: TURN,
      state: opts.isWorking ? "running" : "completed",
      startedAt: t(1),
      completedAt: opts.isWorking ? null : t(30),
    },
    runningTurnId: opts.isWorking ? TURN : null,
    isWorking: opts.isWorking ?? false,
    activeTurnStartedAt: opts.isWorking ? t(1) : null,
  });
}

describe("blob-card rows", () => {
  it("renders a card as its own row, outside the work group beside it", () => {
    const rows = rowsFor([
      toolDone("tool-a", 5),
      toolDone("tool-b", 6),
      activity("card-a", "blob.card", 7, memory("c1", 1)),
      toolDone("tool-c", 8),
    ]);
    const kinds = rows.map((row) => row.kind);
    expect(kinds).toContain("blob-card");
    const card = rows.find((row) => row.kind === "blob-card");
    expect(card && card.kind === "blob-card" && card.card.cardId).toBe("c1");
    // No work row ever carries the card entry.
    for (const row of rows) {
      if (row.kind === "work" || row.kind === "work-toggle" || row.kind === "work-live") {
        const entries =
          row.kind === "work-toggle"
            ? []
            : row.kind === "work-live"
              ? row.groupedEntries
              : row.groupedEntries;
        expect(entries.some((entry) => entry.blobCard !== undefined)).toBe(false);
      }
    }
  });

  it("splits the tool run around a card instead of grouping across it", () => {
    // Turn-less tool rows never fold, so the run is visible and the card's position in it is observable.
    const rows = rowsFor([
      toolDone("tool-a", 5, null),
      toolDone("tool-b", 6, null),
      activity("card-a", "blob.card", 7, memory("c1", 1), null),
      toolDone("tool-c", 8, null),
      toolDone("tool-d", 9, null),
    ]);
    const cardIndex = rows.findIndex((row) => row.kind === "blob-card");
    const before = rows
      .slice(0, cardIndex)
      .filter((row) => row.kind === "work-toggle" || row.kind === "work");
    const after = rows
      .slice(cardIndex + 1)
      .filter((row) => row.kind === "work-toggle" || row.kind === "work");
    expect(before.length).toBeGreaterThan(0);
    expect(after.length).toBeGreaterThan(0);
  });

  it("keeps the latest version only and one row per cardId", () => {
    const rows = rowsFor([
      activity("card-a", "blob.card", 25, memory("c1", 1)),
      activity("card-b", "blob.card", 26, memory("c1", 2)),
    ]);
    const cards = rows.filter((row) => row.kind === "blob-card");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.kind === "blob-card" && cards[0].card.version).toBe(2);
  });

  it("stays visible when the settled turn folds its work away", () => {
    const rows = rowsFor([
      toolDone("tool-a", 5),
      activity("card-a", "blob.card", 25, memory("c1", 1)),
    ]);
    expect(rows.some((row) => row.kind === "blob-card")).toBe(true);
    expect(rows.some((row) => row.kind === "turn-fold")).toBe(true);
  });

  it("shows mid-turn, while finished tool calls are hidden", () => {
    const rows = rowsFor(
      [
        toolDone("tool-a", 5),
        activity("card-a", "blob.card", 7, {
          cardKind: "rate-limit",
          cardId: "rl",
          version: 1,
          engine: "claude",
          resetsAt: null,
          threadId: "t",
        }),
      ],
      { isWorking: true },
    );
    expect(rows.some((row) => row.kind === "blob-card")).toBe(true);
  });
});
