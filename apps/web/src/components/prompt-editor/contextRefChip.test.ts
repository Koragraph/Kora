import { $getRoot, $isElementNode } from "lexical";
import { describe, expect, it, vi } from "vite-plus/test";

import { splitPromptIntoPromptSegments } from "~/prompt-editor-mentions";
import { $createContextRefChipNode, ContextRefChipNode } from "./contextRefChip";
import { $line, chipEditor, promptOf } from "./testEditor";

vi.mock("../contextChipPresentation", () => ({ ContextChipReferenceChip: () => null }));
vi.mock("../thread/ReplyFootnoteChip", () => ({ ReplyFootnoteChip: () => null }));
vi.mock("../thread/FileTagChip", () => ({
  FileTagBody: () => null,
  FILE_TAG_CHIP_CLASS_NAME: "",
}));

const ref = { kind: "review-comment", contextId: "ctx-r7", label: "Comment on api.ts:12" };
const canonical = "[Comment on api.ts:12](kora-context://v1/review-comment/ctx-r7)";

/** An editor whose paragraph holds the chips `make` returns. */
function holding(make: () => ContextRefChipNode[]) {
  const editor = chipEditor();
  editor.update(
    () => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      if ($isElementNode(paragraph)) paragraph.append(...make());
    },
    { discrete: true },
  );
  return editor;
}
const $chips = () =>
  $line().filter((n): n is ContextRefChipNode => n instanceof ContextRefChipNode);

describe("a context chip", () => {
  it("reads as its canonical link, which parses back to the same reference", () => {
    const editor = holding(() => [$createContextRefChipNode(ref, "occ-1")]);
    expect(promptOf(editor)).toBe(canonical);
    expect(splitPromptIntoPromptSegments(canonical)).toEqual([
      { type: "context-reference", ...ref, source: canonical },
    ]);
  });

  it("keeps its reference and occurrence id through JSON", () => {
    const editor = holding(() => [$createContextRefChipNode(ref, "occ-1")]);
    const copy = chipEditor();
    copy.setEditorState(copy.parseEditorState(editor.getEditorState().toJSON()));
    const read = copy
      .getEditorState()
      .read(() =>
        $chips().map((chip) => ({ occurrence: chip.__referenceId, ref: chip.getReference() })),
      );
    expect(read).toEqual([{ occurrence: "occ-1", ref }]);
  });

  it("gets its own occurrence id each time one is made, even for the same record", () => {
    const editor = holding(() => [$createContextRefChipNode(ref), $createContextRefChipNode(ref)]);
    const [a, b] = editor
      .getEditorState()
      .read(() =>
        $chips().map((chip) => ({ ref: chip.getReference(), occurrence: chip.__referenceId })),
      );
    expect(a!.ref).toEqual(b!.ref);
    expect(a!.occurrence).not.toBe(b!.occurrence);
    expect(a!.occurrence).toMatch(/^[0-9a-f-]{36}$/);
  });
});
