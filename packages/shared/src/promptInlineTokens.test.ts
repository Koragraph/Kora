import { describe, expect, it } from "vite-plus/test";

import { collectPromptInlineTokens as collect } from "./promptInlineTokens.ts";

/** The token expected for the (single) occurrence of `source` inside `text`. */
function tokenIn(text: string, source: string, type: "skill" | "mention", value: string) {
  const start = text.indexOf(source);
  expect(start, `${source} not in fixture`).toBeGreaterThanOrEqual(0);
  return { type, value, source, start, end: start + source.length };
}

describe("prompt inline tokens", () => {
  describe("recognised tokens", () => {
    it("finds a skill, a file link and a bare mention with their ranges", () => {
      const text = "Run $lint then open [main.ts](lib/main.ts) and @CLAUDE.md now";
      expect(collect(text)).toEqual([
        tokenIn(text, "$lint", "skill", "lint"),
        tokenIn(text, "[main.ts](lib/main.ts)", "mention", "lib/main.ts"),
        tokenIn(text, "@CLAUDE.md", "mention", "CLAUDE.md"),
      ]);
    });

    it("allows a skill name starting with a digit", () => {
      const text = "try $3d-render first";
      expect(collect(text)).toEqual([tokenIn(text, "$3d-render", "skill", "3d-render")]);
    });

    it("ends a link token before the following space", () => {
      const text = "Check [tsconfig.json](tsconfig.json) later";
      const [token] = collect(text);
      expect(token).toEqual(
        tokenIn(text, "[tsconfig.json](tsconfig.json)", "mention", "tsconfig.json"),
      );
      expect(text.slice(token!.end)).toBe(" later");
    });

    it("treats an unscoped @path as a mention", () => {
      const text = "Look at @CHANGELOG.md soon";
      expect(collect(text)).toEqual([tokenIn(text, "@CHANGELOG.md", "mention", "CHANGELOG.md")]);
    });

    it("accepts scoped paths written as a file link or a quoted mention", () => {
      const linked = "Look at [cli](@acme/tools/cli) soon";
      expect(collect(linked)).toEqual([
        tokenIn(linked, "[cli](@acme/tools/cli)", "mention", "@acme/tools/cli"),
      ]);
      const quoted = 'Look at @"acme/tools" soon';
      expect(collect(quoted)).toEqual([tokenIn(quoted, '@"acme/tools"', "mention", "acme/tools")]);
    });
  });

  describe("left as plain text", () => {
    it.each([
      "Lunch was $15 today",
      "Raise $2_500 more",
      "Valued at $40k now",
      "Revenue hit $3B this year",
      "About $5e3 left",
    ])("money: %s", (text) => {
      expect(collect(text)).toEqual([]);
    });

    it.each(["Run $lint", "Open @CLAUDE.md"])("an unfinished token at the end: %s", (text) => {
      expect(collect(text)).toEqual([]);
    });

    it("a normal web link", () => {
      expect(collect("See [the guide](https://example.org/guide) first")).toEqual([]);
    });

    it.each(["@vue/core", "@sam/util.ts", "@org/pkg/deep/file"])("the scoped package %s", (ref) => {
      expect(collect(`Add ${ref} please`)).toEqual([]);
    });

    it("a scoped package at the end or followed by an ideographic space", () => {
      expect(collect("Add @vue/core")).toEqual([]);
      expect(collect("追加 @vue/core　して")).toEqual([]);
    });

    it("a context-chip link, in image or link form", () => {
      expect(collect("see [shot.png](kora-context://v1/image/ctx_9) ok")).toEqual([]);
      expect(collect("see ![ctx_9](kora-context://v1/image/ctx_9) ok")).toEqual([]);
    });
  });

  describe("confirmed pills", () => {
    const pill = "[tsconfig.json](tsconfig.json)";

    it("survive losing their trailing delimiter", () => {
      const confirmed = collect(`${pill} `);
      expect(collect(pill, { preserveTrailingFrom: confirmed })).toEqual([
        tokenIn(pill, pill, "mention", "tsconfig.json"),
      ]);
    });

    it("do not survive an edit to their source", () => {
      const confirmed = collect(`${pill} `);
      expect(
        collect("[tsconfig.json](tsconfig-json)", { preserveTrailingFrom: confirmed }),
      ).toEqual([]);
    });
  });

  describe("label length cap", () => {
    const linkWithLabel = (length: number) => {
      const label = `${"b".repeat(length - 3)}.md`;
      return { label, text: `open [${label}](docs/${label}) now` };
    };

    it("accepts a label of exactly 512 characters", () => {
      const { label, text } = linkWithLabel(512);
      const tokens = collect(text);
      expect(tokens.map((token) => token.value)).toEqual([`docs/${label}`]);
    });

    it("rejects a label one character longer", () => {
      expect(collect(linkWithLabel(513).text)).toEqual([]);
    });
  });

  it("returns quickly for long runs of unclosed brackets", () => {
    // Without a bound the label scan restarted at every space: seconds on this input.
    const before = performance.now();
    expect(collect(" [[".repeat(40_000))).toEqual([]);
    expect(performance.now() - before).toBeLessThan(1_000);
  });
});
