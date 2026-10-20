import { ItemId, TurnId } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ChatMessage, PlanProposal } from "../../types";
import type { WorkLogEntry } from "./entries";
import { at } from "./testActivities";
import {
  deriveTranscriptEntries,
  deriveTranscriptEntriesWithState,
  isStreamingMessageTextUpdate,
} from "./transcript";

const message = (id: string, seconds: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: ItemId.make(id),
  role: "assistant",
  text: "",
  streaming: false,
  turnId: null,
  createdAt: at(seconds),
  updatedAt: at(seconds),
  ...extra,
});
const plan = (id: string, seconds: number): PlanProposal => ({
  id,
  turnId: TurnId.make("t1"),
  planMarkdown: "# plan",
  createdAt: at(seconds),
  updatedAt: at(seconds),
  implementedAt: null,
  implementationThreadId: null,
});
const work = (id: string, seconds: number): WorkLogEntry => ({
  id,
  label: "Ran tests",
  tone: "tool",
  createdAt: at(seconds),
});
const ids = (entries: ReadonlyArray<{ id: string }>) => entries.map((e) => e.id);

describe("the transcript's order", () => {
  it("is by time across messages, plans and work rows", () => {
    const entries = deriveTranscriptEntries([message("m", 1)], [plan("p", 2)], [work("w", 3)]);
    expect(entries.map((e) => e.kind)).toEqual(["message", "proposed-plan", "work"]);
    expect(entries[1]).toMatchObject({
      kind: "proposed-plan",
      proposedPlan: { planMarkdown: "# plan" },
    });
  });

  it("on a tie puts messages, then plans, then work, and keeps each list's own order", () => {
    const entries = deriveTranscriptEntries(
      [message("m1", 5), message("m2", 5)],
      [plan("p", 5)],
      [work("w1", 5), work("w2", 5)],
    );
    expect(ids(entries)).toEqual(["m1", "m2", "p", "w1", "w2"]);
  });

  it("is the same whether built at once or from an earlier projection", () => {
    const streaming = message("s", 3, { streaming: true });
    const plans = [plan("p", 3)];
    const w1 = work("w1", 3);
    const first = deriveTranscriptEntriesWithState([streaming], plans, [w1]);
    const messages = [streaming, message("m2", 3, { streaming: true })];
    const rows = [w1, work("w2", 3)];
    const appended = deriveTranscriptEntriesWithState(messages, plans, rows, first);
    expect(ids(appended.entries)).toEqual(["s", "m2", "p", "w1", "w2"]);
    expect(appended.entries[0]).toBe(first.entries[0]); // reused, not rebuilt

    // An older page loaded in front, or a message whose time was corrected: both still sort correctly.
    const older = message("old", -100);
    const withOlder = deriveTranscriptEntriesWithState([older, ...messages], plans, rows, appended);
    expect(withOlder.entries).toEqual(deriveTranscriptEntries([older, ...messages], plans, rows));
    const moved = { ...streaming, createdAt: at(50), streaming: false };
    const corrected = deriveTranscriptEntriesWithState(
      [moved, messages[1]!],
      plans,
      rows,
      appended,
    );
    expect(corrected.entries).toEqual(deriveTranscriptEntries([moved, messages[1]!], plans, rows));
  });
});

describe("streaming text", () => {
  const history = message("h", 3);
  const reply = message("r", 3, { streaming: true });
  const rows = [work("w", 3)];

  it("patches the projection without touching an earlier one", () => {
    const first = deriveTranscriptEntriesWithState([history, reply], [], rows);
    Object.freeze(first.entries);
    first.entries.forEach((e) => Object.freeze(e));
    const typed = (text: string, seconds: number) => ({ ...reply, text, updatedAt: at(seconds) });
    const a = deriveTranscriptEntriesWithState([history, typed("Hel", 4)], [], rows, first);
    const b = deriveTranscriptEntriesWithState([history, typed("Hello", 5)], [], rows, first);
    expect(a.entries).toEqual(deriveTranscriptEntries([history, typed("Hel", 4)], [], rows));
    expect(b.entries).toEqual(deriveTranscriptEntries([history, typed("Hello", 5)], [], rows));
    expect([a.entries[0], a.entries[2]]).toEqual([first.entries[0], first.entries[2]]);
    expect(a.entries[0]).toBe(first.entries[0]);
    expect(first.entries[1]).toMatchObject({ message: { text: "" } });
  });

  it("counts as text-only only for a streaming assistant message whose other fields are unchanged", () => {
    const later = { ...reply, text: "more", updatedAt: at(9) };
    expect(isStreamingMessageTextUpdate(reply, later)).toBe(true);
    expect(isStreamingMessageTextUpdate(reply, { ...later, streaming: false })).toBe(false);
    expect(isStreamingMessageTextUpdate(reply, { ...later, turnId: TurnId.make("t9") })).toBe(
      false,
    );
    expect(
      isStreamingMessageTextUpdate({ ...reply, role: "user" }, { ...later, role: "user" }),
    ).toBe(false);
  });
});

it("a user message that only answered a question shows in the question's row, not as a message", () => {
  const answer = message("async-answer:q1", 2, { role: "user", text: "yes" });
  const row: WorkLogEntry = {
    ...work("w", 2),
    questionAnswer: { requestId: "q1" } as WorkLogEntry["questionAnswer"] & object,
  };
  expect(ids(deriveTranscriptEntries([message("m", 1), answer], [], [row]))).toEqual(["m", "w"]);
});
