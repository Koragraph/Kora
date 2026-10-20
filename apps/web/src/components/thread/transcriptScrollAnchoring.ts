/** Matches the titlebar fade inset, so promoting a draft keeps the first row where it was. */

export const CHAT_TRANSCRIPT_ANCHOR_OFFSET = 24;

export type TranscriptScrollMode = "following-end" | "anchoring-new-turn" | "free-scrolling";

export interface TranscriptListMeasurementState {
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly sizeAtIndex: (index: number) => number | undefined;
  readonly data: readonly unknown[];
  readonly scrollLength: number;
  readonly scroll: number;
}

export interface AnchoredTurnMetrics {
  anchorTop: number;
  lastBottom: number;
  turnHeight: number;
  usableViewportHeight: number;
  visibleUsableBottom: number;
  overflowsUsableViewport: boolean;
  targetScrollToRevealEnd: number;
  scrollDeltaToRevealEnd: number;
}

const finite = (value: number | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

export function getRowBottom(state: TranscriptListMeasurementState, index: number): number | null {
  const top = state.positionAtIndex(index);
  const height = state.sizeAtIndex(index);
  if (!finite(top) || !finite(height)) return null;
  return top + Math.max(1, height);
}

export function transcriptContentOverflowsViewport(
  state: TranscriptListMeasurementState | undefined,
  input: { composerInset: number; anchorOffset: number },
): boolean {
  if (!state || state.data.length === 0) return false;
  if (!finite(state.scrollLength) || state.scrollLength <= 0) return false;
  // The list's content length includes the composer spacer, so measure from the last row.
  const lastBottom = getRowBottom(state, state.data.length - 1);
  if (lastBottom === null) return false;
  return lastBottom > Math.max(0, state.scrollLength - input.composerInset - input.anchorOffset);
}

export function getAnchoredTurnMetrics(args: {
  state: TranscriptListMeasurementState;
  anchorIndex: number;
  composerOverlayHeight: number;
  anchorOffset: number;
}): AnchoredTurnMetrics | null {
  const { state } = args;
  const length = state.data.length;
  if (length === 0) return null;
  const anchorIndex = Math.min(Math.max(args.anchorIndex, 0), length - 1);
  const anchorTop = state.positionAtIndex(anchorIndex);
  const lastBottom = getRowBottom(state, length - 1);
  if (!finite(anchorTop) || lastBottom === null) return null;

  const usableViewportHeight = Math.max(
    0,
    state.scrollLength - args.composerOverlayHeight - args.anchorOffset,
  );
  const turnHeight = Math.max(0, lastBottom - anchorTop);
  const targetScrollToRevealEnd = Math.max(0, lastBottom - usableViewportHeight);
  return {
    anchorTop,
    lastBottom,
    turnHeight,
    usableViewportHeight,
    visibleUsableBottom: state.scroll + usableViewportHeight,
    overflowsUsableViewport: turnHeight > usableViewportHeight,
    targetScrollToRevealEnd,
    scrollDeltaToRevealEnd: Math.max(0, targetScrollToRevealEnd - state.scroll),
  };
}
