/** Keys the prompt editor handles itself, on top of Lexical's plain-text behaviour. */
import {
  $createRangeSelectionFromDom,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  COMMAND_PRIORITY_HIGH,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DOWN_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  type LexicalCommand,
  type LexicalEditor,
} from "lexical";

import { isCollapsedCursorAdjacentToInlineToken } from "~/prompt-logic";
import { isMacPlatform } from "~/util/utils";
import { isChipNode } from "./inlineChip";
import { $caretOffset, $promptLength, $selectRange, offsetOfPoint } from "./offsets";
import { unregisterAll } from "./unregister";

export type PromptCommandKey = "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Escape";
/** The composer's handler for a command key; true when it took the key (menus, history, send). */
export type CommandKeyHandler = (key: PromptCommandKey, event: KeyboardEvent) => boolean;

const COMMAND_KEYS: ReadonlyArray<[LexicalCommand<KeyboardEvent | null>, PromptCommandKey]> = [
  [KEY_ENTER_COMMAND, "Enter"],
  [KEY_TAB_COMMAND, "Tab"],
  [KEY_ARROW_UP_COMMAND, "ArrowUp"],
  [KEY_ARROW_DOWN_COMMAND, "ArrowDown"],
  // Escape closes an open composer menu (slash commands, mentions) and keeps the text.
  [KEY_ESCAPE_COMMAND, "Escape"],
];

/** Offers Enter, Tab, the vertical arrows and Escape to the composer before the editor acts on them. */
export function registerCommandKeys(
  editor: LexicalEditor,
  handler: () => CommandKeyHandler | undefined,
): () => void {
  const offer = (key: PromptCommandKey, event: KeyboardEvent | null): boolean => {
    const onKey = handler();
    if (!onKey || !event) return false;
    // Enter that confirms an IME composition belongs to the IME, never to send.
    if (key === "Enter" && (event.isComposing || event.keyCode === 229)) {
      event.stopPropagation();
      return true;
    }
    if (!onKey(key, event)) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  };
  return unregisterAll(
    ...COMMAND_KEYS.map(([command, key]) =>
      editor.registerCommand(command, (event) => offer(key, event), COMMAND_PRIORITY_HIGH),
    ),
  );
}

/** Left and right arrows step over a chip in one press (the caret never stops inside its link text). */
export function registerChipStepping(editor: LexicalEditor): () => void {
  const step = (direction: "left" | "right", event: KeyboardEvent | null): boolean => {
    const target = editor.getEditorState().read(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
      const caret = $caretOffset("collapsed", 0);
      const atEdge = direction === "left" ? caret <= 0 : caret >= $promptLength();
      if (atEdge) return null;
      const prompt = $getRoot().getTextContent();
      if (!isCollapsedCursorAdjacentToInlineToken(prompt, caret, direction)) return null;
      return direction === "left" ? caret - 1 : caret + 1;
    });
    if (target === null) return false;
    event?.preventDefault();
    event?.stopPropagation();
    editor.update(() => $selectRange(target));
    return true;
  };
  return unregisterAll(
    editor.registerCommand(KEY_ARROW_LEFT_COMMAND, (e) => step("left", e), COMMAND_PRIORITY_HIGH),
    editor.registerCommand(KEY_ARROW_RIGHT_COMMAND, (e) => step("right", e), COMMAND_PRIORITY_HIGH),
  );
}

/**
 * On macOS, Home and End go to the start and end of the visual line (as in every Mac text field) instead of
 * scrolling; with Shift they extend the selection. Uses the browser's own line-boundary movement.
 */
export function registerMacLineEnds(editor: LexicalEditor): () => void {
  return editor.registerCommand(
    KEY_DOWN_COMMAND,
    (event) => {
      if (event.key !== "Home" && event.key !== "End") return false;
      if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return false;
      if (!isMacPlatform(navigator.platform)) return false;
      const root = editor.getRootElement();
      const dom = window.getSelection();
      const inEditor = root && dom?.anchorNode && root.contains(dom.anchorNode);
      if (!inEditor || dom.rangeCount === 0 || typeof dom.modify !== "function") return false;
      event.preventDefault();
      event.stopPropagation();
      dom.modify(
        event.shiftKey ? "extend" : "move",
        event.key === "Home" ? "backward" : "forward",
        "lineboundary",
      );
      editor.update(() => $setSelection($createRangeSelectionFromDom(dom, editor)));
      return true;
    },
    COMMAND_PRIORITY_HIGH,
  );
}

/** A caret that lands inside a chip (a click on it, say) is moved to just after the chip. */
export function registerCaretOffChips(editor: LexicalEditor): () => void {
  return editor.registerUpdateListener(({ editorState }) => {
    const after = editorState.read(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
      const { anchor } = selection;
      const node = anchor.getNode();
      return isChipNode(node) && anchor.offset !== 0
        ? offsetOfPoint(node, 0, "collapsed") + 1
        : null;
    });
    if (after !== null) queueMicrotask(() => editor.update(() => $selectRange(after)));
  });
}

/** Backspace right after a chip removes the whole chip. */
export function registerChipBackspace(editor: LexicalEditor): () => void {
  return editor.registerCommand(
    KEY_BACKSPACE_COMMAND,
    (event) => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
      const { anchor } = selection;
      const at = anchor.getNode();
      // The chip just before the caret, if there is one.
      let before: unknown = null;
      if (isChipNode(at)) before = at;
      else if ($isTextNode(at)) {
        if (anchor.offset > 0) return false;
        before = at.getPreviousSibling();
        if (!isChipNode(before)) {
          const parent = at.getParent();
          const index = at.getIndexWithinParent();
          before = $isElementNode(parent) && index > 0 ? parent.getChildAtIndex(index - 1) : null;
        }
      } else if ($isElementNode(at) && anchor.offset > 0) {
        before = at.getChildAtIndex(anchor.offset - 1);
      }
      if (!isChipNode(before)) return false;
      const start = offsetOfPoint(before, 0, "collapsed");
      before.remove();
      $selectRange(start);
      event?.preventDefault();
      return true;
    },
    COMMAND_PRIORITY_HIGH,
  );
}
