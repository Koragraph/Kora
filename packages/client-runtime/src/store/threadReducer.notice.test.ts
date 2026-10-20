import { describe, expect, it } from "vite-plus/test";

import { EventId, ItemId, ProjectId, AgentProfileId, ThreadId } from "@kora/contracts";
import type { ChatThread } from "@kora/contracts";

import { applyThreadDetailEvent } from "./threadReducer.ts";

// Swarm S1: a Kora-authored turn (mode notice / fleet notes) carries `notice` through the reducer so the timeline
// renders it as a row, never a user bubble; a swarm agent-mode-set lands like any other mode.

const THREAD_ID = ThreadId.make("thread-1");
const DAY = "2026-09-24T00:00:00.000Z";
const LATER = "2026-09-24T01:00:00.000Z";

const nulls = <Key extends string>(...keys: Key[]) =>
  Object.fromEntries(keys.map((key) => [key, null])) as Record<Key, null>;
const empties = <Key extends string>(...keys: Key[]) =>
  Object.fromEntries(keys.map((key) => [key, []])) as Record<Key, []>;

const thread: ChatThread = {
  ...nulls("branch", "worktreePath", "latestTurn", "archivedAt", "deletedAt", "session"),
  ...nulls("settledOverride", "settledAt"),
  ...empties("messages", "activities", "checkpoints", "proposedPlans", "pullRequests"),
  id: THREAD_ID,
  title: "T",
  projectId: ProjectId.make("project-1"),
  agentMode: "chat",
  interactionMode: "default",
  runtimeMode: "full-access",
  modelSelection: { model: "claude", instanceId: AgentProfileId.make("claude") },
  updatedAt: DAY,
  createdAt: DAY,
};

const envelope = (sequence: number) =>
  ({
    ...nulls("commandId", "causationEventId", "correlationId"),
    sequence,
    metadata: {},
    occurredAt: LATER,
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    eventId: EventId.make("event-1"),
  }) as const;

const sent = (sequence: number, extra: Record<string, unknown> = {}) =>
  ({
    ...envelope(sequence),
    type: "threadMessageSent",
    payload: {
      role: "user",
      threadId: THREAD_ID,
      messageId: ItemId.make("msg-k"),
      text: "[kora] User has switched to Swarm mode.",
      streaming: false,
      turnId: null,
      updatedAt: LATER,
      createdAt: LATER,
      ...extra,
    },
  }) as any;

/** Applies the event and returns the thread, failing when the reducer did not update it. */
const after = (current: ChatThread, event: unknown) => {
  const outcome = applyThreadDetailEvent(current, event as any);
  if (outcome.kind !== "updated") throw new Error(`reducer said ${outcome.kind}`);
  return outcome.thread;
};

describe("threadReducer: Kora notices", () => {
  it("carries notice on a new message", () => {
    const notice = { to: "swarm", from: "chat", kind: "agent-mode-switched" };
    expect(after(thread, sent(1, { notice })).messages[0]?.notice).toEqual(notice);
  });

  it("keeps notice when the same message is merged again, and leaves plain messages without the key", () => {
    const fleetNote = { notice: { kind: "fleet-note" } };
    const merged = after(after(thread, sent(1, fleetNote)), sent(2, fleetNote));
    expect(merged.messages.map((message) => message.notice)).toEqual([{ kind: "fleet-note" }]);

    const [plain] = after(thread, sent(3)).messages;
    expect(Object.hasOwn(plain!, "notice")).toBe(false);
  });

  it("applies a swarm agent-mode-set", () => {
    const modeSet = {
      ...envelope(4),
      type: "threadAgentModeSet",
      payload: { agentMode: "swarm", updatedAt: LATER, threadId: THREAD_ID },
    };
    expect(after(thread, modeSet).agentMode).toBe("swarm");
  });
});
