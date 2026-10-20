export function resolvePromptMenuActiveItemId(input: {
  items: ReadonlyArray<{ id: string }>;
  highlightedSearchKey: string | null;
  highlightedItemId: string | null;
  currentSearchKey: string | null;
}): string | null {
  const { items, highlightedItemId } = input;
  const first = items[0];
  if (first === undefined) {
    return null;
  }
  const searchUnchanged = input.currentSearchKey === input.highlightedSearchKey;
  const stillListed = highlightedItemId
    ? items.some((item) => item.id === highlightedItemId)
    : false;
  if (searchUnchanged && highlightedItemId && stillListed) {
    return highlightedItemId;
  }
  return first.id ?? null;
}
