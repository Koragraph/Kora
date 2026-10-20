import type { DiffsHighlighter } from "@pierre/diffs";

import type { DiffThemeName } from "./diffRendering";

function codeChildren(tree: ReturnType<DiffsHighlighter["codeToHast"]>) {
  const pre = tree.children.find((child) => child.type === "element" && child.tagName === "pre");
  if (pre?.type !== "element") throw new Error("Missing highlighted pre element");
  const codeElement = pre.children.find(
    (child) => child.type === "element" && child.tagName === "code",
  );
  if (codeElement?.type !== "element") throw new Error("Missing highlighted code element");
  return codeElement.children;
}

/** Resume tokenization after the last completed line. Keep its grammar state so
 * multiline strings, comments, and embedded languages continue to highlight as
 * they do in a full pass. The current line is always highlighted again.
 */
export function createIncrementalHighlightedDocument(
  engine: DiffsHighlighter,
  language: string,
  palette: DiffThemeName,
) {
  const opts = { lang: language, theme: palette };
  const newline = { type: "text" as const, value: "\n" };
  let cache:
    | {
        children: ReturnType<typeof codeChildren>;
        state: ReturnType<DiffsHighlighter["getLastGrammarState"]>;
        prefix: string;
      }
    | undefined;

  return (source: string) => {
    // Plain text and ANSI do not have a TextMate grammar state. A CR at the end
    // of a chunk can still become a CRLF, so keep that input on the full path.
    if (
      !language ||
      ["text", "plaintext", "plain", "txt", "ansi"].includes(language) ||
      source.includes("\r")
    ) {
      return engine.codeToHast(source, opts);
    }
    if (cache && !source.startsWith(cache.prefix)) cache = undefined;
    const until = source.lastIndexOf("\n") + 1;
    if (until > (cache?.prefix.length ?? 0)) {
      // Omit the final newline: Shiki would tokenize an extra empty line and
      // advance the grammar state twice before we process the following line.
      const chunk = engine.codeToHast(source.slice(cache?.prefix.length ?? 0, until - 1), {
        ...opts,
        ...(cache ? { grammarState: cache.state } : {}),
      });
      const grammar = engine.getLastGrammarState(chunk);
      if (!grammar) {
        cache = undefined;
        return engine.codeToHast(source, opts);
      }
      cache = {
        prefix: source.slice(0, until),
        state: grammar,
        children: [...(cache ? [...cache.children, newline] : []), ...codeChildren(chunk)],
      };
    }
    const lead = cache;
    if (!lead) return engine.codeToHast(source, opts);
    return engine.codeToHast(source.slice(lead.prefix.length), {
      ...opts,
      grammarState: lead.state,
      transformers: [
        {
          code: (codeNode) => ({
            ...codeNode,
            children: [...lead.children, newline, ...codeNode.children],
          }),
        },
      ],
    });
  };
}
