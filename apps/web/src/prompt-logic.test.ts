import { HostId, ItemId, ThreadId, type ReplyFootnote } from "@kora/contracts";
import {
  collectAssistantFootnotes,
  expandAssistantFootnotesForAgent,
  serializeReplyFootnote,
} from "@kora/shared/assistantFootnotes";
import { describe, expect, it } from "vite-plus/test";

import {
  clampCollapsedPromptCursor,
  collapseExpandedPromptCursor,
  detectPromptTrigger,
  expandCollapsedPromptCursor,
  formatReplyFootnoteForPrompt,
  isCollapsedCursorAdjacentToInlineToken,
  isPromptTriggerDismissed,
  parseStandalonePromptSlashCommand,
  promptSubmissionIntentForEnter,
  replaceTextRange,
} from "./prompt-logic";
import { formatTerminalExcerptReference } from "./util/terminalContext";

const shellRef = formatTerminalExcerptReference({
  id: "ctx-42",
  terminalLabel: "Shell 3",
  lineStart: 20,
  lineEnd: 25,
});

const quote: ReplyFootnote = {
  version: 1,
  hostId: HostId.make("host-b"),
  threadId: ThreadId.make("thr-b"),
  messageId: ItemId.make("msg-b"),
  text: "Emoji 🚀 survive, as do (parentheses).",
  start: 1,
  end: 30,
  prefix: "先: ",
  suffix: " 後",
};
const quoteSource = serializeReplyFootnote(quote).replaceAll("+", "%20");

/** One placeholder per inline token, matching how the editor shows pills. */
const PILL = "□";

describe("slash command parsing", () => {
  it.each([
    ["/plan", "plan"],
    ["  /plan\n", "plan"],
    ["/default", "default"],
    ["/PLAN", "plan"],
    ["/Default", "default"],
  ] as const)("%j is the standalone command %s", (input, expected) => {
    expect(parseStandalonePromptSlashCommand(input)).toBe(expected);
  });

  it.each(["/plan do the thing", "/default now", "/model", "plan", "/plans", "", "x /plan"])(
    "%j is not a standalone command",
    (input) => {
      expect(parseStandalonePromptSlashCommand(input)).toBeNull();
    },
  );
});

describe("Enter key intent", () => {
  it.each([
    [false, "foreground"],
    [true, null],
  ] as const)("shiftKey=%s gives %s", (shiftKey, expected) => {
    expect(promptSubmissionIntentForEnter({ shiftKey })).toBe(expected);
  });
});

describe("replaceTextRange", () => {
  it("swaps the range and parks the cursor after the replacement", () => {
    expect(replaceTextRange("go @ab", 3, 6, "@abc.ts ")).toEqual({
      text: "go @abc.ts ",
      cursor: 11,
    });
  });

  it("can delete a range", () => {
    expect(replaceTextRange("hi @x", 3, 5, "")).toEqual({ text: "hi ", cursor: 3 });
  });

  it("clamps offsets that fall outside the string", () => {
    expect(replaceTextRange("abc", -5, 99, "Z")).toEqual({ text: "Z", cursor: 1 });
    expect(replaceTextRange("abc", 2, 1, "Z")).toEqual({ text: "abZc", cursor: 3 });
  });

  it("leaves a doubled space unless the caller extends the range over the old one", () => {
    const prompt = "then @RE finish";
    const from = "then ".length;
    const to = "then @RE".length;

    expect(replaceTextRange(prompt, from, to, "@README.md ").text).toBe("then @README.md  finish");
    const widened = prompt[to] === " " ? to + 1 : to;
    expect(replaceTextRange(prompt, from, widened, "@README.md ").text).toBe(
      "then @README.md finish",
    );
  });
});

describe("detectPromptTrigger", () => {
  const detect = (prompt: string, caret = prompt.length) => detectPromptTrigger(prompt, caret);

  it.each([
    ["path with a nested query", "Look at @lib/ut", "path", "lib/ut", "Look at ".length],
    ["empty path query", "Look at @", "path", "", "Look at ".length],
    ["skill", "Try $bu", "skill", "bu", "Try ".length],
    ["slash command", "/exp", "slash-command", "exp", 0],
    ["bare slash", "/", "slash-command", "", 0],
    ["slash on a later line", "hello\n/he", "slash-command", "he", "hello\n".length],
  ] as const)("%s", (_label, prompt, kind, query, rangeStart) => {
    expect(detect(prompt)).toEqual({ kind, query, rangeStart, rangeEnd: prompt.length });
  });

  it("only looks left of the caret when the @ sits inside existing text", () => {
    const prompt = "Check @ut for details";
    const caret = "Check @ut".length;
    expect(detect(prompt, caret)).toEqual({
      kind: "path",
      query: "ut",
      rangeStart: "Check ".length,
      rangeEnd: caret,
    });
    expect(detect(prompt, "Check @".length)?.query).toBe("");
  });

  it.each(["# Title", "bug#77", "plain words", "email me", "/cmd with args", ""])(
    "opens nothing for %j",
    (prompt) => {
      expect(detect(prompt)).toBeNull();
    },
  );

  it("treats a slash that is not at line start as ordinary text", () => {
    expect(detect("see /usr")).toBeNull();
  });

  it("clamps non-finite and out-of-range carets", () => {
    expect(detect("go @a", Number.POSITIVE_INFINITY)?.query).toBe("a");
    expect(detect("go @a", 500)?.query).toBe("a");
    expect(detect("go @a", -4)).toBeNull();
  });

  it("goes quiet once the caret is past a finished mention", () => {
    const prompt = "open @LICENSE ";
    const caretAfterPill = "open ".length + 2;
    expect(detect(prompt, expandCollapsedPromptCursor(prompt, caretAfterPill))).toBeNull();
  });
});

describe("isPromptTriggerDismissed", () => {
  const slashAtStart = { kind: "slash-command" as const, rangeStart: 0 };

  it("holds while the same trigger grows", () => {
    const first = detectPromptTrigger("/", 1);
    expect(isPromptTriggerDismissed(first, slashAtStart)).toBe(true);
    expect(isPromptTriggerDismissed(detectPromptTrigger("/revi", 5), slashAtStart)).toBe(true);
  });

  it.each([
    ["a trigger on another line", detectPromptTrigger("x\n/", 3)],
    ["a different kind at the same start", detectPromptTrigger("$s", 2)],
    ["no trigger at all", null],
  ])("is lifted for %s", (_label, trigger) => {
    expect(isPromptTriggerDismissed(trigger, slashAtStart)).toBe(false);
  });

  it("is never dismissed when nothing was dismissed", () => {
    expect(isPromptTriggerDismissed(detectPromptTrigger("/", 1), null)).toBe(false);
  });
});

describe("cursor mapping between expanded text and collapsed pills", () => {
  // Each case: the text, and pairs of [collapsed cursor, expanded cursor] that must map both ways.
  const mappings: Array<[string, string, Array<[number, number]>]> = [
    [
      "a skill",
      "do $lint-fix soon",
      [
        [3, 3],
        [4, "do $lint-fix".length],
        [5, "do $lint-fix ".length],
      ],
    ],
    [
      "a bare @mention",
      "see @NOTES.md ok",
      [
        [4, "see ".length],
        [5, "see @NOTES.md".length],
        [6, "see @NOTES.md ".length],
      ],
    ],
    [
      "a quoted @mention",
      'see @"My Notes.md" ok',
      [
        [4, 4],
        [5, 'see @"My Notes.md"'.length],
        [6, 'see @"My Notes.md" '.length],
      ],
    ],
    [
      "a markdown file link",
      "see [x.ts](src/x.ts) ok",
      [
        [4, 4],
        [5, "see [x.ts](src/x.ts)".length],
        [6, "see [x.ts](src/x.ts) ".length],
      ],
    ],
    [
      "a terminal chip",
      `see ${shellRef} ok`,
      [
        [4, 4],
        [5, `see ${shellRef}`.length],
        [6, `see ${shellRef} `.length],
      ],
    ],
  ];

  it.each(mappings)("round-trips around %s", (_label, prompt, pairs) => {
    for (const [collapsed, expanded] of pairs) {
      expect(expandCollapsedPromptCursor(prompt, collapsed)).toBe(expanded);
      expect(collapseExpandedPromptCursor(prompt, expanded)).toBe(collapsed);
    }
  });

  it("is the identity when there are no tokens", () => {
    expect(expandCollapsedPromptCursor("nothing here", 7)).toBe(7);
    expect(collapseExpandedPromptCursor("nothing here", 7)).toBe(7);
  });

  it("is the identity for an empty prompt", () => {
    expect(expandCollapsedPromptCursor("", 0)).toBe(0);
    expect(collapseExpandedPromptCursor("", 0)).toBe(0);
  });

  it("snaps a caret inside a token to just after its pill", () => {
    const prompt = "a @NOTES.md b";
    for (const inside of ["a @".length, "a @NOTES".length]) {
      expect(collapseExpandedPromptCursor(prompt, inside)).toBe("a ".length + 1);
    }
  });

  it("does not count package-like @scope/name text as a pill", () => {
    const prompt = "add @org/lib then @CHANGELOG.md ";
    const collapsed = collapseExpandedPromptCursor(prompt, prompt.length);
    expect(collapsed).toBe("add @org/lib then ".length + 1 + 1);
    expect(expandCollapsedPromptCursor(prompt, collapsed)).toBe(prompt.length);
  });

  it("keeps package-like text expanded even after an earlier real mention", () => {
    const prompt = "open @CHANGELOG.md then @docs/readme ";
    const collapsed = collapseExpandedPromptCursor(prompt, prompt.length);
    expect(collapsed).toBe("open ".length + 1 + " then @docs/readme ".length);
    expect(expandCollapsedPromptCursor(prompt, collapsed)).toBe(prompt.length);
  });
});

describe("clampCollapsedPromptCursor", () => {
  const prompt = "open @CHANGELOG.md then ";
  const collapsedLength = "open ".length + 1 + " then ".length;

  it.each([
    ["inside range", 3, 3],
    ["at the end", collapsedLength, collapsedLength],
    ["past the end", 999, collapsedLength],
    ["Infinity", Number.POSITIVE_INFINITY, collapsedLength],
    ["NaN", Number.NaN, collapsedLength],
    ["negative", -3, 0],
    ["fractional", 2.9, 2],
  ])("%s", (_label, input, expected) => {
    expect(clampCollapsedPromptCursor(prompt, input)).toBe(expected);
  });
});

describe("pill adjacency", () => {
  const adjacent = isCollapsedCursorAdjacentToInlineToken;

  it.each([
    ["a skill", "go $lint-fix now", "go ".length],
    ["a terminal chip", `go ${shellRef} now`, "go ".length],
    ["a mention", "go @NOTES.md now", "go ".length],
  ])("is right-adjacent at the start of %s and left-adjacent one past it", (_l, prompt, start) => {
    expect(adjacent(prompt, start, "right")).toBe(true);
    expect(adjacent(prompt, start + 1, "left")).toBe(true);
  });

  it("is strict about which side counts", () => {
    const prompt = "go @NOTES.md now";
    const start = "go ".length;
    expect(adjacent(prompt, start + 1, "right")).toBe(false);
    expect(adjacent(prompt, start - 1, "right")).toBe(false);
    expect(adjacent(prompt, start, "left")).toBe(false);
    expect(adjacent(prompt, start + 2, "left")).toBe(false);
  });

  it.each(["no pills here", "typing @par"])("is never adjacent in %j", (prompt) => {
    for (const side of ["left", "right"] as const) {
      expect(adjacent(prompt, prompt.length, side)).toBe(false);
      expect(adjacent(prompt, 4, side)).toBe(false);
    }
  });
});

describe("assistant citation pills", () => {
  it("deleting one collapsed citation leaves its twin and the punctuation alone", () => {
    const prompt = `[${quoteSource}];${quoteSource}?`;
    const result = replaceTextRange(
      prompt,
      expandCollapsedPromptCursor(prompt, 1),
      expandCollapsedPromptCursor(prompt, 2),
      "",
    );

    expect(result).toEqual({ text: `[];${quoteSource}?`, cursor: 1 });
    expect(collapseExpandedPromptCursor(result.text, result.text.length)).toBe(
      `[];${PILL}?`.length,
    );
  });

  it("snaps every offset inside a citation to the end of its pill", () => {
    const lead = "先🚀";
    const prompt = `${lead}${quoteSource}.`;

    for (const inside of [1, quoteSource.length - 1, quoteSource.length]) {
      expect(collapseExpandedPromptCursor(prompt, lead.length + inside)).toBe(lead.length + 1);
    }
    expect(isCollapsedCursorAdjacentToInlineToken(prompt, lead.length, "right")).toBe(true);
    expect(isCollapsedCursorAdjacentToInlineToken(prompt, lead.length + 1, "left")).toBe(true);
    expect(isCollapsedCursorAdjacentToInlineToken(prompt, lead.length + 2, "left")).toBe(false);
  });

  it("maps every collapsed position back to itself in a prompt full of token kinds", () => {
    const lead = "🚀(";
    const middle = "),猫";
    const tail = " @LICENSE $ship ";
    const prompt = `${lead}${quoteSource}${middle}${quoteSource}${tail}${shellRef}!`;
    const collapsedLength = `${lead}${PILL}${middle}${PILL} ${PILL} ${PILL} ${PILL}!`.length;

    const anchors: Array<[number, number]> = [
      [collapsedLength, prompt.length],
      [lead.length + 2 + middle.length, lead.length + quoteSource.length * 2 + middle.length],
      [lead.length + 1 + middle.length, lead.length + quoteSource.length + middle.length],
      [lead.length + 1, lead.length + quoteSource.length],
      [lead.length, lead.length],
    ];
    for (const [collapsed, expanded] of anchors) {
      expect(expandCollapsedPromptCursor(prompt, collapsed)).toBe(expanded);
      expect(collapseExpandedPromptCursor(prompt, expanded)).toBe(collapsed);
    }
    for (let at = 0; at <= collapsedLength; at += 1) {
      expect(collapseExpandedPromptCursor(prompt, expandCollapsedPromptCursor(prompt, at))).toBe(
        at,
      );
    }
    expect(clampCollapsedPromptCursor(prompt, Number.POSITIVE_INFINITY)).toBe(collapsedLength);
  });
});

describe("formatReplyFootnoteForPrompt", () => {
  it("attaches a trimmed multiline remark to the citation and adds nothing else", () => {
    const remark = 'Is "this" right? 🚀\n  Show a sample.';
    const inserted = formatReplyFootnoteForPrompt(quote, `\n  ${remark}  \n`);
    const bound = { ...quote, comment: remark };

    expect(inserted).toBe(`${serializeReplyFootnote(bound)} `);
    expect(collectAssistantFootnotes(inserted).map((entry) => entry.citation)).toEqual([bound]);
    expect(expandAssistantFootnotesForAgent(inserted)).toMatch(/^\[assistant-quote-1\] \n\n/);
  });

  it.each([undefined, "", "   ", "\n\t \n"])(
    "inserts only the citation for remark %j",
    (remark) => {
      expect(formatReplyFootnoteForPrompt(quote, remark)).toBe(`${serializeReplyFootnote(quote)} `);
    },
  );
});
