import { ProjectId } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import * as Sort from "./threadSort.ts";
import type { ThreadSortInput } from "./threadSort.ts";

const { sortThreads, getLatestThreadForProject, planPinnedReorder } = Sort;
const { pinOrderKeyBetween, generateSpreadPinOrderKeys } = Sort;
const { sortActiveThreadsByOrderKey, sortPinnedThreadsByOrderKey } = Sort;

type Row = ThreadSortInput & { readonly id: string };

const NOON = "2026-04-02T12:00:00.000Z";
/** 2026-04-02 at the given hh:mm, UTC. */
const at = (hhmm: string) => `2026-04-02T${hhmm}:00.000Z`;

const row = (id: string, extra: Partial<Row> = {}): Row => ({
  latestUserMessageAt: null,
  messages: [],
  updatedAt: NOON,
  createdAt: NOON,
  id,
  ...extra,
});

const ids = (rows: ReadonlyArray<{ readonly id: string }>) => rows.map(({ id }) => id);

/** Applies a reorder plan's keys on top of each row's existing key. */
const withPlan = <T extends { readonly id: string; readonly activeOrderKey: string | null }>(
  rows: ReadonlyArray<T>,
  plan: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>,
) => {
  const planned = new Map(plan.map(({ id, orderKey }) => [id, orderKey]));
  return rows.map((r) => ({ ...r, activeOrderKey: planned.get(r.id) ?? r.activeOrderKey }));
};

describe("sortThreads", () => {
  it.each(["created_at", "updated_at"] as const)(
    "%s: equal or unreadable times fall back to id, highest first, without copying rows",
    (order) => {
      const input = Object.freeze([
        row("m"),
        row("y"),
        row("bad-m", { updatedAt: "??", createdAt: "??" }),
        row("bad-y", { updatedAt: "??", createdAt: "??" }),
      ]);

      const sorted = sortThreads(input, order);

      expect(ids(sorted)).toEqual(["y", "m", "bad-y", "bad-m"]);
      expect(sorted.every((r) => input.includes(r))).toBe(true);
      expect(ids(input)).toEqual(["m", "y", "bad-m", "bad-y"]);
    },
  );

  it("falls back from a broken last-message time to updatedAt, then createdAt", () => {
    const rows = [
      row("p", { updatedAt: at("09:10"), createdAt: at("09:00"), latestUserMessageAt: "x" }),
      row("q", { updatedAt: "no", createdAt: "no", latestUserMessageAt: "y" }),
      row("r", { updatedAt: "no", createdAt: at("09:20"), latestUserMessageAt: "z" }),
    ];
    expect(ids(sortThreads(rows, "updated_at"))).toEqual(["r", "p", "q"]);
  });

  it("reads the newest user message when the last-message time is broken", () => {
    const chatty = row("chatty", {
      updatedAt: at("08:00"),
      latestUserMessageAt: "broken",
      messages: [
        { createdAt: at("08:10"), role: "user" },
        { createdAt: at("08:50"), role: "assistant" },
        { createdAt: at("08:40"), role: "user" },
      ],
    });
    const quiet = row("quiet", { updatedAt: at("08:30"), createdAt: at("08:30") });
    expect(ids(sortThreads([quiet, chatty], "updated_at"))).toEqual(["chatty", "quiet"]);
  });
});

describe("getLatestThreadForProject", () => {
  const mine = ProjectId.make("mine");

  it.each(["created_at", "updated_at"] as const)(
    "%s: picks the top live thread of the project",
    (order) => {
      const owned = (id: string, archivedAt: string | null = null, projectId = mine) => ({
        ...row(id),
        archivedAt,
        projectId,
      });
      const rows = [
        owned("b"),
        owned("x"),
        owned("xx", "2026-04-05T00:00:00Z"),
        owned("xxx", null, ProjectId.make("theirs")),
      ];
      const latest = (list: typeof rows, projectId = mine) =>
        getLatestThreadForProject(list, projectId, order);

      expect(latest(rows)).toBe(rows[1]);
      expect(latest([])).toBeNull();
      expect(latest(rows, ProjectId.make("nobody"))).toBeNull();

      const undated = rows.slice(0, 2).map((r) => ({ ...r, updatedAt: "?", createdAt: "?" }));
      expect(latest(undated)).toBe(undated[1]);
      // On a full tie the first of the equal rows wins.
      expect(latest([rows[1]!, { ...rows[1]! }])).toBe(rows[1]);
    },
  );
});

describe("planPinnedReorder", () => {
  it("lands a moved row between its visible neighbours, avoiding a hidden row's key", () => {
    const hidden = pinOrderKeyBetween("f", "t")!;
    const plan = planPinnedReorder({
      movedId: "moved",
      orderedIds: ["left", "moved", "right"],
      keysById: new Map([
        ["snoozed", hidden],
        ["moved", "z"],
        ["right", "t"],
        ["left", "f"],
      ]),
    });

    expect(plan.map(({ id }) => id)).toEqual(["moved"]);
    const key = plan[0]!.orderKey;
    expect([key > "f", key < "t", key === hidden]).toEqual([true, true, false]);
  });

  it("keys every unkeyed row in order and keeps clear of hidden rows' keys", () => {
    const hiddenKeys = generateSpreadPinOrderKeys(6);
    const keysById = new Map<string, string | null>(
      hiddenKeys.map((key, n) => [`off-screen-${n}`, key]),
    );
    for (const id of ["p", "q", "r"]) keysById.set(id, null);

    const plan = planPinnedReorder({ movedId: "r", keysById, orderedIds: ["r", "p", "q"] });
    const keys = plan.map(({ orderKey }) => orderKey);

    expect(ids(plan)).toEqual(["r", "p", "q"]);
    expect(keys.toSorted()).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter((key) => hiddenKeys.includes(key))).toEqual([]);
  });
});

describe("sortPinnedThreadsByOrderKey", () => {
  it("settles a key tie by id and then host, so every device merges the same way", () => {
    const pinned = sortPinnedThreadsByOrderKey([
      { pinOrderKey: "k", hostId: "host-2", createdAt: at("07:00"), id: "same" },
      { pinOrderKey: "k", hostId: "host-1", createdAt: at("08:00"), id: "same" },
    ]);
    expect(pinned.map(({ hostId }) => hostId)).toEqual(["host-1", "host-2"]);
  });
});

describe("generateSpreadPinOrderKeys", () => {
  it.each([0, 1, 650, 675, 676, 1_001, 2_000])(
    "%i keys stay unique, sorted and splittable",
    (n) => {
      const keys = generateSpreadPinOrderKeys(n);

      expect([keys.length, new Set(keys).size]).toEqual([n, n]);
      expect(keys.toSorted()).toEqual(keys);
      let previous: string | null = null;
      for (const key of keys) {
        // Keys never end in "a", which would leave no room below them.
        expect(key).toMatch(/^[a-z]*[b-z]$/);
        const middle = pinOrderKeyBetween(previous, key);
        expect(middle !== null && middle < key && (previous === null || middle > previous)).toBe(
          true,
        );
        previous = key;
      }
    },
  );
});

describe("sortActiveThreadsByOrderKey", () => {
  it("lists new and reopened threads ahead of the arranged ones", () => {
    const sorted = sortActiveThreadsByOrderKey([
      { activeOrderKey: "f", createdAt: at("09:00"), id: "kept-1" },
      { activeOrderKey: null, createdAt: at("11:00"), id: "fresh" },
      { activeOrderKey: "t", unsettledAt: at("13:00"), createdAt: at("12:00"), id: "kept-2" },
      { unsettledAt: at("12:00"), createdAt: "2026-03-01T09:00:00.000Z", id: "woken" },
    ]);
    expect(ids(sorted)).toEqual(["woken", "fresh", "kept-1", "kept-2"]);
  });

  it.each([null, "m"])("orders exact ties by id then host (key %s)", (activeOrderKey) => {
    const rows = [
      ["two", "h1"],
      ["one", "h2"],
      ["one", "h1"],
    ].map(([id, hostId]) => ({ activeOrderKey, createdAt: NOON, hostId: hostId!, id: id! }));

    const order = sortActiveThreadsByOrderKey(rows).map(({ id, hostId }) => `${id}@${hostId}`);
    expect(order).toEqual(["one@h1", "one@h2", "two@h1"]);
  });

  it("can perform any single move in a list where only some rows have keys", () => {
    const keyed = ["f", "m", "t"];
    const rows = [0, 1, 2, 3, 4, 5].map((n) => ({
      activeOrderKey: n >= 3 ? keyed[n - 3]! : null,
      createdAt: at(`0${6 - n}:00`),
      id: `${n}`,
    }));
    const keysById = new Map(rows.map((r) => [r.id, r.activeOrderKey]));

    for (const movedId of ids(rows)) {
      const rest = ids(rows).filter((id) => id !== movedId);
      for (let slot = 0; slot <= rest.length; slot += 1) {
        const orderedIds = rest.toSpliced(slot, 0, movedId);
        const plan = planPinnedReorder({ keysById, movedId, orderedIds });
        expect(ids(sortActiveThreadsByOrderKey(withPlan(rows, plan)))).toEqual(orderedIds);
      }
    }
  });

  it("holds the asked-for order when a long unkeyed list needs keys", () => {
    const rows = Array.from({ length: 1_200 }, (_, n) => ({
      activeOrderKey: null as string | null,
      createdAt: NOON,
      id: `${n}`,
    }));
    const orderedIds = ids(rows).reverse();
    const plan = planPinnedReorder({
      keysById: new Map(rows.map((r) => [r.id, r.activeOrderKey])),
      movedId: orderedIds[0]!,
      orderedIds,
    });
    expect(ids(sortActiveThreadsByOrderKey(withPlan(rows, plan)))).toEqual(orderedIds);
  });
});
