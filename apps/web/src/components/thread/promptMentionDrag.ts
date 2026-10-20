/**
 * Drag payload type carrying a serialized composer mention. Set on drags that
 * start in the workspace file tree so the composer can tell them apart from
 * OS file drags and plain text selections.
 */

import { serializePromptFileLink } from "@kora/shared/promptTrigger";

export const PROMPT_MENTION_DRAG_TYPE = "application/x-kora-composer-mention";

export function promptMentionFromTreePath(treePath: string): string | null {
  const trimmed = treePath.replace(/\/+$/, "");
  return trimmed ? serializePromptFileLink(trimmed) : null;
}

export function dataTransferHasPromptMention(types: ReadonlyArray<string>): boolean {
  return types.includes(PROMPT_MENTION_DRAG_TYPE);
}

export interface PromptMentionDragTransfer {
  dropEffect: string;
  getData(format: string): string;
  readonly types: ReadonlyArray<string>;
}

export interface PromptMentionDragEvent {
  preventDefault(): void;
  stopPropagation(): void;
  readonly dataTransfer: PromptMentionDragTransfer;
  readonly nativeEvent: { stopPropagation(): void };
}

/**
 * What a mention drop is allowed to do to the composer. Deliberately narrow:
 * there is no way to focus the editor from here. Focusing it synchronously
 * during the drop makes the not-yet-reconciled editor sync its stale empty
 * state back over the inserted mention; the insert path already focuses on
 * the next frame, after the editor has caught up.
 */
export interface PromptMentionDropHost {
  onInsertRejected(): void;
  setDragActive(active: boolean): void;
  insertMentionAtEnd(text: string): boolean;
}

export interface PromptMentionDragHandlers {
  onDragEnter(event: PromptMentionDragEvent): void;
  onDragOver(event: PromptMentionDragEvent): void;
  onDrop(event: PromptMentionDragEvent): void;
}

export function makePromptMentionDragHandlers(
  host: PromptMentionDropHost,
): PromptMentionDragHandlers {
  // Claim the event for the composer: React's stopPropagation only halts the
  // synthetic dispatch, so the native event must be stopped too or the
  // editor's own DOM listeners still process the drag.
  const claim = (event: PromptMentionDragEvent): boolean => {
    if (!dataTransferHasPromptMention(event.dataTransfer.types)) {
      return false;
    }
    event.nativeEvent.stopPropagation();
    event.stopPropagation();
    event.preventDefault();
    return true;
  };
  return {
    onDragEnter(event) {
      if (claim(event)) host.setDragActive(true);
    },
    onDragOver(event) {
      if (!claim(event)) return;
      // The tree constrains its drags to effectAllowed "move"; naming any
      // other effect makes the browser cancel the drop without firing it.
      host.setDragActive(true);
      event.dataTransfer.dropEffect = "move";
    },
    onDrop(event) {
      if (!claim(event)) return;
      host.setDragActive(false);
      const mention = event.dataTransfer.getData(PROMPT_MENTION_DRAG_TYPE);
      if (!mention) return;
      const inserted = host.insertMentionAtEnd(`${mention} `);
      if (!inserted) host.onInsertRejected();
    },
  };
}
