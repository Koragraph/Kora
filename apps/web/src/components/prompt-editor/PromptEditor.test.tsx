import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $copyNode,
  $getRoot,
  $isElementNode,
  KEY_ARROW_LEFT_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_ENTER_COMMAND,
  PASTE_COMMAND,
  type LexicalEditor,
} from "lexical";
import { act, createRef } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { collapseExpandedPromptCursor } from "~/prompt-logic";
import { FileChipNode } from "./chips";
import { $selectRange } from "./offsets";
import { PromptEditor, type PromptCommandKey, type PromptEditorHandle } from "./PromptEditor";
import { FakeClipboardEvent } from "./testEditor";

vi.mock("../thread/FileTagChip", () => ({
  FileTagBody: () => null,
  FILE_TAG_CHIP_CLASS_NAME: "",
}));
vi.mock("../thread/ReplyFootnoteChip", () => ({ ReplyFootnoteChip: () => null }));

// The real composer, nodes, listeners and handle; only the contenteditable view is left out, so Lexical runs
// headless and the test drives it through commands.
let editor: LexicalEditor;
vi.mock("@lexical/react/LexicalPlainTextPlugin", () => ({
  PlainTextPlugin: function Headless() {
    [editor] = useLexicalComposerContext();
    return null;
  },
}));

const handle = createRef<PromptEditorHandle>();
let view: ReactTestRenderer | undefined;
let changes: Array<{ value: string; cursor: number; besideChip: boolean }> = [];
let commandKeys: (key: PromptCommandKey) => boolean = () => false;

const composer = (value: string, cursor = collapseExpandedPromptCursor(value, value.length)) => (
  <PromptEditor
    value={value}
    cursor={cursor}
    contextRecords={new Map()}
    skills={[]}
    disabled={false}
    placeholder="Ask anything"
    editorRef={handle}
    onPaste={() => {}}
    onCommandKeyDown={(key) => commandKeys(key)}
    onChange={(value, cursor, _expanded, besideChip) => changes.push({ value, cursor, besideChip })}
  />
);
async function show(value: string, cursor?: number) {
  await act(() => {
    if (view) view.update(composer(value, cursor));
    else view = create(composer(value, cursor));
  });
}
const snapshot = () => handle.current!.readSnapshot();
const firstNode = () =>
  editor.getEditorState().read(() => {
    const paragraph = $getRoot().getFirstChildOrThrow();
    if (!$isElementNode(paragraph)) throw new Error("no paragraph");
    return paragraph.getFirstChildOrThrow();
  });
/** Runs a command the way a key press would (inside an update). */
const press = (run: () => void) => act(() => editor.update(run, { discrete: true }));
const key = (k: string) => ({ key: k, preventDefault() {}, stopPropagation() {} }) as KeyboardEvent;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", { activeElement: null });
  changes = [];
  commandKeys = () => false;
});
afterEach(async () => {
  await act(() => view?.unmount());
  view = undefined;
  vi.unstubAllGlobals();
});

describe("what the editor shows is the prompt, byte for byte", () => {
  it.each([
    "@README.md control",
    '@"docs/My \\"File\\".md" please',
    '@"docs/雪 👋.md" please',
    "[README.md](README.md) control",
    "[config#draft?.json](config%23draft%3f.json) control",
    "@terminal-1:3 Explain this output\n\n<terminal_context>\n- Terminal 1 line 3:\n  3 | output\n</terminal_context>",
    "Plain text\n  Keep indentation 👋",
  ])("%j", async (prompt) => {
    await show(prompt);
    expect(snapshot().value).toBe(prompt);
  });

  it("follows each new controlled value, chips included, caret at the end", async () => {
    for (const prompt of ["", "@README.md go", "plain again", "@README.md go"]) {
      await show(prompt);
      expect(snapshot()).toMatchObject({ value: prompt, expandedCursor: prompt.length });
    }
    expect(firstNode()).toBeInstanceOf(FileChipNode);
  });

  it("a file chip keeps the exact text it was written as, through a copy of the node and a JSON reload", async () => {
    const prompt = '@"docs/雪 👋.md" stays a chip';
    await show(prompt);
    const before = firstNode().getKey();
    await press(() => {
      const chip = $getRoot()
        .getFirstChildOrThrow<import("lexical").ElementNode>()
        .getFirstChildOrThrow();
      chip.replace($copyNode(chip));
    });
    expect(firstNode().getKey()).not.toBe(before);
    expect(snapshot().value).toBe(prompt);
    const saved = editor.getEditorState().toJSON();
    await show("");
    await act(() => editor.setEditorState(editor.parseEditorState(saved)));
    expect(snapshot().value).toBe(prompt);
    expect(firstNode()).toBeInstanceOf(FileChipNode);
  });

  it("JSON from an older build without `source` reads back as the canonical link", async () => {
    await show("");
    const json = {
      root: {
        type: "root",
        version: 1,
        children: [
          {
            type: "paragraph",
            version: 1,
            children: [{ type: "prompt-file", version: 1, path: "README.md" }],
          },
        ],
      },
    };
    await act(() => editor.setEditorState(editor.parseEditorState(JSON.stringify(json))));
    expect(snapshot().value).toBe("[README.md](README.md)");
  });

  it("a pasted @file becomes a chip written as a canonical link", async () => {
    vi.stubGlobal("ClipboardEvent", FakeClipboardEvent);
    await show("");
    const event = new FakeClipboardEvent("@README.md ");
    await press(() => {
      $getRoot().selectEnd();
      editor.dispatchCommand(PASTE_COMMAND, event as unknown as ClipboardEvent);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(snapshot().value).toBe("[README.md](README.md) ");
    expect(firstNode().isInline()).toBe(true);
  });
});

describe("keys", () => {
  it("Backspace right after a chip removes all of it and reports the change", async () => {
    await show("@a.ts x", collapseExpandedPromptCursor("@a.ts x", "@a.ts ".length) - 1);
    await press(() => {
      $getRoot().getFirstChildOrThrow<import("lexical").ElementNode>().select(1, 1);
      editor.dispatchCommand(KEY_BACKSPACE_COMMAND, key("Backspace"));
    });
    expect(snapshot().value).toBe(" x");
    expect(changes.at(-1)).toMatchObject({ value: " x", cursor: 0 });
  });

  it("Left steps over a chip in one press: the chip counts as one place", async () => {
    // "ab " + chip + " x": just after the chip is collapsed offset 4.
    await show("ab @c.ts x");
    // The key handler reads the committed state, as a real key press (outside any update) would see it.
    await press(() => $selectRange(4));
    await press(() => void editor.dispatchCommand(KEY_ARROW_LEFT_COMMAND, key("ArrowLeft")));
    expect(snapshot()).toMatchObject({ cursor: 3, expandedCursor: 3 });
  });

  it("Enter goes to the composer first; it sends, and the editor adds no line", async () => {
    const seen: PromptCommandKey[] = [];
    commandKeys = (k) => {
      seen.push(k);
      return true;
    };
    await show("hello");
    await press(() => void editor.dispatchCommand(KEY_ENTER_COMMAND, key("Enter")));
    expect(seen).toEqual(["Enter"]);
    expect(snapshot().value).toBe("hello");
  });

  it("an Enter that ends an IME composition is the IME's, never a send", async () => {
    const seen: PromptCommandKey[] = [];
    commandKeys = (k) => (seen.push(k), true);
    await show("こんにちは");
    const composing = { ...key("Enter"), isComposing: true } as KeyboardEvent;
    await press(() => void editor.dispatchCommand(KEY_ENTER_COMMAND, composing));
    expect(seen).toEqual([]);
  });
});
