import { describe, expect, it } from "vite-plus/test";

import { upgradeLegacyContextMessage } from "./contextChipLegacy.ts";

// ---------------------------------------------------------------------------
// Compileers for the legacy wire text and the chips it should turn into
// ---------------------------------------------------------------------------

type ChipKind = "terminal" | "element" | "preview-annotation" | "review-comment";

/** The markdown link a chip is rendered as. */
const chip = (kind: ChipKind, ordinal: number, label: string) =>
  `[${label}](kora-context://v1/${kind}/legacy_${kind}_${ordinal})`;

const joinLines = (...parts: ReadonlyArray<string>) => parts.join("\n");

const wrapIn = (tag: string, ...inner: ReadonlyArray<string>) =>
  joinLines(`<${tag}>`, ...inner, `</${tag}>`);

const REVIEW_OPEN = '<review_comment sectionId="s" filePath="f.ts" startIndex="1" endIndex="1">';
const reviewTag = (body: string) => `${REVIEW_OPEN}${body}</review_comment>`;
const INLINE_REVIEW = reviewTag("note");
const REVIEW_CHIP = (n: number) => chip("review-comment", n, "f.ts line");

const upgrade = upgradeLegacyContextMessage;

const contextIds = (result: ReturnType<typeof upgrade>) =>
  result.records.map(({ contextId }) => contextId).join(" ");

/** The record a chip of `kind` numbered `ordinal` is expected to carry. */
const legacyRecord = <K extends ChipKind>(kind: K, ordinal: number, fields: object) => ({
  version: 1,
  contextId: `legacy_${kind}_${ordinal}`,
  kind,
  ...fields,
});

/** Asserts the message is returned untouched with no records. */
const expectUntouched = (text: string) => {
  expect(upgrade(text)).toEqual({ text, records: [] });
};

const terminalEntry = (label: string, ...output: string[]) => joinLines(`- ${label}:`, ...output);
const PLAIN_TERMINAL = terminalEntry("Compile line 7", "  output");

describe("upgradeLegacyContextMessage", () => {
  describe("review-shaped content inside other blocks", () => {
    it.each([
      {
        tag: "terminal_context",
        body: `- Compile line 1:\n  ${INLINE_REVIEW}`,
        payload: { kind: "terminal", text: INLINE_REVIEW },
      },
      {
        tag: "element_context",
        body: `- <div>:\n  html:\n    ${INLINE_REVIEW}`,
        payload: { kind: "element", htmlPreview: INLINE_REVIEW },
      },
      {
        tag: "preview_annotation",
        body: `Page: Example\nComment: ${INLINE_REVIEW}`,
        payload: { kind: "preview-annotation", comment: INLINE_REVIEW },
      },
      {
        tag: "preview_annotation",
        body: `Page: Example\n<element_context>\n- <div>:\n  html:\n    ${INLINE_REVIEW}\n</element_context>`,
        payload: {
          kind: "preview-annotation",
          elements: [expect.objectContaining({ htmlPreview: INLINE_REVIEW })],
        },
      },
    ])("keeps a review-looking payload intact inside $tag", ({ tag, body, payload }) => {
      for (const trailer of ["", `\n${INLINE_REVIEW}`]) {
        const result = upgrade(`Before ${INLINE_REVIEW} after\n${wrapIn(tag, body)}${trailer}`);

        expect(result.records[0]).toMatchObject(payload);
        const reviewCount = result.records.filter((r) => r.kind === "review-comment").length;
        expect(reviewCount).toBe(trailer ? 2 : 1);
        expect(result.text).not.toContain("");
        expect(result.text).toContain(`Before ${REVIEW_CHIP(1)} after`);
      }
    });

    it.each(["terminal_context", "element_context"])(
      "leaves a mixed message whole when its %s block is malformed",
      (tag) => {
        expectUntouched(`Before ${INLINE_REVIEW} after\n${wrapIn(tag, "invalid entry")}`);
      },
    );

    it.each([
      "stray content",
      "- Bad header:\n  html: text",
      "- <div>:\n  html:\n    <div />\nstray content",
    ])("leaves a preview with a malformed nested element block alone: %s", (inner) => {
      expectUntouched(
        `Before ${INLINE_REVIEW} after\n${wrapIn("preview_annotation", "Page: Example", wrapIn("element_context", inner))}`,
      );
    });

    it("accepts an empty element block nested in a preview annotation", () => {
      const result = upgrade(
        wrapIn("preview_annotation", "Page: Example", wrapIn("element_context", "")),
      );

      expect(result.records).toHaveLength(1);
      expect(result.records[0]).toMatchObject({ kind: "preview-annotation", pageTitle: "Example" });
    });
  });

  describe("fenced review bodies", () => {
    it.each([3, 4, 6])("ignores closing review tags inside a fence of %i backticks", (ticks) => {
      const fence = "`".repeat(ticks);
      const diff = '+ const tag = "</review_comment>";\n</review_comment>\n+ final line';
      const fenced = reviewTag(`\nComment\n${fence}diff\n${diff}\n${fence}\n`);

      const result = upgrade(`Before ${fenced} between ${INLINE_REVIEW} after`);

      expect(result.text).toBe(`Before ${REVIEW_CHIP(1)} between ${REVIEW_CHIP(2)} after`);
      expect(result.records).toHaveLength(2);
      expect(result.records[0]).toMatchObject({ text: "Comment", diff, fenceLanguage: "diff" });
    });

    it("only closes a fence on a backtick run at least as long as the opener", () => {
      const diff = "```\n</review_comment>\n+ remaining source";
      const text = reviewTag(`\nNote\n\`\`\`\`diff\n${diff}\n\`\`\`\`\n`);

      expect(upgrade(text).records[0]).toMatchObject({ text: "Note", diff });
    });

    it("leaves a review with an unterminated fence as text", () => {
      expectUntouched(reviewTag("\nNote\n```diff\n+ source\n"));
    });

    it.each(["x".repeat(16_001), `note\n\`\`\`diff\n${"+x".repeat(16_001)}\n\`\`\``])(
      "does not convert an oversized review (it would leave dangling references)",
      (body) => {
        expectUntouched(reviewTag(body));
      },
    );
  });

  describe("limits", () => {
    it.each([
      `- ${"x".repeat(256)} line 1:\n  output`,
      `- Compile line 1:\n  ${"x".repeat(64_001)}`,
      "- Compile lines 9-1:\n  output",
      Array.from({ length: 201 }, () => "- Compile line 1:\n  output").join("\n"),
    ])("keeps terminal source that would break the wire contract", (body) => {
      expectUntouched(`Prompt\n${wrapIn("terminal_context", body)}`);
    });

    it.each([
      wrapIn("element_context", `- <div>:\n  html:\n    ${"x".repeat(8_001)}`),
      wrapIn("preview_annotation", `Comment: ${"x".repeat(8_001)}`),
    ])("keeps oversized element and preview source as text", (text) => {
      expectUntouched(text);
    });
  });

  describe("terminal labels in the prompt", () => {
    it.each([
      "email@compile:7",
      "café@compile:7",
      "𐐀@compile:7",
      "@compile:7foo",
      "@compile:7st",
      "@compile:7é",
      "@compile:7.foo",
      "@compile:7@mention",
      "@compile:7..foo",
      "@compile:7.é",
    ])("does not rewrite a label that is part of a longer word: %s", (prompt) => {
      const upgraded = upgrade(
        `${prompt}\n${wrapIn("terminal_context", terminalEntry("Compile line 7", "  output"))}`,
      );

      expect(upgraded.text).toBe(`${prompt}\n\n${chip("terminal", 1, "Compile line 7")}`);
    });

    it.each([".", ",", ":", ";", "!", "?", ")", "@", ". Next sentence", "@ next", ".)"])(
      "rewrites a label followed by %s",
      (after) => {
        const result = upgrade(
          `See @compile:7${after}\n${wrapIn("terminal_context", terminalEntry("Compile line 7", "  output"))}`,
        );

        expect(result.text).toBe(`See ${chip("terminal", 1, "Compile line 7")}${after}`);
        expect(result.records).toHaveLength(1);
      },
    );

    it("matches whole line ranges, not numeric prefixes", () => {
      const upgraded = upgrade(
        joinLines(
          "Compare @terminal:10 and @terminal:1-2 with @terminal:1",
          wrapIn(
            "terminal_context",
            terminalEntry("Terminal line 1", "  1 | one"),
            terminalEntry("Terminal line 10", "  10 | ten"),
            terminalEntry("Terminal lines 1-2", "  1 | one", "  2 | two"),
          ),
        ),
      );

      expect(upgraded.text).toBe(
        `Compare ${chip("terminal", 2, "Terminal line 10")} and ${chip("terminal", 3, "Terminal lines 1-2")} with ${chip("terminal", 1, "Terminal line 1")}`,
      );
    });

    it("binds materialized inline labels from sent messages where they stand", () => {
      const text = joinLines(
        "Look at @terminal-1:509-510 and again @compile:7 please",
        "",
        wrapIn(
          "terminal_context",
          terminalEntry(
            "Terminal 1 lines 509-510",
            "  509 | error: boom",
            "  510 |   at main.ts:1",
          ),
          "",
          terminalEntry("Compile line 7", "  7 | done"),
        ),
      );

      expect(upgrade(text).text).toBe(
        `Look at ${chip("terminal", 1, "Terminal 1 lines 509-510")} and again ${chip("terminal", 2, "Compile line 7")} please`,
      );
    });

    it("binds U+FFFC placeholders to the trailing terminal entries in order", () => {
      const text = joinLines(
        "Look at ￼ and ￼ please",
        "",
        wrapIn(
          "terminal_context",
          terminalEntry(
            "Terminal 1 lines 509-510",
            "  509 | error: boom",
            "  510 |   at main.ts:1",
          ),
          "",
          terminalEntry("Compile line 7", "  7 | done"),
        ),
      );

      const upgraded = upgrade(text);

      expect(upgraded.text).toBe(
        `Look at ${chip("terminal", 1, "Terminal 1 lines 509-510")} and ${chip("terminal", 2, "Compile line 7")} please`,
      );
      expect(upgraded.records).toEqual([
        legacyRecord("terminal", 1, {
          text: "error: boom\n  at main.ts:1",
          lineEnd: 510,
          terminalLabel: "Terminal 1",
          label: "Terminal 1 lines 509-510",
          lineStart: 509,
          terminalId: "terminal-1",
        }),
        legacyRecord("terminal", 2, {
          label: "Compile line 7",
          terminalId: "compile",
          terminalLabel: "Compile",
          lineStart: 7,
          lineEnd: 7,
          text: "done",
        }),
      ]);
    });

    it("adds references for entries without a placeholder and drops surplus placeholders", () => {
      const block = wrapIn("terminal_context", terminalEntry("T line 1", "  1 | x"));

      expect(upgrade(`￼ and ￼\n\n${block}`).text).toBe(`${chip("terminal", 1, "T line 1")} and`);
      expect(upgrade(`hi\n\n${block}`).text).toBe(`hi\n\n${chip("terminal", 1, "T line 1")}`);
    });
  });

  describe("malformed trailing blocks", () => {
    it.each(["terminal_context", "element_context"])(
      "keeps a malformed trailing %s block as text",
      (tag) => {
        for (const body of ["partial output", "- Unknown header:\n  partial output"]) {
          expectUntouched(`message\n${wrapIn(tag, body)}`);
        }
      },
    );

    it.each(["terminal_context", "element_context"])(
      "keeps a %s block that is only partly parseable",
      (tag) => {
        const entry =
          tag === "terminal_context"
            ? PLAIN_TERMINAL
            : "- <button>:\n  html:\n    <button>Buy</button>";
        const damaged = [
          `stray prefix\n${entry}`,
          `${entry}\nstray suffix`,
          `${entry}\nstray middle\n${entry}`,
          `  dangling body\n${entry}`,
        ];
        for (const body of damaged) expectUntouched(`Prompt\n${wrapIn(tag, body)}`);
      },
    );
  });

  describe("literal tokens", () => {
    it("never mistakes literal placeholder tokens for its own, even next to real reviews", () => {
      const upgraded = upgrade(`Literal 0 before ${INLINE_REVIEW} after 7`);
      expect(upgraded.text).toBe(`Literal 0 before ${REVIEW_CHIP(1)} after 7`);
      expect(upgraded.records).toHaveLength(1);

      expectUntouched("Literal 0 <review_comment>invalid</review_comment> 99");
    });

    it("returns plain text as it came", () => {
      expect(upgrade("hello **world**")).toEqual({ text: "hello **world**", records: [] });
    });

    it("keeps Markdown hard breaks when it strips the legacy block", () => {
      const text = joinLines(
        "Line with hard break  ",
        "next",
        "",
        wrapIn("terminal_context", terminalEntry("Compile line 7", "  7 | done")),
      );

      expect(upgrade(text).text).toContain("Line with hard break  \nnext");
    });
  });

  describe("element and preview blocks", () => {
    it("turns a trailing element block into element records", () => {
      const text = joinLines(
        "repair this",
        "",
        wrapIn(
          "element_context",
          "- <Cta> (Cta.tsx:12):",
          "  url: http://localhost:4100/pricing",
          "  selector: #buy",
          "  source: src/Cta.tsx:12:3",
          "  html:",
          '    <button id="buy">Buy</button>',
          "  styles:",
          "    color: red;",
        ),
      );

      const upgraded = upgrade(text);

      expect(upgraded.text).toBe(`repair this\n\n${chip("element", 1, "<Cta>")}`);
      expect(upgraded.records).toEqual([
        legacyRecord("element", 1, {
          label: "<Cta>",
          pageUrl: "http://localhost:4100/pricing",
          pageTitle: null,
          tagName: "cta",
          selector: "#buy",
          htmlPreview: '<button id="buy">Buy</button>',
          componentName: "Cta",
          source: {
            functionName: null,
            fileName: "src/Cta.tsx",
            lineNumber: 12,
            columnNumber: 3,
          },
          styles: "color: red;",
        }),
      ]);
    });

    it("treats a URL given as the page as a location, not a title", () => {
      const upgraded = upgrade(wrapIn("preview_annotation", "Page: https://example.com/pricing"));

      expect(upgraded.records[0]).toMatchObject({
        pageUrl: "https://example.com/pricing",
        pageTitle: null,
      });
    });

    describe("annotation comments", () => {
      const annotation = (...commentLines: string[]) =>
        wrapIn(
          "preview_annotation",
          "Preview annotation:",
          ...commentLines,
          "Targets: 1 selected element.",
        );

      // Older clients wrote the comment verbatim, newlines and all. Reading only the first line
      // would drop the rest while the original block is swapped for a chip, so those
      // instructions would vanish from what the reader sees and copies.
      it("keeps every line of a multi-line comment", () => {
        const text = joinLines(
          "<preview_annotation>",
          "Preview annotation:",
          "Id: ann_b",
          "Page: Pricing",
          "Comment: Do this first",
          "Then do that",
          "Targets: 1 selected element.",
          "</preview_annotation>",
        );

        expect(upgrade(text).records[0]).toMatchObject({
          kind: "preview-annotation",
          comment: "Do this first\nThen do that",
        });
      });

      it("keeps a blank line in the middle of a comment", () => {
        const text = annotation("Comment: First paragraph", "", "Second paragraph");

        expect(upgrade(text).records[0]).toMatchObject({
          comment: "First paragraph\n\nSecond paragraph",
        });
      });

      // Only a real block delimiter ends the comment; a line that merely starts with `<` is
      // something the author typed.
      it("keeps markup the author typed inside the comment", () => {
        const text = joinLines(
          "<preview_annotation>",
          "Preview annotation:",
          "Comment: Alter this",
          "<div>leave me</div>",
          "and also this",
          "</preview_annotation>",
        );

        expect(upgrade(text).records[0]).toMatchObject({
          comment: "Alter this\n<div>leave me</div>\nand also this",
        });
      });

      it("keeps a literal opening preview tag inside the comment", () => {
        const upgraded = upgrade(
          joinLines(
            "Describe this",
            "<preview_annotation>",
            "Id: note-a",
            "Page: Pricing",
            "Comment: Keep the <preview_annotation> text",
            "Targets: 3 selected elements.",
            "</preview_annotation>",
          ),
        );

        expect(upgraded.text).toBe(`Describe this\n\n${chip("preview-annotation", 1, "Pricing")}`);
        expect(upgraded.records).toHaveLength(1);
        expect(upgraded.records[0]).toMatchObject({
          annotationId: "note-a",
          comment: "Keep the <preview_annotation> text",
          targetSummary: "3 selected elements.",
        });
      });
    });

    it("upgrades a trailing preview annotation with its nested element", () => {
      const text = joinLines(
        "bigger",
        "",
        wrapIn(
          "preview_annotation",
          "Preview annotation:",
          "Id: ann_a",
          "Page: Pricing",
          "Comment: Increase the size",
          "Targets: 1 selected element.",
          "Requested visual changes:",
          "- font-size: 14px → 22px",
          "The attached screenshot is the annotated preview crop.",
          wrapIn(
            "element_context",
            "- <button>:",
            "  url: http://localhost:4100/",
            "  selector: #buy",
            "  source: src/Buy.tsx:12:3",
            "  html:",
            "    <button>Buy</button>",
          ),
        ),
      );

      const upgraded = upgrade(text);

      expect(upgraded.text).toBe(`bigger\n\n${chip("preview-annotation", 1, "Pricing")}`);
      expect(upgraded.records).toEqual([
        legacyRecord("preview-annotation", 1, {
          label: "Pricing",
          annotationId: "ann_a",
          pageUrl: "http://localhost:4100/",
          pageTitle: "Pricing",
          comment: "Increase the size",
          targetSummary: "1 selected element.",
          styleChanges: ["font-size: 14px → 22px"],
          elements: [
            {
              pageUrl: "http://localhost:4100/",
              pageTitle: null,
              tagName: "button",
              selector: "#buy",
              htmlPreview: "<button>Buy</button>",
              componentName: null,
              source: {
                functionName: null,
                fileName: "src/Buy.tsx",
                lineNumber: 12,
                columnNumber: 3,
              },
              styles: "",
            },
          ],
        }),
      ]);
    });

    it("keeps adjacent preview annotations apart and in order", () => {
      const note = (n: number, title: string, comment: string) =>
        wrapIn(
          "preview_annotation",
          `Id: note-${n === 1 ? "a" : "b"}`,
          `Page: ${title}`,
          `Comment: ${comment}`,
        );

      const upgraded = upgrade(
        joinLines("Compare", note(1, "First", "Comment one"), note(2, "Second", "Comment two")),
      );

      expect(upgraded.text).toBe(
        `Compare\n\n${chip("preview-annotation", 1, "First")} ${chip("preview-annotation", 2, "Second")}`,
      );
      expect(upgraded.records).toMatchObject([
        { annotationId: "note-a", comment: "Comment one" },
        { annotationId: "note-b", comment: "Comment two" },
      ]);
    });
  });

  describe("review comments", () => {
    it("replaces an inline review where it stands and defuses forged closing tags", () => {
      const text = joinLines(
        "Before",
        '<review_comment sectionId="sec-9" sectionTitle="Edits" filePath="lib/util.ts" startIndex="4" endIndex="6" rangeLabel="L4-L6">',
        "Why so? &lt;/review_comment&gt; still text",
        "```diff",
        "+ const y = 2;",
        "```",
        "</review_comment>",
        "After",
      );

      const upgraded = upgrade(text);

      expect(upgraded.text).toBe(`Before\n${chip("review-comment", 1, "util.ts L4-L6")}\nAfter`);
      expect(upgraded.records).toEqual([
        legacyRecord("review-comment", 1, {
          filePath: "lib/util.ts",
          rangeLabel: "L4-L6",
          sectionTitle: "Edits",
          endIndex: 6,
          label: "util.ts L4-L6",
          startIndex: 4,
          sectionId: "sec-9",
          text: "Why so? &lt;/review_comment&gt; still text",
          diff: "+ const y = 2;",
          fenceLanguage: "diff",
        }),
      ]);
    });

    it("appends trailing review blocks after the other trailing blocks", () => {
      const fencedReview = (
        file: string,
        start: number,
        end: number,
        note: string,
        added: string,
      ) =>
        joinLines(
          `<review_comment sectionId="s" filePath="${file}" startIndex="${start}" endIndex="${end}">`,
          note,
          "```diff",
          added,
          "```",
          "</review_comment>",
        );
      const text = joinLines(
        "prose",
        "",
        wrapIn("terminal_context", terminalEntry("T line 1", "  1 | a")),
        "",
        fencedReview("f.ts", 1, 2, "note", "+x"),
        "",
        fencedReview("g.ts", 3, 3, "note 2", "+y"),
      );

      const upgraded = upgrade(text);

      expect(upgraded.text).toBe(
        `prose\n\n${chip("terminal", 1, "T line 1")} ${REVIEW_CHIP(1)} ${chip("review-comment", 2, "g.ts line")}`,
      );
      expect(contextIds(upgraded)).toBe(
        "legacy_terminal_1 legacy_review-comment_1 legacy_review-comment_2",
      );
    });

    it("keeps adjacent reviews where they were, spacing included", () => {
      const upgraded = upgrade(`Compare ${INLINE_REVIEW}  ${INLINE_REVIEW}`);

      expect(upgraded.text).toBe(`Compare ${REVIEW_CHIP(1)}  ${REVIEW_CHIP(2)}`);
    });

    it("keeps a review next to a terminal chip whose payload comes after it", () => {
      const upgraded = upgrade(
        `@compile:7 ${INLINE_REVIEW}\n\n${wrapIn("terminal_context", terminalEntry("Compile line 7", "  output"))}`,
      );

      expect(upgraded.text).toBe(`${chip("terminal", 1, "Compile line 7")} ${REVIEW_CHIP(1)}`);
    });
  });

  it("handles the full legacy send order: terminal, element, preview, review", () => {
    const text = joinLines(
      "See ￼",
      '<review_comment sectionId="s" filePath="f.ts" startIndex="1" endIndex="1">',
      "note",
      "```diff",
      "+x",
      "```",
      "</review_comment>",
      "",
      wrapIn("terminal_context", terminalEntry("T line 1", "  1 | a")),
      "",
      wrapIn("element_context", "- <div>:", "  url: http://x/"),
      "",
      wrapIn("preview_annotation", "Preview annotation:", "Id: p1", "Page: P"),
    );

    const upgraded = upgrade(text);

    expect(upgraded.text).toBe(
      joinLines(
        `See ${chip("terminal", 1, "T line 1")}`,
        REVIEW_CHIP(1),
        "",
        `${chip("element", 1, "<div>")} ${chip("preview-annotation", 1, "P")}`,
      ),
    );
    expect(contextIds(upgraded)).toBe(
      "legacy_terminal_1 legacy_element_1 legacy_preview-annotation_1 legacy_review-comment_1",
    );
  });
});
