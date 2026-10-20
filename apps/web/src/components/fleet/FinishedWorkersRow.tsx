import type { FinishedMarker, FinishedTone } from "./finishedWorkers";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/util/utils";

import { AgentIcon } from "./AgentIcon";

const DOT: Record<FinishedTone, string> = {
  done: "bg-success",
  failed: "bg-destructive",
  stopped: "bg-muted-foreground",
};

/**
 * A row of tiny agent marks, one per finished worker, each with a done / failed / stopped dot. Hover names the task and
 * how it ended; click reopens that worker's pane.
 */
export function FinishedWorkersRow(props: {
  readonly markers: ReadonlyArray<FinishedMarker>;
  readonly onOpen: (paneId: string) => void;
  readonly className?: string;
}) {
  if (props.markers.length === 0) return null;
  return (
    <div
      className={cn("flex min-w-0 items-center gap-1.5", props.className)}
      data-finished-workers={props.markers.length}
    >
      <span className="shrink-0 text-[11px] text-muted-foreground">Finished</span>
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {props.markers.map((marker) => (
          <Tooltip key={marker.paneId}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="relative flex size-5 shrink-0 items-center justify-center rounded-md opacity-80 hover:bg-accent/30 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                  aria-label={`${marker.title}: ${marker.result}. Reopen`}
                  data-finished-pane={marker.paneId}
                  data-tone={marker.tone}
                  onClick={() => props.onOpen(marker.paneId)}
                />
              }
            >
              <AgentIcon id={marker.agent} size={13} />
              <span
                aria-hidden
                className={cn(
                  "absolute -right-px -bottom-px size-1.5 rounded-full ring-1 ring-background",
                  DOT[marker.tone],
                )}
              />
            </TooltipTrigger>
            <TooltipPopup side="top">
              <div className="max-w-64">
                <div className="truncate font-medium">{marker.title}</div>
                <div className="text-muted-foreground">{marker.result}</div>
              </div>
            </TooltipPopup>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}
