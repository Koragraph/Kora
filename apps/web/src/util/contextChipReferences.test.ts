import { describe, expect, it } from "vite-plus/test";

import {
  appendInlineContextLink,
  collectInlineContextIds,
  ensureInlineContextLinks,
  formatInlineContextLink,
  inlineContextReferenceReplacement,
  insertInlineContextLink,
  producerIdFromContextChipId,
  removeInlineContextLink,
  stripInlineContextLinks,
  toContextChipId,
  toKindScopedContextChipId,
} from "./contextChipReferences";

const comment = { kind: "review-comment", contextId: "rv-8", label: "main.rs L12" };
const annotation = { kind: "preview-annotation", contextId: "an-3", label: "Login form" };
const commentLink = "[main.rs L12](kora-context://v1/review-comment/rv-8)";
const annotationLink = "[Login form](kora-context://v1/preview-annotation/an-3)";

describe("chip ids", () => {
  it("passes through ids that already satisfy the grammar", () => {
    expect(toContextChipId("note_42-A")).toBe("note_42-A");
  });

  it("folds other ids into slug + 16 hex digits, deterministically", () => {
    const folded = toContextChipId("diff-hunk:lib/x.ts:7-9");
    expect(folded).toMatch(/^diff-hunk-lib-x-ts-7-9-[0-9a-f]{16}$/);
    expect(toContextChipId("diff-hunk:lib/x.ts:7-9")).toBe(folded);
  });

  it("gives different ids to producer ids that differ by one character", () => {
    expect(toContextChipId("diff-hunk:lib/x.ts:7-9")).not.toBe(
      toContextChipId("diff-hunk:lib/y.ts:7-9"),
    );
  });

  it("falls back to a ctx slug when nothing usable is left", () => {
    expect(toContextChipId("::")).toMatch(/^ctx-[0-9a-f]{16}$/);
  });

  it("still tells long ids apart after the slug is cut at 48 characters", () => {
    const head = `finding:${"z".repeat(70)}`;
    const a = toContextChipId(`${head}:1`);
    const b = toContextChipId(`${head}:2`);

    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(128);
  });

  it("namespaces by kind without colliding when the raw id repeats the prefix", () => {
    expect(toKindScopedContextChipId("image", "p")).toBe("image_p");
    expect(toKindScopedContextChipId("image", "image_p")).toBe("image_image_p");
  });

  it.each([
    ["image", "image_p", "p"],
    ["image", "image_image_p", "image_p"],
    ["image", "other_p", "other_p"],
    ["terminal", "image_p", "image_p"],
  ] as const)("strips the %s_ namespace: %s -> %s", (kind, contextId, producer) => {
    expect(producerIdFromContextChipId(kind, contextId)).toBe(producer);
  });
});

describe("link text", () => {
  it("formats a reference as a markdown link with a kora-context href", () => {
    expect(formatInlineContextLink(comment)).toBe(commentLink);
    expect(formatInlineContextLink(annotation)).toBe(annotationLink);
  });

  it("lists distinct ids in first-seen order", () => {
    const prompt = `a ${commentLink} b ${annotationLink} c ${commentLink}`;
    expect(collectInlineContextIds(prompt)).toEqual(["rv-8", "an-3"]);
    expect(collectInlineContextIds("no links")).toEqual([]);
  });

  it("strips every link and leaves the surrounding spaces", () => {
    expect(stripInlineContextLinks(`a ${commentLink} b ${annotationLink} ${commentLink}`)).toBe(
      "a  b  ",
    );
  });
});

describe("inserting links", () => {
  it("pads a mid-word insert with a space on each side", () => {
    expect(insertInlineContextLink("xy", 1, comment)).toEqual({
      prompt: `x ${commentLink} y`,
      cursor: `x ${commentLink} `.length,
    });
  });

  it("does not pad after existing whitespace or at the start", () => {
    expect(insertInlineContextLink("", 0, comment)).toEqual({
      prompt: `${commentLink} `,
      cursor: commentLink.length + 1,
    });
    expect(insertInlineContextLink("go\n", 3, comment).prompt).toBe(`go\n${commentLink} `);
  });

  it("appends at the end with a leading space only when needed", () => {
    expect(appendInlineContextLink("hello", annotation)).toBe(`hello ${annotationLink} `);
    expect(appendInlineContextLink("hello ", annotation)).toBe(`hello ${annotationLink} `);
    expect(appendInlineContextLink("", annotation)).toBe(`${annotationLink} `);
  });

  it("clamps an out-of-range cursor into the prompt", () => {
    expect(insertInlineContextLink("ab", 99, comment).prompt).toBe(`ab ${commentLink} `);
    expect(insertInlineContextLink("ab", -4, comment).prompt).toBe(`${commentLink} ab`);
  });
});

describe("replacing a selection", () => {
  it.each([
    ["mid-word selection", "xSELy", 1, 4, `x ${commentLink} y`],
    ["whole prompt", "picked", 0, 6, `${commentLink} `],
    ["selection between spaces", "pre picked post", 4, 10, `pre ${commentLink} post`],
  ])("%s", (_label, prompt, start, end, expected) => {
    const edit = inlineContextReferenceReplacement(prompt, { start, end }, [comment]);
    expect(prompt.slice(0, edit.start) + edit.text + prompt.slice(edit.end)).toBe(expected);
  });

  it("joins several references with single spaces", () => {
    const edit = inlineContextReferenceReplacement("", { start: 0, end: 0 }, [comment, annotation]);
    expect(edit).toEqual({ start: 0, end: 0, text: `${commentLink} ${annotationLink} ` });
  });
});

describe("ensureInlineContextLinks", () => {
  it("adds only the references the prompt does not already contain", () => {
    expect(ensureInlineContextLinks(`see ${commentLink}`, [comment, annotation])).toBe(
      `see ${commentLink} ${annotationLink} `,
    );
  });

  it("leaves a prompt that has them all untouched", () => {
    expect(ensureInlineContextLinks(commentLink, [comment])).toBe(commentLink);
  });

  it("adds a repeated reference once", () => {
    expect(ensureInlineContextLinks("", [comment, comment])).toBe(`${commentLink} `);
  });
});

describe("removeInlineContextLink", () => {
  it("removes every occurrence and parks the cursor at the first cut", () => {
    expect(removeInlineContextLink(`${commentLink} mid ${commentLink} end`, "rv-8")).toEqual({
      prompt: "mid end",
      cursor: 0,
    });
  });

  it("eats the space after the link, or else the one before it", () => {
    expect(removeInlineContextLink(`a ${commentLink} b`, "rv-8")).toEqual({
      prompt: "a b",
      cursor: 2,
    });
    expect(removeInlineContextLink(`a ${commentLink}`, "rv-8")).toEqual({ prompt: "a", cursor: 1 });
  });

  it("leaves other links in place", () => {
    expect(removeInlineContextLink(`${commentLink} ${annotationLink} `, "rv-8").prompt).toBe(
      `${annotationLink} `,
    );
  });

  it("returns the prompt unchanged with the cursor at the end when the id is absent", () => {
    expect(removeInlineContextLink("plain", "rv-8")).toEqual({ prompt: "plain", cursor: 5 });
  });
});
