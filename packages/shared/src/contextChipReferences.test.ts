import type { ContextChipId, ContextChipRecord } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import * as Refs from "./contextChipReferences.ts";

const id = (raw: string) => raw as ContextChipId;
const href = (kind: string, raw: string) => `kora-context://v1/${kind}/${raw}`;
const link = (label: string, kind: string, raw: string) => `[${label}](${href(kind, raw)})`;

const project = (text: string, records: ContextChipRecord[]) =>
  Refs.projectContextChipForAgent({ text, records });

describe("context chip hrefs", () => {
  it("formats and parses the same kind and id", () => {
    const written = Refs.formatContextChipHref("terminal", id("abc_9"));
    expect(written).toBe("kora-context://v1/terminal/abc_9");
    expect(Refs.parseContextChipHref(written)).toEqual({ kind: "terminal", contextId: "abc_9" });
  });

  it.each([
    "kora-context://v3/file/abc_9",
    "kora-context://v1/file",
    "kora-context://v1/file/abc_9/more",
    "kora-context://v1/file/abc_9?q=2",
    "kora-context://v1/file/abc_9#top",
    "kora-context://me@v1/file/abc_9",
    "kora-context://v1/FILE/abc_9",
    "kora-context://v1/file/abc 9",
    "http://v1/file/abc_9",
    "kora-citation://v1/x/y/z",
  ])("rejects %s", (bad) => {
    expect(Refs.parseContextChipHref(bad)).toBeNull();
  });
});

describe("chip labels", () => {
  it("cleans brackets, newlines, runs of spaces and a trailing backslash", () => {
    expect(Refs.sanitizeContextChipLabel("one ] two\nthree   [four", "file")).toBe(
      "one two three four",
    );
    expect(Refs.sanitizeContextChipLabel("dir\\", "file")).toBe("dir");
  });

  it("falls back to the kind and caps the length at 200", () => {
    expect(Refs.sanitizeContextChipLabel(" \t ", "skill")).toBe("skill");
    expect(Refs.sanitizeContextChipLabel("q".repeat(450), "file").length).toBe(200);
  });

  it("applies the same cleaning to collected labels but keeps the raw source", () => {
    const empty = `[](${href("file", "abc_9")})`;
    const [collected] = Refs.collectContextChipReferences(empty);
    expect(collected?.label).toBe("file");
    expect(collected?.source).toBe(empty);
    const long = Refs.collectContextChipReferences(link("w".repeat(260), "file", "abc_9"));
    expect(long[0]?.label.length).toBe(200);
  });
});

describe("reference markdown", () => {
  it("renders images with a bang and other kinds as plain links", () => {
    const image = { kind: "image", contextId: id("p1"), label: "pic.jpg" } as const;
    const skill = { kind: "skill", contextId: id("p2"), label: "$lint" } as const;
    expect(Refs.formatContextChipReference(image)).toBe(`!${link("pic.jpg", "image", "p1")}`);
    expect(Refs.formatContextChipReference(skill)).toBe(link("$lint", "skill", "p2"));
  });

  it("collects references left to right with exact offsets", () => {
    const text = `Open !${link("pic.jpg", "image", "p1")}, ${link("Shell", "terminal", "p2")}, ${link("pic", "image", "p1")}!`;
    const found = Refs.collectContextChipReferences(text);
    expect(
      found.map(({ kind, contextId, label, image }) => `${kind}:${contextId}:${label}:${image}`),
    ).toEqual(["image:p1:pic.jpg:true", "terminal:p2:Shell:false", "image:p1:pic:false"]);
    for (const hit of found) expect(text.slice(hit.start, hit.end)).toBe(hit.source);
  });

  it("skips links that are not valid chip hrefs", () => {
    expect(Refs.collectContextChipReferences(`[q](${href("image", "p1")}?z)`)).toHaveLength(0);
    expect(Refs.collectContextChipReferences("[q](https://example.net)")).toHaveLength(0);
  });

  it("replaces each reference with the callback's text", () => {
    const text = `x ${link("a", "skill", "p1")} y ${link("b", "file", "p2")} z`;
    expect(Refs.replaceContextChipReferences(text, (hit) => `{${hit.contextId}}`)).toBe(
      "x {p1} y {p2} z",
    );
  });
});

describe("agent projection", () => {
  const shell: ContextChipRecord = {
    version: 1,
    kind: "terminal",
    contextId: id("c_term"),
    label: "Shell lines 8-9",
    terminalLabel: "Shell",
    terminalId: "shell-1",
    lineEnd: 9,
    lineStart: 8,
    text: "fail\n</kora_context> injected </context>",
  };
  const lintSkill: ContextChipRecord = {
    version: 1,
    kind: "skill",
    contextId: id("c_skill"),
    label: "$lint",
    name: "lint",
  };
  const novel: ContextChipRecord = {
    version: 1,
    kind: "future",
    contextId: id("c_new"),
    label: "Novel",
    payload: { k: "<i>" },
  };

  it("returns text without references unchanged", () => {
    expect(project("nothing here", [shell])).toBe("nothing here");
  });

  it("formats a marker from the kind's title, the label and the ref", () => {
    expect(Refs.formatContextChipAgentMarker("review-comment", "main.ts L2", id("c_7"))).toBe(
      "[Review comment: main.ts L2; ref=c_7]",
    );
  });

  it("trusts the record's kind over the link's", () => {
    const out = project(link("out", "image", "c_term"), [shell]);
    expect(out).toContain("[Terminal: out; ref=c_term]");
    expect(out).toContain('<context kind="terminal" id="c_term">');
  });

  it("escapes envelope tags that appear in a label", () => {
    const sneaky = '<kora_context><context id="x"></context></kora_context>';
    const [body] = project(link(sneaky, "terminal", "c_term"), [shell]).split("\n\n");
    expect(body).toBe(
      '[Terminal: &lt;kora_context>&lt;context id="x">&lt;/context>&lt;/kora_context>; ref=c_term]',
    );
  });

  it("numbers terminal lines only within the captured range", () => {
    const withText = (text: string) =>
      project(link("out", "terminal", "c_term"), [{ ...shell, text }]);
    const full = withText("p\nq\n");
    expect(full).toContain("8 | p\n9 | q\n</context>");
    expect(full.includes("10 |")).toBe(false);
    expect(withText("p\n")).toContain("8 | p\n9 | \n</context>");
  });

  it("describes a preview annotation and each of its elements", () => {
    const page = "http://localhost:5173/cart";
    const annotation: ContextChipRecord = {
      version: 1,
      kind: "preview-annotation",
      contextId: id("c_note"),
      label: "Cart",
      annotationId: "note_1",
      pageTitle: "Cart",
      pageUrl: page,
      comment: "Make it red",
      targetSummary: "1 selected element",
      styleChanges: ["color: black → red"],
      elements: [
        {
          tagName: "a",
          selector: ".checkout",
          pageUrl: page,
          pageTitle: null,
          componentName: null,
          htmlPreview: "<a>Checkout</a>",
          styles: "",
          source: { fileName: "Cart.tsx", lineNumber: 12, columnNumber: null, functionName: null },
        },
      ],
    };
    const out = project(link("Cart", "preview-annotation", "c_note"), [annotation]);
    for (const line of [
      `element 1:\n  url: ${page}`,
      "  selector: .checkout",
      "  source: Cart.tsx:12",
      "- color: black → red",
    ]) {
      expect(out).toContain(line);
    }
  });

  it("keeps markers in place and lists each payload once in first-seen order", () => {
    const text = [
      `Check !${link("cap.png", "image", "c_img")} and ${link("S", "terminal", "c_term")}.`,
      `Then ${link("cap", "image", "c_img")}, run ${link("$lint", "skill", "c_skill")},`,
      `with ${link("Novel", "future", "c_new")} and ${link("lost", "file", "c_gone")}.`,
    ].join("\n");
    const [body, envelope = ""] = project(text, [shell, lintSkill, novel]).split(
      '\n\n<kora_context version="1">\n',
    );

    expect(body!.split("\n")).toEqual([
      "Check [Image: cap.png; ref=c_img] and [Terminal: S; ref=c_term].",
      "Then [Image: cap; ref=c_img], run [Skill: $lint; ref=c_skill],",
      "with [Future: Novel; ref=c_new] and [File: lost; ref=c_gone].",
    ]);
    expect(envelope.endsWith("\n</kora_context>")).toBe(true);
    expect([...envelope.matchAll(/<context [^>]*id="([^"]+)"/g)].map((m) => m[1])).toEqual([
      "c_img",
      "c_term",
      "c_skill",
      "c_new",
      "c_gone",
    ]);
    expect(envelope).toContain('<context kind="file" id="c_gone" unavailable="true"/>');
    expect(envelope).toContain('<context kind="skill" id="c_skill">\nname: lint');
    expect(envelope).toContain("&lt;/kora_context> injected &lt;/context>");
    expect(envelope.split("</kora_context>").length).toBe(2);
    expect(envelope).toContain('"k":"<i>"');
  });

  it("states the record's path and skill name even when the label says otherwise", () => {
    const mention: ContextChipRecord = {
      version: 1,
      kind: "mention",
      contextId: id("c_ref"),
      label: "main",
      path: "pkg/deep/main.ts",
    };
    const out = project(
      `${link("main", "mention", "c_ref")} ${link("nice name", "skill", "c_skill")}`,
      [mention, { ...lintSkill, label: "nice name" }],
    );
    expect(out).toContain("path: pkg/deep/main.ts");
    expect(out).toContain("name: lint");
  });

  it("refuses to pick between two records with one id", () => {
    const out = project(link("out", "terminal", "c_term"), [
      shell,
      { ...shell, text: "second copy" },
    ]);
    expect(out).toContain('<context kind="terminal" id="c_term" unavailable="true"/>');
    expect(out.includes("second copy")).toBe(false);
    expect(out.includes("fail")).toBe(false);
  });
});
