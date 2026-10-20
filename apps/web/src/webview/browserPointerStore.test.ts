import { beforeEach, describe, expect, test } from "vite-plus/test";

import { useBrowserPointerStore } from "./browserPointerStore";

type Event = Parameters<ReturnType<typeof useBrowserPointerStore.getState>["apply"]>[0];

const store = () => useBrowserPointerStore.getState();
const at = (
  tabId: string,
  sequence: number,
  x: number,
  y: number,
  phase: Event["phase"],
): Event => ({
  tabId,
  sequence,
  phase,
  x,
  y,
  createdAt: `2026-06-12T00:00:0${sequence}.000Z`,
});

beforeEach(() => {
  useBrowserPointerStore.setState({ byTabId: {} });
});

describe("browserPointerStore", () => {
  test("each tab keeps only its most recent pointer event", () => {
    store().apply(at("one", 0, 20, 30, "move"));
    store().apply(at("two", 1, 40, 50, "move"));
    store().apply(at("one", 2, 60, 70, "click"));

    expect(store().byTabId).toMatchObject({
      one: { phase: "click", x: 60, y: 70, sequence: 2 },
      two: { phase: "move", x: 40, y: 50, sequence: 1 },
    });
  });

  test("clearing a tab leaves the others untouched", () => {
    store().apply(at("one", 0, 20, 30, "move"));
    store().apply(at("two", 1, 40, 50, "move"));

    store().clear("one");

    expect(Object.keys(store().byTabId)).toEqual(["two"]);
    expect(store().byTabId["two"]).toMatchObject({ x: 40, y: 50 });
  });

  test("clearing an unknown tab is harmless", () => {
    store().apply(at("one", 0, 1, 2, "move"));
    store().clear("ghost");
    expect(Object.keys(store().byTabId)).toEqual(["one"]);
  });
});
