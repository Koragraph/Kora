import { cn } from "~/util/utils";
import { resolvePathLinkTarget } from "~/thread/terminal-links";
import { useCopyToClipboard } from "~/hooks/useCopyText";
import { Spinner } from "~/components/ui/spinner";
import { Button } from "~/components/ui/button";
import { useInView } from "./useInView";
import {
  useFileObjectUrl,
  useFileThumbnail,
  useSheetPreview,
  type PreviewFailure,
  useOfficeMeta,
} from "./useFilePreview";
import { revealInFinder } from "./reveal";
import { PREVIEW_LIMITS } from "./limits";
import { parseDelimited, delimiterFor } from "./delimited";
import { tableModelFromSheet, SheetTable, type TableModel } from "./SheetTable";
import { useProjectFile } from "../../viewer/projectFilesQueryState";
import {
  classifyOutputFamily,
  truncateOutputName,
  outputDisplayName,
  outputFamilyLabel,
  useOpenChatOutput,
  formatOutputSize,
  outputFamilyIcon,
  type OutputFamily,
} from "../../assistant/outputs";
import ReplyMarkdown from "../../ReplyMarkdown";
// Rich output cards for the Blobs surface: a finished file in the blob's workspace becomes a card in the chat (and in
// the Files tab) that SHOWS the file where it can: a spreadsheet as a real table with sheet tabs, a CSV as a table,
// a Word document / deck / PDF as a titled summary with page count, an image inline, markdown rendered. Everything
// loads lazily (only once the card is on screen) and parses off the main thread; limits are stated, never silent.
import type { HostThreadRef, HostId } from "@kora/contracts";
import { useState, useMemo } from "react";
import { ExternalLinkIcon, ChevronDownIcon, FolderOpenIcon, ChevronUpIcon } from "lucide-react";

interface CardTarget {
  readonly hostId: HostId;
  readonly cwd: string;
  readonly threadRef: HostThreadRef | null;
  readonly blobId: string;
  readonly relativePath: string;
}

// ── shell ─────────────────────────────────────────────────────────────────────────────────────────────────────

function CardShell(props: {
  readonly target: CardTarget;
  readonly family: OutputFamily;
  readonly title: string;
  readonly subtitle: string;
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly onToggleExpanded: () => void;
  readonly wide: boolean;
  readonly children?: React.ReactNode;
  readonly innerRef?: React.Ref<HTMLDivElement>;
}) {
  const Icon = outputFamilyIcon(props.family);
  const open = useOpenChatOutput(props.target.threadRef);
  const { copyToClipboard } = useCopyToClipboard({ target: "file path" });
  const absolutePath = resolvePathLinkTarget(props.target.relativePath, props.target.cwd);
  const name = outputDisplayName(props.target.relativePath);
  return (
    <div
      ref={props.innerRef}
      data-blob-output-card={props.family}
      className={cn(
        "min-w-0 overflow-hidden rounded-xl border border-border/60 bg-card",
        props.wide ? "w-full max-w-[36rem]" : "w-full max-w-[26rem]",
      )}
    >
      <div className="flex items-center gap-2.5 px-3 py-2">
        <Icon className="size-6 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium leading-5 text-foreground">
            {props.title === name ? truncateOutputName(name, 44) : props.title}
          </p>
          <p className="truncate text-[11.5px] leading-4 text-muted-foreground">{props.subtitle}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {props.expandable ? (
            <Button
              aria-expanded={props.expanded}
              aria-label={props.expanded ? "Collapse preview" : "Expand preview"}
              onClick={props.onToggleExpanded}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              {props.expanded ? (
                <ChevronUpIcon className="size-3.5" aria-hidden />
              ) : (
                <ChevronDownIcon className="size-3.5" aria-hidden />
              )}
            </Button>
          ) : null}
          <Button
            type="button"
            size="xs"
            variant="secondary"
            className="gap-1"
            disabled={props.target.threadRef === null}
            onClick={() => open(props.target.relativePath)}
          >
            <ExternalLinkIcon className="size-3.5" aria-hidden />
            Open
          </Button>
          <Button
            aria-label="Reveal in Finder"
            onClick={() => void revealInFinder(absolutePath, copyToClipboard)}
            size="icon-xs"
            title="Reveal in Finder"
            type="button"
            variant="ghost"
          >
            <FolderOpenIcon className="size-3.5" aria-hidden />
          </Button>
        </div>
      </div>
      {props.children}
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="px-3 pb-2.5 text-[11.5px] leading-4 text-muted-foreground">{children}</p>;
}

function Busy({ label }: { label: string }) {
  return (
    <div
      className="flex items-center gap-2 px-3 pb-2.5 text-[11.5px] text-muted-foreground"
      role="status"
    >
      <Spinner className="size-3" />
      {label}
    </div>
  );
}

function failureNote(failure: PreviewFailure): string {
  return failure.code === "unavailable"
    ? `Preview isn't available here. ${failure.message}`
    : failure.message;
}

// ── spreadsheet ───────────────────────────────────────────────────────────────────────────────────────────────

function SheetCard({ target }: { target: CardTarget }) {
  const { ref, seen } = useInView<HTMLDivElement>();
  const [expanded, setExpanded] = useState(false);
  const { state, selectSheet } = useSheetPreview({
    blobId: target.blobId,
    relativePath: target.relativePath,
    enabled: seen,
  });
  const name = outputDisplayName(target.relativePath);
  const model: TableModel | null = useMemo(
    () => (state.status === "ready" && state.sheet ? tableModelFromSheet(state.sheet) : null),
    [state],
  );
  if (state.status === "error" && state.failure.code === "not_found") return null;
  const sheets = state.status === "ready" ? state.sheetNames : [];
  const subtitle =
    state.status === "ready"
      ? `Spreadsheet · ${sheets.length} ${sheets.length === 1 ? "sheet" : "sheets"} · ${formatOutputSize(state.byteLength)}`
      : "Spreadsheet";
  return (
    <CardShell
      target={target}
      family="sheet"
      title={name}
      subtitle={subtitle}
      expandable={state.status === "ready"}
      expanded={expanded}
      onToggleExpanded={() => setExpanded((current) => !current)}
      wide
      innerRef={ref}
    >
      {state.status === "idle" || state.status === "loading" ? (
        <Busy label="Reading the sheet" />
      ) : null}
      {state.status === "error" ? <Note>{failureNote(state.failure)}</Note> : null}
      {state.status === "ready" ? (
        <>
          {sheets.length > 1 ? (
            <div
              role="tablist"
              aria-label="Sheets"
              className="flex gap-0.5 overflow-x-auto border-t border-border/60 px-2 pt-1.5"
            >
              {sheets.map((sheetName, index) => (
                <button
                  key={sheetName}
                  type="button"
                  role="tab"
                  aria-selected={state.active === index}
                  onClick={() => selectSheet(index)}
                  className={cn(
                    "shrink-0 rounded-t-md px-2.5 py-1 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
                    state.active === index
                      ? "bg-foreground/[0.06] font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {sheetName}
                </button>
              ))}
            </div>
          ) : null}
          <div
            className={cn(
              "overflow-auto border-t border-border/60",
              expanded ? "max-h-[26rem]" : "max-h-[10.5rem]",
            )}
          >
            {state.sheetLoading ? <Busy label="Reading the sheet" /> : null}
            {state.sheetError ? <Note>{failureNote(state.sheetError)}</Note> : null}
            {model ? (
              model.header.length === 0 && model.rows.length === 0 ? (
                <Note>This sheet is empty.</Note>
              ) : (
                <SheetTable
                  model={model}
                  rowLimit={expanded ? PREVIEW_LIMITS.sheetRows : PREVIEW_LIMITS.cardRows}
                  colLimit={expanded ? PREVIEW_LIMITS.sheetCols : PREVIEW_LIMITS.cardCols}
                  gutter={expanded}
                />
              )
            ) : null}
          </div>
        </>
      ) : null}
    </CardShell>
  );
}

// ── csv / tsv ─────────────────────────────────────────────────────────────────────────────────────────────────

function DelimitedCard({ target }: { target: CardTarget }) {
  const { ref, seen } = useInView<HTMLDivElement>();
  const [expanded, setExpanded] = useState(false);
  const file = useProjectFile(target.hostId, target.cwd, target.relativePath, seen);
  const name = outputDisplayName(target.relativePath);
  const table = useMemo(() => {
    if (!file.data) return null;
    return parseDelimited(
      file.data.contents,
      delimiterFor(target.relativePath, file.data.contents),
      {
        textTruncated: file.data.truncated,
      },
    );
  }, [file.data, target.relativePath]);
  // A name the agent mentioned but never wrote gets no card (as the plain output card).
  if (seen && !file.isPending && !file.data && file.error) return null;

  const model: TableModel | null = table
    ? {
        header: table.header,
        rows: table.rows,
        totalRows: table.totalRows,
        moreRows: table.moreRows,
        moreCols: table.moreCols,
        textTruncated: table.textTruncated,
      }
    : null;
  const subtitle = file.data ? `Table · ${formatOutputSize(file.data.byteLength)}` : "Table";
  return (
    <CardShell
      target={target}
      family="delimited"
      title={name}
      subtitle={subtitle}
      expandable={model !== null}
      expanded={expanded}
      onToggleExpanded={() => setExpanded((current) => !current)}
      wide
      innerRef={ref}
    >
      {!seen || file.isPending ? <Busy label="Reading the table" /> : null}
      {model ? (
        <div
          className={cn(
            "overflow-auto border-t border-border/60",
            expanded ? "max-h-[26rem]" : "max-h-[10.5rem]",
          )}
        >
          {model.header.length === 0 ? (
            <Note>This file is empty.</Note>
          ) : (
            <SheetTable
              model={model}
              rowLimit={expanded ? PREVIEW_LIMITS.delimitedRows : PREVIEW_LIMITS.cardRows}
              colLimit={expanded ? PREVIEW_LIMITS.delimitedCols : PREVIEW_LIMITS.cardCols}
              gutter={expanded}
            />
          )}
        </div>
      ) : null}
    </CardShell>
  );
}

// ── document / deck / pdf ─────────────────────────────────────────────────────────────────────────────────────

function countLabel(
  family: "document" | "slides" | "pdf",
  count: number | null,
  approximate: boolean,
) {
  if (count === null) return null;
  const noun =
    family === "slides" ? (count === 1 ? "slide" : "slides") : count === 1 ? "page" : "pages";
  return `${approximate && family !== "document" ? "about " : ""}${count} ${noun}`;
}

/** The first page of a document / deck: a slide in full, a page cropped to its top (the whole page on expand). */
function FirstPage(props: {
  readonly url: string;
  readonly family: "document" | "slides" | "pdf";
  readonly name: string;
  readonly expanded: boolean;
}) {
  const slide = props.family === "slides";
  return (
    <div
      className="border-t border-border/60 bg-background/40 p-2.5"
      data-first-page={props.family}
    >
      <div
        className={cn(
          "relative mx-auto overflow-hidden rounded-md border border-border/50 bg-white shadow-sm",
          slide ? "w-full max-w-[26rem]" : "max-w-[19rem]",
          !slide && !props.expanded && "max-h-[13.5rem]",
        )}
      >
        <img
          src={props.url}
          alt={`${props.name}, first ${slide ? "slide" : "page"}`}
          loading="lazy"
          className="block h-auto w-full"
        />
        {!slide && !props.expanded ? (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-white to-transparent"
            aria-hidden
          />
        ) : null}
      </div>
    </div>
  );
}

function OfficeCard({
  target,
  family,
}: {
  target: CardTarget;
  family: "document" | "slides" | "pdf";
}) {
  const { ref, seen } = useInView<HTMLDivElement>();
  const [showPdf, setShowPdf] = useState(false);
  // Documents and decks show their real first page (rendered by the daemon); a PDF opens its own viewer on expand.
  const thumb = useFileThumbnail({
    blobId: target.blobId,
    relativePath: target.relativePath,
    enabled: seen && family !== "pdf",
  });
  const meta = useOfficeMeta({
    blobId: target.blobId,
    relativePath: target.relativePath,
    family,
    enabled: seen,
  });
  const pdf = useFileObjectUrl({
    blobId: target.blobId,
    relativePath: target.relativePath,
    enabled: family === "pdf" && showPdf,
    maxBytes: PREVIEW_LIMITS.maxOfficeBytes,
  });
  const name = outputDisplayName(target.relativePath);
  if (meta.status === "error" && meta.failure.code === "not_found") return null;

  const label = outputFamilyLabel(family);
  const pieces: string[] = [label];
  if (meta.status === "ready") {
    const count = countLabel(family, meta.meta.count, meta.meta.approximate);
    if (count) pieces.push(count);
    pieces.push(formatOutputSize(meta.byteLength));
  }
  const title = meta.status === "ready" && meta.meta.title ? meta.meta.title : name;
  return (
    <CardShell
      target={target}
      family={family}
      title={title}
      subtitle={
        meta.status === "ready" && meta.meta.title
          ? `${name} · ${pieces.join(" · ")}`
          : pieces.join(" · ")
      }
      expandable={(family === "pdf" && meta.status === "ready") || thumb.status === "ready"}
      expanded={showPdf}
      onToggleExpanded={() => setShowPdf((current) => !current)}
      wide={(family === "pdf" && showPdf) || thumb.status === "ready"}
      innerRef={ref}
    >
      {meta.status === "idle" || meta.status === "loading" ? (
        <Busy label="Reading the file" />
      ) : null}
      {meta.status === "error" ? <Note>{failureNote(meta.failure)}</Note> : null}
      {thumb.status === "ready" ? (
        <FirstPage url={thumb.url} family={family} name={name} expanded={showPdf} />
      ) : meta.status === "ready" && meta.meta.excerpt ? (
        <p className="line-clamp-3 px-3 pb-2.5 text-[12px] leading-[18px] text-muted-foreground">
          {meta.meta.excerpt}
        </p>
      ) : null}
      {family === "pdf" && showPdf ? (
        <div className="border-t border-border/60">
          {pdf.status === "loading" ? <Busy label="Opening the PDF" /> : null}
          {pdf.status === "error" ? <Note>{failureNote(pdf.failure)}</Note> : null}
          {pdf.status === "ready" ? (
            <object
              data={`${pdf.url}#page=1&toolbar=0&navpanes=0`}
              type="application/pdf"
              aria-label={`${name}, first page`}
              className="block h-[26rem] w-full bg-background"
            >
              <Note>This view cannot show PDFs. Use Open.</Note>
            </object>
          ) : null}
        </div>
      ) : null}
    </CardShell>
  );
}

// ── image ─────────────────────────────────────────────────────────────────────────────────────────────────────

function ImageCard({ target }: { target: CardTarget }) {
  const { ref, seen } = useInView<HTMLDivElement>();
  const image = useFileObjectUrl({
    blobId: target.blobId,
    relativePath: target.relativePath,
    enabled: seen,
    maxBytes: PREVIEW_LIMITS.maxImageBytes,
  });
  const name = outputDisplayName(target.relativePath);
  if (image.status === "error" && image.failure.code === "not_found") return null;
  return (
    <CardShell
      target={target}
      family="image"
      title={name}
      subtitle={
        image.status === "ready" ? `Image · ${formatOutputSize(image.byteLength)}` : "Image"
      }
      expandable={false}
      expanded={false}
      onToggleExpanded={() => undefined}
      wide
      innerRef={ref}
    >
      {image.status === "idle" || image.status === "loading" ? (
        <Busy label="Loading the image" />
      ) : null}
      {image.status === "error" ? <Note>{failureNote(image.failure)}</Note> : null}
      {image.status === "ready" ? (
        <div className="border-t border-border/60 bg-background/40 p-2">
          <img
            src={image.url}
            alt={name}
            loading="lazy"
            className="mx-auto max-h-[22rem] w-auto max-w-full rounded-md object-contain"
          />
        </div>
      ) : null}
    </CardShell>
  );
}

// ── markdown / everything else ────────────────────────────────────────────────────────────────────────────────

function TextCard({ target, family }: { target: CardTarget; family: OutputFamily }) {
  const { ref, seen } = useInView<HTMLDivElement>();
  const [expanded, setExpanded] = useState(false);
  const readable = family === "markdown";
  // Any text-like file is read once (the preview of a report, and the proof that it exists): a card for a file the turn
  // never made (a denied `touch test.txt`) must not appear. Binary "other" files have no cheap existence check.
  const checkable = readable || family === "text" || family === "html" || family === "json";
  const file = useProjectFile(target.hostId, target.cwd, target.relativePath, seen && checkable);
  const name = outputDisplayName(target.relativePath);
  if (checkable && seen && !file.isPending && !file.data && file.error) return null;
  const subtitle = file.data
    ? `${outputFamilyLabel(family)} · ${formatOutputSize(file.data.byteLength)}`
    : outputFamilyLabel(family);
  return (
    <CardShell
      target={target}
      family={family}
      title={name}
      subtitle={subtitle}
      expandable={readable && file.data !== null}
      expanded={expanded}
      onToggleExpanded={() => setExpanded((current) => !current)}
      wide={readable && expanded}
      innerRef={ref}
    >
      {readable && expanded && file.data ? (
        <div className="max-h-[26rem] overflow-auto border-t border-border/60 px-3.5 py-2.5">
          <ReplyMarkdown
            text={file.data.contents}
            cwd={target.cwd}
            {...(target.threadRef ? { threadRef: target.threadRef } : {})}
            isStreaming={false}
            lineBreaks={false}
            headingLevelOffset={3}
          />
          {file.data.truncated ? (
            <Note>This report is longer than the preview reads. Open it for the rest.</Note>
          ) : null}
        </div>
      ) : null}
    </CardShell>
  );
}

// ── public ────────────────────────────────────────────────────────────────────────────────────────────────────

export function BlobOutputCard(props: CardTarget) {
  const family = classifyOutputFamily(props.relativePath);
  switch (family) {
    case "sheet":
      return <SheetCard target={props} />;
    case "delimited":
      return <DelimitedCard target={props} />;
    case "document":
    case "slides":
    case "pdf":
      return <OfficeCard target={props} family={family} />;
    case "image":
      return <ImageCard target={props} />;
    default:
      return <TextCard target={props} family={family} />;
  }
}

export function BlobOutputCardGroup(props: {
  readonly hostId: HostId;
  readonly cwd: string;
  readonly threadRef: HostThreadRef | null;
  readonly relativePaths: ReadonlyArray<string>;
  readonly blobId: string;
}) {
  if (props.relativePaths.length === 0) return null;
  return (
    <div
      className="mt-2 flex flex-col items-start gap-2"
      data-output-card-group
      data-blob-output-cards
    >
      {props.relativePaths.map((relativePath) => (
        <BlobOutputCard
          key={relativePath}
          hostId={props.hostId}
          cwd={props.cwd}
          threadRef={props.threadRef}
          blobId={props.blobId}
          relativePath={relativePath}
        />
      ))}
    </div>
  );
}
