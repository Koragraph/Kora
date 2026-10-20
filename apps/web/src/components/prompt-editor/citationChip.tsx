import type { ReplyFootnote } from "@kora/contracts";
import { serializeReplyFootnote, withReplyFootnoteComment } from "@kora/shared/assistantFootnotes";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $applyNodeReplacement, $getNodeByKey } from "lexical";
import { $getRoot, $isElementNode } from "lexical";
import { HISTORY_PUSH_TAG, SKIP_DOM_SELECTION_TAG } from "lexical";
import type { NodeKey, SerializedLexicalNode, Spread } from "lexical";
import { createContext, use, type ReactElement } from "react";

import type { ReplyFootnoteSourceAnchor } from "~/util/assistantTextSelection";
import { ReplyFootnoteChip } from "../thread/ReplyFootnoteChip";
import { InlineChipNode } from "./inlineChip";

/**
 * "Cite" on a reply puts a citation into the prompt and opens its comment box. The request is made before the
 * new prompt reaches the editor, so it is held until the editor shows exactly that prompt.
 */
export type CitationCommentRequest = {
  sourceAnchor: ReplyFootnoteSourceAnchor;
  citationStart: number;
  value: string;
  previousValue: string;
};

/** The citation whose comment box is open. `removeOnCancel`: cancelling takes the just-added chip out again. */
export type CitationCommentTarget = {
  nodeKey: NodeKey;
  sourceAnchor?: ReplyFootnoteSourceAnchor;
  removeOnCancel?: boolean;
};

export const CitationCommentContext = createContext<{
  openComment: CitationCommentTarget | null;
  onOpenChange: (nodeKey: NodeKey, open: boolean) => void;
}>({ openComment: null, onOpenChange: () => {} });

/**
 * Resolves a pending cite request against the editor's current prompt: the citation chip it added, once the prompt
 * is the requested one. A prompt still at `previousValue` keeps the request waiting; any other prompt drops it.
 */
export function $takeCitationCommentRequest(pending: {
  current: CitationCommentRequest | null;
}): CitationCommentTarget | null {
  const request = pending.current;
  if (!request) return null;
  const prompt = $getRoot().getTextContent();
  if (prompt === request.previousValue) return null;
  pending.current = null;
  const paragraph = $getRoot().getFirstChild();
  if (prompt !== request.value || !$isElementNode(paragraph)) return null;
  let offset = 0;
  for (const child of paragraph.getChildren()) {
    if (offset === request.citationStart && child instanceof CitationChipNode) {
      return { nodeKey: child.getKey(), sourceAnchor: request.sourceAnchor, removeOnCancel: true };
    }
    offset += child.getTextContentSize();
  }
  return null;
}

function CitationChip({ citation, nodeKey }: { citation: ReplyFootnote; nodeKey: NodeKey }) {
  const [editor] = useLexicalComposerContext();
  const comments = use(CitationCommentContext);
  const target = comments.openComment?.nodeKey === nodeKey ? comments.openComment : null;

  /** Runs `change` on this chip if it is still in the editor; false when it is not (or the editor is read-only). */
  const onThisChip = (
    change: (chip: CitationChipNode) => void,
    tag: string | string[],
  ): boolean => {
    if (!editor.isEditable()) return false;
    let done = false;
    editor.update(
      () => {
        const node = $getNodeByKey(nodeKey);
        if (node instanceof CitationChipNode && node.isAttached()) {
          change(node);
          done = true;
        }
      },
      { discrete: true, tag },
    );
    return done;
  };

  const removeChip = () => {
    if (!editor.isEditable()) return;
    onThisChip((chip) => {
      chip.selectPrevious();
      chip.remove();
    }, HISTORY_PUSH_TAG);
    const root = editor.getRootElement();
    if (root) root.focus({ preventScroll: true });
  };

  return (
    <span
      data-prompt-footnote-chip="true"
      contentEditable={false}
      spellCheck={false}
      className="inline-flex max-w-full min-w-0"
    >
      <ReplyFootnoteChip
        composer
        citation={citation}
        commentEditor={{
          open: target !== null,
          sourceAnchor: target?.sourceAnchor,
          onSave: (comment) =>
            onThisChip(
              (chip) => chip.setComment(comment),
              [HISTORY_PUSH_TAG, SKIP_DOM_SELECTION_TAG],
            ),
          ...(target?.removeOnCancel ? { onCancel: removeChip } : {}),
          onOpenChange: (open) => {
            if (!open || editor.isEditable()) comments.onOpenChange(nodeKey, open);
          },
        }}
      />
    </span>
  );
}

interface SerializedCitationRecord {
  readonly type: "prompt-citation";
  readonly version: 1;
  readonly citation: ReplyFootnote;
  readonly source: string;
}

type CitationChipJSON = Spread<SerializedCitationRecord, SerializedLexicalNode>;

/** A quoted piece of an earlier reply, with an optional comment. Its text is the serialized footnote. */
export class CitationChipNode extends InlineChipNode {
  static override getType(): string {
    return "prompt-citation";
  }

  __citation: ReplyFootnote;
  __source: string;

  static override clone(from: CitationChipNode): CitationChipNode {
    return new CitationChipNode(from.__citation, from.__source, from.__key);
  }

  static override importJSON(json: CitationChipJSON): CitationChipNode {
    return $createCitationChipNode(json.citation, json.source).updateFromJSON(json);
  }

  constructor(citation: ReplyFootnote, source: string, key?: NodeKey) {
    super(key);
    this.__citation = citation;
    this.__source = source;
  }

  protected override hostClasses(): string {
    return "max-w-full";
  }

  override exportJSON(): CitationChipJSON {
    const node = this.getLatest();
    return {
      ...super.exportJSON(),
      type: "prompt-citation",
      version: 1,
      citation: node.__citation,
      source: node.__source,
    };
  }

  override getTextContent(): string {
    const active = this.getLatest();
    return active.__source;
  }

  /** Sets the comment; the chip's text follows, since the comment is part of the serialized footnote. */
  setComment(commentText: string): this {
    const active = this.getLatest();
    const updated = withReplyFootnoteComment(active.__citation, commentText);
    if (updated.comment === active.__citation.comment) return active;
    const next = this.getWritable();
    next.__citation = updated;
    next.__source = serializeReplyFootnote(updated);
    return next;
  }

  override decorate(): ReactElement {
    return <CitationChip citation={this.__citation} nodeKey={this.__key} />;
  }
}

export function $createCitationChipNode(citation: ReplyFootnote, source: string): CitationChipNode {
  return $applyNodeReplacement(new CitationChipNode(citation, source));
}
