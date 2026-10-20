import { HostId, ItemId, ThreadId, type ReplyFootnote } from "@kora/contracts";
import { serializeReplyFootnote } from "@kora/shared/assistantFootnotes";
import {
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
} from "lexical";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ReplyFootnoteSourceAnchor } from "~/util/assistantTextSelection";
import {
  $createCitationChipNode,
  $takeCitationCommentRequest,
  type CitationCommentRequest,
} from "./citationChip";
import { $citations, $line, chipEditor, FakeClipboardEvent, paste, promptOf } from "./testEditor";

vi.mock("../thread/ReplyFootnoteChip", () => ({ ReplyFootnoteChip: () => null }));
vi.mock("../thread/FileTagChip", () => ({
  FileTagBody: () => null,
  FILE_TAG_CHIP_CLASS_NAME: "",
}));

const quote: ReplyFootnote = {
  version: 1,
  hostId: HostId.make("local/ünï"),
  threadId: ThreadId.make("t-2"),
  messageId: ItemId.make("m-8"),
  text: 'The "cache" is (still) warm — ask @infra.md',
  start: 12,
  end: 55,
  prefix: "« ",
  suffix: " »",
};
const link = serializeReplyFootnote(quote);
const withComment = (comment: string) => ({ ...quote, comment });
const citationsOf = (editor: ReturnType<typeof chipEditor>) =>
  editor.getEditorState().read(() => $citations().map((c) => c.exportJSON().citation));

beforeEach(() => vi.stubGlobal("ClipboardEvent", FakeClipboardEvent));
afterEach(() => vi.unstubAllGlobals());

describe("a citation's comment", () => {
  it("is part of the chip's text, and survives a JSON reload and a copy-paste", () => {
    const comment = "why twice??\nkeep this indent:\n  ok 👍";
    const editor = chipEditor();
    paste(editor, `see (${link}).`);
    editor.update(() => void $citations()[0]!.setComment(comment), { discrete: true });
    const expected = `see (${serializeReplyFootnote(withComment(comment))}).`;
    expect(promptOf(editor)).toBe(expected);
    expect(citationsOf(editor)).toEqual([withComment(comment)]);

    const reloaded = chipEditor();
    reloaded.setEditorState(reloaded.parseEditorState(editor.getEditorState().toJSON()));
    reloaded.update(
      () => {
        const paragraph = $getRoot().getFirstChildOrThrow();
        if ($isElementNode(paragraph)) paragraph.selectStart().insertText("Re: ");
      },
      { discrete: true },
    );
    expect(promptOf(reloaded)).toBe(`Re: ${expected}`);
    expect(citationsOf(reloaded)).toEqual([withComment(comment)]);

    const pasted = chipEditor();
    paste(pasted, promptOf(reloaded));
    expect(promptOf(pasted)).toBe(`Re: ${expected}`);
    expect(citationsOf(pasted)).toEqual([withComment(comment)]);
  });

  it("on one of two identical quotes changes only that one, keeps the selection, and leaves old states alone", () => {
    const editor = chipEditor();
    const prompt = `a ${link} b ${link} c`;
    paste(editor, prompt);
    editor.update(() => void $getRoot().getAllTextNodes().at(-1)!.select(1, 2), { discrete: true });
    const before = editor.getEditorState();
    const selection = before.read(() => $getSelection()!.clone());
    const second = before.read(() => $citations()[1]!);
    editor.update(() => void second.setComment("draft"), { discrete: true });
    editor.update(() => void second.setComment("this one"), { discrete: true });
    const after = editor.getEditorState();

    expect(promptOf(editor)).toBe(
      `a ${link} b ${serializeReplyFootnote(withComment("this one"))} c`,
    );
    expect(citationsOf(editor)).toEqual([quote, withComment("this one")]);
    expect(after.read(() => $getSelection()?.is(selection))).toBe(true);
    // Undo-style restores see the states exactly as they were.
    editor.setEditorState(before);
    expect([promptOf(editor), citationsOf(editor)]).toEqual([prompt, [quote, quote]]);
    editor.setEditorState(after);
    expect(citationsOf(editor)).toEqual([quote, withComment("this one")]);
  });

  it.each(["", "  \n\t"])("set to %j removes the comment and keeps the quote", (blank) => {
    const editor = chipEditor();
    paste(editor, link);
    editor.update(() => void $citations()[0]!.setComment("temporary"), { discrete: true });
    editor.update(() => void $citations()[0]!.setComment(blank), { discrete: true });
    expect(citationsOf(editor)).toStrictEqual([quote]);
    expect(promptOf(editor)).toBe(link);
  });
});

describe("citations as a unit", () => {
  it("a cut of two commented citations pastes back with every field intact", () => {
    const first = withComment("first one");
    const second = withComment("second one\n  ✓");
    const editor = chipEditor();
    paste(editor, `x ${link},${link} y`);
    editor.update(
      () => {
        $citations()[0]!.setComment(first.comment);
        $citations()[1]!.setComment(second.comment);
      },
      { discrete: true },
    );
    let cut = "";
    editor.update(
      () => {
        const paragraph = $getRoot().getFirstChildOrThrow();
        if (!$isElementNode(paragraph)) return;
        paragraph.select(1, 4); // the two chips and the comma between them
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;
        cut = selection.getTextContent();
        selection.removeText();
      },
      { discrete: true },
    );
    expect(cut).toBe(`${serializeReplyFootnote(first)},${serializeReplyFootnote(second)}`);
    expect(promptOf(editor)).toBe("x  y");
    paste(editor, cut);
    expect(promptOf(editor)).toBe(`x ${cut} y`);
    expect(citationsOf(editor)).toEqual([first, second]);
  });

  it.each([
    ["Backspace", true],
    ["Delete", false],
  ])(
    "%s removes a citation and its comment together; the JSON before still restores both",
    (_, backwards) => {
      const commented = withComment("goes with it");
      const editor = chipEditor();
      editor.update(
        () => {
          const [left, right] = [$createTextNode("<"), $createTextNode(">")];
          $line()[0]?.remove();
          const paragraph = $getRoot().getFirstChildOrThrow();
          if (!$isElementNode(paragraph)) return;
          paragraph.append(
            left,
            $createCitationChipNode(quote, link).setComment(commented.comment),
            right,
          );
          (backwards ? right.selectStart() : left.selectEnd()) satisfies unknown;
        },
        { discrete: true },
      );
      const saved = editor.getEditorState().toJSON();
      editor.update(
        () => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) selection.deleteCharacter(backwards);
        },
        { discrete: true },
      );
      expect([promptOf(editor), citationsOf(editor)]).toEqual(["<>", []]);
      editor.setEditorState(editor.parseEditorState(saved));
      expect(promptOf(editor)).toBe(`<${serializeReplyFootnote(commented)}>`);
      expect(citationsOf(editor)).toEqual([commented]);
    },
  );
});

describe("opening the comment box after Cite", () => {
  // Where in the reply the cite came from; only passed through, so stand-ins do.
  const element = { nodeType: 1 } as HTMLElement;
  const anchor: ReplyFootnoteSourceAnchor = {
    viewport: element,
    source: element,
    range: { collapsed: false } as Range,
  };
  const pending = (request: CitationCommentRequest) => ({
    current: request as CitationCommentRequest | null,
  });

  it("waits for the cited prompt, then targets the new chip and no other (and only once)", () => {
    const editor = chipEditor();
    const previousValue = `top ${link}\nmid end ${link}`;
    paste(editor, previousValue);
    const at = `top ${link}\nmid `.length;
    const value = `${previousValue.slice(0, at)}${link} ${previousValue.slice(at)}`;
    const request = pending({ previousValue, value, citationStart: at, sourceAnchor: anchor });

    editor.getEditorState().read(() => expect($takeCitationCommentRequest(request)).toBeNull());
    expect(request.current).not.toBeNull(); // still waiting
    editor.update(
      () => {
        const mid = $getRoot()
          .getAllTextNodes()
          .find((n) => n.getTextContent() === "mid end ");
        mid?.select(4, 4);
      },
      { discrete: true },
    );
    paste(editor, `${link} `);
    editor.getEditorState().read(() => {
      const selection = $getSelection()?.clone();
      expect($getRoot().getTextContent()).toBe(value);
      const target = $takeCitationCommentRequest(request);
      expect(target).toMatchObject({
        nodeKey: $citations()[1]!.getKey(),
        sourceAnchor: anchor,
        removeOnCancel: true,
      });
      expect($getSelection()?.is(selection!)).toBe(true);
      expect($takeCitationCommentRequest(request)).toBeNull();
    });
  });

  it("is not reopened by undoing to the cite, reloading it or pasting it", () => {
    const editor = chipEditor("so ");
    const empty = editor.getEditorState();
    const value = `so ${link} `;
    const request = pending({
      previousValue: "so ",
      value,
      citationStart: 3,
      sourceAnchor: anchor,
    });
    paste(editor, `${link} `);
    const cited = editor.getEditorState();
    cited.read(() =>
      expect($takeCitationCommentRequest(request)?.nodeKey).toBe($citations()[0]!.getKey()),
    );
    editor.update(() => void $citations()[0]!.setComment("kept"), { discrete: true });
    const commented = editor.getEditorState();

    for (const state of [empty, cited, commented]) {
      editor.setEditorState(state);
      editor.getEditorState().read(() => expect($takeCitationCommentRequest(request)).toBeNull());
    }
    const reloaded = chipEditor();
    reloaded.setEditorState(reloaded.parseEditorState(commented.toJSON()));
    const pasted = chipEditor();
    paste(
      pasted,
      commented.read(() => $getRoot().getTextContent()),
    );
    for (const other of [reloaded, pasted]) {
      other.getEditorState().read(() => {
        expect($takeCitationCommentRequest({ current: null })).toBeNull();
        expect($citations()[0]!.exportJSON().citation.comment).toBe("kept");
      });
    }
  });

  it("is dropped when a different prompt arrives instead", () => {
    const editor = chipEditor();
    const request = pending({
      previousValue: "",
      value: link,
      citationStart: 0,
      sourceAnchor: anchor,
    });
    editor.update(
      () => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) selection.insertText("something else");
      },
      { discrete: true },
    );
    editor.getEditorState().read(() => expect($takeCitationCommentRequest(request)).toBeNull());
    editor.update(
      () => {
        const paragraph = $getRoot().getFirstChildOrThrow();
        if ($isElementNode(paragraph)) paragraph.clear().selectStart();
      },
      { discrete: true },
    );
    paste(editor, link);
    editor.getEditorState().read(() => {
      expect($getRoot().getTextContent()).toBe(link);
      expect($takeCitationCommentRequest(request)).toBeNull();
    });
  });
});
