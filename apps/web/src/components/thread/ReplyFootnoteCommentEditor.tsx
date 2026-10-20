import { Button } from "../ui/button";
import { REPLY_FOOTNOTE_MAX_COMMENT_LENGTH, type ReplyFootnote } from "@kora/contracts";
import { useState, type Ref } from "react";

export function ReplyFootnoteCommentEditor({
  citation,
  inputRef,
  onSubmit,
  onCancel,
}: {
  citation: ReplyFootnote;
  inputRef?: Ref<HTMLTextAreaElement>;
  onSubmit: (comment: string) => boolean;
  onCancel: () => void;
}) {
  const [comment, setComment] = useState(citation.comment ?? "");
  const commentTooLong = comment.length > REPLY_FOOTNOTE_MAX_COMMENT_LENGTH;
  const submit = () => {
    if (!commentTooLong) onSubmit(comment);
  };
  return (
    <div
      data-footnote-comment-editor="true"
      onKeyDown={(event) => {
        event.stopPropagation();
      }}
    >
      <textarea
        className="field-sizing-content block max-h-40 min-h-16 w-full resize-none bg-transparent px-1 py-1.5 text-base outline-none placeholder:text-muted-foreground sm:text-sm"
        onChange={(event) => setComment(event.currentTarget.value)}
        placeholder="Add an optional comment..."
        ref={inputRef}
        onKeyDown={(event) => {
          const plainEnter = event.key === "Enter" && !event.shiftKey;
          const composing = event.nativeEvent.isComposing || event.keyCode === 229;
          if (plainEnter && !composing) {
            event.preventDefault();
            submit();
          }
        }}
        aria-invalid={commentTooLong || undefined}
        value={comment}
        aria-label="Comment on selected text"
        rows={2}
      />
      {commentTooLong ? (
        <p role="status" className="pt-1 text-xs text-destructive">
          Comments can contain up to {REPLY_FOOTNOTE_MAX_COMMENT_LENGTH.toLocaleString()}{" "}
          characters.
        </p>
      ) : null}
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button
          onPointerDown={(event) => event.preventDefault()}
          onClick={onCancel}
          variant="outline"
          size="xs"
        >
          Cancel
        </Button>
        <Button
          onPointerDown={(event) => event.preventDefault()}
          disabled={commentTooLong}
          onClick={submit}
          size="xs"
        >
          {commentTooLong ? "Shorten comment" : "Save"}
        </Button>
      </div>
    </div>
  );
}
