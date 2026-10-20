import { describe, expect, it } from "vite-plus/test";

import { codexFileFootnoteMarkdown, resolveCodexFileFootnoteLink } from "./fileFootnotes.ts";

const resolve = resolveCodexFileFootnoteLink;

describe("Codex file footnotes", () => {
  it("turns an output footnote into a link labelled by the file name", () => {
    const path = "/srv/out/report-q3-summary.csv";
    expect(resolve({ path, purpose: "output" })).toEqual({
      path,
      href: path,
      label: "report-q3-summary.csv",
    });
  });

  it("points the link at the first cited line", () => {
    expect(
      resolve({
        path: "lib/run.py",
        line_range_start: "17",
        line_range_end: "30",
        git_url: "https://git.test/run.py",
      }),
    ).toEqual({ path: "lib/run.py", href: "lib/run.py#L17", label: "run.py", lineRangeStart: 17 });
  });

  it("needs a path and ignores a line that is not a number", () => {
    expect(resolve({ purpose: "output" })).toBeNull();
    expect(resolve({ path: "lib/run.py", line_range_start: "seventeen" })).toEqual({
      path: "lib/run.py",
      href: "lib/run.py",
      label: "run.py",
    });
  });

  it("escapes %, # and ? in the href but not in the label", () => {
    expect(resolve({ path: "notes/50% #2? final.txt", line_range_start: "3" })).toEqual({
      path: "notes/50% #2? final.txt",
      href: "notes/50%25 %232%3F final.txt#L3",
      label: "50% #2? final.txt",
      lineRangeStart: 3,
    });
  });

  describe("as markdown", () => {
    const markdown = (path: string) => {
      const link = resolve({ path });
      return link && codexFileFootnoteMarkdown(link);
    };

    it("wraps a path with spaces in angle brackets", () => {
      expect(markdown("notes/tax return.pdf")).toBe("[tax return.pdf](<notes/tax return.pdf>)");
    });

    it("escapes markdown in the label and < in the destination", () => {
      expect(markdown("notes/_v2_*[x]`<&.md")).toBe(
        "[\\_v2\\_\\*\\[x\\]\\`\\<\\&.md](<notes/_v2_*[x]`%3C&.md>)",
      );
    });
  });
});
