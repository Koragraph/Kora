import { describe, expect, it } from "vite-plus/test";

import { resolveWorkGroupScrollAnchor } from "./scrollAnchor.js";

const ROW = 40;
const rows = Array.from({ length: 20 }, (_, n) => ({ id: `row-${n}` }));
const evenRows = { data: rows, positionAtIndex: (index: number) => index * ROW };
/** A layout snapshot that also carries the virtualizer's cached start index, which must be ignored. */
const atScroll = (scroll: number, start: number) => {
  const snapshot = { ...evenRows, scroll, start };
  return snapshot;
};
const anchor = (rowId: string, offsetWithinRow: number, scrollOffset: number) => ({
  rowId,
  offsetWithinRow,
  scrollOffset,
});

describe("work group scroll anchor", () => {
  it("anchors to the first row at the top, whatever the stale start index says", () => {
    expect(resolveWorkGroupScrollAnchor(atScroll(0, 7))).toEqual(anchor("row-0", 0, 0));
  });

  it.each([
    [405, 0, "row-10", 5],
    [47, 12, "row-1", 7],
    [200, 4, "row-5", 0],
  ])(
    "finds the row under scroll %i from measured positions (stale start %i)",
    (scroll, start, rowId, offset) => {
      expect(resolveWorkGroupScrollAnchor(atScroll(scroll, start))).toEqual(
        anchor(rowId, offset, scroll),
      );
    },
  );

  it("keeps the offset inside a tall expanded row", () => {
    const tops = [0, ROW, 700];
    const snapshot = {
      data: [{ id: "head" }, { id: "big-output" }, { id: "tail" }],
      positionAtIndex: (index: number) => tops[index],
      scroll: 190,
    };
    expect(resolveWorkGroupScrollAnchor(snapshot)).toEqual(anchor("big-output", 150, 190));
  });

  it("clamps overscroll above the first row to zero", () => {
    expect(resolveWorkGroupScrollAnchor({ ...evenRows, scroll: -35 })).toEqual(
      anchor("row-0", 0, 0),
    );
  });

  it.each([
    ["no rows", { ...evenRows, data: [], scroll: 0 }],
    ["a NaN scroll", { ...evenRows, scroll: Number.NaN }],
    ["unmeasured rows", { ...evenRows, scroll: 200, positionAtIndex: () => undefined }],
    [
      "a NaN position",
      { ...evenRows, scroll: 200, positionAtIndex: (i: number) => (i === 0 ? 0 : Number.NaN) },
    ],
  ])("gives no anchor for %s", (_label, snapshot) => {
    expect(resolveWorkGroupScrollAnchor(snapshot)).toBeUndefined();
  });
});
