import { describe, expect, test } from "vite-plus/test";

import {
  getAnchoredTurnMetrics,
  getRowBottom,
  transcriptContentOverflowsViewport,
} from "./transcriptScrollAnchoring";

/** A fake list state from per-row top positions and heights. */
function list(opts: { tops: number[]; heights: number[]; scroll?: number; viewport?: number }) {
  return {
    data: opts.tops.map((_, i) => i),
    positionAtIndex: (i: number) => opts.tops[i],
    sizeAtIndex: (i: number) => opts.heights[i],
    scroll: opts.scroll ?? 0,
    scrollLength: opts.viewport ?? 700,
  };
}

const anchoredAt1 = (state: ReturnType<typeof list>, composerOverlayHeight: number) =>
  getAnchoredTurnMetrics({ state, anchorIndex: 1, anchorOffset: 16, composerOverlayHeight });

describe("getAnchoredTurnMetrics", () => {
  test("the composer's height is taken off the usable viewport", () => {
    const state = list({ tops: [0, 300], heights: [120, 470], viewport: 700 });
    expect(anchoredAt1(state, 0)?.overflowsUsableViewport).toBe(false);
    expect(anchoredAt1(state, 220)?.overflowsUsableViewport).toBe(true);
  });

  test("when the turn ends below the visible area, it reports the smallest scroll that reveals the end", () => {
    const state = list({
      tops: [0, 900, 1180],
      heights: [800, 220, 360],
      scroll: 900,
      viewport: 760,
    });
    const m = anchoredAt1(state, 180);
    expect(m?.lastBottom).toBe(1540);
    expect(m?.visibleUsableBottom).toBe(1464);
    expect(m?.scrollDeltaToRevealEnd).toBe(76);
  });

  test("overflow is judged on the anchored turn only (rows before it do not count)", () => {
    const state = list({
      tops: [0, 900, 1180],
      heights: [800, 220, 300],
      scroll: 900,
      viewport: 760,
    });
    const m = anchoredAt1(state, 180);
    expect([m?.turnHeight, m?.usableViewportHeight, m?.overflowsUsableViewport]).toEqual([
      580,
      564,
      true,
    ]);
  });

  test("the target is the real end of the last row, not a temporary reserved tail", () => {
    const state = list({
      tops: [0, 1720, 1880],
      heights: [1600, 80, 120],
      scroll: 1900,
      viewport: 760,
    });
    const m = anchoredAt1(state, 180);
    expect(m?.lastBottom).toBe(2000);
    expect(m?.targetScrollToRevealEnd).toBe(1436);
    expect(m?.scrollDeltaToRevealEnd).toBe(0);
  });

  test("a turn that fits above the composer is reported as fitting, with a positive scroll to its end", () => {
    const state = list({ tops: [0, 300, 460], heights: [240, 80, 140], viewport: 760 });
    const m = anchoredAt1(state, 180);
    expect(m?.turnHeight).toBe(300);
    expect(m?.usableViewportHeight).toBe(564);
    expect(m?.overflowsUsableViewport).toBe(false);
    expect(m?.targetScrollToRevealEnd).toBe(36);
    expect(m?.scrollDeltaToRevealEnd).toBe(36);
  });
});

describe("getRowBottom", () => {
  test("is the row's position plus its size", () => {
    expect(getRowBottom(list({ tops: [0, 120], heights: [80, 40] }), 1)).toBe(160);
  });
});

describe("transcriptContentOverflowsViewport", () => {
  const inset = { composerInset: 100, anchorOffset: 24 };

  test.each([
    ["no list yet", undefined],
    ["a viewport of zero", list({ tops: [0, 200], heights: [200, 400], viewport: 0 })],
    ["no rows", list({ tops: [], heights: [] })],
    ["an unmeasured last row", list({ tops: [0, 200], heights: [200, Number.NaN] })],
  ])("%s counts as fitting", (_label, state) => {
    expect(transcriptContentOverflowsViewport(state, inset)).toBe(false);
  });

  test("overflow comes from the last row's end, not from the inset spacer", () => {
    expect(
      transcriptContentOverflowsViewport(
        list({ tops: [0, 200], heights: [200, 300], viewport: 700 }),
        inset,
      ),
    ).toBe(false);
    expect(
      transcriptContentOverflowsViewport(
        list({ tops: [0, 200], heights: [200, 400], viewport: 700 }),
        inset,
      ),
    ).toBe(true);
  });
});
