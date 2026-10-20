import { formatRelativeTimeLabel } from "~/timeFormat";
import { isValidHistoryTimestamp, type BrowserHistoryEntry } from "~/stores/webHistoryStore";
import { useNowMinute } from "~/hooks/useMinuteClock";
import { WebFaviconIcon } from "./WebFaviconIcon";
import type { HostThreadRef } from "@kora/contracts";
import { X } from "lucide-react";

interface Props {
  onOpen: () => void;
  onRemove: () => void;
  entry: BrowserHistoryEntry;
  threadRef: HostThreadRef;
}

/** One tile in the browser's start grid: the page's name first, where it lives underneath. */
export function WebRecentUrlCard({ threadRef, entry, onOpen, onRemove }: Props) {
  useNowMinute();
  const { host, pathname, search, hash } = new URL(entry.url);
  const label = `${host}${pathname === "/" ? "" : pathname}${search}${hash}`;
  let visitedAt = "";
  if (isValidHistoryTimestamp(entry.lastVisitedAt)) {
    visitedAt = formatRelativeTimeLabel(new Date(entry.lastVisitedAt).toISOString());
  }
  return (
    <div className="group/recent relative min-w-0">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full min-w-0 cursor-pointer flex-col gap-2 rounded-xl bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex min-w-0 items-center gap-2 pr-5">
          <WebFaviconIcon threadRef={threadRef} url={entry.url} />
          <span className="min-w-0 truncate text-[13px] text-foreground">
            {entry.title ?? host}
          </span>
        </span>
        <span className="flex min-w-0 items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
          <span className="min-w-0 truncate font-mono">{label}</span>
          {visitedAt ? <span className="shrink-0 tabular-nums">{visitedAt}</span> : null}
        </span>
      </button>
      <button
        className="absolute top-2 right-2 cursor-pointer rounded-full p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/recent:opacity-100"
        aria-label={`Remove ${label} from history`}
        onClick={onRemove}
        type="button"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
