// Layout decisions for the composer footer and its resting (collapsed single-row) state. No UI.

export const PROMPT_FOOTER_COMPACT_BREAKPOINT_PX = 620;
export const PROMPT_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX = 780;
/** How much taller the empty expanded composer is than the resting row. */
export const PROMPT_RESTING_EXPANSION_MIN_PX = 94;

type FooterWidthOptions = { hasWideActions?: boolean };

export function shouldUseCompactPromptFooter(
  width: number | null,
  options?: FooterWidthOptions,
): boolean {
  if (width === null) return false;
  const breakpoint = options?.hasWideActions
    ? PROMPT_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX
    : PROMPT_FOOTER_COMPACT_BREAKPOINT_PX;
  return width < breakpoint;
}

export function shouldUseCompactPromptPrimaryActions(
  available: number | null,
  settings?: FooterWidthOptions,
): boolean {
  if (settings?.hasWideActions !== true || available === null) return false;
  return available < PROMPT_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX;
}

/**
 * Only a timeline scroll rests the composer: an existing thread whose content overflows, scrolled by the user,
 * with a single-line draft and no expanded chrome (banners, tasks badge).
 */
export function shouldUseRestingPromptLayout(input: {
  hasMultilinePrompt: boolean;
  timelineOverflows: boolean;
  isScrollCollapsed: boolean;
  hasExpandedChrome: boolean;
  isExistingThread: boolean;
}): boolean {
  const quietComposer = !input.hasMultilinePrompt && !input.hasExpandedChrome;
  return (
    quietComposer && input.isExistingThread && input.timelineOverflows && input.isScrollCollapsed
  );
}

export function resolvePromptTranscriptInset(input: {
  overlayHeight: number;
  currentInset: number;
  isResting: boolean;
}): number {
  // A resting measurement must keep room for the later expansion; an expanded one is authoritative.
  return input.isResting
    ? Math.max(input.currentInset, input.overlayHeight + PROMPT_RESTING_EXPANSION_MIN_PX)
    : input.overlayHeight;
}

/**
 * The inset after a thread switch. The composer stays mounted at the same size, so its ResizeObserver stays quiet:
 * zeroing the inset would leave the transcript's end (the message just sent, the live reply) under the composer until
 * it next resized. Re-measure from the live overlay instead; an unmeasurable (hidden) overlay keeps what is known.
 */
export function resetPromptTranscriptInset(input: {
  overlayHeight: number;
  currentInset: number;
  isResting: boolean;
}): number {
  if (input.overlayHeight <= 0) return input.currentInset;
  return resolvePromptTranscriptInset({ ...input, currentInset: 0 });
}

export interface RestingPromptControlsMeasurement {
  blockWidths: readonly number[];
  naturalFixedWidth: number;
  minimumFixedWidth: number;
  overflowWidth: number;
  gap: number;
}

function clusterWidth(
  m: RestingPromptControlsMeasurement,
  fixedWidth: number,
  hiddenCount: number,
): number {
  const shown = m.blockWidths.slice(0, m.blockWidths.length - hiddenCount);
  const blocksWidth = shown.reduce((sum, width) => sum + width, 0);
  const overflow = hiddenCount > 0 ? m.overflowWidth : 0;
  const items = shown.length + (hiddenCount > 0 ? 1 : 0);
  return fixedWidth + blocksWidth + overflow + m.gap * items;
}

export function resolveRestingPromptControlsLayout(
  input: RestingPromptControlsMeasurement & {
    hostWidth: number;
    previous?: { hiddenCount: number; visible: boolean };
  },
): { hiddenCount: number; visible: boolean } {
  const count = input.blockWidths.length;
  // The picker's natural width comes from an integral scrollWidth against a fractional box, so a layout that
  // is already settled needs 1px of slack before it may flip back; otherwise a threshold width oscillates.
  const slack = (settled: boolean) => (settled ? input.hostWidth - 1 : input.hostWidth);

  let hiddenCount = 0;
  while (hiddenCount < count) {
    const limit = slack(input.previous !== undefined && hiddenCount < input.previous.hiddenCount);
    if (clusterWidth(input, input.naturalFixedWidth, hiddenCount) <= limit) break;
    hiddenCount += 1;
  }

  const visibleLimit = slack(input.previous !== undefined && !input.previous.visible);
  const visible = clusterWidth(input, input.minimumFixedWidth, hiddenCount) <= visibleLimit;
  return { hiddenCount, visible };
}

export function resolveScrollToEndClearance(input: {
  attachments: ReadonlyArray<{ top: number; left: number; right: number }>;
  button: { left: number; right: number };
  mainSurfaceTop: number;
  overlayHeight: number;
}): number {
  const { button, attachments, mainSurfaceTop } = input;
  const overlapsButton = (box: { left: number; right: number }) =>
    box.left < button.right && box.right > button.left;
  const contentTop = Math.min(mainSurfaceTop, ...attachments.map((box) => box.top));
  const overlappingTops = attachments.filter(overlapsButton).map((box) => box.top);
  const top = Math.min(mainSurfaceTop, ...overlappingTops);
  return Math.ceil(input.overlayHeight - (top - contentTop));
}
