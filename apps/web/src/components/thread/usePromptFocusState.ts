import { useCallback, useState } from "react";

/** Focus and scroll-collapse state of the composer. */
export function usePromptFocusState() {
  const [focused, setFocused] = useState(false);
  const [scrollCollapsed, setScrollCollapsed] = useState(false);

  // Reaching the end of the timeline lifts a scroll collapse without moving
  // DOM focus to the editor.
  const restoreAtTimelineEnd = useCallback(() => setScrollCollapsed(false), []);

  return {
    restoreAtTimelineEnd,
    isComposerScrollCollapsed: scrollCollapsed,
    setIsComposerScrollCollapsed: setScrollCollapsed,
    isComposerFocused: focused,
    setIsComposerFocused: setFocused,
  };
}
