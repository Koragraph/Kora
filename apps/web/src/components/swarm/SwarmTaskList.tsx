/**
 * The Swarm task list: one calm row per delegated task (not per pane), and a detail view to review a
 * worker's result and act on it. Rows reserve fixed lines (title + state, model · attempt · elapsed, one
 * activity line) so live updates never shift the layout; the only motion is a DOM-written elapsed clock.
 * Actions are the ones the daemon already has: read the report, merge the worktree branch, stop the worker.
 */
import { Hint } from "~/components/ui/hint";
import type { FleetSwarmActivity, HostThreadRef } from "@kora/contracts";
import {
  ArrowLeftIcon,
  CheckIcon,
  CircleAlertIcon,
  GitMergeIcon,
  SquareIcon,
  TerminalSquareIcon,
} from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/util/utils";
import { fleetHost } from "~/atoms/fleet";
import { useHostQuery } from "~/atoms/query";

import ReplyMarkdown from "../ReplyMarkdown";
import {
  formatSwarmValueMeter,
  formatTaskElapsed,
  isSwarmTaskSettled,
  SWARM_TASK_STATE_LABEL,
  type SwarmTask,
  type SwarmTaskState,
} from "./swarmTasks";

const DOT: Record<SwarmTaskState, string> = {
  queued: "bg-muted-foreground/50",
  running: "bg-info",
  checking: "bg-info",
  retrying: "bg-warning",
  "cooling-down": "bg-warning",
  passed: "bg-success",
  done: "bg-success/70",
  stopped: "bg-muted-foreground/50",
  failed: "bg-destructive",
};

function StateDot({ state }: { state: SwarmTaskState }) {
  return <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[state])} />;
}

/** Elapsed time; a live task ticks by writing the DOM (no React commit per second). */
export function TaskElapsed({ task }: { task: Pick<SwarmTask, "startedAt" | "endedAt"> }) {
  const ref = useRef<HTMLSpanElement>(null);
  const { startedAt, endedAt } = task;
  useEffect(() => {
    if (endedAt !== null) return;
    const tick = () => {
      if (ref.current) ref.current.textContent = formatTaskElapsed(Date.now() - startedAt);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [startedAt, endedAt]);
  return (
    <span ref={ref} className="tabular-nums">
      {formatTaskElapsed((endedAt ?? Date.now()) - startedAt)}
    </span>
  );
}

function attemptText(task: SwarmTask): string | null {
  if (task.maxAttempts !== null && task.maxAttempts > 1)
    return `attempt ${task.attempt}/${task.maxAttempts}`;
  return task.attempt > 1 ? `attempt ${task.attempt}` : null;
}

/** "Claude used 14k new tokens (+300k cached) · workers did 3 tasks (410k tokens, free)" — measured only. */
export function SwarmValueMeter({
  activity,
  lead,
}: {
  activity: FleetSwarmActivity | null;
  lead?: string | undefined;
}) {
  const meter = formatSwarmValueMeter(activity, lead);
  const line = (
    <span className="min-w-0 truncate" data-testid="swarm-value-meter">
      {meter.summary}
    </span>
  );
  if (meter.detail.length === 0) {
    return <div className="flex px-2 pb-1 text-[11px] text-muted-foreground">{line}</div>;
  }
  return (
    <div className="flex px-2 pb-1 text-[11px] text-muted-foreground">
      <Tooltip>
        <TooltipTrigger render={<span className="min-w-0 truncate" />}>{line}</TooltipTrigger>
        <TooltipPopup side="bottom" className="whitespace-pre-line">
          {`${meter.detail.join("\n")}\nMeasured, not estimated.`}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

export const SwarmTaskRow = memo(function SwarmTaskRow(props: {
  task: SwarmTask;
  merged: boolean;
  onOpen: () => void;
}) {
  const { task } = props;
  const meta = [task.model, attemptText(task)].filter((x): x is string => x !== null);
  return (
    <button
      type="button"
      onClick={props.onOpen}
      data-swarm-task={task.taskId}
      data-swarm-task-state={task.state}
      className="grid h-[3.875rem] w-full grid-cols-[0.375rem_minmax(0,1fr)_auto] grid-rows-[1.25rem_1.125rem_1rem] items-center gap-x-2 rounded-md px-1.5 py-1 text-left hover:bg-accent/40"
    >
      <span className="col-start-1 row-start-1 flex items-center">
        <StateDot state={task.state} />
      </span>
      <span className="col-start-2 row-start-1 min-w-0 truncate text-sm font-medium">
        {task.title}
      </span>
      <span
        className={cn(
          "col-start-3 row-start-1 flex items-center gap-1 text-right text-[.7rem]",
          task.needsYou
            ? "text-warning"
            : task.state === "failed"
              ? "text-destructive-foreground"
              : "text-muted-foreground",
        )}
      >
        {task.needsYou ? <CircleAlertIcon aria-hidden className="size-3" /> : null}
        {props.merged ? "Merged" : SWARM_TASK_STATE_LABEL[task.state]}
      </span>
      <span
        className={cn(
          "col-start-2 col-end-4 row-start-2 block truncate text-xs",
          task.state === "failed" ? "text-destructive-foreground" : "text-muted-foreground",
        )}
      >
        {task.activity}
      </span>
      <span className="col-start-2 col-end-4 row-start-3 flex min-w-0 gap-1.5 font-mono text-[.7rem] text-muted-foreground/70">
        <span className="min-w-0 truncate">{meta.join(" · ")}</span>
        <span aria-hidden>·</span>
        <TaskElapsed task={task} />
      </span>
    </button>
  );
});

export function SwarmTaskList(props: {
  tasks: ReadonlyArray<SwarmTask>;
  activity: FleetSwarmActivity | null;
  lead?: string | undefined;
  merged: ReadonlySet<string>;
  onOpen: (taskId: string) => void;
}) {
  const live = props.tasks.filter((t) => !isSwarmTaskSettled(t));
  const attention = props.tasks.filter((t) => t.needsYou);
  return (
    <div className="flex flex-col gap-0.5 p-2" data-testid="swarm-task-list">
      <SwarmValueMeter activity={props.activity} lead={props.lead} />
      {attention.length > 0 ? (
        <p className="px-2 pb-1 text-[11px] text-warning">
          {attention.length === 1 ? "1 task needs you" : `${attention.length} tasks need you`}
        </p>
      ) : live.length === 0 && props.tasks.length > 0 ? (
        <p className="px-2 pb-1 text-[11px] text-muted-foreground">
          All {props.tasks.length} {props.tasks.length === 1 ? "task has" : "tasks have"} finished.
        </p>
      ) : null}
      {props.tasks.map((task) => (
        <SwarmTaskRow
          key={task.taskId}
          task={task}
          merged={props.merged.has(task.worker.paneId)}
          onOpen={() => props.onOpen(task.taskId)}
        />
      ))}
    </div>
  );
}

const OUTCOME_WORD: Record<string, string> = {
  running: "running",
  ok: "finished",
  "rate-limited": "rate-limited",
  "model-gone": "model no longer offered",
  crashed: "crashed",
  "auth-failed": "key rejected",
};

/** One task, reviewed: what it did, how it went, its report, and what you can do with it. */
export function SwarmTaskDetail(props: {
  task: SwarmTask;
  threadRef: HostThreadRef;
  merged: boolean;
  onBack: () => void;
  onMerge: () => void;
  onDiscard: () => void;
  onOpenTerminal: () => void;
}) {
  const { task } = props;
  const w = task.worker;
  const s = w.swarm!;
  const exited = w.state === "exited";
  // Merging an unchecked or failed change, and stopping a worker, are two-step clicks.
  const [armed, setArmed] = useState<"merge" | "discard" | null>(null);
  useEffect(() => {
    if (armed === null) return;
    const t = window.setTimeout(() => setArmed(null), 6000);
    return () => window.clearTimeout(t);
  }, [armed]);
  const risky = task.state !== "passed";
  const report = useHostQuery(
    s.report
      ? fleetHost.readReport({
          hostId: props.threadRef.hostId,
          input: { threadId: props.threadRef.threadId, paneId: w.paneId },
        })
      : null,
  );
  const reportUpdatedAt = s.report?.updatedAt ?? null;
  const { refresh } = report;
  const seen = useRef<number | null>(reportUpdatedAt);
  useEffect(() => {
    // The report was rewritten (a retry): re-read instead of showing the old text.
    if (reportUpdatedAt !== null && seen.current !== reportUpdatedAt) {
      seen.current = reportUpdatedAt;
      refresh();
    }
  }, [refresh, reportUpdatedAt]);
  const branch = w.worktree?.branch.replace(/^kora\//, "") ?? null;
  const meta = [task.model, attemptText(task)].filter((x): x is string => x !== null);

  return (
    <div className="flex h-full min-h-0 flex-col" data-swarm-task-detail={task.taskId}>
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border/60 px-1.5 text-xs">
        <Button size="xs" variant="ghost" className="gap-1" onClick={props.onBack}>
          <ArrowLeftIcon className="size-3.5" aria-hidden />
          Tasks
        </Button>
        <span className="ms-auto flex items-center gap-1">
          <Button size="xs" variant="ghost" className="gap-1" onClick={props.onOpenTerminal}>
            <TerminalSquareIcon className="size-3.5" aria-hidden />
            Terminal
          </Button>
          {!exited ? (
            <Button
              size="xs"
              variant={armed === "discard" ? "outline" : "ghost"}
              className="gap-1"
              onClick={() => {
                if (armed !== "discard") return setArmed("discard");
                setArmed(null);
                props.onDiscard();
              }}
            >
              <SquareIcon className="size-3" aria-hidden />
              {armed === "discard" ? "Stop it? Branch is kept" : "Stop worker"}
            </Button>
          ) : null}
          {w.worktree && !props.merged ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="xs"
                    variant={armed === "merge" ? "outline" : "default"}
                    className={cn("gap-1", risky && armed !== "merge" && "opacity-90")}
                    onClick={() => {
                      if (risky && armed !== "merge") return setArmed("merge");
                      setArmed(null);
                      props.onMerge();
                    }}
                  />
                }
              >
                <GitMergeIcon className="size-3.5" aria-hidden />
                {armed === "merge" ? "Merge anyway?" : "Merge"}
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                {risky
                  ? `This change has not passed its checks (${SWARM_TASK_STATE_LABEL[task.state].toLowerCase()}). Click again to merge ${branch} anyway.`
                  : `Merge ${branch} into the main checkout (commits first).`}
              </TooltipPopup>
            </Tooltip>
          ) : props.merged ? (
            <span className="flex items-center gap-1 px-1.5 text-success">
              <CheckIcon className="size-3.5" aria-hidden />
              Merged
            </span>
          ) : null}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-[13px]">
        <div className="flex items-center gap-2">
          <StateDot state={task.state} />
          <span className="font-medium">{SWARM_TASK_STATE_LABEL[task.state]}</span>
          <span className="text-xs text-muted-foreground">
            {meta.join(" · ")} · <TaskElapsed task={task} />
          </span>
        </div>
        <h3 className="mt-1 text-sm font-medium">{task.title}</h3>
        <p
          className={cn("mt-0.5 text-xs", task.needsYou ? "text-warning" : "text-muted-foreground")}
        >
          {task.activity}
        </p>
        <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {branch ? (
            <>
              <dt>Branch</dt>
              <Hint label={w.worktree?.path}>
                <dd className="truncate font-mono">
                  {branch}
                  {w.worktree?.ahead ? ` · ${w.worktree.ahead} ahead` : ""}
                  {w.worktree?.dirty ? ` · ${w.worktree.dirty} uncommitted` : ""}
                </dd>
              </Hint>
            </>
          ) : null}
          {s.verify && s.verify.state !== "skipped" ? (
            <>
              <dt>Check</dt>
              <dd>
                {s.verify.summary ?? s.verify.state}
                {s.verify.bounces > 0
                  ? ` · sent back ${s.verify.bounces} ${s.verify.bounces === 1 ? "time" : "times"}`
                  : ""}
              </dd>
            </>
          ) : null}
          {s.attempts.length > 1 ? (
            <>
              <dt>Models</dt>
              <dd>
                {s.attempts
                  .map(
                    (a) => `${a.model.split("/").at(-1)} ${OUTCOME_WORD[a.outcome] ?? a.outcome}`,
                  )
                  .join(" → ")}
              </dd>
            </>
          ) : null}
          {w.tokens ? (
            <>
              <dt>Tokens</dt>
              <dd className="tabular-nums">
                {(w.tokens.input + w.tokens.output).toLocaleString()} in+out ·{" "}
                {w.tokens.cached.toLocaleString()} cache reads (measured by OpenCode)
              </dd>
            </>
          ) : null}
        </dl>
        <h4 className="mt-3 mb-1 text-xs font-medium text-muted-foreground">Report</h4>
        {report.data?.text ? (
          <ReplyMarkdown
            text={report.data.text}
            cwd={undefined}
            threadRef={props.threadRef}
            isStreaming={false}
          />
        ) : s.report && report.isPending ? (
          <p className="text-xs text-muted-foreground">Reading the report…</p>
        ) : report.error ? (
          <p className="text-xs text-destructive">Couldn't read the report: {report.error}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {isSwarmTaskSettled(task) ? "This worker wrote no report." : "No report yet."}
          </p>
        )}
      </div>
    </div>
  );
}
