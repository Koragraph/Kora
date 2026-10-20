import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ThreadMessage, ThreadTurnStartCommand } from "./chat.ts";
import { CONTEXT_CHIP_KINDS, ContextChipRecord, ThreadMessageContext } from "./contextChip.ts";

const record = Schema.decodeUnknownOption(ContextChipRecord);
const context = Schema.decodeUnknownSync(ThreadMessageContext);
const accepts = (input: unknown) => Option.isSome(record(input));

type Kind = (typeof CONTEXT_CHIP_KINDS)[number];

const PAGE = "http://127.0.0.1:5173/cart";
const head = (contextId = "chip_a") => ({ contextId, version: 1 }) as const;

const pageElement = {
  tagName: "a",
  selector: ".buy",
  pageUrl: PAGE,
  pageTitle: "Cart",
  componentName: "BuyLink",
  htmlPreview: "<a>Buy</a>",
  styles: "",
  source: null,
};

const sample: Record<Kind, Record<string, unknown>> = {
  terminal: {
    ...head(),
    kind: "terminal",
    text: "panic: nil map\n  at run.go:9",
    lineEnd: 42,
    lineStart: 40,
    terminalLabel: "Shell 2",
    terminalId: "sh-2",
    label: "Shell 2 lines 40-42",
  },
  element: {
    ...head(),
    kind: "element",
    ...pageElement,
    label: "<BuyLink>",
    styles: "font-weight: 600;",
    source: { fileName: "BuyLink.tsx", lineNumber: 7, columnNumber: 1, functionName: "BuyLink" },
  },
  "preview-annotation": {
    ...head(),
    kind: "preview-annotation",
    label: "Cart",
    annotationId: "note_9",
    pageTitle: "Cart",
    pageUrl: PAGE,
    comment: "Make the link bolder",
    targetSummary: "1 selected element",
    styleChanges: ["font-weight: 700"],
    elements: [pageElement],
  },
  "review-comment": {
    ...head(),
    kind: "review-comment",
    label: "router.ts L88",
    filePath: "src/router.ts",
    rangeLabel: "L88",
    startIndex: 88,
    endIndex: 88,
    sectionTitle: "Edits",
    sectionId: "sec-3",
    text: "Is this branch reachable?",
    diff: "- return null;",
    fenceLanguage: "diff",
  },
  mention: { ...head(), kind: "mention", path: "lib/util.ts", label: "@lib/util.ts" },
  skill: { ...head(), kind: "skill", name: "lint", label: "$lint" },
};

describe("context chip records", () => {
  it.each(CONTEXT_CHIP_KINDS)("decodes a %s record unchanged", (kind) => {
    expect(Option.getOrNull(record(sample[kind]))).toEqual(sample[kind]);
  });

  it("keeps a kind from a newer build together with its payload", () => {
    const novel = { ...head(), kind: "sticky-note", label: "Note", payload: { lines: ["a", "b"] } };
    expect(Option.getOrNull(record(novel))).toEqual(novel);
  });

  it("does not treat a broken known kind as an unknown one", () => {
    expect(accepts({ ...head(), kind: "terminal", label: "half" })).toBe(false);
  });

  it("caps the serialized payload of unknown kinds", () => {
    const novel = { ...head(), kind: "sticky-note", label: "Note" };
    expect(accepts({ ...novel, payload: "p".repeat(63_998) })).toBe(true);
    expect(accepts({ ...novel, payload: "p".repeat(63_999) })).toBe(false);
    // Escaping counts: each quote doubles in JSON.
    expect(accepts({ ...novel, payload: '"'.repeat(32_000) })).toBe(false);

    const lint = { ...sample.skill, contextId: "chip_lint" };
    const decoded = context({
      version: 1,
      records: [{ ...novel, payload: "p".repeat(64_000) }, lint],
    });
    expect(decoded.records).toEqual([lint]);
  });

  it.each([
    ["an id with a space", { contextId: "chip a" }],
    ["version 2", { version: 2 }],
    ["a kind that is not a slug", { kind: "Sticky Note" }],
  ])("refuses %s", (_label, override) => {
    expect(accepts({ ...sample.skill, ...override })).toBe(false);
  });
});

describe("message context", () => {
  it("limits the total size even when every record is fine on its own", () => {
    const heavy = {
      ...sample["preview-annotation"],
      styleChangeDetails: Array.from({ length: 200 }, () => ({
        targetId: "t",
        selector: null,
        property: "content",
        previousValue: "o".repeat(8_000),
        value: "n".repeat(8_000),
      })),
    };
    expect(accepts(heavy)).toBe(true);
    expect(() => context({ version: 1, records: [heavy] })).not.toThrow();
    const six = [0, 1, 2, 3, 4, 5].map((n) => ({ ...heavy, contextId: `chip_${n}` }));
    expect(() => context({ version: 1, records: six })).toThrow();
  });

  it("trims ids and names", () => {
    const decoded = context({
      version: 1,
      records: [{ ...sample.skill, contextId: " chip_a\t", name: " fmt " }],
    });
    expect(decoded.records[0]).toMatchObject({ contextId: "chip_a", name: "fmt" });
  });

  it("refuses more than 200 records before looking at any of them", () => {
    expect(() => context({ version: 1, records: new Array(201).fill({}) })).toThrow();
  });

  it("drops records that do not decode and keeps the others", () => {
    const decoded = context({
      version: 1,
      records: [
        sample.skill,
        { kind: "terminal", version: 1 },
        { ...sample.terminal, contextId: "chip_b" },
      ],
    });
    expect(decoded.records.map(({ kind }) => kind)).toEqual(["skill", "terminal"]);
  });

  it("refuses two records whose ids are equal once trimmed", () => {
    expect(() =>
      context({
        version: 1,
        records: [sample.skill, { ...sample.terminal, contextId: "  chip_a " }],
      }),
    ).toThrow();
  });

  it("is optional on stored messages and on turn.start", () => {
    const at = "2025-04-04T04:04:04.000Z";
    const message = {
      createdAt: at,
      updatedAt: at,
      id: "msg-1",
      turnId: null,
      role: "user",
      streaming: false,
      text: "look",
    };
    const decodeMessage = Schema.decodeUnknownSync(ThreadMessage);
    expect(decodeMessage(message).context).toBeUndefined();
    expect(
      decodeMessage({ ...message, context: { version: 1, records: [sample.mention] } }).context
        ?.records.length,
    ).toBe(1);

    const turn = Schema.decodeUnknownSync(ThreadTurnStartCommand)({
      type: "turn.start",
      commandId: "cmd-1",
      threadId: "th-1",
      createdAt: at,
      message: {
        messageId: "msg-1",
        role: "user",
        text: "look",
        attachments: [],
        context: { version: 1, records: [sample.terminal] },
      },
    });
    expect(turn.message.context?.records[0]?.kind).toBe("terminal");
  });
});
