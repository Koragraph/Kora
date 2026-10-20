import type { ChatMessage } from "../../types";
import { deriveTranscriptEntries } from "../../thread/timeline";

import { deriveTranscriptRows } from "./ThreadTranscript.logic";
import { ItemId } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

// Swarm S1: a Kora-authored user-role turn (mode notice / fleet notes) becomes a `mode-notice` row,
// never a user bubble; plain user messages are untouched.

const time = (second: number) => new Date(Date.UTC(2026, 8, 24, 0, 0, second)).toISOString();

function rowsFor(messages: ChatMessage[]) {
  return deriveTranscriptRows({
    activeTurnStartedAt: null,
    isWorking: false,
    timelineEntries: deriveTranscriptEntries(messages, [], []),
  });
}

const user = (id: string, second: number, text: string, extra: Partial<ChatMessage> = {}) =>
  ({
    id: ItemId.make(id),
    role: "user",
    text,
    turnId: null,
    createdAt: time(second),
    updatedAt: time(second),
    streaming: false,
    ...extra,
  }) as ChatMessage;

describe("mode-notice timeline rows", () => {
  it("renders fleet notes as a mode-notice row without from/to", () => {
    const rows = rowsFor([
      user("k2", 0, "[kora] worker p4 finished", { notice: { kind: "fleet-note" } }),
    ]);
    expect(rows.find((row) => row.kind === "mode-notice")).toMatchObject({
      to: null,
      from: null,
      noticeKind: "fleet-note",
    });
    expect(rows.some((row) => row.kind === "message")).toBe(false);
  });
  it("renders an agent-mode-switched notice as a mode-notice row with from/to", () => {
    const rows = rowsFor([
      user("u1", 0, "hello"),
      user("k1", 1, "[kora] User has switched to Swarm mode.\nLoad /koraswarm.", {
        notice: { kind: "agent-mode-switched", from: "chat", to: "swarm" },
      }),
    ]);
    const notice = rows.find((row) => row.kind === "mode-notice");
    expect(notice).toMatchObject({
      text: "[kora] User has switched to Swarm mode.\nLoad /koraswarm.",
      to: "swarm",
      from: "chat",
      noticeKind: "agent-mode-switched",
      kind: "mode-notice",
    });
    const bubbles = rows.filter((row) => row.kind === "message" && row.message.role === "user");
    expect(bubbles).toHaveLength(1);
  });
});
