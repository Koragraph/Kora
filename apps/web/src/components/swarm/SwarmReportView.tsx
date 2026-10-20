import type { FleetReadReportResult, HostThreadRef } from "@kora/contracts";
import { ArrowLeftIcon, CheckIcon, CopyIcon, LoaderCircleIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { fleetHost } from "~/atoms/fleet";
import { useHostQuery } from "~/atoms/query";

import ReplyMarkdown from "../ReplyMarkdown";

export interface SwarmReportViewProps {
  readonly threadRef: HostThreadRef;
  readonly paneId: string;
  /** "Back to terminal". */
  readonly onClose: () => void;
}

export function formatReportBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
}

/** Presentational half (tested on its own): the report text, or where it stands. */
export function SwarmReportPanel(props: {
  readonly paneId: string;
  readonly report: FleetReadReportResult | null;
  readonly pending: boolean;
  readonly error: string | null;
  readonly threadRef?: HostThreadRef | undefined;
  readonly onClose: () => void;
  readonly onRefresh?: (() => void) | undefined;
  readonly onCopy?: (() => void) | undefined;
  readonly copied?: boolean | undefined;
}) {
  const { report } = props;
  return (
    <div
      className="absolute inset-0 z-10 flex min-h-0 flex-col bg-background"
      data-swarm-report={props.paneId}
    >
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border/60 px-1.5 text-xs">
        <Button size="xs" variant="ghost" className="gap-1" onClick={props.onClose}>
          <ArrowLeftIcon className="size-3.5" aria-hidden />
          Back to terminal
        </Button>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          Report · {props.paneId}
          {report?.truncated ? " · truncated (first 256 KB)" : ""}
        </span>
        {props.onRefresh ? (
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={props.onRefresh}
            aria-label="Re-read report"
            disabled={props.pending}
          >
            <RefreshCwIcon className="size-3.5" aria-hidden />
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="ghost"
          className="gap-1"
          onClick={props.onCopy}
          disabled={!report?.text}
        >
          {props.copied ? (
            <CheckIcon className="size-3.5" aria-hidden />
          ) : (
            <CopyIcon className="size-3.5" aria-hidden />
          )}
          Copy
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-[13px]">
        {report?.text ? (
          <ReplyMarkdown
            text={report.text}
            cwd={undefined}
            threadRef={props.threadRef}
            isStreaming={false}
          />
        ) : props.pending ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden />
            Reading the report…
          </div>
        ) : props.error ? (
          <p className="text-xs text-destructive">Couldn't read the report: {props.error}</p>
        ) : (
          <p className="text-xs text-muted-foreground">No report yet.</p>
        )}
      </div>
    </div>
  );
}

/** A swarm worker's report (`fleet.readReport`) over the tile's terminal (the terminal stays mounted beneath). */
export function SwarmReportView({ threadRef, paneId, onClose }: SwarmReportViewProps) {
  const query = useHostQuery(
    fleetHost.readReport({
      hostId: threadRef.hostId,
      input: { threadId: threadRef.threadId, paneId },
    }),
  );
  // The query family caches per pane; a re-opened view re-reads so a rewritten report is never stale.
  const refreshed = useRef(false);
  const { refresh, data } = query;
  useEffect(() => {
    if (refreshed.current) return;
    refreshed.current = true;
    if (data !== null) refresh();
  }, [data, refresh]);
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    const text = query.data?.text;
    if (!text || typeof navigator === "undefined" || !navigator.clipboard) return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }, [query.data]);
  return (
    <SwarmReportPanel
      paneId={paneId}
      report={query.data}
      pending={query.isPending}
      error={query.error}
      threadRef={threadRef}
      onClose={onClose}
      onRefresh={refresh}
      onCopy={copy}
      copied={copied}
    />
  );
}
