import type { Root } from "mdast";

/** The processor's own parser, so recovered text keeps whatever inline extensions are configured. */
interface MarkdownParser {
  parse(markdown: string): unknown;
}

type Node = {
  type: string;
  value?: string | undefined;
  children?: Node[] | undefined;
  position?:
    | ({ start: { line: number; offset?: number | undefined } } & Record<string, unknown>)
    | undefined;
};

const RECOVERY_PREFIX = "kora-markdown-inline-prefix:";

/**
 * CommonMark turns `-       text` into a list item holding an indented code block. Aligned bullets
 * are far more common than code in a list item's first line, so that code is parsed again as prose.
 */
export const remarkNormalizeListItemIndentation = function (this: MarkdownParser) {
  const parser = this;

  const isOverIndentedCode = (child: Node, parent: Node, source: string): boolean => {
    if (child.type !== "code" || parent.type !== "listItem") return false;
    if (!/^[ \t]/.test(child.value ?? "")) return false;
    const at = child.position as { start: { line: number; offset?: number } } | undefined;
    const parentStart = parent.position?.start;
    if (!at || !parentStart || at.start.line !== parentStart.line) return false;
    // Explicit fences stay code.
    const first = source[at.start.offset ?? -1];
    return first !== "`" && first !== "~";
  };

  const recover = (code: Node): { blocks: Node[]; source: string } | null => {
    const value = (code.value ?? "").trim();
    const prefixed = RECOVERY_PREFIX + value;
    const recovered = parser.parse(prefixed) as Root | undefined;
    const blocks = (recovered?.children ?? []) as unknown as Node[];
    const head = blocks[0];
    const text = head?.type === "paragraph" ? head.children?.[0] : undefined;
    if (head && text?.type === "text" && (text.value ?? "").startsWith(RECOVERY_PREFIX)) {
      text.value = (text.value ?? "").slice(RECOVERY_PREFIX.length);
      if (text.value === "") head.children!.shift();
      head.position = code.position;
      return { blocks, source: prefixed };
    }
    return null;
  };

  const visit = (node: Node, source: string): void => {
    const children = node.children;
    if (!children) return;
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      if (!isOverIndentedCode(child, node, source)) {
        visit(child, source);
        continue;
      }
      const recovered = recover(child);
      if (recovered) {
        children.splice(i, 1, ...recovered.blocks);
        for (const block of recovered.blocks) visit(block, recovered.source);
        i += recovered.blocks.length - 1;
      } else {
        children[i] = { type: "text", value: (child.value ?? "").trim(), position: child.position };
      }
    }
  };

  return (tree: unknown, file: { value?: unknown }) => {
    if (typeof file.value !== "string") return;
    visit(tree as Node, file.value);
  };
};
