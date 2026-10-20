import type { WorkerFeedItem } from "@kora/contracts";
import { describe, expect, it } from "@effect/vitest";

import { applyWorkerFeedStreamEvent } from "./fleet.ts";

const user = (id: string, text: string): WorkerFeedItem => ({
  id,
  at: 1,
  kind: "user",
  text,
  source: "leader",
});
const say = (id: string, text: string, streaming = true): WorkerFeedItem => ({
  id,
  at: 2,
  kind: "assistant",
  text,
  streaming,
});

describe("applyWorkerFeedStreamEvent", () => {
  it("a snapshot replaces whatever was there", () => {
    const before = [user("u0", "old")];
    const after = applyWorkerFeedStreamEvent(before, {
      type: "snapshot",
      paneId: "p1",
      items: [user("u1", "task"), say("a1", "hi")],
    });
    expect(after.map((i) => i.id)).toEqual(["u1", "a1"]);
  });

  it("an upsert of a known id replaces it in place; a new id appends", () => {
    let items = applyWorkerFeedStreamEvent([], {
      type: "snapshot",
      paneId: "p1",
      items: [user("u1", "task"), say("a1", "Look")],
    });
    items = applyWorkerFeedStreamEvent(items, {
      type: "upsert",
      paneId: "p1",
      item: user("u2", "steer"),
    });
    items = applyWorkerFeedStreamEvent(items, {
      type: "upsert",
      paneId: "p1",
      item: say("a1", "Looking at it", false),
    });
    expect(items.map((i) => i.id)).toEqual(["u1", "a1", "u2"]);
    expect(items[1]).toMatchObject({ text: "Looking at it", streaming: false });
  });

  it("never mutates the previous feed", () => {
    const before = [say("a1", "x")];
    const after = applyWorkerFeedStreamEvent(before, {
      type: "upsert",
      paneId: "p1",
      item: say("a1", "xy"),
    });
    expect(before[0]).toMatchObject({ text: "x" });
    expect(after).not.toBe(before);
  });
});
