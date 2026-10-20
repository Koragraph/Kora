import { Textarea } from "../ui/textarea";
import { Button } from "../ui/button";
import { cn } from "../../util/utils";
import { useLayoutEffect, type FocusEvent, type ReactNode, useState, useRef } from "react";
import { MessageCircleIcon, Trash2Icon } from "lucide-react";

interface DiffCommentSecondaryAction {
  readonly onAction: (text: string) => void;
  readonly allowEmpty?: boolean;
  readonly icon?: ReactNode;
  readonly label: string;
}

interface DiffCommentAnnotationProps {
  secondaryAction?: DiffCommentSecondaryAction;
  onTextChange?: (text: string) => void;
  onComment: (text: string) => void;
  kind: "draft" | "comment";
  focusOnMount?: boolean;
  onDelete?: () => void;
  submitLabel?: string;
  placeholder?: string;
  onCancel: () => void;
  rangeLabel: string;
  pending?: boolean;
  text: string;
}

// The host diff/editor must not steal the selection when the widget is pressed.
const hostIsolation = {
  "data-diff-comment-annotation": "",
  contentEditable: false,
  onPointerDown: (event: { stopPropagation: () => void }) => event.stopPropagation(),
} as const;

export function DiffCommentAnnotation(props: DiffCommentAnnotationProps) {
  const {
    placeholder = "Add a comment…",
    submitLabel = "Comment",
    focusOnMount = true,
    secondaryAction,
    pending = false,
    onTextChange,
    rangeLabel,
    onComment,
    onDelete,
    onCancel,
    text,
    kind,
  } = props;
  const [localText, setLocalText] = useState("");
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  const controlled = onTextChange !== undefined;
  const value = controlled ? text : localText;
  const trimmed = value.trim();

  useLayoutEffect(() => {
    if (kind !== "draft" || !focusOnMount) return;
    const frame = requestAnimationFrame(() => fieldRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [kind, focusOnMount]);

  if (kind === "comment") {
    return (
      <div
        {...hostIsolation}
        className="group flex min-w-0 items-start gap-2.5 border-s-2 border-primary/55 bg-primary/[0.045] px-3 py-2.5 font-sans text-foreground"
      >
        <MessageCircleIcon
          aria-hidden="true"
          className="mt-0.5 size-3.5 shrink-0 text-primary/70"
        />
        <p className="min-w-0 flex-1 text-[13px] leading-5 whitespace-pre-wrap">{text}</p>
        {onDelete ? (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Delete comment"
            className="-my-1 -mr-1 text-muted-foreground transition-opacity focus-visible:opacity-100 group-hover:opacity-100 sm:opacity-0"
            onClick={onDelete}
          >
            <Trash2Icon className="size-3" />
          </Button>
        ) : null}
      </div>
    );
  }

  const placeCaretAtEnd = (event: FocusEvent<HTMLTextAreaElement>) => {
    const field = event.currentTarget;
    field.setSelectionRange(field.value.length, field.value.length);
  };

  const update = (next: string) => {
    if (controlled) onTextChange(next);
    else setLocalText(next);
  };

  return (
    <div {...hostIsolation} className="px-3 py-2 font-sans text-foreground">
      <Textarea
        onChange={(event) => update(event.target.value)}
        className={cn(
          "inline-flex w-full cursor-text rounded-md border border-border/50 bg-background/20 transition-colors focus-within:border-border/70",
          "[&_textarea]:min-h-12 [&_textarea]:cursor-text [&_textarea]:px-2.5 [&_textarea]:py-1.5 [&_textarea]:font-sans [&_textarea]:text-xs [&_textarea]:leading-5 [&_textarea]:caret-foreground max-sm:[&_textarea]:min-h-12",
        )}
        onFocus={placeCaretAtEnd}
        autoFocus={focusOnMount}
        placeholder={placeholder}
        unstyled
        value={value}
        ref={fieldRef}
        size="sm"
        aria-label={`Comment on lines ${rangeLabel}`}
      />
      <div className="mt-1.5 flex items-center gap-1">
        <div className="flex-1" />
        <Button
          size="xs"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground"
          onClick={onCancel}
        >
          Cancel
        </Button>
        {secondaryAction ? (
          <Button
            size="xs"
            variant="outline"
            disabled={trimmed === "" && !secondaryAction.allowEmpty}
            onClick={() => secondaryAction.onAction(trimmed)}
          >
            {secondaryAction.icon}
            {secondaryAction.label}
          </Button>
        ) : null}
        <Button size="xs" disabled={pending || trimmed === ""} onClick={() => onComment(trimmed)}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}
