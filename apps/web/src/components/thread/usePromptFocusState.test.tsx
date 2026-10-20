import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { shouldUseRestingPromptLayout } from "../promptFooterLayout";
import { usePromptFocusState } from "./usePromptFocusState";

type ComposerState = ReturnType<typeof usePromptFocusState>;

let latest: { composer: ComposerState; resting: boolean };
let tree: ReactTestRenderer;

/** Mounts the hook the way ThreadView uses it: an existing thread whose timeline overflows. */
function Composer() {
  const composer = usePromptFocusState();
  useLayoutEffect(() => {
    const resting = shouldUseRestingPromptLayout({
      isExistingThread: true,
      timelineOverflows: true,
      isScrollCollapsed: composer.isComposerScrollCollapsed,
      hasMultilinePrompt: false,
      hasExpandedChrome: false,
    });
    latest = { composer, resting };
  });
  return null;
}

const run = (change: (composer: ComposerState) => void) => act(() => change(latest.composer));

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(() => {
    tree = create(<Composer />);
  });
});

afterEach(async () => {
  await act(() => tree.unmount());
  vi.unstubAllGlobals();
});

describe("usePromptFocusState", () => {
  it("starts unfocused and expanded", () => {
    expect(latest.composer.isComposerFocused).toBe(false);
    expect(latest.composer.isComposerScrollCollapsed).toBe(false);
    expect(latest.resting).toBe(false);
  });

  it("rests while scroll-collapsed and expands again at the timeline end, without taking focus", async () => {
    await run((c) => c.setIsComposerScrollCollapsed(true));
    expect(latest.resting).toBe(true);

    await run((c) => c.restoreAtTimelineEnd());
    expect(latest.resting).toBe(false);
    expect(latest.composer.isComposerFocused).toBe(false);

    // The next scroll away collapses it again.
    await run((c) => c.setIsComposerScrollCollapsed(true));
    expect(latest.resting).toBe(true);
  });

  it("does not collapse just because focus left the editor", async () => {
    await run((c) => c.setIsComposerFocused(true));
    expect(latest.composer.isComposerFocused).toBe(true);
    await run((c) => c.setIsComposerFocused(false));
    expect(latest.resting).toBe(false);
  });

  it("keeps the restore callback stable across renders", async () => {
    const first = latest.composer.restoreAtTimelineEnd;
    await run((c) => c.setIsComposerFocused(true));
    expect(latest.composer.restoreAtTimelineEnd).toBe(first);
  });
});
