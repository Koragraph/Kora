// Usage per blob, in the header, in every edition: this thread's tokens (and the blob's total in the tooltip).
// Counts only; the plan-usage meters stay Kora Pro.
import type { BlobUsage, TokenTotals } from "@kora/contracts";
import { useEffect, useState } from "react";

import { cn } from "~/util/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { useBlobsApi } from "../shell/blobsApi";

function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** Fresh tokens: new input + output (what a turn added). */
const freshTokens = (t: TokenTotals) => t.input + t.output;
/** What the model actually processed: fresh plus cache reads. A turn re-reads a ~25k preamble, so this is the honest size
 *  (the fresh number alone read "642" for a turn that processed 134k). */
const chipTokens = (t: TokenTotals) => t.input + t.output + t.cached;

export function BlobUsageChip(props: {
  readonly blobId: string;
  readonly threadId: string | null;
  /** Changes when a turn settles (the thread's latest completion time), so the chip refetches. */
  readonly refreshKey: string | null;
  readonly className?: string;
}) {
  const api = useBlobsApi();
  const [usage, setUsage] = useState<BlobUsage | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api.usage(props.blobId).then((r) => {
      if (!cancelled && r.ok) setUsage(r.value);
    });
    return () => {
      cancelled = true;
    };
  }, [props.blobId, props.refreshKey, api.hostId]);

  if (!usage) return null;
  const thread = props.threadId
    ? (usage.byThread.find((t) => t.threadId === props.threadId)?.totals ?? null)
    : null;
  const shown = thread ?? usage.total;
  if (chipTokens(usage.total) === 0 && shown.turns === 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-blob-usage
            aria-label={`${thread ? "This thread" : "This blob"}: ${formatTokens(chipTokens(shown))} tokens processed, ${formatTokens(freshTokens(shown))} of them new`}
            className={cn(
              "inline-flex h-6 shrink-0 items-center rounded-full px-2 text-[11.5px] tabular-nums text-muted-foreground ring-1 ring-border/70",
              props.className,
            )}
          />
        }
      >
        {formatTokens(chipTokens(shown))}
        <span className="ms-1 max-[30rem]:hidden">tokens</span>
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        <div className="space-y-0.5 text-[12px]">
          {thread ? (
            <div>
              This thread: {formatTokens(chipTokens(thread))} processed (
              {formatTokens(freshTokens(thread))} new) · {thread.turns} turns
            </div>
          ) : null}
          <div>
            All threads: {formatTokens(chipTokens(usage.total))} processed (
            {formatTokens(freshTokens(usage.total))} new) · {usage.total.turns} turns
          </div>
          <div className="text-muted-foreground">
            Processed = new input and output plus {formatTokens(usage.total.cached)} read from the
            prompt cache. Cache reads are cheap, but they count toward your plan's usage.
          </div>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
