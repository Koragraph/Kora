import { describe, expect, it } from "vite-plus/test";

import * as Clip from "./contextChipClipboard.ts";

type Fragment = Parameters<typeof Clip.encodeContextChipFragment>[0];

const terminalRecord = (contextId: string, text: string, label = "Logs") => ({
  version: 1 as const,
  kind: "terminal" as const,
  contextId: contextId as never,
  label,
  terminalId: "t1",
  terminalLabel: "Shell",
  lineStart: 3,
  lineEnd: 3,
  text,
});

const fragmentOf = (records: Fragment["records"], hostId = "host-a"): Fragment => ({
  version: 1,
  source: { hostId: hostId as never },
  records,
});

describe("context chip fragment JSON", () => {
  it("survives a round trip well past two million characters", () => {
    const big = fragmentOf(
      Array.from({ length: 40 }, (_, n) => terminalRecord(`ctx-${n}`, "y".repeat(60_000))),
    );
    const json = Clip.encodeContextChipFragment(big);
    expect(json).not.toBeNull();
    expect(json!.length).toBeGreaterThan(2_000_000);
    expect(Clip.decodeContextChipFragment(json)).toEqual(big);
  });

  it("refuses to encode a fragment over the size cap", () => {
    // Each NUL becomes a six-character escape in JSON.
    const records = Array.from({ length: 200 }, (_, n) =>
      terminalRecord(`ctx-${n}`, "\u0000".repeat(64_000)),
    );
    expect(Clip.encodeContextChipFragment(fragmentOf(records))).toBeNull();
  });

  it("keeps decodable records and drops the rest", () => {
    const skill = {
      version: 1,
      contextId: "keep",
      kind: "skill",
      label: "$deploy",
      name: "deploy",
    };
    const brokenImage = { version: 1, contextId: "drop", kind: "image", label: "broken" };
    const base = fragmentOf([skill, brokenImage] as never);
    const json = Clip.encodeContextChipFragment({
      ...base,
      source: { ...base.source, threadId: "th-9" as never },
    });
    const back = Clip.decodeContextChipFragment(json);
    expect(back?.source.threadId).toBe("th-9");
    expect(back?.records.map(({ contextId }) => contextId)).toEqual(["keep"]);
  });

  it.each([
    ["null", null],
    ["text that is not JSON", "{oops"],
    ["a future version", JSON.stringify({ version: 2, source: { hostId: "h" }, records: [] })],
    ["a huge non-JSON string", "z".repeat(2_000_001)],
  ])("returns null for %s", (_label, raw) => {
    expect(Clip.decodeContextChipFragment(raw)).toBeNull();
  });

  it("exposes a custom web application MIME type", () => {
    expect(Clip.CONTEXT_CHIP_CLIPBOARD_MIME.startsWith("web application/")).toBe(true);
  });
});

describe("context chip clipboard HTML", () => {
  const sample = JSON.stringify(
    fragmentOf([terminalRecord("one", "<b>bold</b> & naïve", 'Run "tests"')]),
  );

  it("wraps the caller's rich markup as-is", () => {
    const json = Clip.encodeContextChipFragment(fragmentOf([]))!;
    const markup = '<ul><li><em>First</em> <a href="https://example.org">item</a></li></ul>';
    const html = Clip.encodeContextChipClipboardHtml("First item", json, markup);
    expect(html.includes(markup)).toBe(true);
    expect(Clip.decodeContextChipClipboardHtml(html)).toEqual(JSON.parse(json));
  });

  it("escapes plain text so captured output never becomes markup", () => {
    const html = Clip.encodeContextChipClipboardHtml("<b>bold</b> & naïve", sample);
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt; &amp; naïve");
    expect(html.includes("<b>")).toBe(false);
    expect(Clip.decodeContextChipClipboardHtml(html)).toEqual(JSON.parse(sample));
  });

  it("ignores HTML without a fragment or with a broken escape", () => {
    expect(
      Clip.decodeContextChipClipboardHtml('<div data-kora-context-fragment="%G1">x</div>'),
    ).toBeNull();
    expect(Clip.decodeContextChipClipboardHtml("<span>just copied text</span>")).toBeNull();
    expect(Clip.decodeContextChipClipboardHtml(undefined)).toBeNull();
  });

  it("allows the ninefold growth of percent-encoded non-ASCII text", () => {
    const wide = JSON.stringify(
      fragmentOf([terminalRecord("wide", "한국어".repeat(21_000), "출력")]),
    );
    const html = Clip.encodeContextChipClipboardHtml("output", wide);
    expect(html.length).toBeGreaterThan(wide.length * 8);
    expect(Clip.decodeContextChipClipboardHtml(html)).toEqual(JSON.parse(wide));
  });
});
