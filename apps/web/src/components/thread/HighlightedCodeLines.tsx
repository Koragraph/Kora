import { Fragment, jsxs, jsx } from "react/jsx-runtime";
import { isValidElement, type DOMAttributes, cloneElement, memo } from "react";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { toHtml } from "hast-util-to-html";
import type { DiffsHighlighter } from "@pierre/diffs";

type HighlightedRoot = ReturnType<DiffsHighlighter["codeToHast"]>;
type HighlightedNode = HighlightedRoot["children"][number];
type HighlightedElement = Extract<HighlightedNode, { type: "element" }>;
const runtime = { jsxs, jsx, Fragment };

function elementShell(node: HighlightedElement) {
  const shell = toJsxRuntime({ ...node, children: [] }, runtime);
  if (isValidElement<DOMAttributes<HTMLElement>>(shell)) {
    return shell;
  }
  throw new Error("Expected a highlighted code element");
}

const HighlightedLine = memo(function HighlightedLine({ node }: { node: HighlightedNode }) {
  if (node.type !== "element") {
    return toJsxRuntime(node, runtime);
  }
  return cloneElement(elementShell(node), {
    dangerouslySetInnerHTML: { __html: toHtml({ children: node.children, type: "root" }) },
  });
});

/** Completed line nodes retain their identity in the incremental highlighter.
 * Keep their DOM mounted too: replacing the entire pre makes the browser parse
 * and resolve styles for thousands of unchanged token spans on each update.
 */
export function HighlightedCodeLines({ root }: { root: HighlightedRoot }) {
  const pre = root.children[0];
  if (pre?.type !== "element" || pre.tagName !== "pre") {
    return toJsxRuntime(root, runtime);
  }
  const code = pre.children[0];
  if (code?.type !== "element" || code.tagName !== "code") {
    return toJsxRuntime(root, runtime);
  }
  const lines = code.children.map((node, index) => (
    // A line's position is stable as tokens and new lines are appended.
    // oxlint-disable-next-line react/no-array-index-key
    <HighlightedLine node={node} key={index} />
  ));
  const codeElement = cloneElement(elementShell(code), undefined, lines);
  return cloneElement(elementShell(pre), undefined, codeElement);
}
