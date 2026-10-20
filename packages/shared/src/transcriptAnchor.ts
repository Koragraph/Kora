export const CHAT_LIST_ANCHOR_OFFSET = 16;

export interface ChatListAnchoredEndSpace {
  readonly anchorOffset: number;
  readonly anchorIndex: number;
}

export type ChatListAnchorOptions = { readonly anchorOffset?: number };

/**
 * Walks the items for the first one that carries an anchor id. That item decides the
 * result: it either is the requested anchor (an end space is reserved) or it is not (none).
 */
type AnchorOf<Item, AnchorId> = (item: Item) => AnchorId | null;

export function resolveChatListAnchoredEndSpace<Item, AnchorId>(
  list: ReadonlyArray<Item>,
  wanted: AnchorId | null,
  anchorOf: AnchorOf<Item, AnchorId>,
  { anchorOffset = CHAT_LIST_ANCHOR_OFFSET }: ChatListAnchorOptions = {},
): ChatListAnchoredEndSpace | undefined {
  if (wanted === null) return undefined;
  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index];
    if (entry === undefined) continue;
    const id = anchorOf(entry);
    if (id === null) continue;
    return id === wanted ? { anchorOffset, anchorIndex: index } : undefined;
  }
  return undefined;
}
