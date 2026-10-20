// The run log: one receipt per run, newest first. queued / running / waiting for you / done / missed (Kora was off) /
// failed / cancelled, with how it started, why it ended, and the way into the hidden execution thread ("Open run").
import { ArrowUpRightIcon, SquareIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/util/utils";
import { Button } from "../../ui/button";
import {
  SOURCE_LABEL,
  STATUS_META,
  whenLabel,
  type RunWire,
  type StatusMeta,
} from "./routineModel";

const TONE: Record<StatusMeta["tone"], string> = {
  live: "bg-info/12 text-info-foreground ring-info/30",
  wait: "bg-warning/14 text-warning-foreground ring-warning/35",
  good: "bg-success/12 text-success-foreground ring-success/30",
  muted: "bg-muted text-muted-foreground ring-border/70",
  bad: "bg-destructive/10 text-destructive-foreground ring-destructive/30",
};

export function StatusChip(props: { readonly status: RunWire["status"] }) {
  const meta = STATUS_META[props.status];
  return (
    <span
      data-run-status={props.status}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] leading-none font-medium ring-1",
        TONE[meta.tone],
      )}
    >
      {props.status === "active" || props.status === "waiting" ? (
        <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden />
      ) : null}
      {meta.label}
    </span>
  );
}

function RunRow(props: {
  readonly run: RunWire;
  readonly now: number;
  readonly onOpenRun: (threadId: string) => void;
  readonly onOpenResults: (threadId: string) => void;
  readonly onCancel: (runId: string) => void;
}) {
  const { run } = props;
  const live = run.status === "queued" || run.status === "active" || run.status === "waiting";
  return (
    <li data-run={run.id} className="flex flex-col gap-1 py-2.5 first:pt-0">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[12.5px] font-medium text-foreground">{run.title}</span>
        <StatusChip status={run.status} />
      </div>
      <div className="text-[11.5px] text-muted-foreground">
        {whenLabel(run.dueAt, props.now)} · {SOURCE_LABEL[run.source]}
        {run.reason ? ` · ${run.reason}` : ""}
      </div>
      {run.status === "waiting" ? (
        <div className="text-[11.5px] text-warning-foreground">
          Needs your answer. Open the run to approve.
        </div>
      ) : null}
      {run.threadId || run.resultsThreadId || live ? (
        <div className="flex items-center gap-1 pt-0.5">
          {run.threadId ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => props.onOpenRun(run.threadId!)}
              data-open-run
            >
              Open run <ArrowUpRightIcon />
            </Button>
          ) : null}
          {run.resultsThreadId && run.status === "completed" ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => props.onOpenResults(run.resultsThreadId!)}
            >
              See report
            </Button>
          ) : null}
          {live ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => props.onCancel(run.id)}
              aria-label={`Stop ${run.title}`}
            >
              <SquareIcon /> Stop
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function RunLog(props: {
  readonly runs: ReadonlyArray<RunWire>;
  readonly now: number;
  readonly onOpenRun: (threadId: string) => void;
  readonly onOpenResults: (threadId: string) => void;
  readonly onCancel: (runId: string) => void;
  readonly pageSize?: number;
}) {
  const size = props.pageSize ?? 8;
  const [shown, setShown] = useState(size);
  if (props.runs.length === 0) {
    return (
      <p data-run-log-empty className="text-[12.5px] text-muted-foreground">
        Nothing has run yet. Receipts show up here: what ran, what was missed while Kora was off,
        and what needs you.
      </p>
    );
  }
  return (
    <div data-run-log>
      <ul className="divide-y divide-border/60">
        {props.runs.slice(0, shown).map((r) => (
          <RunRow
            key={r.id}
            run={r}
            now={props.now}
            onOpenRun={props.onOpenRun}
            onOpenResults={props.onOpenResults}
            onCancel={props.onCancel}
          />
        ))}
      </ul>
      {props.runs.length > shown ? (
        <Button size="xs" variant="ghost" className="mt-2" onClick={() => setShown(shown + size)}>
          Show {Math.min(size, props.runs.length - shown)} more
        </Button>
      ) : null}
    </div>
  );
}
