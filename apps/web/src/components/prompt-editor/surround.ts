/**
 * Typing an opening bracket or quote over selected text wraps the selection instead of replacing it:
 * select `foo`, type `(`, get `(foo)` with `foo` still selected.
 *
 * The selection is noted on keydown, because by the time `beforeinput` fires some keys have already changed it.
 * A backtick on layouts where it is a dead key arrives as a composition: the browser has already replaced the
 * selection with "`" when it ends, so that case is repaired afterwards (the "`" is swapped for "`foo`").
 */
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  HISTORY_MERGE_TAG,
  type LexicalEditor,
} from "lexical";

import { selectionTouchesMentionBoundary } from "~/prompt-editor-mentions";
import { collapseExpandedPromptCursor } from "~/prompt-logic";
import type { SkillChipDetails } from "./chips";
import { $selectRange, $writePrompt, expandedRangeOf, selectionHasChip } from "./offsets";

const CLOSING = new Map<string, string>([
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
  ["<", ">"],
  ["«", "»"],
  ["“", "”"],
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["*", "*"],
  ["_", "_"],
]);

/** The prompt and the selected span in it (expanded offsets). */
type Snapshot = { value: string; start: number; end: number };

/** The current selection if it can be wrapped: a real span of plain text, no chip in it or cut by it. */
function $wrappableSelection(): Snapshot | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || selection.isCollapsed() || selectionHasChip(selection))
    return null;
  const range = expandedRangeOf(selection);
  if (!range || range.start === range.end) return null;
  const value = $getRoot().getTextContent();
  return selectionTouchesMentionBoundary(value, range.start, range.end)
    ? null
    : { value, ...range };
}

export function registerSurroundSelection(
  editor: LexicalEditor,
  skills: () => ReadonlyMap<string, SkillChipDetails>,
): () => void {
  /** The selection seen at the last keydown. */
  let noted: Snapshot | null = null;
  /** Set while a dead-key backtick composition is running over `noted`. */
  let deadKey: Snapshot | null = null;
  const forget = () => {
    noted = null;
    deadKey = null;
  };

  const wrap = (open: string): boolean => {
    const close = CLOSING.get(open);
    if (!close) {
      noted = null;
      return false;
    }
    let wrapped = false;
    editor.update(() => {
      const span = noted ?? $wrappableSelection();
      if (!span) return;
      const inner = span.value.slice(span.start, span.end);
      const next =
        span.value.slice(0, span.start) + open + inner + close + span.value.slice(span.end);
      $writePrompt(next, skills());
      const innerStart = collapseExpandedPromptCursor(next, span.start) + open.length;
      $selectRange(innerStart, innerStart + inner.length);
      noted = null;
      wrapped = true;
    });
    return wrapped;
  };

  /** After a dead-key backtick replaced the selection with "`": put the text back inside backticks. */
  const repairDeadKeyBacktick = (lastChance: boolean) =>
    queueMicrotask(() =>
      editor.update(
        () => {
          const span = deadKey;
          if (!span) return;
          const now = $getRoot().getTextContent();
          if (now !== span.value.slice(0, span.start) + "`" + span.value.slice(span.end)) {
            if (lastChance) forget();
            return; // the composition has not landed yet
          }
          const inner = span.value.slice(span.start, span.end);
          const tick = collapseExpandedPromptCursor(now, span.start);
          $selectRange(tick, tick + 1);
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertText(`\`${inner}\``);
            $selectRange(tick + 1, tick + 1 + inner.length);
          }
          forget();
        },
        { tag: HISTORY_MERGE_TAG },
      ),
    );

  const onKeyDown = (event: KeyboardEvent) => {
    if (deadKey) {
      // The dead key itself, or the space that commits it, belongs to the running composition.
      if (event.key === "Dead" || event.key === " " || event.code === "Space") return;
      deadKey = null;
    }
    if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey) {
      forget();
      return;
    }
    noted = editor.getEditorState().read($wrappableSelection);
    deadKey = null;
  };

  const onBeforeInput = (event: InputEvent) => {
    if (event.inputType === "insertCompositionText") {
      if (event.data === "`" && noted && !deadKey) deadKey = noted;
      return;
    }
    if (deadKey) return;
    const typed = event.inputType === "insertText" ? event.data : null;
    if (typeof event.data !== "string" || !typed || typed.length !== 1) {
      noted = null;
      return;
    }
    if (!wrap(typed)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };

  const onInput = (event: Event) => {
    const { inputType } = event as InputEvent;
    if (inputType === "insertText" || inputType === "insertCompositionText")
      repairDeadKeyBacktick(false);
  };
  const onCompositionEnd = () => repairDeadKeyBacktick(true);

  const listen = (root: HTMLElement | null, on: boolean) => {
    if (!root) return;
    const method = on ? root.addEventListener.bind(root) : root.removeEventListener.bind(root);
    method("keydown", onKeyDown as EventListener);
    method("beforeinput", onBeforeInput as EventListener, true);
    method("input", onInput);
    method("compositionend", onCompositionEnd);
  };
  let attached: HTMLElement | null = null;
  const stopRootListener = editor.registerRootListener((root, previous) => {
    listen(previous, false);
    listen(root, true);
    attached = root;
  });
  return () => {
    listen(attached, false);
    stopRootListener();
  };
}
