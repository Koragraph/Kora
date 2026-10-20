import { upgradeLegacyContextMessage } from "@kora/shared/contextChipLegacy";
import {
  HostId,
  ItemId,
  ThreadId,
  ThreadMessageContext,
  type ContextChipId,
  type WebMarkupPayload,
} from "@kora/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, test } from "vite-plus/test";

import {
  asKnownContextRecord,
  buildMessageContext,
  contextChipImportLookupIds,
  isSameContextChipPayload,
  resolveUserMessageContext,
  reviewCommentContextLabel,
  reviewCommentContextRecord,
  reviewCommentFromRecord,
  selectedMessageContextFragment,
  terminalExcerptDraftFromRecord,
  terminalExcerptRecord,
  terminalExcerptReference,
  webMarkupContextLabel,
  webMarkupContextRecord,
  webMarkupFromRecord,
} from "./contextChipRecords";
import { formatInlineContextLink, removeInlineContextLink } from "./contextChipReferences";

const decodeContext = Schema.decodeUnknownSync(ThreadMessageContext);
const THREAD = ThreadId.make("th");
const NOW = "2026-02-02T00:00:00.000Z";

const terminalDraft = (over: Record<string, unknown> = {}) => ({
  id: "term-9",
  threadId: THREAD,
  terminalId: "main",
  terminalLabel: "Shell 2",
  lineStart: 1,
  lineEnd: 2,
  text: "A",
  createdAt: NOW,
  ...over,
});

const reviewDraft = (over: Record<string, unknown> = {}) => ({
  id: "rc-9",
  sectionId: "file:src/x.ts",
  sectionTitle: "File comment",
  filePath: "src/x.ts",
  rangeLabel: "L4",
  startIndex: 3,
  endIndex: 3,
  text: "Why?",
  diff: "",
  ...over,
});

const annotation: WebMarkupPayload = {
  id: "ann_9",
  comment: "  Make this   bigger ",
  pageTitle: "Checkout",
  pageUrl: "http://localhost:3000/checkout",
  createdAt: NOW,
  screenshot: null,
  strokes: [],
  regions: [],
  styleChanges: [
    { targetId: "el_1", selector: "#buy", property: "margin", previousValue: "", value: "20px" },
  ],
  elements: [
    {
      id: "el_1",
      rect: { x: 0, y: 0, width: 10, height: 10 },
      element: {
        pickedAt: NOW,
        pageTitle: "Checkout",
        pageUrl: "http://localhost:3000/checkout",
        tagName: "BUTTON",
        selector: "#buy",
        htmlPreview: '<button id="buy">Buy</button>',
        componentName: "CartButton",
        source: null,
        stack: [],
        styles: "color: blue;",
      },
    },
  ],
};

const chipLink = (kind: string, label: string, id: string) =>
  `[${label}](kora-context://v1/${kind}/${id})`;

describe("labels", () => {
  test.each([
    ["L4", "x.ts L4"],
    ["-63", "x.ts L63 (before)"],
    ["+181", "x.ts L181"],
    ["+181 to +183", "x.ts L181 to L183"],
    ["whole file", "x.ts whole file"],
  ])("a review range %j reads %j", (rangeLabel, expected) => {
    expect(reviewCommentContextLabel(reviewDraft({ rangeLabel }) as never)).toBe(expected);
  });

  test("an annotation is labelled by its whitespace-collapsed comment", () => {
    expect(webMarkupContextLabel(annotation)).toBe("Make this bigger");
  });
});

describe("record builders", () => {
  test("terminal text is trimmed and the label carries the line span", () => {
    const record = terminalExcerptRecord(
      terminalDraft({ text: "\nboom\n", lineStart: 5, lineEnd: 8 }),
    );
    expect(record).toMatchObject({ kind: "terminal", text: "boom", label: "Shell 2 lines 5-8" });
  });

  test("review records keep the fence language and use the file name in the label", () => {
    const record = reviewCommentContextRecord(
      reviewDraft({ fenceLanguage: "ts", diff: "const x = 1;" }) as never,
    );
    expect(record).toMatchObject({ kind: "review-comment", label: "x.ts L4", fenceLanguage: "ts" });
  });

  test("an annotation record flattens elements, lowercases tags and words its style changes", () => {
    expect(webMarkupContextRecord(annotation)).toEqual({
      version: 1,
      kind: "preview-annotation",
      contextId: "preview-annotation_ann_9",
      annotationId: "ann_9",
      label: "Make this bigger",
      comment: "Make this   bigger",
      pageTitle: "Checkout",
      pageUrl: "http://localhost:3000/checkout",
      targetSummary: "1 selected element",
      elementIds: ["el_1"],
      styleChanges: ["margin: (unset) → 20px"],
      styleChangeDetails: annotation.styleChanges,
      elements: [
        {
          tagName: "button",
          selector: "#buy",
          htmlPreview: '<button id="buy">Buy</button>',
          componentName: "CartButton",
          source: null,
          styles: "color: blue;",
          pageTitle: "Checkout",
          pageUrl: "http://localhost:3000/checkout",
        },
      ],
    });
  });

  test("a message context lists records in review → annotation order, and is undefined when empty", () => {
    const context = buildMessageContext({
      terminalContexts: [],
      reviewComments: [reviewDraft({ id: "rc-1", rangeLabel: "L1" }) as never],
      previewAnnotations: [annotation],
    });
    expect(context?.records.map((r) => r.contextId)).toEqual([
      "review-comment_rc-1",
      "preview-annotation_ann_9",
    ]);
    expect(
      buildMessageContext({ terminalContexts: [], reviewComments: [], previewAnnotations: [] }),
    ).toBeUndefined();
  });

  test("an oversized review diff is clamped (with a marker) so the record still decodes", () => {
    const make = (n: number) =>
      reviewCommentContextRecord(reviewDraft({ id: "big", diff: "d".repeat(n) }) as never);
    const exact = make(32_000);
    const over = make(32_001);
    expect(exact.diff).toHaveLength(32_000);
    expect(over.diff.length).toBeLessThanOrEqual(32_000);
    expect(over.diff.endsWith("… truncated …")).toBe(true);
    for (const record of [exact, over]) {
      expect(() => decodeContext({ version: 1, records: [record] })).not.toThrow();
    }
  });
});

describe("ids", () => {
  test("a producer id outside the id grammar is folded with a hash suffix but still resolves", () => {
    const record = reviewCommentContextRecord(reviewDraft({ id: "finding:7" }) as never);
    expect(record.contextId).toMatch(/^review-comment_finding-7-[0-9a-f]{16}$/);
    const resolved = resolveUserMessageContext({
      context: { version: 1, records: [record] },
      text: chipLink("review-comment", "x.ts L4", record.contextId),
    });
    expect(resolved.recordsById.has(record.contextId)).toBe(true);
  });

  test.each(["x", "terminal_x"])("terminal id %j survives repeated draft round trips", (id) => {
    const record = terminalExcerptRecord(terminalDraft({ id }));
    const once = terminalExcerptRecord(terminalExcerptDraftFromRecord(record, THREAD));
    const twice = terminalExcerptRecord(terminalExcerptDraftFromRecord(once, THREAD));
    expect([once, twice]).toEqual([record, record]);
  });

  test.each(["x", "review-comment_x"])("review id %j survives a round trip", (id) => {
    const record = reviewCommentContextRecord(reviewDraft({ id }) as never);
    expect(reviewCommentContextRecord(reviewCommentFromRecord(record))).toEqual(record);
  });

  test.each(["x", "preview-annotation_x"])("annotation id %j survives a round trip", (id) => {
    const record = webMarkupContextRecord({ ...annotation, id });
    expect(webMarkupContextRecord(webMarkupFromRecord(record)).contextId).toBe(record.contextId);
  });

  test("edits that contain arrows and newlines are restored from structured details", () => {
    const arrowEdit = {
      targetId: "el_1",
      selector: "#buy",
      property: "width",
      previousValue: "x → y",
      value: "x\ny → z",
    };
    const styleChanges = [...annotation.styleChanges, arrowEdit];
    const back = webMarkupFromRecord(webMarkupContextRecord({ ...annotation, styleChanges }));
    expect(back.styleChanges).toEqual(styleChanges);
    expect(back.elements[0]?.id).toBe("el_1");
  });

  test("a chip is removed from a prompt by its kind-scoped id, not the producer id", () => {
    const draft = terminalDraft({ id: "term-1", text: "boom", lineStart: 5, lineEnd: 8 });
    const ref = terminalExcerptReference(draft);
    expect(ref.contextId).toBe("terminal_term-1");
    const prompt = `prose ${formatInlineContextLink(ref)} tail`;

    expect(removeInlineContextLink(prompt, draft.id).prompt).toBe(prompt);
    expect(removeInlineContextLink(prompt, ref.contextId).prompt).toBe("prose tail");
  });
});

describe("resolveUserMessageContext", () => {
  test("structured context is used as given", () => {
    const resolved = resolveUserMessageContext({
      context: {
        version: 1,
        records: [reviewCommentContextRecord(reviewDraft({ id: "rc-1" }) as never)],
      },
      text: `hi ${chipLink("review-comment", "x.ts L4", "rc-1")}`,
    });
    expect(resolved.recordsById.get("review-comment_rc-1")?.kind).toBe("review-comment");
  });

  test("legacy <terminal_context> text is upgraded into a chip and a record", () => {
    const resolved = resolveUserMessageContext({
      text: "hi\n\n<terminal_context>\n- T line 1:\n  1 | x\n</terminal_context>",
    });
    expect(resolved.text).toBe(`hi\n\n${chipLink("terminal", "T line 1", "legacy_terminal_1")}`);
    expect(resolved.recordsById.get("legacy_terminal_1")?.kind).toBe("terminal");
  });
});

describe("selectedMessageContextFragment", () => {
  const terminal = terminalExcerptRecord(terminalDraft({ id: "t-1" }));
  const review = reviewCommentContextRecord(reviewDraft({ id: "r-1" }) as never);
  const base = {
    messageId: ItemId.make("msg"),
    threadId: THREAD,
    hostId: HostId.make("host"),
    records: [terminal, review],
  };

  test("null when the selection has no chips or no backing records", () => {
    expect(selectedMessageContextFragment({ ...base, markdown: "just prose" })).toBeNull();
    expect(
      selectedMessageContextFragment({
        ...base,
        records: [],
        markdown: chipLink("review-comment", "x.ts L4", review.contextId),
      }),
    ).toBeNull();
  });

  test("only chips inside the selection contribute their records", () => {
    const fragment = selectedMessageContextFragment({
      ...base,
      markdown: `see ${chipLink("review-comment", "x.ts L4", review.contextId)}`,
    });
    expect(fragment).toContain(review.contextId);
    expect(fragment).not.toContain(terminal.contextId);
  });
});

describe("isSameContextChipPayload", () => {
  test("labels are display text, never identity", () => {
    const record = terminalExcerptRecord(terminalDraft());
    expect(isSameContextChipPayload(record, { ...record, label: "other" })).toBe(true);
    expect(isSameContextChipPayload(record, { ...record, text: "B" })).toBe(false);
  });

  test("an imported legacy id equals its canonical rebuild when the payload matches", () => {
    const canonical = terminalExcerptRecord(terminalDraft());
    const imported = { ...canonical, contextId: "legacy_terminal_1" as ContextChipId };
    expect(isSameContextChipPayload(canonical, imported)).toBe(true);
    expect(isSameContextChipPayload(canonical, { ...canonical, text: "B" })).toBe(false);
  });

  test("two legacy messages collide on the destination id but are different payloads", () => {
    const legacy = (line: string) =>
      asKnownContextRecord(
        upgradeLegacyContextMessage(
          `Look\n\n<terminal_context>\n- Terminal 1 line 1:\n  1 | ${line}\n</terminal_context>`,
        ).records[0],
      )!;
    const a = legacy("A");
    const b = legacy("B");
    if (a.kind !== "terminal" || b.kind !== "terminal") throw new Error("expected terminals");
    const destination = terminalExcerptReference(
      terminalExcerptDraftFromRecord(a, THREAD),
    ).contextId;

    expect(destination).toBe("terminal_legacy_terminal_1");
    expect(contextChipImportLookupIds(b)[0]).toBe(destination);
    expect(isSameContextChipPayload(a, b)).toBe(false);
  });

  test("annotation comparison looks inside nested element and source data", () => {
    const base = webMarkupContextRecord(annotation);
    const withElements = (patch: Record<string, unknown>) => ({
      ...base,
      elements: base.elements?.map((el) => ({ ...el, ...patch })),
    });
    expect(isSameContextChipPayload(base, { ...base, label: "Other label" })).toBe(true);
    expect(
      isSameContextChipPayload(
        base,
        withElements({ htmlPreview: '<button id="buy">Changed</button>' }),
      ),
    ).toBe(false);
    expect(
      isSameContextChipPayload(
        base,
        withElements({
          source: {
            fileName: "src/Cart.tsx",
            lineNumber: 31,
            columnNumber: 9,
            functionName: "Cart",
          },
        }),
      ),
    ).toBe(false);
  });
});
