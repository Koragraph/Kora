import {
  $getSelection,
  $isRangeSelection,
  BLUR_COMMAND,
  COMMAND_PRIORITY_LOW,
  DecoratorNode,
  FOCUS_COMMAND,
  type LexicalEditor,
} from "lexical";

import { unregisterAll } from "./unregister";

const SELECTED = "data-prompt-chip-selected";

/**
 * Chips are non-editable islands, so the browser paints no selection over them: a selection across chips shows only
 * in the gaps between them. This marks every chip inside a selection with an attribute the stylesheet highlights.
 * The marks go while the editor is blurred, along with the native highlight (Lexical keeps its selection on blur
 * without an update, so focus is followed separately).
 */
export function registerChipSelectionHighlight(editor: LexicalEditor): () => void {
  let marked: ReadonlySet<string> = new Set();
  let focused = document.activeElement === editor.getRootElement();

  const chipsInSelection = (): Set<string> => {
    const keys = new Set<string>();
    if (!focused) return keys;
    editor.getEditorState().read(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || selection.isCollapsed()) return;
      for (const node of selection.getNodes())
        if (node instanceof DecoratorNode) keys.add(node.getKey());
    });
    return keys;
  };
  const mark = (next: ReadonlySet<string>) => {
    for (const key of marked)
      if (!next.has(key)) editor.getElementByKey(key)?.removeAttribute(SELECTED);
    for (const key of next) editor.getElementByKey(key)?.setAttribute(SELECTED, "true");
    marked = next;
  };
  const onFocusChange = (isFocused: boolean) => () => {
    focused = isFocused;
    mark(chipsInSelection());
    return false;
  };

  return unregisterAll(
    editor.registerUpdateListener(() => mark(chipsInSelection())),
    editor.registerCommand(FOCUS_COMMAND, onFocusChange(true), COMMAND_PRIORITY_LOW),
    editor.registerCommand(BLUR_COMMAND, onFocusChange(false), COMMAND_PRIORITY_LOW),
  );
}
