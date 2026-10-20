import { HostId, ItemId, ThreadId, type ReplyFootnote } from "@kora/contracts";
import { serializeReplyFootnote } from "@kora/shared/assistantFootnotes";
import { upgradeLegacyContextMessage } from "@kora/shared/contextChipLegacy";
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  COPY_COMMAND,
  PASTE_COMMAND,
} from "lexical";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { splitPromptIntoPromptSegments } from "~/prompt-editor-mentions";
import { webMarkupContextRecord } from "~/util/contextChipRecords";
import { elementContextToWebMarkup } from "~/util/elementContext";
import { importPastedPromptText, readPastedContextChip, registerChipCopy } from "./clipboard";
import { chipEditor, FakeClipboardEvent, paste, promptOf, shapeOf } from "./testEditor";

vi.mock("../thread/ReplyFootnoteChip", () => ({ ReplyFootnoteChip: () => null }));
vi.mock("../thread/FileTagChip", () => ({
  FileTagBody: () => null,
  FILE_TAG_CHIP_CLASS_NAME: "",
}));

const FRAGMENT_TYPE = "web application/x-kora-context-fragment+json";

const quote: ReplyFootnote = {
  version: 1,
  hostId: HostId.make("local/ünï"),
  threadId: ThreadId.make("t-9"),
  messageId: ItemId.make("m-3"),
  text: "Ship it — but run «pnpm canary» first 🚢",
  start: 0,
  end: 40,
  prefix: "→ ",
  suffix: " ←",
};
const quoteLink = serializeReplyFootnote(quote);

/** A terminal-excerpt record as it travels on the clipboard. */
const terminalRecord = (contextId: string, label = contextId) => ({
  version: 1,
  contextId,
  kind: "terminal",
  label,
  terminalId: "pty-1",
  terminalLabel: "Terminal 1",
  lineStart: 2,
  lineEnd: 2,
  text: "ok",
});
const fragmentOf = (records: unknown[]) =>
  JSON.stringify({ version: 1, source: { hostId: "local" }, records });

beforeEach(() => vi.stubGlobal("ClipboardEvent", FakeClipboardEvent));
afterEach(() => vi.unstubAllGlobals());

describe("pasting text with tokens in it", () => {
  it("a file link becomes one file chip, with the trailing space a typed mention gets, and no plain paste", () => {
    const editor = chipEditor();
    const plain = vi.fn(() => true);
    editor.registerCommand(PASTE_COMMAND, plain, COMMAND_PRIORITY_EDITOR);
    const event = paste(editor, "[notes.md](docs/notes.md)");
    expect(event.defaultPrevented).toBe(true);
    expect(plain).not.toHaveBeenCalled();
    expect(shapeOf(editor)).toEqual(["file:docs/notes.md", " "]);
  });

  it("a link to a scoped folder is a file chip too", () => {
    const editor = chipEditor();
    paste(editor, "[ui](@acme/ui)");
    expect(shapeOf(editor)).toEqual(["file:@acme/ui", " "]);
  });

  it.each(["pnpm add @acme/ui", "npx @acme/cli@latest init", 'import x from "@acme/ui/button"'])(
    "a scoped package name (%s) is plain text, left to the default paste",
    (text) => {
      const editor = chipEditor();
      const plain = vi.fn((event: ClipboardEvent) => {
        const selection = $getSelection();
        if ($isRangeSelection(selection))
          selection.insertText(event.clipboardData?.getData("text/plain") ?? "");
        return true;
      });
      editor.registerCommand(PASTE_COMMAND, plain, COMMAND_PRIORITY_EDITOR);
      paste(editor, text);
      expect(plain).toHaveBeenCalledTimes(1);
      expect(promptOf(editor)).toBe(text);
    },
  );

  it("a file chip pasted right after a word is spaced from it", () => {
    const editor = chipEditor("see");
    paste(editor, "[a.ts](src/a.ts) now");
    expect(promptOf(editor)).toBe("see [a.ts](src/a.ts) now");
  });

  it("several citations next to punctuation and non-Latin text all become chips, text unchanged", () => {
    const other = serializeReplyFootnote({
      ...quote,
      messageId: ItemId.make("m-4"),
      text: "二つ目",
    });
    const text = `「${quoteLink}」;${other}${quoteLink}`;
    const editor = chipEditor();
    expect(paste(editor, text).defaultPrevented).toBe(true);
    expect(promptOf(editor)).toBe(text);
    expect(shapeOf(editor)).toEqual(["「", "cite", "」;", "cite", "cite"]);
  });

  it("citations and file chips mix; only a file chip at the very end gets padded", () => {
    const editor = chipEditor();
    paste(editor, `${quoteLink}\n[a.ts](a.ts) ${quoteLink}`);
    expect(shapeOf(editor)).toEqual(["cite", "\n", "file:a.ts", " ", "cite"]);
    const ending = chipEditor();
    paste(ending, `${quoteLink} [a.ts](a.ts)`);
    expect(shapeOf(ending)).toEqual(["cite", " ", "file:a.ts", " "]);
  });

  it("a citation pasted after a lone @ still reads back as a citation", () => {
    const editor = chipEditor("@");
    paste(editor, quoteLink);
    expect(splitPromptIntoPromptSegments(promptOf(editor))).toEqual([
      { type: "text", text: "@" },
      { type: "citation", citation: quote, source: quoteLink },
    ]);
  });

  it("context links become context chips", () => {
    const editor = chipEditor("look: ");
    paste(editor, "[Terminal 1 line 2](kora-context://v1/terminal/ctx-9) please");
    expect(shapeOf(editor)).toEqual(["look: ", "ctx:ctx-9", " please"]);
  });
});

describe("pasting context copied from another prompt", () => {
  const copiedText = (prefix: string) =>
    `${prefix}[out](kora-context://v1/terminal/ctx-a) and [err](kora-context://v1/terminal/ctx-b)`;
  const clipboard = (prefix: string) =>
    new FakeClipboardEvent(copiedText(prefix), {
      [FRAGMENT_TYPE]: fragmentOf([
        terminalRecord("ctx-a", "out"),
        terminalRecord("ctx-b", "err"),
        terminalRecord("ctx-z"),
      ]),
    }).clipboardData;

  it("only the records the pasted text links to are taken from the fragment", () => {
    expect(readPastedContextChip(clipboard(""))?.records.map((r) => r.contextId)).toEqual([
      "ctx-a",
      "ctx-b",
    ]);
  });

  it.each(["", "x".repeat(40_000)])(
    "records are imported and links to renamed ones rewritten, before a paste into the editor (%#)",
    (prefix) => {
      const imported: string[] = [];
      const renameA = (fragment: { records: ReadonlyArray<{ contextId: string }> }) => {
        imported.push(...fragment.records.map((r) => r.contextId));
        return new Map([["ctx-a", "ctx-a2"]]);
      };
      // Paste that focuses the composer first: the text alone.
      expect(importPastedPromptText(clipboard(prefix), renameA)).toBe(
        `${prefix}[out](kora-context://v1/terminal/ctx-a2) and [err](kora-context://v1/terminal/ctx-b)`,
      );
      // Paste into the editor: chips for the rewritten links.
      const editor = chipEditor("", renameA);
      paste(editor, copiedText(prefix), {
        [FRAGMENT_TYPE]: fragmentOf([
          terminalRecord("ctx-a", "out"),
          terminalRecord("ctx-b", "err"),
        ]),
      });
      expect(imported).toEqual(["ctx-a", "ctx-b", "ctx-a", "ctx-b"]);
      expect(shapeOf(editor).filter((s) => s.startsWith("ctx:"))).toEqual([
        "ctx:ctx-a2",
        "ctx:ctx-b",
      ]);
    },
  );

  it("an element annotation copied from an older version comes back as a preview annotation", () => {
    const old = upgradeLegacyContextMessage(
      [
        "Make it blue",
        "",
        "<element_context>",
        "- <a>:",
        "  url: https://example.com",
        "  selector: nav a",
        "  html:",
        "    <a>Home</a>",
        "  styles:",
        "    color: red;",
        "</element_context>",
      ].join("\n"),
    );
    const data = new FakeClipboardEvent(old.text, { [FRAGMENT_TYPE]: fragmentOf(old.records) })
      .clipboardData;
    const made: ReturnType<typeof webMarkupContextRecord>[] = [];
    const text = importPastedPromptText(data, (fragment) => {
      const record = fragment.records[0]!;
      if (record.kind !== "element" || "payload" in record)
        throw new Error("expected an element record");
      const annotation = webMarkupContextRecord(
        elementContextToWebMarkup(record, "pasted", "2026-10-19T00:00:00Z"),
      );
      made.push(annotation);
      return new Map([[record.contextId, annotation.contextId]]);
    });
    expect(text).toContain("kora-context://v1/preview-annotation/preview-annotation_pasted");
    expect(made[0]?.elements?.[0]).toMatchObject({
      selector: "nav a",
      htmlPreview: "<a>Home</a>",
      styles: "color: red;",
    });
  });

  it("an unrelated record riding along in the fragment is not imported", () => {
    const id = "preview-annotation_n1";
    const imported: string[] = [];
    const editor = chipEditor("", (fragment) => {
      imported.push(...fragment.records.map((r) => r.contextId));
      return new Map();
    });
    paste(editor, `[Bigger](kora-context://v1/preview-annotation/${id})`, {
      [FRAGMENT_TYPE]: fragmentOf([
        {
          version: 1,
          contextId: id,
          kind: "preview-annotation",
          label: "Bigger",
          annotationId: "n1",
          pageUrl: "http://localhost:3000",
          pageTitle: "Home",
          comment: "Bigger",
          targetSummary: "1 selected element",
          styleChanges: [],
        },
        terminalRecord("terminal_other"),
      ]),
    });
    expect(imported).toEqual([id]);
    expect(shapeOf(editor)).toEqual([`ctx:${id}`]);
  });
});

describe("copying context chips", () => {
  it("writes the text, the fragment and an HTML carrier for the selected chips", () => {
    const editor = chipEditor();
    paste(editor, "a [out](kora-context://v1/terminal/ctx-a) b");
    const built: string[][] = [];
    registerChipCopy(editor, (ids) => {
      built.push([...ids]);
      return '{"fragment":true}';
    });
    const written = new Map<string, string>();
    const event = Object.assign(new Event("copy", { cancelable: true }), {
      clipboardData: { setData: (type: string, value: string) => void written.set(type, value) },
    });
    editor.update(
      () => {
        $getRoot().select(0, 1);
        editor.dispatchCommand(COPY_COMMAND, event as unknown as ClipboardEvent);
      },
      { discrete: true },
    );
    expect(built).toEqual([["ctx-a"]]);
    expect(event.defaultPrevented).toBe(true);
    expect(written.get("text/plain")).toBe("a [out](kora-context://v1/terminal/ctx-a) b");
    expect(written.get(FRAGMENT_TYPE)).toBe('{"fragment":true}');
    expect(written.get("text/html")).toContain("ctx-a");
  });
});
