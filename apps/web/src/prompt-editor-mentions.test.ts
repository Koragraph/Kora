import { HostId, ItemId, ThreadId, type ReplyFootnote } from "@kora/contracts";
import { serializeReplyFootnote } from "@kora/shared/assistantFootnotes";
import { describe, expect, it } from "vite-plus/test";

import {
  collectPromptEditorInlineTokens,
  selectionTouchesMentionBoundary,
  splitPromptIntoPromptSegments,
} from "./prompt-editor-mentions";
import { formatTerminalExcerptReference } from "./util/terminalContext";

const text = (value: string) => ({ type: "text" as const, text: value });
const mention = (path: string, source: string) => ({ type: "mention" as const, path, source });
const skill = (name: string) => ({ type: "skill" as const, name });

const shellRef = formatTerminalExcerptReference({
  id: "ctx-7",
  terminalLabel: "Shell 2",
  lineStart: 10,
  lineEnd: 12,
});
const shellChip = {
  type: "context-reference" as const,
  kind: "terminal",
  contextId: "terminal_ctx-7",
  label: "Shell 2 lines 10-12",
  source: shellRef,
};

const quote: ReplyFootnote = {
  version: 1,
  hostId: HostId.make("laptop/ホスト"),
  threadId: ThreadId.make("thr-9"),
  messageId: ItemId.make("msg-9"),
  text: 'Run @README.md then $ship and "猫 🐈" (twice).',
  start: 2,
  end: 40,
  prefix: "頭: ",
  suffix: " 尾",
};
const quoteSource = serializeReplyFootnote(quote);
const secondQuote: ReplyFootnote = { ...quote, messageId: ItemId.make("msg-10"), text: "Another" };
const secondQuoteSource = serializeReplyFootnote(secondQuote);
const quoteChip = { type: "citation" as const, citation: quote, source: quoteSource };

const split = splitPromptIntoPromptSegments;

describe("splitPromptIntoPromptSegments: plain input", () => {
  it("returns no segments for an empty prompt", () => {
    expect(split("")).toEqual([]);
  });

  it("returns a single text segment when nothing is tokenised", () => {
    expect(split("just words")).toEqual([text("just words")]);
  });
});

describe("splitPromptIntoPromptSegments: @file mentions", () => {
  const cases: Array<[string, string, ReturnType<typeof split>]> = [
    [
      "bare path",
      "Open @Makefile now",
      [text("Open "), mention("Makefile", "@Makefile"), text(" now")],
    ],
    [
      "newline on both sides",
      "a\n@notes.txt \nb",
      [text("a\n"), mention("notes.txt", "@notes.txt"), text(" \nb")],
    ],
    [
      "quoted path with a space",
      'Open @"Meeting Notes.md" now',
      [text("Open "), mention("Meeting Notes.md", '@"Meeting Notes.md"'), text(" now")],
    ],
    [
      "quoted path with escaped quotes",
      'Open @"a/The \\"Plan\\".md" now',
      [text("Open "), mention('a/The "Plan".md', '@"a/The \\"Plan\\".md"'), text(" now")],
    ],
    [
      "generated markdown file link",
      "See [pnpm-lock.yaml](ci/pnpm-lock.yaml) here",
      [
        text("See "),
        mention("ci/pnpm-lock.yaml", "[pnpm-lock.yaml](ci/pnpm-lock.yaml)"),
        text(" here"),
      ],
    ],
    [
      "markdown link with percent-encoded reserved characters",
      "See [a#b?.ts](a%23b%3F.ts) here",
      [text("See "), mention("a#b?.ts", "[a#b?.ts](a%23b%3F.ts)"), text(" here")],
    ],
    [
      "markdown link to a scoped folder",
      "See [lib](@org/pkg/lib) here",
      [text("See "), mention("@org/pkg/lib", "[lib](@org/pkg/lib)"), text(" here")],
    ],
  ];

  it.each(cases)("%s", (_name, prompt, expected) => {
    expect(split(prompt)).toEqual(expected);
  });

  const staysText: Array<[string, string]> = [
    ["a trailing mention with no terminator yet", "Open @Makefile"],
    ["an http link", "Visit [site](https://example.org/a) today"],
    ["scoped package @expo/ui", "Add @expo/ui please"],
    ["scoped package with extension", "Add @someone/lib.js please"],
    ["deep scoped package path", "Add @org/pkg/a/b/c please"],
    ["scoped package next to an ideographic space", "追加 @expo/ui　お願い"],
  ];

  it.each(staysText)("leaves %s as text", (_name, prompt) => {
    expect(split(prompt)).toEqual([text(prompt)]);
  });
});

describe("splitPromptIntoPromptSegments: $skill tokens", () => {
  it.each([
    ["hyphenated", "Run $lint-fix now", "lint-fix"],
    ["starting with a digit", "Run $3way now", "3way"],
  ])("recognises a %s skill name", (_label, prompt, name) => {
    const [head, tail] = prompt.split(`$${name}`);
    expect(split(prompt)).toEqual([text(head!), skill(name), text(tail!)]);
  });

  it("waits for a terminator before converting", () => {
    expect(split("Run $lint-fix")).toEqual([text("Run $lint-fix")]);
  });

  it.each(["Pay $5 today", "Raise is $12k soon", "Worth $300M overall", "Rate $2e9 here"])(
    "treats the money-like %j as text",
    (prompt) => {
      expect(split(prompt)).toEqual([text(prompt)]);
    },
  );
});

describe("splitPromptIntoPromptSegments: context references", () => {
  it("places a chip between surrounding text and mentions", () => {
    expect(split(`See ${shellRef} @a.ts end`)).toEqual([
      text("See "),
      shellChip,
      text(" "),
      mention("a.ts", "@a.ts"),
      text(" end"),
    ]);
  });

  it("keeps back-to-back chips in order", () => {
    expect(split(`${shellRef}${shellRef}rest`)).toEqual([shellChip, shellChip, text("rest")]);
  });

  it("mixes chips with skills and mentions", () => {
    expect(split(`See ${shellRef} $lint-fix then @a.ts `)).toEqual([
      text("See "),
      shellChip,
      text(" "),
      skill("lint-fix"),
      text(" then "),
      mention("a.ts", "@a.ts"),
      text(" "),
    ]);
  });

  it("leaves a context link with an unparsable href as text", () => {
    const prompt = "ref [y](kora-context://v1/terminal/ctx 9) end";
    expect(split(prompt)).toEqual([text(prompt)]);
  });
});

describe("splitPromptIntoPromptSegments: assistant citations", () => {
  it("keeps two citations whole beside punctuation and CJK text", () => {
    expect(split(`頭(${quoteSource}),${secondQuoteSource}尾`)).toEqual([
      text("頭("),
      quoteChip,
      text("),"),
      { type: "citation", citation: secondQuote, source: secondQuoteSource },
      text("尾"),
    ]);
  });

  it("round-trips the exact source of citations that end the prompt", () => {
    const source = quoteSource.replaceAll("+", "%20");
    expect(split(`${source}${source}`)).toEqual([
      { type: "citation", citation: quote, source },
      { type: "citation", citation: quote, source },
    ]);
  });

  it.each(["@", "@README.md"])("a citation survives directly after the dangling %j", (lead) => {
    expect(split(`${lead}${quoteSource}`)).toEqual([text(lead), quoteChip]);
  });

  it("coexists with mentions, skills and chips", () => {
    expect(split(`@a.ts ${quoteSource}\n$ship ${shellRef}${quoteSource}`)).toEqual([
      mention("a.ts", "@a.ts"),
      text(" "),
      quoteChip,
      text("\n"),
      skill("ship"),
      text(" "),
      shellChip,
      quoteChip,
    ]);
  });

  it("keeps a malformed citation link editable", () => {
    const prompt = "[quote](kora-citation://v1/env/thread/message?text=no+metadata)";
    expect(split(prompt)).toEqual([text(prompt)]);
  });
});

describe("collectPromptEditorInlineTokens", () => {
  it("returns tokens in document order with citations placed among them", () => {
    const prompt = `@a.ts ${quoteSource} $ship `;
    const kinds = collectPromptEditorInlineTokens(prompt).map((token) => token.type);
    expect(kinds).toEqual(["mention", "citation", "skill"]);
  });

  it("returns nothing for text without tokens", () => {
    expect(collectPromptEditorInlineTokens("plain")).toEqual([]);
  });
});

describe("selectionTouchesMentionBoundary", () => {
  const touches = selectionTouchesMentionBoundary;

  it("is false for an empty prompt or an empty / inverted range", () => {
    expect(touches("", 0, 0)).toBe(false);
    expect(touches("x @a.ts y", 4, 4)).toBe(false);
    expect(touches("x @a.ts y", 6, 3)).toBe(false);
  });

  it("is true when the range covers the space right after a mention", () => {
    const prompt = "x @a.ts y";
    expect(touches(prompt, "x @a.ts".length, prompt.length)).toBe(true);
  });

  it("is true when the range covers the space right before a mention", () => {
    const prompt = "x y @a.ts z";
    expect(touches(prompt, "x y".length, "x y ".length)).toBe(true);
  });

  it("is false once the range starts past the trailing space", () => {
    const prompt = "x @a.ts y";
    expect(touches(prompt, "x @a.ts ".length, prompt.length)).toBe(false);
  });

  it("is false for the space before text that only looks like a mention before a citation", () => {
    const prompt = `pre @${quoteSource}`;
    expect(touches(prompt, "pre".length, "pre ".length)).toBe(false);
  });

  it.each([
    ["a mention after a context chip", `${shellRef} @a.ts end`, `${shellRef} @a.ts`],
    ["a quoted mention", 'x @"My Doc.md" y', 'x @"My Doc.md"'],
    ["a markdown file link", "x [a.ts](src/a.ts) y", "x [a.ts](src/a.ts)"],
  ])("is true for the space after %s", (_label, prompt, upToMention) => {
    expect(touches(prompt, upToMention.length, prompt.length)).toBe(true);
  });
});
