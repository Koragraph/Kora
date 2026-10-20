/**
 * Clipboard in the prompt editor.
 *
 * Paste: tokens in pasted text (file links, citations, context links) become chips, and a structured fragment on
 * the clipboard (copied from another prompt) brings its context records along. Copy and cut: a selection with
 * context chips also writes that fragment, so pasting elsewhere keeps what the chips point at.
 */
import type { ContextChipClipboardFragment } from "@kora/contracts";
import { ContextChipId } from "@kora/contracts";
import {
  CONTEXT_CHIP_CLIPBOARD_MIME,
  decodeContextChipClipboardHtml,
  decodeContextChipFragment,
  encodeContextChipClipboardHtml,
} from "@kora/shared/contextChipClipboard";
import {
  collectContextChipReferences,
  formatContextChipReference,
  replaceContextChipReferences,
} from "@kora/shared/contextChipReferences";
import { $createLineBreakNode, $createTextNode, $getRoot, COMMAND_PRIORITY_HIGH } from "lexical";
import {
  $getSelection,
  $isRangeSelection,
  COPY_COMMAND,
  CUT_COMMAND,
  PASTE_COMMAND,
} from "lexical";
import type { LexicalEditor, LexicalNode } from "lexical";

import { collectPromptEditorInlineTokens } from "~/prompt-editor-mentions";
import { collectInlineContextIds } from "~/util/contextChipReferences";
import { $createFileChipNode } from "./chips";
import { $createCitationChipNode } from "./citationChip";
import { $createContextRefChipNode } from "./contextRefChip";
import { offsetOfPoint } from "./offsets";
import { unregisterAll } from "./unregister";

/** Imports a fragment's records into the draft; returns the ids that had to change (a re-attached file gets a new one). */
export type ImportContextFragment = (
  fragment: ContextChipClipboardFragment,
) => ReadonlyMap<string, string>;
/** The structured fragment for these context ids, or null to copy plain text only. */
export type BuildContextFragment = (contextIds: ReadonlyArray<string>) => string | null;

/** The fragment on the clipboard, cut down to the records whose links are in the pasted text. */
export function readPastedContextChip(
  clipboard: Pick<DataTransfer, "getData">,
): ContextChipClipboardFragment | null {
  const fragment =
    decodeContextChipFragment(clipboard.getData(CONTEXT_CHIP_CLIPBOARD_MIME)) ??
    decodeContextChipClipboardHtml(clipboard.getData("text/html"));
  if (fragment === null) return null;
  // A fragment built for a bigger copy may carry more; those must not start transfers.
  const linked = new Set<string>(
    collectContextChipReferences(clipboard.getData("text/plain")).map((ref) => ref.contextId),
  );
  return {
    ...fragment,
    records: fragment.records.filter((record) => linked.has(record.contextId)),
  };
}

/**
 * The pasted text, after importing its fragment's records: links to records that got new ids are rewritten to
 * them. Used both by a paste into the editor and by a paste that focuses the composer first.
 */
export function importPastedPromptText(
  clipboard: Pick<DataTransfer, "getData">,
  importFragment?: ImportContextFragment,
): string {
  const text = clipboard.getData("text/plain");
  const fragment = importFragment ? readPastedContextChip(clipboard) : null;
  const renamed = fragment && fragment.records.length > 0 ? importFragment!(fragment) : null;
  if (!renamed || renamed.size === 0) return text;
  return replaceContextChipReferences(text, (ref) => {
    const newId = renamed.get(ref.contextId);
    if (!newId) return ref.source;
    // Pasted element annotations come back as preview annotations.
    const kind = ref.kind === "element" ? "preview-annotation" : ref.kind;
    return formatContextChipReference({ ...ref, kind, contextId: ContextChipId.make(newId) });
  });
}

/** Text with line breaks as nodes (the editor's paragraph keeps "\n" as line-break nodes). */
function plainTextNodes(text: string): LexicalNode[] {
  return text.split("\n").flatMap((line, index) => {
    const nodes: LexicalNode[] = index > 0 ? [$createLineBreakNode()] : [];
    if (line !== "") nodes.push($createTextNode(line));
    return nodes;
  });
}

/** Turns pasted text that contains tokens into chips. Plain text is left to the default paste. */
export function registerChipPaste(
  editor: LexicalEditor,
  importFragment?: ImportContextFragment,
): () => void {
  return editor.registerCommand(
    PASTE_COMMAND,
    (event) => {
      if (!(event instanceof ClipboardEvent) || !event.clipboardData) return false;
      // Files are the attachment handler's; empty text is nothing to do.
      if (event.clipboardData.files.length > 0 || event.clipboardData.getData("text/plain") === "")
        return false;
      const text = importPastedPromptText(event.clipboardData, importFragment);
      // The token grammar wants whitespace after a token; a newline on the end lets a final one parse.
      const tokens = collectPromptEditorInlineTokens(`${text}\n`).filter(
        (t) =>
          (t.type === "mention" || t.type === "citation" || t.type === "context-reference") &&
          t.end <= text.length,
      );
      if (tokens.length === 0) return false;

      // Command listeners already run inside an update, so insert here directly (a nested update would run after
      // the default plain-text paste).
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return false;
      const nodes: LexicalNode[] = [];

      // A file chip pasted straight after a word gets a space between them.
      const first = tokens[0]!;
      if (first.type === "mention" && first.start === 0) {
        const start = selection.isBackward() ? selection.focus : selection.anchor;
        const at = offsetOfPoint(start.getNode(), start.offset, "expanded");
        const before = $getRoot()
          .getTextContent()
          .slice(at - 1, at);
        if (before !== "" && !/\s/.test(before)) nodes.push($createTextNode(" "));
      }

      let done = 0;
      for (const token of tokens) {
        if (token.start < done) continue;
        if (token.start > done) nodes.push(...plainTextNodes(text.slice(done, token.start)));
        if (token.type === "citation")
          nodes.push($createCitationChipNode(token.citation, token.source));
        else if (token.type === "context-reference") {
          const { kind, label, contextId } = token;
          nodes.push($createContextRefChipNode({ kind, label, contextId }));
        } else nodes.push($createFileChipNode(token.value));
        done = token.end;
      }
      if (done < text.length) nodes.push(...plainTextNodes(text.slice(done)));
      // A file chip at the very end gets the trailing space autocomplete would add, so the prompt still parses.
      else if (tokens.at(-1)?.type === "mention") nodes.push($createTextNode(" "));

      selection.insertNodes(nodes);
      event.preventDefault();
      return true;
    },
    COMMAND_PRIORITY_HIGH,
  );
}

/** Copy and cut write the context fragment next to the text when the selection holds context chips. */
export function registerChipCopy(
  editor: LexicalEditor,
  buildFragment: BuildContextFragment,
): () => void {
  const onCopy = (event: ClipboardEvent | KeyboardEvent | null, cutting: boolean): boolean => {
    if (!(event && "clipboardData" in event && event.clipboardData)) return false;
    const selection = $getSelection();
    if (!$isRangeSelection(selection) || selection.isCollapsed()) return false;
    const text = selection.getTextContent();
    const ids = collectInlineContextIds(text);
    const fragment = ids.length > 0 ? buildFragment(ids) : null;
    if (!fragment) return false;
    event.preventDefault();
    const { clipboardData } = event;
    clipboardData.setData("text/plain", text);
    clipboardData.setData(CONTEXT_CHIP_CLIPBOARD_MIME, fragment);
    clipboardData.setData("text/html", encodeContextChipClipboardHtml(text, fragment));
    if (cutting) selection.removeText();
    return true;
  };
  return unregisterAll(
    editor.registerCommand(COPY_COMMAND, (event) => onCopy(event, false), COMMAND_PRIORITY_HIGH),
    editor.registerCommand(CUT_COMMAND, (event) => onCopy(event, true), COMMAND_PRIORITY_HIGH),
  );
}
