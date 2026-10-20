import { cn } from "~/util/utils";
import {
  findReplyFootnoteSourceAnchor,
  type ReplyFootnoteSourceAnchor,
} from "~/util/assistantTextSelection";
import { promptFloatingLayerProps } from "./promptEventScope";
import { observeReplyFootnoteCommentSource } from "./ReplyFootnoteSource";
import { ReplyFootnoteCommentEditor } from "./ReplyFootnoteCommentEditor";
import { TooltipTrigger, TooltipPopup, Tooltip } from "../ui/tooltip";
import { PopoverTrigger, PopoverPopup, Popover } from "../ui/popover";
import { mark, markTextHover, pill } from "../tagStyles";
import { replyFootnoteNavigation, replyFootnoteHash } from "../../util/replyFootnoteNavigation";
import { serializeReplyFootnote } from "@kora/shared/assistantFootnotes";
import type { ReplyFootnote } from "@kora/contracts";
import { useEffect, useMemo, useRef } from "react";
import { PencilIcon, QuoteIcon } from "lucide-react";
import { useNavigate, Link } from "@tanstack/react-router";

const PREVIEW_MAX = 64;

type CommentEditor = {
  sourceAnchor?: ReplyFootnoteSourceAnchor | undefined;
  onOpenChange: (open: boolean) => void;
  onSave: (comment: string) => boolean;
  onCancel?: () => void;
  open: boolean;
};

function previewOf(citation: ReplyFootnote): string {
  const source = citation.comment?.trim() || citation.text;
  const flat = source.replace(/\s+/g, " ");
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX)}…` : flat;
}

/** Popover anchor that sits on the last line of a multi-line selection. */
function virtualAnchor(anchor: ReplyFootnoteSourceAnchor) {
  return {
    contextElement: anchor.source,
    getBoundingClientRect: () => {
      const rects = anchor.range.getClientRects();
      return rects.length > 0 ? rects[rects.length - 1]! : anchor.range.getBoundingClientRect();
    },
  };
}

function CommentButton({ citation, editor }: { citation: ReplyFootnote; editor: CommentEditor }) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const latest = useRef(editor);
  latest.current = editor;

  // While open, keep the quoted source marked; close if it disappears.
  useEffect(() => {
    if (!editor.open) return;
    const anchor =
      editor.sourceAnchor ?? findReplyFootnoteSourceAnchor(document, citation) ?? undefined;
    if (!anchor) return;
    const providedAnchor = editor.sourceAnchor !== undefined;
    return observeReplyFootnoteCommentSource({
      anchor,
      citation,
      onUnavailable: () => {
        if (providedAnchor) latest.current.onOpenChange(false);
      },
    });
  }, [editor.open, editor.sourceAnchor, citation]);

  const anchor = useMemo(
    () => (editor.sourceAnchor ? virtualAnchor(editor.sourceAnchor) : undefined),
    [editor.sourceAnchor],
  );

  return (
    <Popover onOpenChange={editor.onOpenChange} open={editor.open}>
      <PopoverTrigger
        render={
          <button
            aria-label={citation.comment ? "Edit citation comment" : "Add comment to citation"}
            className={cn(pill.dismiss, cn("text-inherit", markTextHover))}
            type="button"
          />
        }
      >
        <PencilIcon aria-hidden="true" className="size-[0.85em]" />
      </PopoverTrigger>
      {editor.open ? (
        <PopoverPopup
          {...promptFloatingLayerProps}
          align="end"
          anchor={anchor}
          aria-label="Edit citation comment"
          className="w-72 max-w-[calc(100vw-1rem)]"
          initialFocus={() => {
            inputRef.current?.focus({ preventScroll: true });
            return false;
          }}
          onPointerDown={(event) => event.stopPropagation()}
          side={editor.sourceAnchor ? "bottom" : "top"}
          viewportClassName="p-3"
        >
          <ReplyFootnoteCommentEditor
            citation={citation}
            inputRef={inputRef}
            key={serializeReplyFootnote(citation)}
            onCancel={() => (editor.onCancel ? editor.onCancel() : editor.onOpenChange(false))}
            onSubmit={(comment) => {
              if (!editor.onSave(comment)) return false;
              editor.onOpenChange(false);
              return true;
            }}
          />
        </PopoverPopup>
      ) : null}
    </Popover>
  );
}

export function ReplyFootnoteChip({
  citation,
  composer = false,
  commentEditor,
}: {
  citation: ReplyFootnote;
  composer?: boolean;
  commentEditor?: CommentEditor;
}) {
  const navigate = useNavigate();
  const label = previewOf(citation);
  const markdown = serializeReplyFootnote(citation);

  const link = (
    <Link
      resetScroll={false}
      hash={replyFootnoteHash(citation)}
      data-markdown-copy={markdown}
      className={cn(
        "inline-flex h-full items-center gap-[0.33em] rounded-sm text-inherit no-underline focus-visible:outline-2 focus-visible:outline-[var(--contrast-foreground)]",
        !composer && markTextHover,
      )}
      params={{ hostId: citation.hostId, threadId: citation.threadId }}
      aria-label={`View cited assistant text: ${label}`}
      to="/$hostId/$threadId"
      onClick={(event) => {
        const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
        if (modified || event.button !== 0) {
          return;
        }
        event.preventDefault();
        void navigate(replyFootnoteNavigation(citation));
      }}
    >
      <QuoteIcon aria-hidden="true" />
      <span className={cn("max-w-[16em]", pill.label)}>{label}</span>
    </Link>
  );

  return (
    <span
      className={composer ? cn(pill.base, pill.tint) : cn(mark.base, mark.tint)}
      contentEditable={false}
      data-markdown-copy={markdown}
      data-reply-footnote-chip="true"
    >
      {composer ? (
        link
      ) : (
        <Tooltip>
          <TooltipTrigger render={link} />
          <TooltipPopup side="top">View source</TooltipPopup>
        </Tooltip>
      )}
      {commentEditor ? <CommentButton citation={citation} editor={commentEditor} /> : null}
    </span>
  );
}
