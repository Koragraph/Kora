import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, test } from "vite-plus/test";

import { remarkNormalizeListItemIndentation } from "./list-indentation";

const toHtml = (md: string) =>
  renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkNormalizeListItemIndentation]}>
      {md}
    </ReactMarkdown>,
  );

describe("list item indentation recovery", () => {
  test.each([
    ["same-line indented code", "-     let n = 1;", "<pre><code>let n = 1;"],
    ["code indented below a bare marker", "-\n      let n = 1;", "<pre><code>let n = 1;"],
    [
      "a fenced block inside an item",
      "- ```ts\n  let n = 1;\n  ```",
      '<pre><code class="language-ts">let n = 1;',
    ],
  ])("real code is left alone: %s", (_label, md, expected) => {
    expect(toHtml(md)).toContain(expected);
  });

  test("an over-indented one-liner becomes text, with inline formatting parsed", () => {
    const out = toHtml("-       **key** [docs](https://example.com) with `code` and ~~gone~~");
    expect(out).not.toContain("<pre>");
    expect(out).toContain("<strong>key</strong>");
    expect(out).toContain('<a href="https://example.com">docs</a>');
    expect(out).toContain("<code>code</code>");
    expect(out).toContain("<del>gone</del>");
  });

  test("each over-indented line of a run is its own item", () => {
    const out = toHtml('intro\n\n-       if (x) {\n-           y = "<z>";\n-       }');
    expect(out).not.toContain("<pre>");
    expect(out).toContain("<li>if (x) {</li>");
    expect(out).toContain("<li>y = &quot;&lt;z&gt;&quot;;</li>");
    expect(out).toContain("<li>}</li>");
  });

  test("every blank-line separated block of the recovered tail survives", () => {
    const out = toHtml("-       **one**\n\n        [two](https://example.com)");
    expect(out).toContain("<strong>one</strong>");
    expect(out).toContain('<a href="https://example.com">two</a>');
  });

  test("nested lists inside the recovered tail are normalised too", () => {
    const out = toHtml("-       outer\n\n        -       inner");
    expect(out).not.toContain("<pre>");
    expect(out).toContain("<li>inner</li>");
  });
});
