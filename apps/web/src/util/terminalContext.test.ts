import { collectContextChipReferences } from "@kora/shared/contextChipReferences";
import { ThreadId } from "@kora/contracts";
import { describe, expect, test } from "vite-plus/test";

import { terminalExcerptRecord } from "./contextChipRecords";
import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER as LEGACY_MARK,
  filterTerminalExcerptsWithText,
  formatTerminalExcerptLabel,
  formatTerminalExcerptReference,
  hasTerminalExcerptText,
  isTerminalExcerptExpired,
  migrateLegacyTerminalExcerptPlaceholders,
  normalizeTerminalExcerptText,
  type TerminalExcerptDraft,
} from "./terminalContext";

const draft = (over: Partial<TerminalExcerptDraft> = {}): TerminalExcerptDraft => ({
  id: "ctx-a",
  threadId: ThreadId.make("th-1"),
  terminalId: "main",
  terminalLabel: "Shell 3",
  lineStart: 20,
  lineEnd: 24,
  text: "ls -la\ntotal 0",
  createdAt: "2026-03-13T12:00:00.000Z",
  ...over,
});

describe("snapshot text", () => {
  test.each([
    ["real output", "echo\nhi", true],
    ["empty", "", false],
    ["only blank lines", "\n\r\n\n", false],
  ])("%s -> has text: %s", (_label, text, has) => {
    expect(hasTerminalExcerptText({ text })).toBe(has);
    expect(isTerminalExcerptExpired({ text })).toBe(!has);
  });

  test("CRLF is folded and outer blank lines are trimmed", () => {
    expect(normalizeTerminalExcerptText("\r\n\r\na\r\nb\r\n\r\n")).toBe("a\nb");
  });

  test("only contexts with text survive filtering, in order", () => {
    const live1 = draft({ id: "1" });
    const gone = draft({ id: "2", text: "" });
    const live2 = draft({ id: "3" });
    expect(filterTerminalExcerptsWithText([live1, gone, live2])).toEqual([live1, live2]);
  });
});

describe("labels and references", () => {
  test("a span reads 'lines a-b', a single line 'line n'", () => {
    expect(formatTerminalExcerptLabel(draft())).toBe("Shell 3 lines 20-24");
    expect(formatTerminalExcerptLabel(draft({ lineStart: 9, lineEnd: 9 }))).toBe("Shell 3 line 9");
  });

  test("the reference is a canonical kora-context link with a kind-scoped id", () => {
    expect(formatTerminalExcerptReference(draft())).toBe(
      "[Shell 3 lines 20-24](kora-context://v1/terminal/terminal_ctx-a)",
    );
  });

  test("a producer id outside the grammar is folded the same way in link and record", () => {
    const d = draft({ id: "weird id:1" });
    const [ref] = collectContextChipReferences(formatTerminalExcerptReference(d));
    expect(ref?.contextId).toBe(terminalExcerptRecord(d).contextId);
  });
});

describe("migrateLegacyTerminalExcerptPlaceholders", () => {
  test("placeholders become references in order; surplus ones are dropped", () => {
    const only = draft();
    const link = formatTerminalExcerptReference(only);
    expect(
      migrateLegacyTerminalExcerptPlaceholders(`a ${LEGACY_MARK} b ${LEGACY_MARK}`, [only]),
    ).toBe(`a ${link} b `);
  });

  test("text without placeholders is untouched", () => {
    expect(migrateLegacyTerminalExcerptPlaceholders("plain", [draft()])).toBe("plain");
  });
});
