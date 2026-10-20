import { remarkCodexDirectives } from "@kora/client-runtime/codex/markdown-directives";
import type { Root } from "mdast";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { PluggableList, Plugin } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { remarkGithubAlerts } from "./github-alerts";
import { createIncrementalMarkdownPlugin } from "./incremental";
import { remarkNormalizeListItemIndentation } from "./list-indentation";

type IncrementalPlugin = ReturnType<typeof createIncrementalMarkdownPlugin>;

interface RenderResult {
  html: string;
  tree: Root | undefined;
}

const appPlugins = [
  remarkGfm,
  remarkCodexDirectives,
  remarkGithubAlerts,
  remarkNormalizeListItemIndentation,
];

/**
 * Renders markdown through the app's plugin chain, optionally followed by an incremental plugin.
 * `seenByParser`, when given, receives every string the markdown parser is asked to parse.
 */
function render(source: string, incremental?: IncrementalPlugin, seenByParser?: string[]) {
  const result: RenderResult = { html: "", tree: undefined };
  const spyOnParser: Plugin<[], Root> = function () {
    const original = this.parser;
    if (!original) return;
    this.parser = (text, file) => {
      seenByParser?.push(text);
      return original(text, file);
    };
  };
  const snapshotTree: Plugin<[], Root> = () => (root) => {
    result.tree = structuredClone(root);
  };
  const remarkPlugins: PluggableList = [spyOnParser, snapshotTree, ...appPlugins];
  if (incremental) remarkPlugins.push(incremental);
  result.html = renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      { remarkPlugins, rehypePlugins: [rehypeRaw, rehypeSanitize] },
      source,
    ),
  );
  return result;
}

/** The incremental path is correct only if it is indistinguishable from rendering the text from scratch. */
function expectMatchesFreshRender(source: string, incremental: IncrementalPlugin, label = source) {
  expect(render(source, incremental), label).toEqual(render(source));
}

/** Feeds every prefix of `source` to one plugin instance, as a streaming reply would. */
function expectEveryPrefixMatches(source: string) {
  const plugin = createIncrementalMarkdownPlugin();
  for (let length = 0; length <= source.length; length++) {
    expectMatchesFreshRender(source.slice(0, length), plugin, `prefix of length ${length}`);
  }
}

const stableHead = "# Intro\n\n```ts\nconst items = [3, 4];\n```\n\n";
const tick3 = "`".repeat(3);

describe("incremental markdown: equivalence with a fresh render", () => {
  it("never caches fences it cannot be sure about", () => {
    const untrustworthyOpeners = [
      `${tick3}sh\nnever closed\n\n`,
      `${"`".repeat(4)}\n${tick3}\ninside\n\n`,
      `> ${tick3}\n> in a quote\n> ${tick3}\n\n`,
      `* ${tick3}\n  in a list\n  ${tick3}\n\n`,
      `    ${tick3}\n    indented\n    ${tick3}\n\n`,
      `<script>\n${tick3}\nraw html\n${tick3}\n\n`,
    ];
    for (const opener of untrustworthyOpeners) {
      const plugin = createIncrementalMarkdownPlugin();
      for (const ending of ["", "text", "\n```\n", "\n```\n\nnext"]) {
        expectMatchesFreshRender(opener + ending, plugin);
      }
    }
  });

  it("stays clean across edits, rewrites and repeated identical renders", () => {
    const plugin = createIncrementalMarkdownPlugin();
    const history = [
      `${stableHead}- one\n - two`,
      `${stableHead}> [!NOTE]\n> converted alert`,
      `${stableHead}just words`,
      "an unrelated document without any fence",
      `${stableHead.replace("Intro", "Changed")}new body`,
      `${stableHead}just words`,
      `${stableHead}just words`,
    ];
    for (const document of history) expectMatchesFreshRender(document, plugin);
  });

  it("resolves a reference whose definition only shows up after the cached prefix", () => {
    const prefix = `[pending] and a footnote[^f]\n\n${stableHead}`;
    const plugin = createIncrementalMarkdownPlugin();
    for (const suffix of ["words", "[pending]: /dest", "[pending]: /dest\n\n[^f]: footnote body"]) {
      expectMatchesFreshRender(prefix + suffix, plugin);
    }
  });

  it.each(["\r\n", "\r"])("matches for every prefix of a document with %j line endings", (eol) => {
    expectEveryPrefixMatches(
      `${stableHead}after\n\n\`\`\`\nclosing\n\`\`\`\n\nfin`.replaceAll("\n", eol),
    );
  });

  it.each([
    ["setext headings", "x\n===\n\ny\n---\n"],
    ["a loose list item", "- one\n\n  more\n\n- two\n"],
    ["a fenced block inside a quote", "> quote\n>\n> ```js\n> xyz\n> ```\n\nfin"],
    ["raw html with a blank line", "<div>\nhi\n\n</div>\n\nfin"],
    ["a forward link reference", "[tag]\n\n[tag]: /elsewhere"],
    ["a footnote", "b[^q]\n\n[^q]: remark"],
    ["a table", "c | d\n--|--\nc | d\n"],
    ["two fence styles", "```\nx\n```\n\nbetween\n\n~~~\ny\n~~~\n\nrest"],
    ["an indented code block", "\n\n\tcode\n\nrest"],
    ["autolinks and emphasis", "text <https://example.org> *em*"],
    ["an alert next to a task list", "> [!NOTE]\n> heads up\n\n- [ ] todo"],
    ["a leading byte-order mark", "﻿text after a byte-order mark"],
  ])("matches while streaming %s one character at a time", (_label, tail) => {
    expectEveryPrefixMatches(stableHead + tail);
  });
});

describe("incremental markdown: work avoided", () => {
  it("re-parses only the tail when a document with recovered list fences grows", () => {
    const document = `${stableHead}-       list start\n\n        \`\`\`ts\n        const nested = 7;\n        \`\`\`\n\n        end`;
    const plugin = createIncrementalMarkdownPlugin();
    expectMatchesFreshRender(document, plugin);

    const parserInputs: string[] = [];
    const longer = `${document} extra`;
    expect(render(longer, plugin, parserInputs)).toEqual(render(longer));
    expect(parserInputs).not.toContain(longer);
    expect(parserInputs.some((text) => text.startsWith("kora-markdown-inline-prefix:"))).toBe(true);
  });
});
