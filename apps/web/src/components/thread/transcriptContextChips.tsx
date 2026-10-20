import { cn } from "~/util/utils";
import { TerminalExcerptInlineChip } from "./TerminalExcerptInlineChip";
import { SkillInlineText } from "./SkillInlineText";
import { CHAT_FILE_TAG_CHIP_CLASS_NAME, FileTagBody } from "./FileTagChip";
import { ReadOnlySourceViewer } from "../viewer/LazySourceViewer";
import { TooltipTrigger, TooltipPopup, Tooltip } from "../ui/tooltip";
import { mark, pill, tagFocusRing, SKILL_GLYPH_SVG } from "../tagStyles";
import {
  createContextDisplayRegistry,
  type ContextDisplayCapability,
} from "../contextDisplayRegistry";
import { ContextTagPopover, ContextTagShell, UnresolvedChip } from "../contextTagParts";
import ReplyMarkdown, { type ReplyMarkdownContextReference } from "../ReplyMarkdown";
import { DiffWorkerPoolProvider } from "../DiffWorkers";
import { formatWorkspaceRelativePath } from "../../workspace/filePathDisplay";
import {
  DIFF_SURFACE_THEME_UNSAFE_CSS,
  resolveDiffThemeName,
  getRenderablePatch,
} from "../../util/diffRendering";
import {
  selectedMessageContextFragment,
  reviewCommentFromRecord,
} from "../../util/contextChipRecords";
import { buildReviewCommentRenderablePatch } from "../../thread/reviewCommentContext";
import { useDockStore } from "../../stores/dockStore";
import { replyMarkdownClipboardPayload } from "../../markdown/clipboard";
import { formatContextChipReference } from "@kora/shared/contextChipReferences";
import { encodeContextChipClipboardHtml } from "@kora/shared/contextChipClipboard";
// Chips for the context a user message carries (files, skills, terminal excerpts, picked elements, review
// comments, preview annotations), plus the copy handling that keeps those chips intact on the clipboard.
import {
  CONTEXT_CHIP_CLIPBOARD_MIME,
  type ReviewCommentChipRecord,
  type WebMarkupContextRecord,
  type ElementContextRecord,
  type MentionContextRecord,
  CONTEXT_CHIP_KINDS,
  type SkillContextRecord,
  type ContextChipRecord,
  type ContextTagKind,
  type HostThreadRef,
  type ContextChipId,
  type ThreadId,
  type HostId,
  type ItemId,
} from "@kora/contracts";
import { type ClipboardEvent, type ReactElement, type ReactNode, useMemo, memo } from "react";
import { MousePointerClickIcon, MessageCircleIcon, PaintbrushIcon } from "lucide-react";
import { FileDiff } from "@pierre/diffs/react";

export interface UserContextChipEnvironment {
  readonly records: ReadonlyMap<string, ContextChipRecord>;
  readonly resolvedTheme: "light" | "dark";
  readonly workspaceRoot: string | undefined;
  readonly threadRef: HostThreadRef | null;
  readonly skills: ReadonlyArray<{
    readonly name: string;
    readonly displayName?: string | undefined;
  }>;
}

interface ChipRequest {
  readonly reference: ReplyMarkdownContextReference;
  readonly env: UserContextChipEnvironment;
}

const UNRESOLVED_TOOLTIP = "This context is no longer available.";
const ICON_CLASS = cn(pill.icon, "size-3.5 text-current");

function copyMarkdownFor(reference: ReplyMarkdownContextReference): string {
  return formatContextChipReference({
    kind: reference.kind as ContextTagKind,
    contextId: reference.contextId as ContextChipId,
    label: reference.label,
  });
}

const CHIP_CLASS = cn(mark.base, mark.tint);

/** Opens a detail card from a chip: the chip is the button, the card is a popover over it. */
function PopoverChip(props: {
  readonly accessibleLabel: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly copyMarkdown: string;
  readonly popupClassName?: string;
  readonly children: ReactNode;
}) {
  const chipClass = CHIP_CLASS;
  return (
    <ContextTagPopover
      accessibleLabel={props.accessibleLabel}
      copyMarkdown={props.copyMarkdown}
      chip={
        <span className={chipClass}>
          {props.icon}
          <span className={mark.label}>{props.label}</span>
        </span>
      }
      triggerClassName={cn(chipClass, mark.hover, "cursor-pointer")}
      {...(props.popupClassName !== undefined ? { popupClassName: props.popupClassName } : {})}
    >
      {props.children}
    </ContextTagPopover>
  );
}

// ---------------------------------------------------------------------------
// Detail cards

const CARD_CLASS = "space-y-2 rounded-lg border border-border/70 bg-background/70 p-3";

function ElementDetails({ record }: { record: ElementContextRecord }) {
  const heading = record.pageTitle?.trim() || record.pageUrl;
  const source = record.source;
  const sourceLabel =
    source?.fileName != null
      ? `${source.fileName}${source.lineNumber != null ? `:${source.lineNumber}` : ""}`
      : null;
  return (
    <div className={CARD_CLASS}>
      <div className="min-w-0">
        <div className="truncate text-xs font-medium text-foreground">{heading}</div>
        {record.pageTitle?.trim() ? (
          <div className="truncate text-[11px] text-secondary-label">{record.pageUrl}</div>
        ) : null}
      </div>
      {record.selector || sourceLabel ? (
        <div className="space-y-0.5 text-[11px]">
          {record.selector ? (
            <code className="block truncate font-mono text-foreground">{record.selector}</code>
          ) : null}
          {sourceLabel ? (
            <div className="truncate font-mono text-secondary-label">{sourceLabel}</div>
          ) : null}
        </div>
      ) : null}
      {record.htmlPreview ? (
        <div className="flex h-40 min-h-0 flex-col overflow-hidden rounded-md border border-border">
          <ReadOnlySourceViewer name="element.html" text={record.htmlPreview} />
        </div>
      ) : null}
      {record.styles ? (
        <div className="flex h-32 min-h-0 flex-col overflow-hidden rounded-md border border-border">
          <ReadOnlySourceViewer name="styles.css" text={record.styles} />
        </div>
      ) : null}
    </div>
  );
}

function ReviewCommentCode(props: {
  readonly comment: ReturnType<typeof reviewCommentFromRecord>;
  readonly theme: "light" | "dark";
}) {
  const { comment, theme } = props;
  const language = comment.fenceLanguage ?? "diff";
  const patch = useMemo(
    () => getRenderablePatch(buildReviewCommentRenderablePatch(comment), "review-comment"),
    [comment],
  );

  if (language !== "diff") {
    const fence = `\`\`\`${language}\n${comment.diff.trimEnd()}\n\`\`\``;
    return <ReplyMarkdown text={fence} cwd={undefined} />;
  }
  if (patch?.kind === "files") {
    return (
      <DiffWorkerPoolProvider>
        <div className="overflow-hidden rounded-md border border-border">
          {patch.files.map((fileDiff, index) => (
            <FileDiff
              key={`${fileDiff.name}:${index}`}
              fileDiff={fileDiff}
              options={{
                diffStyle: "unified",
                theme: resolveDiffThemeName(theme),
                themeType: theme,
                disableFileHeader: true,
                overflow: "scroll",
                unsafeCSS: DIFF_SURFACE_THEME_UNSAFE_CSS,
              }}
            />
          ))}
        </div>
      </DiffWorkerPoolProvider>
    );
  }
  const raw = patch?.kind === "raw" ? patch.text : comment.diff;
  return (
    <pre className="max-h-64 overflow-auto rounded-md border border-border bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
      {raw}
    </pre>
  );
}

function ReviewCommentDetails(props: {
  readonly record: ReviewCommentChipRecord;
  readonly env: UserContextChipEnvironment;
}) {
  const comment = useMemo(() => reviewCommentFromRecord(props.record), [props.record]);
  const text = comment.text.trim();
  return (
    <div className={CARD_CLASS}>
      <div className="truncate text-xs font-medium text-foreground">
        {formatWorkspaceRelativePath(comment.filePath, props.env.workspaceRoot)}
      </div>
      <div className="text-[11px] text-secondary-label">
        {comment.sectionTitle} · {comment.rangeLabel}
      </div>
      {text ? (
        <div className="text-sm text-foreground">
          <SkillInlineText text={text} skills={props.env.skills} />
        </div>
      ) : null}
      {comment.diff.trim() ? (
        <ReviewCommentCode comment={comment} theme={props.env.resolvedTheme} />
      ) : null}
    </div>
  );
}

const MAX_LISTED_ELEMENTS = 4;

function PreviewAnnotationDetails({ record }: { record: WebMarkupContextRecord }) {
  const elements = record.elements ?? [];
  const listed = elements.slice(0, MAX_LISTED_ELEMENTS);
  const hidden = elements.length - listed.length;
  const styleCount = record.styleChangeDetails?.length ?? record.styleChanges.length;
  return (
    <div className={CARD_CLASS}>
      <div className="min-w-0">
        <div className="truncate text-xs font-medium text-foreground">
          {record.pageTitle?.trim() || record.pageUrl}
        </div>
        {record.pageTitle?.trim() ? (
          <div className="truncate text-[11px] text-secondary-label">{record.pageUrl}</div>
        ) : null}
      </div>
      {record.comment.trim() ? (
        <p className="text-sm break-words whitespace-pre-wrap text-foreground">
          {record.comment.trim()}
        </p>
      ) : null}
      {record.targetSummary ? (
        <p className="text-xs text-secondary-label">{record.targetSummary}</p>
      ) : null}
      {styleCount > 0 ? (
        <div className="flex items-center gap-1.5 text-xs text-secondary-label">
          <PaintbrushIcon className="size-3.5" aria-hidden />
          {styleCount} style change{styleCount === 1 ? "" : "s"}
        </div>
      ) : null}
      {listed.length > 0 ? (
        <ul className="space-y-0.5 text-[11px]">
          {listed.map((element, index) => (
            <li key={index} className="truncate font-mono text-foreground">
              {element.selector ?? element.tagName}
            </li>
          ))}
          {hidden > 0 ? (
            <li className="text-secondary-label">
              {hidden} more selected element{hidden === 1 ? "" : "s"}
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Registry

type Handler<Record extends ContextChipRecord> = (
  record: Record,
  request: ChipRequest,
  capabilities: ContextDisplayCapability,
) => ReactElement;

function handler<K extends ContextChipRecord["kind"]>(
  kind: K & (typeof CONTEXT_CHIP_KINDS)[number],
  render: Handler<Extract<ContextChipRecord, { kind: K }>>,
) {
  return {
    kind,
    canRender: (record: ContextChipRecord) => record.kind === kind && !("payload" in record),
    render: (
      record: ContextChipRecord,
      request: ChipRequest,
      definition: { capabilities: ContextDisplayCapability },
    ) =>
      render(record as Extract<ContextChipRecord, { kind: K }>, request, definition.capabilities),
  };
}

function MentionChip({ record, request }: { record: MentionContextRecord; request: ChipRequest }) {
  const { threadRef, resolvedTheme } = request.env;
  const openFile = useDockStore((state) => state.openFile);
  const chipClass = cn(CHAT_FILE_TAG_CHIP_CLASS_NAME, mark.hover);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`Preview ${record.path}`}
            data-markdown-copy={copyMarkdownFor(request.reference)}
            className={cn(chipClass, "cursor-pointer", tagFocusRing)}
            onClick={() => {
              if (threadRef) openFile(threadRef, record.path);
            }}
          />
        }
      >
        <FileTagBody path={record.path} label={request.reference.label} theme={resolvedTheme} />
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-96 leading-tight">
        {record.path}
      </TooltipPopup>
    </Tooltip>
  );
}

function SkillChip({ record, request }: { record: SkillContextRecord; request: ChipRequest }) {
  return (
    <ContextTagShell
      aria-label={`Skill, ${request.reference.label}`}
      data-markdown-copy={copyMarkdownFor(request.reference)}
      className={CHIP_CLASS}
      labelClassName={mark.label}
      label={request.reference.label}
      icon={
        <span
          className={ICON_CLASS}
          aria-hidden
          dangerouslySetInnerHTML={{ __html: SKILL_GLYPH_SVG }}
        />
      }
      tooltip={`$${record.name}`}
      tooltipClassName="max-w-80 leading-tight"
    />
  );
}

const registry = createContextDisplayRegistry<ContextChipRecord, ChipRequest, ReactElement>({
  requiredKinds: [...CONTEXT_CHIP_KINDS],
  handlers: [
    handler("mention", (record, request) => <MentionChip record={record} request={request} />),
    handler("skill", (record, request) => <SkillChip record={record} request={request} />),
    handler("terminal", (record, request, capabilities) => (
      <span className="contents" data-markdown-copy={copyMarkdownFor(request.reference)}>
        <TerminalExcerptInlineChip
          terminalLabel={record.terminalLabel}
          detailsMode={capabilities.details}
          label={request.reference.label}
          lineStart={record.lineStart}
          lineEnd={record.lineEnd}
          surface="transcript"
          text={record.text}
        />
      </span>
    )),
    handler("element", (record, request) => (
      <PopoverChip
        accessibleLabel={`Browser element, ${request.reference.label}`}
        label={request.reference.label}
        icon={<MousePointerClickIcon className={ICON_CLASS} aria-hidden />}
        copyMarkdown={copyMarkdownFor(request.reference)}
      >
        <ElementDetails record={record} />
      </PopoverChip>
    )),
    handler("review-comment", (record, request) => (
      <PopoverChip
        accessibleLabel={`Review comment, ${request.reference.label}`}
        label={request.reference.label}
        icon={<MessageCircleIcon className={ICON_CLASS} aria-hidden />}
        copyMarkdown={copyMarkdownFor(request.reference)}
      >
        <ReviewCommentDetails record={record} env={request.env} />
      </PopoverChip>
    )),
    handler("preview-annotation", (record, request) => (
      <PopoverChip
        accessibleLabel={`Preview annotation, ${request.reference.label}`}
        label={request.reference.label}
        icon={<MousePointerClickIcon className={ICON_CLASS} aria-hidden />}
        copyMarkdown={copyMarkdownFor(request.reference)}
      >
        <PreviewAnnotationDetails record={record} />
      </PopoverChip>
    )),
  ],
  fallback: (_kind, _record, request) => (
    <UnresolvedChip
      label={request.reference.label}
      className={CHIP_CLASS}
      labelClassName={mark.label}
      tooltip={UNRESOLVED_TOOLTIP}
      tooltipClassName="max-w-80 leading-tight"
      copyMarkdown={copyMarkdownFor(request.reference)}
    />
  ),
});

export const UserContextChip = memo(function UserContextChip(props: {
  readonly reference: ReplyMarkdownContextReference;
  readonly env: UserContextChipEnvironment;
}) {
  return registry.render(props.reference.kind, props.env.records.get(props.reference.contextId), {
    reference: props.reference,
    env: props.env,
  });
});

// ---------------------------------------------------------------------------
// Clipboard

/**
 * Copy from a user message body. When the selection takes context chips with it, the clipboard gets the text,
 * HTML carrying the chip fragment, and the chip MIME for just those chips, so pasting into a composer restores them.
 */
export function handleUserMessageCopy(
  event: ClipboardEvent<HTMLElement>,
  message: {
    readonly records: ReadonlyArray<ContextChipRecord>;
    readonly hostId: HostId;
    readonly threadId: ThreadId | undefined;
    readonly messageId: ItemId;
  },
): void {
  if (message.records.length === 0) return;
  const selection = event.currentTarget.ownerDocument.defaultView?.getSelection();
  if (!selection || selection.isCollapsed) return;
  const payload = replyMarkdownClipboardPayload(selection);
  if (!payload) return;
  const fragment = selectedMessageContextFragment({
    markdown: payload.text,
    records: message.records,
    hostId: message.hostId,
    ...(message.threadId !== undefined ? { threadId: message.threadId } : {}),
    messageId: message.messageId,
  });
  if (fragment === null || !event.clipboardData) return;
  event.clipboardData.setData("text/plain", payload.text);
  event.clipboardData.setData(
    "text/html",
    encodeContextChipClipboardHtml(payload.text, fragment, payload.html),
  );
  event.clipboardData.setData(CONTEXT_CHIP_CLIPBOARD_MIME, fragment);
  event.preventDefault();
}
