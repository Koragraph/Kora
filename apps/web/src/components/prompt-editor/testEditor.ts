/** A headless prompt editor for tests: real chip nodes and paste handling, no React view. */
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isLineBreakNode,
  createEditor,
  PASTE_COMMAND,
  type LexicalEditor,
  type LexicalNode,
} from "lexical";

import { FileChipNode, SkillChipNode } from "./chips";
import { CitationChipNode } from "./citationChip";
import { registerChipPaste, type ImportContextFragment } from "./clipboard";
import { ContextRefChipNode } from "./contextRefChip";

/** A ClipboardEvent stand-in carrying plain text plus any other types (`extra`, keyed by MIME type). */
export class FakeClipboardEvent extends Event {
  readonly clipboardData: DataTransfer;
  constructor(text: string, extra: Readonly<Record<string, string>> = {}) {
    super("paste", { cancelable: true });
    const data = { "text/plain": text, ...extra } as Record<string, string>;
    this.clipboardData = {
      files: [],
      getData: (type: string) => data[type] ?? "",
    } as unknown as DataTransfer;
  }
}

/** An editor holding one paragraph with `text`, caret at the end, chip paste registered. */
export function chipEditor(text = "", importFragment?: ImportContextFragment): LexicalEditor {
  const editor = createEditor({
    nodes: [FileChipNode, SkillChipNode, CitationChipNode, ContextRefChipNode],
    onError: (error) => {
      throw error;
    },
  });
  editor.update(
    () => {
      const paragraph = $createParagraphNode();
      $getRoot().append(paragraph);
      if (text !== "") paragraph.append($createTextNode(text));
      paragraph.selectEnd();
    },
    { discrete: true },
  );
  registerChipPaste(editor, importFragment);
  return editor;
}

/** Dispatches a paste of `text` at the current selection; returns the event (to check defaultPrevented). */
export function paste(
  editor: LexicalEditor,
  text: string,
  extra?: Record<string, string>,
): FakeClipboardEvent {
  const event = new FakeClipboardEvent(text, extra);
  editor.update(
    () => void editor.dispatchCommand(PASTE_COMMAND, event as unknown as ClipboardEvent),
    {
      discrete: true,
    },
  );
  return event;
}

export const promptOf = (editor: LexicalEditor) =>
  editor.getEditorState().read(() => $getRoot().getTextContent());

/** The first paragraph's children. */
export function $line(): LexicalNode[] {
  const paragraph = $getRoot().getFirstChildOrThrow();
  if (!$isElementNode(paragraph)) throw new Error("no paragraph");
  return paragraph.getChildren();
}

/** The paragraph as short labels: `file:path`, `skill:name`, `cite`, `ctx:id`, `\n`, or the text itself. */
export function shapeOf(editor: LexicalEditor): string[] {
  return editor.getEditorState().read(() =>
    $line().map((node) => {
      if (node instanceof FileChipNode) return `file:${node.__path}`;
      if (node instanceof SkillChipNode) return `skill:${node.__name}`;
      if (node instanceof CitationChipNode) return "cite";
      if (node instanceof ContextRefChipNode) return `ctx:${node.getReference().contextId}`;
      if ($isLineBreakNode(node)) return "\n";
      return node.getTextContent();
    }),
  );
}

export const $citations = () =>
  $line().filter((n): n is CitationChipNode => n instanceof CitationChipNode);
