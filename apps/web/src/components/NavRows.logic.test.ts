import { describe, expect, test } from "vite-plus/test";
import {
  getFallbackThreadIdAfterDelete,
  hasUnseenCompletion,
  isTrailingDoubleClick,
  orderByPreferredIds,
  pinOrderKeyBetween,
  planPinnedReorder,
  resolveNavThreadStatus,
  searchNavThreads,
  sortPinnedThreadsForSidebar,
  sortScopedProjectsForNav,
  sortThreadsForSidebar,
} from "./NavRows.logic";

const ids = (rows: ReadonlyArray<{ id: string }>) => rows.map((row) => row.id);

describe("hasUnseenCompletion", () => {
  const base = {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default",
    session: null,
  } as const;
  const turn = (completedAt: string | null) =>
    ({
      turnId: "t",
      state: "completed",
      assistantMessageId: null,
      requestedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt,
    }) as never;

  test.each([
    ["finished after the visit", "2026-01-01T00:05:00.000Z", "2026-01-01T00:04:00.000Z", true],
    ["finished before the visit", "2026-01-01T00:05:00.000Z", "2026-01-01T00:06:00.000Z", false],
    ["no visit recorded", "2026-01-01T00:05:00.000Z", undefined, false],
    ["unparseable visit", "2026-01-01T00:05:00.000Z", "garbage", true],
    ["unparseable completion", "garbage", "2026-01-01T00:04:00.000Z", false],
    ["still running", null, "2026-01-01T00:04:00.000Z", false],
  ])("%s", (_label, completedAt, lastVisitedAt, expected) => {
    expect(hasUnseenCompletion({ ...base, latestTurn: turn(completedAt), lastVisitedAt })).toBe(
      expected,
    );
  });
});

describe("isTrailingDoubleClick", () => {
  test.each([
    [0, false],
    [1, false],
    [2, true],
    [5, true],
  ])("click detail %i -> %s", (detail, expected) => {
    expect(isTrailingDoubleClick(detail)).toBe(expected);
  });
});

describe("orderByPreferredIds", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];

  test("an empty preference list returns a copy in the original order", () => {
    const out = orderByPreferredIds({ items: rows, preferredIds: [], getId: (r) => r.id });
    expect(out).toEqual(rows);
    expect(out).not.toBe(rows);
  });

  test("preferred rows lead, unknown preferences vanish, the rest keep their order", () => {
    const out = orderByPreferredIds({
      items: rows,
      preferredIds: ["c", "nope", "a"],
      getId: (r) => r.id,
    });
    expect(ids(out)).toEqual(["c", "a", "b"]);
  });

  test("a repeated preference never yields a row twice", () => {
    const out = orderByPreferredIds({
      items: rows,
      preferredIds: ["b", "a", "b", "b"],
      getId: (r) => r.id,
    });
    expect(ids(out)).toEqual(["b", "a", "c"]);
  });

  test("aliases let an old preference key still find its row", () => {
    const items = [
      { id: "p1", cwd: "/x" },
      { id: "p2", cwd: "/y" },
      { id: "p3", cwd: "/z" },
    ];
    const out = orderByPreferredIds({
      items,
      preferredIds: ["old:/z", "p1"],
      getId: (r) => r.id,
      getPreferenceIds: (r) => [r.id, `old:${r.cwd}`],
    });
    expect(ids(out)).toEqual(["p3", "p1", "p2"]);
  });

  test("two rows sharing a preference id are consumed one per mention", () => {
    const twins = [
      { id: "a", n: 1 },
      { id: "a", n: 2 },
    ];
    const out = orderByPreferredIds({
      items: twins,
      preferredIds: ["a", "a"],
      getId: (r) => r.id,
    });
    expect(out.map((r) => r.n)).toEqual([1, 2]);
  });
});

describe("resolveNavThreadStatus", () => {
  const quiet = { hasPendingApprovals: false, hasPendingUserInput: false };
  const withSession = (status: string, lastError: string | null = null) =>
    ({ status, lastError }) as never;

  test("approval beats input beats a live session", () => {
    const live = withSession("running");
    expect(resolveNavThreadStatus({ ...quiet, hasPendingApprovals: true, session: live })).toBe(
      "approval",
    );
    expect(resolveNavThreadStatus({ ...quiet, hasPendingUserInput: true, session: live })).toBe(
      "input",
    );
    expect(
      resolveNavThreadStatus({
        hasPendingApprovals: true,
        hasPendingUserInput: true,
        session: live,
      }),
    ).toBe("approval");
  });

  test.each([
    ["running", "working"],
    ["starting", "working"],
    ["error", "failed"],
    ["stopped", "ready"],
    ["ready", "ready"],
  ])("session %s -> %s", (status, expected) => {
    expect(resolveNavThreadStatus({ ...quiet, session: withSession(status, "old error") })).toBe(
      expected,
    );
  });

  test("background liveness applies only when the session says nothing stronger", () => {
    expect(resolveNavThreadStatus({ ...quiet, session: null, backgroundLiveness: "working" })).toBe(
      "working",
    );
    expect(
      resolveNavThreadStatus({ ...quiet, session: null, backgroundLiveness: "monitoring" }),
    ).toBe("monitoring");
    expect(
      resolveNavThreadStatus({
        ...quiet,
        session: withSession("error"),
        backgroundLiveness: "working",
      }),
    ).toBe("failed");
  });

  test("no session and no flags is ready", () => {
    expect(resolveNavThreadStatus({ ...quiet, session: null })).toBe("ready");
  });
});

describe("searchNavThreads", () => {
  const pool = [
    { id: "1", title: "Fix workspace search" },
    { id: "2", title: "Review providers" },
    { id: "3", title: "WORKTREE cleanup" },
  ] as never[];

  test("case-insensitive title match that keeps list order", () => {
    expect(ids(searchNavThreads(pool, "WoRk") as never)).toEqual(["1", "3"]);
  });

  test("blank queries match nothing", () => {
    expect(searchNavThreads(pool, "")).toEqual([]);
    expect(searchNavThreads(pool, " \t ")).toEqual([]);
  });

  test("surrounding whitespace in the query is ignored", () => {
    expect(ids(searchNavThreads(pool, "  review ") as never)).toEqual(["2"]);
  });
});

describe("sortThreadsForSidebar", () => {
  const at = (hour: number) => `2026-05-02T${String(hour).padStart(2, "0")}:00:00.000Z`;

  test("newest creation first", () => {
    const out = sortThreadsForSidebar([
      { id: "old", createdAt: at(1) },
      { id: "new", createdAt: at(9) },
      { id: "mid", createdAt: at(5) },
    ]);
    expect(ids(out)).toEqual(["new", "mid", "old"]);
  });

  test("equal stamps fall back to id order", () => {
    const out = sortThreadsForSidebar([
      { id: "z", createdAt: at(3) },
      { id: "y", createdAt: at(3) },
    ]);
    expect(ids(out)).toEqual(["y", "z"]);
  });

  test("a later unsettledAt lifts an old thread to the top", () => {
    const out = sortThreadsForSidebar([
      { id: "a", createdAt: at(9) },
      { id: "b", createdAt: at(1), unsettledAt: at(12) },
    ]);
    expect(ids(out)).toEqual(["b", "a"]);
  });

  test("an unsettledAt earlier than creation does nothing", () => {
    const out = sortThreadsForSidebar([
      { id: "a", createdAt: at(9) },
      { id: "b", createdAt: at(5), unsettledAt: at(2) },
    ]);
    expect(ids(out)).toEqual(["a", "b"]);
  });
});

describe("pinOrderKeyBetween", () => {
  test("keys land strictly inside their bounds", () => {
    const mid = pinOrderKeyBetween(null, null)!;
    const before = pinOrderKeyBetween(null, mid)!;
    const after = pinOrderKeyBetween(mid, null)!;
    const inner = pinOrderKeyBetween(before, mid)!;
    expect([before < inner, inner < mid, mid < after]).toEqual([true, true, true]);
  });

  test("adjacent bounds grow a longer key", () => {
    const key = pinOrderKeyBetween("c", "d")!;
    expect(key > "c" && key < "d").toBe(true);
    expect(key.length).toBeGreaterThan(1);
  });

  test("500 insertions at the head keep descending and unique", () => {
    let head: string | null = null;
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const next: string = pinOrderKeyBetween(null, head)!;
      expect(next).toBeTruthy();
      if (head) expect(next < head).toBe(true);
      seen.add(next);
      head = next;
    }
    expect(seen.size).toBe(500);
  });

  test("squeezing the same gap alternately never breaks ordering", () => {
    let lo = pinOrderKeyBetween(null, null)!;
    let hi = pinOrderKeyBetween(lo, null)!;
    for (let i = 0; i < 80; i++) {
      const k: string = pinOrderKeyBetween(lo, hi)!;
      expect(k > lo && k < hi).toBe(true);
      if (i % 3 === 0) hi = k;
      else lo = k;
    }
  });

  test.each([
    ["inverted", "z", "a"],
    ["equal", "m", "m"],
    ["bad characters", "A!", null],
    ["unreachable upper bound", null, "ma"],
  ])("%s bounds give null", (_label, lo, hi) => {
    expect(pinOrderKeyBetween(lo, hi)).toBeNull();
  });
});

describe("planPinnedReorder", () => {
  test("a drop between two keyed neighbours rewrites just the moved row", () => {
    const plan = planPinnedReorder({
      orderedIds: ["a", "x", "b"],
      keysById: new Map([
        ["a", "d"],
        ["b", "p"],
        ["x", "w"],
      ]),
      movedId: "x",
    });
    expect(plan.map((p) => p.id)).toEqual(["x"]);
    expect(plan[0]!.orderKey > "d" && plan[0]!.orderKey < "p").toBe(true);
  });

  test("dropping at the very top only has an upper bound", () => {
    const plan = planPinnedReorder({
      orderedIds: ["x", "a"],
      keysById: new Map<string, string | null>([
        ["a", "k"],
        ["x", null],
      ]),
      movedId: "x",
    });
    expect(plan).toHaveLength(1);
    expect(plan[0]!.orderKey < "k").toBe(true);
  });

  test("a keyless neighbour forces keys for the whole run, in order", () => {
    const plan = planPinnedReorder({
      orderedIds: ["m", "n", "o"],
      keysById: new Map<string, string | null>([
        ["m", "q"],
        ["n", null],
        ["o", null],
      ]),
      movedId: "m",
    });
    expect(plan.map((p) => p.id)).toEqual(["m", "n", "o"]);
    const keys = plan.map((p) => p.orderKey);
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(3);
  });
});

describe("sortPinnedThreadsForSidebar", () => {
  const pin = (id: string, createdAt: string, pinOrderKey: string | null = null) => ({
    id,
    createdAt,
    pinOrderKey,
  });

  test("keyed rows by key, then keyless rows newest first", () => {
    const out = sortPinnedThreadsForSidebar([
      pin("k-old", "2026-01-01T01:00:00.000Z"),
      pin("b", "2026-01-01T02:00:00.000Z", "t"),
      pin("k-new", "2026-01-01T05:00:00.000Z"),
      pin("a", "2026-01-01T03:00:00.000Z", "c"),
    ]);
    expect(ids(out)).toEqual(["a", "b", "k-new", "k-old"]);
  });

  test("identical keys resolve by id", () => {
    const out = sortPinnedThreadsForSidebar([
      pin("two", "2026-01-01T01:00:00.000Z", "m"),
      pin("one", "2026-01-01T09:00:00.000Z", "m"),
    ]);
    expect(ids(out)).toEqual(["one", "two"]);
  });
});

describe("getFallbackThreadIdAfterDelete", () => {
  const t = (id: string, projectId: string, createdAt: string) =>
    ({
      id,
      projectId,
      createdAt,
      updatedAt: createdAt,
      archivedAt: null,
      messages: [],
    }) as never;
  const pool = [
    t("old", "p1", "2026-02-01T10:00:00.000Z"),
    t("gone", "p1", "2026-02-01T10:05:00.000Z"),
    t("fresh", "p1", "2026-02-01T10:10:00.000Z"),
    t("alien", "p2", "2026-02-01T10:20:00.000Z"),
  ];

  test("picks the next thread in the same project, ignoring other projects", () => {
    expect(
      getFallbackThreadIdAfterDelete({
        threads: pool,
        deletedThreadId: "gone" as never,
        sortOrder: "created_at",
      }),
    ).toBe("fresh");
  });

  test("threads deleted in the same batch are skipped", () => {
    expect(
      getFallbackThreadIdAfterDelete({
        threads: pool,
        deletedThreadId: "gone" as never,
        deletedThreadIds: new Set(["gone", "fresh"]) as never,
        sortOrder: "created_at",
      }),
    ).toBe("old");
  });

  test("null when nothing is left or the id is unknown", () => {
    expect(
      getFallbackThreadIdAfterDelete({
        threads: [pool[3]!],
        deletedThreadId: "alien" as never,
        sortOrder: "created_at",
      }),
    ).toBeNull();
    expect(
      getFallbackThreadIdAfterDelete({
        threads: pool,
        deletedThreadId: "missing" as never,
        sortOrder: "created_at",
      }),
    ).toBeNull();
  });
});

describe("sortScopedProjectsForNav", () => {
  const proj = (
    hostId: string,
    id: string,
    title: string,
    updatedAt = "2026-03-01T00:00:00.000Z",
  ) =>
    ({ hostId, id, title, createdAt: updatedAt, updatedAt }) as never as {
      hostId: string;
      id: string;
      title: string;
    };
  const thr = (
    hostId: string,
    projectId: string,
    updatedAt: string,
    archivedAt: string | null = null,
  ) =>
    ({ hostId, projectId, updatedAt, createdAt: updatedAt, archivedAt }) as never as {
      hostId: string;
      projectId: string;
      archivedAt: string | null;
      updatedAt: string;
      createdAt: string;
    };
  const titles = (rows: ReadonlyArray<{ title: string }>) => rows.map((r) => r.title);

  test("manual order is returned untouched", () => {
    const rows = [proj("h", "2", "B"), proj("h", "1", "A")];
    expect(sortScopedProjectsForNav(rows, [], "manual")).toEqual(rows);
  });

  test("the same project id on two hosts is scored separately", () => {
    const out = sortScopedProjectsForNav(
      [proj("local", "p", "Local"), proj("remote", "p", "Remote")],
      [
        thr("local", "p", "2026-03-02T00:02:00.000Z"),
        thr("remote", "p", "2026-03-02T00:10:00.000Z"),
      ],
      "updated_at",
    );
    expect(titles(out)).toEqual(["Remote", "Local"]);
  });

  test("archived threads do not count as activity", () => {
    const out = sortScopedProjectsForNav(
      [
        proj("h", "a", "Has live", "2026-03-02T00:01:00.000Z"),
        proj("h", "b", "Only archived", "2026-03-02T00:00:00.000Z"),
      ],
      [
        thr("h", "a", "2026-03-02T00:02:00.000Z"),
        thr("h", "b", "2026-03-02T00:10:00.000Z", "2026-03-02T00:11:00.000Z"),
      ],
      "updated_at",
    );
    expect(titles(out)).toEqual(["Has live", "Only archived"]);
  });

  test("ties break on title", () => {
    const out = sortScopedProjectsForNav(
      [proj("h", "1", "Zed"), proj("h", "2", "Abe")],
      [],
      "updated_at",
    );
    expect(titles(out)).toEqual(["Abe", "Zed"]);
  });
});
