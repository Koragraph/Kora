import { describe, expect, test } from "vite-plus/test";

import { getLatestThreadForProject, sortThreads } from "./threadSort";

type Msg = { role: "user" | "assistant"; at: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

/** Build only the fields the sort reads. */
function thread(
  id: string,
  opts: {
    created?: string;
    updated?: string;
    project?: string;
    archivedAt?: string | null;
    msgs?: Msg[];
  } = {},
) {
  return {
    id,
    projectId: opts.project ?? "p1",
    createdAt: opts.created ?? "2026-04-01T09:00:00.000Z",
    updatedAt: opts.updated ?? "2026-04-01T09:00:00.000Z",
    archivedAt: opts.archivedAt ?? null,
    messages: (opts.msgs ?? []).map((m, i) => ({
      id: `m${i}`,
      role: m.role,
      text: "",
      streaming: false,
      turnId: null,
      createdAt: m.at,
      updatedAt: m.at,
    })),
  } as never as Row;
}

const order = (rows: Array<{ id: string }>) => rows.map((r) => r.id);
const T = (minutes: number) => `2026-04-01T09:${String(minutes).padStart(2, "0")}:00.000Z`;

describe("sortThreads by creation time", () => {
  test("newest creation first, whatever the activity", () => {
    const out = sortThreads(
      [
        thread("a", { created: T(5), updated: T(5) }),
        thread("b", { created: T(0), updated: T(10) }),
      ],
      "created_at",
    );
    expect(order(out)).toEqual(["a", "b"]);
  });

  test("an unparseable createdAt falls back to updatedAt", () => {
    const out = sortThreads(
      [
        thread("broken", { created: "nope", updated: T(5) }),
        thread("good", { created: T(0), updated: T(10) }),
      ],
      "created_at",
    );
    expect(order(out)).toEqual(["broken", "good"]);
  });
});

describe("sortThreads by recency", () => {
  test("the latest user message decides, not the thread's updatedAt", () => {
    const out = sortThreads(
      [
        thread("old-msg", { updated: T(10), msgs: [{ role: "user", at: T(1) }] }),
        thread("new-msg", { updated: T(5), created: T(5), msgs: [{ role: "user", at: T(6) }] }),
      ],
      "updated_at",
    );
    expect(order(out)).toEqual(["new-msg", "old-msg"]);
  });

  test("assistant-only messages are ignored in favour of thread timestamps", () => {
    const out = sortThreads(
      [
        thread("chatty", { updated: T(1), msgs: [{ role: "assistant", at: T(20) }] }),
        thread("fresh", { updated: T(5), created: T(5) }),
      ],
      "updated_at",
    );
    expect(order(out)).toEqual(["fresh", "chatty"]);
  });

  test("a broken updatedAt uses createdAt", () => {
    const out = sortThreads(
      [
        thread("x", { updated: "bad", created: T(10) }),
        thread("y", { updated: T(7), created: T(1) }),
      ],
      "updated_at",
    );
    expect(order(out)).toEqual(["x", "y"]);
  });

  test("with no usable timestamps at all, the higher id comes first", () => {
    const out = sortThreads(
      [
        thread("t-1", { updated: "bad", created: "bad" }),
        thread("t-2", { updated: "bad", created: "bad" }),
      ],
      "updated_at",
    );
    expect(order(out)).toEqual(["t-2", "t-1"]);
  });
});

describe("getLatestThreadForProject", () => {
  test("skips archived threads and other projects", () => {
    const latest = getLatestThreadForProject(
      [
        thread("live-old", { updated: T(1) }),
        thread("archived", { updated: T(30), archivedAt: T(31) }),
        thread("live-new", { updated: T(6), created: T(6) }),
        thread("elsewhere", { updated: T(50), project: "p2" }),
      ],
      "p1" as never,
      "updated_at",
    );
    expect(latest?.id).toBe("live-new");
  });

  test("a project with nothing live has no latest thread", () => {
    expect(
      getLatestThreadForProject([thread("a", { archivedAt: T(1) })], "p1" as never, "updated_at"),
    ).toBeNull();
  });
});
