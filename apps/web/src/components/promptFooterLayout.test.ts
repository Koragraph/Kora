import { describe, expect, test } from "vite-plus/test";

import {
  PROMPT_FOOTER_COMPACT_BREAKPOINT_PX,
  PROMPT_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX,
  PROMPT_RESTING_EXPANSION_MIN_PX,
  resetPromptTranscriptInset,
  resolvePromptTranscriptInset,
  resolveRestingPromptControlsLayout,
  resolveScrollToEndClearance,
  shouldUseCompactPromptFooter,
  shouldUseCompactPromptPrimaryActions,
  shouldUseRestingPromptLayout,
} from "./promptFooterLayout";

const WIDE = PROMPT_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX;
const NARROW = PROMPT_FOOTER_COMPACT_BREAKPOINT_PX;

describe("resolveScrollToEndClearance", () => {
  const surfaceTop = 534;
  const scene = (overlayHeight: number) => ({
    overlayHeight,
    mainSurfaceTop: surfaceTop,
    button: { left: 340, right: 460 },
    attachments: [{ top: 500, left: 600, right: 700 }],
  });

  test.each([120, 214])(
    "with a %ipx overlay: only attachments under the button add clearance",
    (height) => {
      const base = scene(height);
      // an attachment off to the side overlaps the surface, so the side-tab gap (34) is removed
      expect(resolveScrollToEndClearance(base)).toBe(height - 34);
      expect(resolveScrollToEndClearance({ ...base, attachments: [] })).toBe(height);
      // an attachment spanning beneath the button needs full clearance
      const underButton = { top: 500, left: 100, right: 700 };
      expect(
        resolveScrollToEndClearance({ ...base, attachments: [...base.attachments, underButton] }),
      ).toBe(height);
      // the button moved over the side attachment
      expect(resolveScrollToEndClearance({ ...base, button: { left: 590, right: 710 } })).toBe(
        height,
      );
    },
  );
});

describe("resolveRestingPromptControlsLayout", () => {
  // picker: 149 natural / 105 minimum; trailing blocks 60 and 140; overflow button 24; gap 4
  const measures = {
    gap: 4,
    overflowWidth: 24,
    blockWidths: [60, 140],
    minimumFixedWidth: 105,
    naturalFixedWidth: 149,
  };
  const layout = (hostWidth: number, extra: object = {}) =>
    resolveRestingPromptControlsLayout({ ...measures, hostWidth, ...extra });
  const shown = (hiddenCount: number) => ({ visible: true, hiddenCount });

  test("from scratch, blocks move into overflow one by one as the host narrows", () => {
    expect(layout(357)).toEqual(shown(0)); // 149 + 60 + 140 + 2*4
    expect(layout(356)).toEqual(shown(1));
    expect(layout(241)).toEqual(shown(1)); // 149 + 60 + 24 + 2*4
    expect(layout(240)).toEqual(shown(2));
    expect(layout(133)).toEqual(shown(2)); // 105 + 24 + 4
  });

  test("below the picker's minimum the whole cluster is hidden", () => {
    expect(layout(132)).toEqual({ visible: false, hiddenCount: 2 });
    expect(layout(0)).toEqual({ visible: false, hiddenCount: 2 });
  });

  test("a lone control with nothing to overflow just hides when it does not fit", () => {
    expect(
      layout(139, {
        naturalFixedWidth: 140,
        minimumFixedWidth: 140,
        blockWidths: [],
        overflowWidth: 0,
      }),
    ).toEqual({ visible: false, hiddenCount: 0 });
  });

  describe("with a previous layout (hysteresis: growing needs 1px of slack)", () => {
    test("a hidden cluster comes back only above its exact minimum", () => {
      const previous = { hiddenCount: 2, visible: false };
      expect(layout(133, { previous })).toEqual(previous);
      expect(layout(134, { previous })).toEqual(shown(2));
    });

    test("a partly restored cluster stays put at the exact threshold", () => {
      const previous = shown(2);
      expect(layout(241, { previous })).toEqual(previous);
      expect(layout(242, { previous })).toEqual(shown(1));
    });

    test("a block stays in overflow when showing it would fill the host exactly", () => {
      expect(layout(357, { previous: shown(1) })).toEqual(shown(1));
      expect(layout(358, { previous: shown(1) })).toEqual(shown(0));
    });

    test("with no slack for everything, it restores only what fits and then holds", () => {
      const partly = layout(357, { previous: shown(2) });
      expect(partly).toEqual(shown(1));
      expect(layout(357, { previous: partly })).toEqual(partly);
      expect(layout(358, { previous: partly })).toEqual(shown(0));
    });

    test("sub-pixel jitter in the picker's measured width settles instead of flip-flopping", () => {
      let current = shown(0);
      const seen = new Set<string>();
      for (let i = 0; i < 12; i++) {
        current = layout(357, { naturalFixedWidth: i % 2 ? 149.5 : 149, previous: current });
        if (i >= 2) seen.add(`${current.hiddenCount}/${current.visible}`);
      }
      expect(seen.size).toBe(1);
    });
  });
});

describe("shouldUseRestingPromptLayout", () => {
  const settled = {
    isExistingThread: true,
    timelineOverflows: true,
    isScrollCollapsed: true,
    hasMultilinePrompt: false,
    hasExpandedChrome: false,
  };

  test("an existing thread whose timeline is scrolled uses the resting layout", () => {
    expect(shouldUseRestingPromptLayout(settled)).toBe(true);
  });

  test.each([
    ["a new thread", { isExistingThread: false }],
    ["a timeline that still fits", { timelineOverflows: false }],
    ["a timeline not yet scrolled", { isScrollCollapsed: false }],
    ["drawers or composer menus open", { hasExpandedChrome: true }],
    ["a multiline draft", { hasMultilinePrompt: true }],
    ["a multiline draft, not scrolled", { hasMultilinePrompt: true, isScrollCollapsed: false }],
  ])("stays expanded for %s", (_label, over) => {
    expect(shouldUseRestingPromptLayout({ ...settled, ...over })).toBe(false);
  });
});

describe("transcript inset", () => {
  test("resting: at least the overlay plus the minimum expansion, never shrinking below a known larger value", () => {
    expect(
      resolvePromptTranscriptInset({ currentInset: 0, overlayHeight: 60, isResting: true }),
    ).toBe(60 + PROMPT_RESTING_EXPANSION_MIN_PX);
    expect(
      resolvePromptTranscriptInset({ currentInset: 200, overlayHeight: 60, isResting: true }),
    ).toBe(200);
  });

  test("expanded: follows the overlay exactly", () => {
    expect(
      resolvePromptTranscriptInset({ currentInset: 160, overlayHeight: 140, isResting: false }),
    ).toBe(140);
  });

  test("a thread switch re-measures the unchanged composer rather than zeroing the inset", () => {
    expect(
      resetPromptTranscriptInset({ currentInset: 176, overlayHeight: 176, isResting: false }),
    ).toBe(176);
  });

  test("a thread switch drops the previous thread's resting ratchet", () => {
    expect(
      resetPromptTranscriptInset({ currentInset: 400, overlayHeight: 60, isResting: true }),
    ).toBe(60 + PROMPT_RESTING_EXPANSION_MIN_PX);
  });

  test("an unmeasurable composer keeps the known inset", () => {
    expect(
      resetPromptTranscriptInset({ currentInset: 176, overlayHeight: 0, isResting: false }),
    ).toBe(176);
  });
});

describe("compact footer breakpoints", () => {
  test("wide action sets go compact below their (higher) breakpoint, in both helpers", () => {
    for (const fn of [shouldUseCompactPromptFooter, shouldUseCompactPromptPrimaryActions]) {
      expect(fn(WIDE - 1, { hasWideActions: true })).toBe(true);
      expect(fn(WIDE, { hasWideActions: true })).toBe(false);
    }
  });

  test("the plain footer goes compact only below its own breakpoint", () => {
    expect(shouldUseCompactPromptFooter(NARROW - 1)).toBe(true);
    expect(shouldUseCompactPromptFooter(NARROW)).toBe(false);
    expect(shouldUseCompactPromptFooter(NARROW + 48)).toBe(false);
  });

  test("an unmeasured width stays expanded", () => {
    expect(shouldUseCompactPromptFooter(null)).toBe(false);
  });
});
