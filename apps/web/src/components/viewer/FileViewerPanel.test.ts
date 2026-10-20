import { describe, expect, test } from "vite-plus/test";

import {
  formatFileCommentRange,
  normalizeFileCommentRange,
  remapFileCommentAnnotations,
} from "./fileCommentAnnotations";
import {
  isMarkdownPreviewFile,
  setMarkdownTaskChecked,
  shouldShowFileExplorer,
} from "./fileViewerMode";

describe("setMarkdownTaskChecked", () => {
  const doc = "- [ ] One\n- [x] Two\n";

  test("an offset that does not point at a marker leaves the text alone", () => {
    expect(setMarkdownTaskChecked(doc, 0, true)).toBe(doc);
    expect(setMarkdownTaskChecked(doc, 500, true)).toBe(doc);
  });

  test("the marker at the offset is set to the requested state", () => {
    expect(setMarkdownTaskChecked(doc, 2, true)).toBe("- [x] One\n- [x] Two\n");
    expect(setMarkdownTaskChecked(doc, 12, false)).toBe("- [ ] One\n- [ ] Two\n");
  });

  test("ordered lists and a capital X work too", () => {
    expect(setMarkdownTaskChecked("1. [X] Step\n", 3, false)).toBe("1. [ ] Step\n");
  });
});

describe("shouldShowFileExplorer", () => {
  const input = (over: Partial<Parameters<typeof shouldShowFileExplorer>[0]>) => ({
    attachmentOpen: false,
    explorerOpen: true,
    relativePath: "docs/a.pdf",
    ...over,
  });

  test("a workspace file follows the saved preference", () => {
    expect(shouldShowFileExplorer(input({ explorerOpen: true }))).toBe(true);
    expect(shouldShowFileExplorer(input({ explorerOpen: false }))).toBe(false);
  });

  test.each([
    ["a file outside the workspace", { relativePath: "/tmp/a.pdf" }],
    ["an attachment", { attachmentOpen: true }],
  ])("is hidden for %s", (_label, over) => {
    expect(shouldShowFileExplorer(input(over))).toBe(false);
  });
});

describe("isMarkdownPreviewFile", () => {
  test.each([
    ["README.md", true],
    ["docs/guide.MDX", true],
    ["docs/guide.txt", false],
    ["docs/markdown.ts", false],
  ])("%s -> %s", (path, expected) => {
    expect(isMarkdownPreviewFile(path)).toBe(expected);
  });
});

describe("file comment line ranges", () => {
  test("a remapped anchor drags the whole range with it, keeping its length", () => {
    const note = (start: number, end: number) => ({
      id: "c1",
      kind: "comment",
      text: "Keep this guarded.",
      startLine: start,
      endLine: end,
    });
    const out = remapFileCommentAnnotations([
      { lineNumber: 30, metadata: { entries: [note(2, 9)] } },
    ] as never);
    expect(out).toEqual([{ lineNumber: 30, metadata: { entries: [note(23, 30)] } }]);
  });

  test("a reversed selection is put in order", () => {
    expect(normalizeFileCommentRange({ start: 16, end: 7 })).toEqual({ startLine: 7, endLine: 16 });
  });

  test("labels read L<n> for one line and L<a> to L<b> for a span", () => {
    expect(formatFileCommentRange(7, 7)).toBe("L7");
    expect(formatFileCommentRange(7, 16)).toBe("L7 to L16");
  });
});
