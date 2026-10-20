type AnchorRow = { readonly id: string };

type ScrollAnchorState = {
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly scroll: number;
  readonly data: ReadonlyArray<AnchorRow>;
};

const usableTop = (top: number | undefined): top is number =>
  top !== undefined && Number.isFinite(top);

/** Save the row at the current offset; a virtualizer's cached visible range can lag a fling. */
export function resolveWorkGroupScrollAnchor(state: ScrollAnchorState) {
  const { data, positionAtIndex } = state;
  if (!data.length || !Number.isFinite(state.scroll)) return undefined;
  const scrollOffset = Math.max(0, state.scroll);
  const firstTop = positionAtIndex(0);
  if (!usableTop(firstTop)) return undefined;

  // Binary search for the last row whose top is at or before the offset.
  let anchorIndex = 0;
  let anchorTop = firstTop;
  let lo = 0;
  let hi = data.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const top = positionAtIndex(mid);
    if (!usableTop(top)) return undefined;
    if (top > scrollOffset) {
      hi = mid - 1;
      continue;
    }
    anchorIndex = mid;
    anchorTop = top;
    lo = mid + 1;
  }

  return {
    scrollOffset,
    offsetWithinRow: Math.max(0, scrollOffset - anchorTop),
    rowId: data[anchorIndex]!.id,
  };
}
