import type { HostThreadRef } from "@kora/contracts";
import { describe, expect, test } from "vite-plus/test";

import {
  buildVisibleToastLayout,
  hasVisibleToastAction,
  shouldHideCollapsedToastContent,
  shouldRenderThreadScopedToast,
  withAnnouncementPriority,
} from "./toast-layout";

describe("hasVisibleToastAction", () => {
  test.each([
    [{ children: "Update" }, true],
    [{ children: "" }, false],
    [{ children: null }, false],
    [undefined, false],
  ])("%j -> %s", (action, visible) => {
    expect(hasVisibleToastAction(action)).toBe(visible);
  });
});

describe("shouldHideCollapsedToastContent", () => {
  test.each([
    [0, 1, false],
    [0, 4, false],
    [1, 4, true],
    [3, 4, true],
  ])("slot %i of %i hides: %s", (slot, total, hidden) => {
    expect(shouldHideCollapsedToastContent(slot, total)).toBe(hidden);
  });
});

describe("buildVisibleToastLayout", () => {
  type Toast = { id: string; height?: number | undefined; transitionStatus?: "ending" };
  const place = (toasts: Toast[]) => {
    const layout = buildVisibleToastLayout(toasts);
    return {
      front: layout.frontmostHeight,
      rows: layout.items.map((i) => [i.toast.id, i.visibleIndex, i.offsetY]),
    };
  };

  test("each toast is offset by the heights of those in front of it", () => {
    expect(
      place([
        { id: "x", height: 10 },
        { id: "y", height: 20 },
        { id: "z", height: 30 },
      ]),
    ).toEqual({
      front: 10,
      rows: [
        ["x", 0, 0],
        ["y", 1, 10],
        ["z", 2, 30],
      ],
    });
  });

  test("when the front toast is leaving, live toasts renumber from zero", () => {
    expect(
      place([
        { id: "x", height: 10, transitionStatus: "ending" },
        { id: "y", height: 20 },
        { id: "z", height: 30 },
      ]),
    ).toEqual({
      front: 20,
      rows: [
        ["x", 0, 0],
        ["y", 0, 0],
        ["z", 1, 20],
      ],
    });
  });

  test("a leaving toast in the middle keeps its slot while the one behind slides into it", () => {
    expect(
      place([
        { id: "x", height: 10 },
        { id: "y", height: 20, transitionStatus: "ending" },
        { id: "z", height: 30 },
      ]),
    ).toEqual({
      front: 10,
      rows: [
        ["x", 0, 0],
        ["y", 1, 10],
        ["z", 1, 10],
      ],
    });
  });

  test("a missing height counts as zero", () => {
    const { front, rows } = place([
      { id: "x" },
      { id: "y", height: undefined },
      { id: "z", height: 5 },
    ]);
    expect(front).toBe(0);
    expect(rows.map((r) => r[2])).toEqual([0, 0, 0]);
  });

  test("no toasts, no layout", () => {
    expect(place([])).toEqual({ front: 0, rows: [] });
  });
});

describe("shouldRenderThreadScopedToast", () => {
  const active = { hostId: "host-a", threadId: "thread-1" } as HostThreadRef;

  test.each([
    ["the same host and thread", { threadRef: active }, true],
    ["another host", { threadRef: { ...active, hostId: "host-b" } as HostThreadRef }, false],
    ["another thread", { threadRef: { ...active, threadId: "thread-2" } as HostThreadRef }, false],
    ["a legacy thread id that matches", { threadId: "thread-1" as never }, true],
    ["a legacy thread id that differs", { threadId: "thread-2" as never }, false],
    ["no scope at all", {}, true],
  ])("%s", (_label, toast, shown) => {
    expect(shouldRenderThreadScopedToast(toast, active)).toBe(shown);
  });
});

describe("withAnnouncementPriority", () => {
  type Options = { type?: string; priority?: "low" | "high"; title?: string };
  const priority = (o: Options) => withAnnouncementPriority(o).priority;

  test.each([
    ["error", "high"],
    ["warning", "high"],
    ["success", undefined],
    ["loading", undefined],
  ])("a %s toast gets priority %s", (type, expected) => {
    expect(priority({ type })).toBe(expected);
  });

  test("an explicit priority is respected", () => {
    expect(priority({ type: "error", priority: "low" })).toBe("low");
  });

  test("an update without a type is returned untouched", () => {
    const update: Options = { title: "Still working" };
    expect(withAnnouncementPriority(update)).toBe(update);
  });
});
