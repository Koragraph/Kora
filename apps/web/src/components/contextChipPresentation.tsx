import { ReadOnlySourceViewer } from "./viewer/LazySourceViewer";
import { PromptPendingTerminalContextChip } from "./thread/PromptPendingTerminalContexts";
import { pill } from "./tagStyles";
import {
  type ContextDisplayCapability,
  createContextDisplayRegistry,
} from "./contextDisplayRegistry";
import { ContextTagPopover, ContextTagShell, UnresolvedChip } from "./contextTagParts";
import ReplyMarkdown from "./ReplyMarkdown";
import { cn } from "../util/utils";
import type { TerminalExcerptDraft } from "../util/terminalContext";
import {
  reviewCommentContextLabel,
  terminalExcerptReference,
  reviewCommentContextId,
  webMarkupContextLabel,
  webMarkupContextId,
} from "../util/contextChipRecords";
import type { ReviewCommentContext } from "../thread/reviewCommentContext";
import type { WebMarkupPayload } from "@kora/contracts";
import { createContext, type ReactElement, use } from "react";
import { MousePointerClickIcon, MessageCircleIcon } from "lucide-react";

export type PromptDraftContextRecord =
  | { kind: "terminal"; record: TerminalExcerptDraft }
  | { kind: "review-comment"; record: ReviewCommentContext }
  | { kind: "preview-annotation"; record: WebMarkupPayload };

export interface ContextChipActions {
  openMention: (path: string) => void;
}

export const ContextChipActionsContext = createContext<ContextChipActions>({
  openMention: () => {},
});

export type PromptDraftContextRecords = ReadonlyMap<string, PromptDraftContextRecord>;

export const ContextChipRecordsContext = createContext<PromptDraftContextRecords>(new Map());

export function contextChipRecordsFromDraft(input: {
  terminalContexts: ReadonlyArray<TerminalExcerptDraft>;
  reviewComments?: ReadonlyArray<ReviewCommentContext>;
  previewAnnotations?: ReadonlyArray<WebMarkupPayload>;
}): PromptDraftContextRecords {
  const records = new Map<string, PromptDraftContextRecord>();
  for (const record of input.terminalContexts) {
    records.set(terminalExcerptReference(record).contextId, { record, kind: "terminal" });
  }
  for (const record of input.reviewComments ?? []) {
    records.set(reviewCommentContextId(record.id), { record, kind: "review-comment" });
  }
  for (const record of input.previewAnnotations ?? []) {
    records.set(webMarkupContextId(record.id), { kind: "preview-annotation", record });
  }
  return records;
}

const UNRESOLVED_TOOLTIP = "This context is no longer available. Remove it or attach it again.";

interface RenderRequest {
  readonly label: string;
}

function GenericChip(props: {
  kindLabel: string;
  label: string;
  details: ContextDisplayCapability["details"];
  tone: "review-comment" | "preview-annotation";
  icon: ReactElement;
  popover?: ReactElement;
}): ReactElement {
  const accessibleLabel = `${props.kindLabel}, ${props.label}`;
  const popover = props.details === "popover";
  const chip = (
    <ContextTagShell
      icon={props.icon}
      label={props.label}
      className={cn(pill.base, pill.tint)}
      labelClassName={pill.label}
      interactive={popover}
      aria-hidden={popover ? true : undefined}
      aria-label={props.details === "tooltip" ? accessibleLabel : undefined}
      tooltip={props.details === "tooltip" ? props.label : undefined}
    />
  );
  if (!popover) return chip;
  return (
    <ContextTagPopover accessibleLabel={accessibleLabel} chip={chip}>
      {props.popover}
    </ContextTagPopover>
  );
}

function ReviewCommentDetails({ comment }: { comment: ReviewCommentContext }) {
  const text = comment.text.trim();
  const diff = comment.diff.trim();
  return (
    <div className="space-y-2 rounded-lg border border-border/70 bg-background/70 p-3">
      <div className="truncate text-xs font-medium text-foreground">{comment.filePath}</div>
      <div className="text-[11px] text-secondary-label">
        {comment.sectionTitle} · {comment.rangeLabel}
      </div>
      {text ? <ReplyMarkdown text={text} cwd={undefined} /> : null}
      {diff ? (
        <div className="flex h-64 min-h-0 flex-col overflow-hidden rounded-md border border-border">
          <ReadOnlySourceViewer name="review.diff" text={comment.diff} />
        </div>
      ) : null}
    </div>
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function annotationSummary(annotation: WebMarkupPayload): string {
  const title = annotation.pageTitle?.trim();
  const lines = [title ? title : annotation.pageUrl];
  const comment = annotation.comment?.trim();
  if (comment) lines.push("", comment);
  const counts = [
    [annotation.elements.length, "element"],
    [annotation.regions.length, "region"],
    [annotation.strokes.length, "drawing"],
    [annotation.styleChanges.length, "style change"],
  ] as const;
  const parts = counts.filter(([count]) => count > 0).map(([count, noun]) => plural(count, noun));
  if (parts.length > 0) lines.push("", parts.join(", "));
  return lines.join("\n");
}

function PreviewAnnotationDetails({ annotation }: { annotation: WebMarkupPayload }) {
  const dataUrl = annotation.screenshot?.dataUrl;
  return (
    <div className="overflow-hidden rounded-lg border border-border/70 bg-background/70">
      {dataUrl ? (
        <img
          src={dataUrl}
          alt="Annotated preview crop"
          className="max-h-64 w-full border-b border-border/70 bg-muted object-contain"
        />
      ) : (
        <div className="border-b border-border/70 bg-muted/40 px-3 py-2 text-xs text-secondary-label">
          Screenshot unavailable
        </div>
      )}
      <div className="px-3 py-2.5 text-sm break-words whitespace-pre-wrap text-foreground">
        {annotationSummary(annotation)}
      </div>
    </div>
  );
}

const iconClass = (tone: "review-comment" | "preview-annotation") =>
  cn(pill.icon, "size-3.5", "text-current");

const registry = createContextDisplayRegistry<
  PromptDraftContextRecord,
  RenderRequest,
  ReactElement
>({
  requiredKinds: ["terminal", "review-comment", "preview-annotation"],
  handlers: [
    {
      kind: "terminal",
      canRender: (record) => record.kind === "terminal",
      render: (record, _request, definition) =>
        record.kind === "terminal" ? (
          <PromptPendingTerminalContextChip
            context={record.record}
            detailsMode={definition.capabilities.details}
          />
        ) : (
          <></>
        ),
    },
    {
      kind: "review-comment",
      canRender: (record) => record.kind === "review-comment",
      render: (record, _request, definition) => {
        if (record.kind !== "review-comment") return <></>;
        return (
          <GenericChip
            kindLabel="Review comment"
            label={reviewCommentContextLabel(record.record)}
            details={definition.capabilities.details}
            tone="review-comment"
            icon={<MessageCircleIcon className={iconClass("review-comment")} />}
            popover={<ReviewCommentDetails comment={record.record} />}
          />
        );
      },
    },
    {
      kind: "preview-annotation",
      canRender: (record) => record.kind === "preview-annotation",
      render: (record, _request, definition) => {
        if (record.kind !== "preview-annotation") return <></>;
        return (
          <GenericChip
            kindLabel="Preview annotation"
            label={webMarkupContextLabel(record.record)}
            details={definition.capabilities.details}
            tone="preview-annotation"
            icon={<MousePointerClickIcon className={iconClass("preview-annotation")} />}
            popover={<PreviewAnnotationDetails annotation={record.record} />}
          />
        );
      },
    },
  ],
  fallback: (_kind, _record, request) => (
    <UnresolvedChip
      label={request.label}
      className={cn(pill.base, pill.tint)}
      labelClassName={pill.label}
      tooltip={UNRESOLVED_TOOLTIP}
      tooltipClassName="max-w-80 leading-tight"
    />
  ),
});

export function ContextChipReferenceChip(props: {
  contextId: string;
  label: string;
  kind: string;
}): ReactElement {
  const records = use(ContextChipRecordsContext);
  return registry.render(props.kind, records.get(props.contextId), { label: props.label });
}
