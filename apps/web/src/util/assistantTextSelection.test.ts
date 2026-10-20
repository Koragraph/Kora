import { HostId, ItemId, REPLY_FOOTNOTE_CONTEXT_LENGTH, ThreadId } from "@kora/contracts";
import { formatReplyFootnoteHref, parseReplyFootnoteHref } from "@kora/shared/assistantFootnotes";
import { describe, expect, it } from "vite-plus/test";
import * as AssistantText from "./assistantTextSelection";
type AssistantTextSelector = AssistantText.AssistantTextSelector;
const { findReplyFootnoteText, createAssistantTextSelector, captureAssistantTextSelection } =
  AssistantText;

function makeSelector(
  quote: string,
  extra: Partial<Omit<AssistantTextSelector, "text">> = {},
): AssistantTextSelector {
  const normalized = quote.replace(/\s+/g, " ");
  return {
    text: quote,
    start: 0,
    end: normalized.length,
    prefix: "",
    suffix: "",
    ...extra,
  };
}

function verifyHrefSerialization(sel: AssistantTextSelector) {
  const url = formatReplyFootnoteHref({
    version: 1,
    hostId: HostId.make("host-env"),
    threadId: ThreadId.make("test-thread"),
    messageId: ItemId.make("msg-id"),
    ...sel,
  });
  return parseReplyFootnoteHref(url);
}

// ---------------- DOM Mock Hierarchy ----------------

class MockNode {
  parent: MockNode | null = null;
  children: MockNode[] = [];

  constructor(
    readonly nodeName: string,
    public data: string = "",
    readonly attrs: Record<string, string> = {},
  ) {}

  get nodeType(): number {
    return this.nodeName === "#text" ? 3 : 1;
  }

  get tagName(): string {
    return this.nodeName.toUpperCase();
  }

  get length(): number {
    return this.nodeType === 3 ? this.data.length : this.children.length;
  }

  get parentElement(): MockNode | null {
    return this.parent;
  }

  get childNodes(): MockNode[] {
    return this.children;
  }

  addChildren(...nodes: MockNode[]): this {
    for (const child of nodes) {
      child.parent = this;
      this.children.push(child);
    }
    return this;
  }

  contains(other: MockNode | null): boolean {
    let curr: MockNode | null = other;
    while (curr) {
      if (curr === this) return true;
      curr = curr.parent;
    }
    return false;
  }

  matches(cssSelector: string): boolean {
    const parts = cssSelector.split(",").map((s) => s.trim());
    return parts.some((p) => {
      if (!p.startsWith("[")) {
        return p.toUpperCase() === this.tagName;
      }
      const match = /^\[([^=\]]+)(?:=(?:"([^"]*)"|([^\]]+)))?\]$/.exec(p);
      if (!match) return false;
      const key = match[1]!;
      const expectedVal = match[2] ?? match[3];
      if (!Object.prototype.hasOwnProperty.call(this.attrs, key)) return false;
      return expectedVal === undefined || this.attrs[key] === expectedVal;
    });
  }

  closest(cssSelector: string): MockNode | null {
    let curr: MockNode | null = this;
    while (curr) {
      if (curr.nodeType === 1 && curr.matches(cssSelector)) return curr;
      curr = curr.parent;
    }
    return null;
  }
}

function mkText(text: string): MockNode {
  return new MockNode("#text", text);
}

function mkElem(
  tag: string,
  attrs: Record<string, string> = {},
  ...children: MockNode[]
): MockNode {
  const el = new MockNode(tag, "", attrs);
  if (children.length > 0) el.addChildren(...children);
  return el;
}

function mkAssistantMessage(messageId: string, ...children: MockNode[]): MockNode {
  return mkElem("div", { "data-reply-footnote-source": messageId }, ...children);
}

class MockRange {
  public startContainer: MockNode;
  public startOffset: number;
  public endContainer: MockNode;
  public endOffset: number;
  private readonly positionMap: Map<MockNode, number[]>;

  constructor(init: {
    fromNode: MockNode;
    fromOffset: number;
    toNode: MockNode;
    toOffset: number;
    coords: Map<MockNode, number[]>;
  }) {
    this.startContainer = init.fromNode;
    this.startOffset = init.fromOffset;
    this.endContainer = init.toNode;
    this.endOffset = init.toOffset;
    this.positionMap = init.coords;
  }

  get collapsed(): boolean {
    return this.startContainer === this.endContainer && this.startOffset === this.endOffset;
  }

  get commonAncestorContainer(): MockNode {
    let ancestor: MockNode | null = this.startContainer;
    while (ancestor && !ancestor.contains(this.endContainer)) {
      ancestor = ancestor.parent;
    }
    return ancestor ?? this.startContainer;
  }

  cloneRange(): MockRange {
    return new MockRange({
      fromNode: this.startContainer,
      fromOffset: this.startOffset,
      toNode: this.endContainer,
      toOffset: this.endOffset,
      coords: this.positionMap,
    });
  }

  setStart(node: MockNode, offset: number) {
    this.startContainer = node;
    this.startOffset = offset;
  }

  setEnd(node: MockNode, offset: number) {
    this.endContainer = node;
    this.endOffset = offset;
  }

  private pointOrder(node: MockNode, offset: number): number {
    const list = this.positionMap.get(node);
    if (!list) return 0;
    return list[Math.min(offset, list.length - 1)] ?? 0;
  }

  intersectsNode(target: MockNode): boolean {
    const parentNode = target.parent;
    if (!parentNode) return true;
    const idx = parentNode.children.indexOf(target);
    const startOrder = this.pointOrder(parentNode, idx);
    const endOrder = this.pointOrder(parentNode, idx + 1);
    const rangeStart = this.pointOrder(this.startContainer, this.startOffset);
    const rangeEnd = this.pointOrder(this.endContainer, this.endOffset);
    return endOrder > rangeStart && startOrder < rangeEnd;
  }
}

function buildSelection(
  startTuple: [MockNode, number],
  endTuple: [MockNode, number],
  isBackwards = false,
): Selection {
  // Find tree root to build position linear index
  let root = startTuple[0];
  while (root.parent) root = root.parent;

  const positions = new Map<MockNode, number[]>();
  let counter = 0;

  function indexSubtree(node: MockNode) {
    const coords = [counter++];
    positions.set(node, coords);
    if (node.nodeType === 3) {
      for (let i = 0; i < node.data.length; i++) {
        coords.push(counter++);
      }
    } else {
      for (const child of node.children) {
        indexSubtree(child);
        coords.push(counter++);
      }
    }
  }
  indexSubtree(root);

  const range = new MockRange({
    fromNode: startTuple[0],
    fromOffset: startTuple[1],
    toNode: endTuple[0],
    toOffset: endTuple[1],
    coords: positions,
  });

  const [anchorTuple, focusTuple] = isBackwards ? [endTuple, startTuple] : [startTuple, endTuple];

  return {
    rangeCount: 1,
    isCollapsed: range.collapsed,
    getRangeAt: () => range,
    anchorNode: anchorTuple[0],
    anchorOffset: anchorTuple[1],
    focusNode: focusTuple[0],
    focusOffset: focusTuple[1],
  } as unknown as Selection;
}

// ---------------- Tests ----------------

describe("findReplyFootnoteText", () => {
  it.each([
    { start: 9, end: 2 },
    { start: Number.POSITIVE_INFINITY, end: Number.POSITIVE_INFINITY },
    { start: Number.NaN, end: Number.NaN },
    { start: 3.14, end: 9.81 },
    { start: -5, end: 3 },
  ])("ignores unusable stored offset hints: $start..$end", (offsets) => {
    const outcome = findReplyFootnoteText("target quote here", makeSelector("quote", offsets));
    expect(outcome).toEqual({ start: 7, end: 12 });
  });

  it.each(["", "   \t\n", "unmatched", "UPPER", "sub.str"])(
    "returns null for invalid or missing literal quote %j",
    (badQuote) => {
      expect(findReplyFootnoteText("sample text", makeSelector(badQuote))).toBeNull();
    },
  );

  it("locates unique text with up to 32 context characters without matching entire document", () => {
    const pfx = "a".repeat(REPLY_FOOTNOTE_CONTEXT_LENGTH - 1) + " ";
    const sfx = " " + "b".repeat(REPLY_FOOTNOTE_CONTEXT_LENGTH - 1);
    const doc = `prefix noise quote ${pfx}target${sfx} trailing noise`;
    const targetIdx = doc.indexOf("target");
    const found = findReplyFootnoteText(doc, makeSelector("target", { prefix: pfx, suffix: sfx }));
    expect(found).toEqual({
      start: targetIdx,
      end: targetIdx + "target".length,
    });
  });

  it("calculates UTF-16 code units properly for emojis and composite characters", () => {
    const content = "🌟 cafe\u0301 💡 completed";
    const found = findReplyFootnoteText(content, makeSelector("cafe\u0301 💡"));
    expect(found).toEqual({ start: 3, end: 11 });
  });

  it("retains leading whitespace offsets from the document start", () => {
    const res = findReplyFootnoteText("\n\n\t  token", makeSelector("token"));
    expect(res).toEqual({ start: 1, end: 6 });
  });

  it("normalizes non-breaking spaces and whitespace sequences", () => {
    const content = "intro\u00a0\n  selected\t words  \noutro";
    const res = findReplyFootnoteText(content, makeSelector("\nselected   words\t"));
    expect(res).toEqual({ start: 5, end: 21 });
  });

  it("handles code snippet indentation changes across lines", () => {
    const codeQuote = "function test() {\r\n    return 42;\r\n}";
    const doc = "Heading:\nfunction test() {\n\treturn 42;\n}\nFooter.";
    const res = findReplyFootnoteText(
      doc,
      makeSelector(codeQuote, { prefix: "Heading:\n", suffix: "\nFooter." }),
    );
    expect(res).toEqual({ start: 9, end: 39 });
  });

  it("considers overlapping matches when determining uniqueness", () => {
    expect(findReplyFootnoteText("banana", makeSelector("ana", { start: 1, end: 4 }))).toBeNull();
  });

  it("rejects duplicate quotes if neither instance matches both prefix and suffix", () => {
    const body = "p1 match wrong / wrong match p2";
    expect(
      findReplyFootnoteText(body, makeSelector("match", { prefix: "p1 ", suffix: " p2" })),
    ).toBeNull();
  });

  it("never relies on stored offsets or proximity to break ties when multiple context matches exist", () => {
    const repeated = "repeat quote finish / repeat quote finish";
    expect(
      findReplyFootnoteText(
        repeated,
        makeSelector("quote", { start: 7, end: 12, prefix: "repeat ", suffix: " finish" }),
      ),
    ).toBeNull();
  });

  it("avoids guessing between multiple identical matches lacking surrounding context", () => {
    expect(findReplyFootnoteText("hello hello hello", makeSelector("hello"))).toBeNull();
  });

  it.each([
    { prefix: "alpha ", suffix: "" },
    { prefix: "", suffix: " omega" },
  ])("resolves ambiguity if one context side uniquely identifies the quote", (ctx) => {
    const str = "alpha item beta / gamma item omega";
    const loc = findReplyFootnoteText(str, makeSelector("item", ctx));
    expect(loc).not.toBeNull();
  });

  it("still locates the match if surrounding non-context text was edited", () => {
    const original = "noise before phrase noise after";
    const edited = "different text phrase completely new suffix";
    const loc = findReplyFootnoteText(edited, makeSelector("phrase"));
    expect(loc).toEqual({ start: 15, end: 21 });
  });

  it("adjusts correctly when insertions before the quote shift its character position", () => {
    const updated = "newly prepended line\nneedle in haystack";
    const needleIdx = updated.indexOf("needle");
    const loc = findReplyFootnoteText(
      updated,
      makeSelector("needle", { start: 0, end: 6, suffix: " in haystack" }),
    );
    expect(loc).toEqual({ start: needleIdx, end: needleIdx + 6 });
  });
});

describe("createAssistantTextSelector", () => {
  it.each(["", "  \n\t  "])("returns null when selecting blank string %j", (blank) => {
    expect(createAssistantTextSelector(`prefix ${blank} suffix`, 7, 7 + blank.length)).toBeNull();
  });

  it("avoids splitting surrogate pairs at prefix and suffix boundaries", () => {
    const pfxPadding = "z".repeat(REPLY_FOOTNOTE_CONTEXT_LENGTH - 1);
    const sfxPadding = "w".repeat(REPLY_FOOTNOTE_CONTEXT_LENGTH - 1);
    const text = `🎉${pfxPadding}center${sfxPadding}🚀`;
    const centerStart = text.indexOf("center");
    const sel = createAssistantTextSelector(text, centerStart, centerStart + 6);
    expect(sel).not.toBeNull();
    expect(sel?.prefix).toBe(pfxPadding);
    expect(sel?.suffix).toBe(sfxPadding);
  });

  it("preserves multiline quotes through serialized citation URLs", () => {
    const fragment = "first line\r\n  second line 💡";
    const fullText = `Lead text ${fragment} tail text`;
    const offset = fullText.indexOf(fragment);
    const selector = createAssistantTextSelector(fullText, offset, offset + fragment.length);
    expect(selector).not.toBeNull();

    const parsed = verifyHrefSerialization(selector!);
    expect(parsed).toMatchObject({
      text: selector?.text,
      prefix: selector?.prefix,
      suffix: selector?.suffix,
    });
    expect(findReplyFootnoteText(fullText, parsed!)).toEqual({
      start: 10,
      end: 10 + "first line second line 💡".length,
    });
  });

  it.each([0, 30, 31, 32])(
    "includes intact emoji when context boundary allows with %d padding units",
    (padCount) => {
      const pad = "x".repeat(padCount);
      const str = `🎉${pad}core${pad}🔥`;
      const coreStart = str.indexOf("core");
      const result = createAssistantTextSelector(str, coreStart, coreStart + 4);
      expect(result).not.toBeNull();
      const fitsEmoji = padCount + 2 <= REPLY_FOOTNOTE_CONTEXT_LENGTH;
      expect(result?.prefix).toBe(`${fitsEmoji ? "🎉" : ""}${pad}`);
      expect(result?.suffix).toBe(`${pad}${fitsEmoji ? "🔥" : ""}`);
    },
  );

  it("preserves exact selection whitespace while normalizing position coordinates", () => {
    const raw = "Alpha \n  selected\t \n Omega";
    const startIdx = "Alpha \n".length;
    const endIdx = startIdx + "  selected\t".length;
    const res = createAssistantTextSelector(raw, startIdx, endIdx);
    expect(res).toEqual({
      text: "  selected\t",
      start: 5,
      end: 15,
      prefix: "Alpha",
      suffix: "Omega",
    });
  });
});

describe("captureAssistantTextSelection", () => {
  it("rejects selections outside the provided viewport", () => {
    const text = mkText("Detached message");
    mkAssistantMessage("msg-1", text);
    const viewport = mkElem("main");
    const sel = buildSelection([text, 0], [text, text.length]);
    expect(captureAssistantTextSelection(viewport as unknown as HTMLElement, sel)).toBeNull();
  });

  it("preserves multiline unicode and filters out buttons and hidden elements", () => {
    const part1 = mkText("Primary text 🌈 ");
    const part2 = mkText("code snippet\r\n  line 2 ⚡");
    const container = mkElem("main");
    const source = mkAssistantMessage(
      "msg-target",
      mkElem("p", {}, part1, mkElem("strong", {}, mkText("bold\u0301"))),
      mkElem("button", {}, mkText("Copy Action")),
      mkElem("span", { hidden: "true" }, mkText("Ignore Me")),
      mkElem("pre", {}, mkElem("code", {}, part2)),
    );
    container.addChildren(source);

    const sel = buildSelection([part1, 0], [part2, part2.length], true);
    const captured = captureAssistantTextSelection(container as unknown as HTMLElement, sel);
    expect(captured).not.toBeNull();
    expect(captured?.selector.text).toBe("Primary text 🌈 bold\u0301\ncode snippet\r\n  line 2 ⚡");
  });

  it.each([
    mkElem("button"),
    mkElem("span", { role: "button" }),
    mkElem("div", { contenteditable: "true" }),
    mkElem("div", { hidden: "" }),
    mkElem("span", { "aria-hidden": "true" }),
  ])("disallows selection endpoints inside interactive or hidden controls", (excludedEl) => {
    const text = mkText("Visible paragraph.");
    const controlText = mkText("Control");
    excludedEl.addChildren(controlText);
    const source = mkAssistantMessage("msg-1", text, excludedEl);
    const viewport = mkElem("main", {}, source);

    const sel = buildSelection([text, 0], [controlText, 1]);
    expect(captureAssistantTextSelection(viewport as unknown as HTMLElement, sel)).toBeNull();
  });

  it("allows selecting adjacent to a control as long as no control text is included", () => {
    const text = mkText("Readable message.");
    const btnText = mkText("Action");
    const source = mkAssistantMessage(
      "msg-1",
      mkElem("p", {}, text),
      mkElem("button", {}, btnText),
    );
    const viewport = mkElem("main", {}, source);

    const zeroOffsetSel = buildSelection([text, 0], [btnText, 0]);
    const captured = captureAssistantTextSelection(
      viewport as unknown as HTMLElement,
      zeroOffsetSel,
    );
    expect(captured).not.toBeNull();
    expect(captured?.selector.text).toBe("Readable message.");

    const nonZeroSel = buildSelection([text, 0], [btnText, 1]);
    expect(
      captureAssistantTextSelection(viewport as unknown as HTMLElement, nonZeroSel),
    ).toBeNull();
  });

  it.each([false, true])(
    "rejects selections spanning across multiple assistant message boundaries (backwards=%s)",
    (backwards) => {
      const first = mkText("Message one content.");
      const second = mkText("Message two content.");
      const viewport = mkElem(
        "main",
        {},
        mkAssistantMessage("msg-1", first),
        mkAssistantMessage("msg-2", second),
      );
      const sel = buildSelection([first, 0], [second, 1], backwards);
      expect(captureAssistantTextSelection(viewport as unknown as HTMLElement, sel)).toBeNull();
    },
  );

  it("ignores zero-width boundary touch from preceding message", () => {
    const prior = mkText("Prior response.");
    const current = mkText("Target response.");
    const currentSource = mkAssistantMessage("msg-2", current);
    const viewport = mkElem("main", {}, mkAssistantMessage("msg-1", prior), currentSource);
    const sel = buildSelection([prior, prior.length], [current, current.length]);
    const captured = captureAssistantTextSelection(viewport as unknown as HTMLElement, sel);
    expect(captured?.source).toBe(currentSource);
    expect(captured?.selector.text).toBe("Target response.");
  });

  it("tolerates selection ending at next element boundary at offset 0", () => {
    const paragraphText = mkText("Active paragraph selection.");
    const nextText = mkText("Following paragraph.");
    const source = mkAssistantMessage("msg-curr", mkElem("p", {}, paragraphText));
    const nextBlock = mkAssistantMessage("msg-next", mkElem("p", {}, nextText));
    const viewport = mkElem("main", {}, source, nextBlock);

    const sel = buildSelection([paragraphText, 0], [nextText, 0]);
    const captured = captureAssistantTextSelection(viewport as unknown as HTMLElement, sel);
    expect(captured?.source).toBe(source);
    expect(captured?.selector.text).toBe("Active paragraph selection.");
  });
});
