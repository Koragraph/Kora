import { DecoratorNode } from "lexical";
import type { ReactElement } from "react";

import { tagHost } from "../tagStyles";

/**
 * What every chip in the prompt has in common: an inline, non-editable React island whose host <span> never
 * changes. Its text content is the token it stands for, so the prompt string round-trips through the editor.
 */
export abstract class InlineChipNode extends DecoratorNode<ReactElement> {
  /** Extra classes on the host span (citations and context chips may shrink to fit). */
  protected hostClasses(): string {
    return "";
  }

  override createDOM(): HTMLElement {
    const host = document.createElement("span");
    host.className = `${tagHost} ${this.hostClasses()}`.trim();
    return host;
  }

  override updateDOM(): false {
    return false;
  }

  override isInline(): true {
    return true;
  }
}

export function isChipNode(node: unknown): node is InlineChipNode {
  return node instanceof InlineChipNode;
}
