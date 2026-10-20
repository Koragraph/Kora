import { getSharedHighlighter } from "@pierre/diffs";
import { toHtml } from "hast-util-to-html";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vite-plus/test";

import { createIncrementalHighlightedDocument } from "../../util/incrementalHighlighting";
import { HighlightedCodeLines } from "./HighlightedCodeLines";

const THEMES = ["pierre-dark", "pierre-light"] as const;
// quotes, markup that must stay escaped, blank lines, a multi-line comment and a tab
const SNIPPET = 'const s = "<script>alert(1)</script>";\n\n/* a\nb */\n\tlet n = 1;\n';

test("the React tree renders exactly the HTML Shiki produced, at every growing prefix", async () => {
  const highlighter = await getSharedHighlighter({
    preferredHighlighter: "shiki-wasm",
    themes: [...THEMES],
    langs: ["typescript"],
  });
  for (const theme of THEMES) {
    const highlight = createIncrementalHighlightedDocument(highlighter, "typescript", theme);
    for (let n = 0; n <= SNIPPET.length; n++) {
      const root = highlight(SNIPPET.slice(0, n));
      expect(renderToStaticMarkup(<HighlightedCodeLines root={root} />)).toBe(toHtml(root));
    }
  }
});
