// Kora's multi-blob job as a card in her chat: the title, each step with the blob that has it (its live animation +
// one status word + a link to the "from Kora" thread), what runs together and what waits, questions a step raised,
// outputs when it ends. You can cancel the job, or edit / cancel a step before it starts. Done jobs go compact.
import { Hint } from "~/components/ui/hint";
import {
  ArrowUpRightIcon,
  BriefcaseBusinessIcon,
  ChevronDownIcon,
  FileIcon,
  MessageCircleQuestionIcon,
  PencilIcon,
  RotateCcwIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { BlobAvatar, defaultOutfitFor, type BlobOutfit } from "~/components/blobs/avatar";
import { cn } from "~/util/utils";
import type { BlobCardRef } from "../../../thread/timeline";
import { Button } from "../../ui/button";
import { Spinner } from "../../ui/spinner";
import {
  STEP_WORD,
  allOutputs,
  avatarStateFor,
  canCancelStep,
  canChangeStep,
  compactSummary,
  isFinal,
  jobProgress,
  isCombining,
  jobWord,
  needsYouCount,
  latestJob,
  outputName,
  parseJob,
  parseJobPayload,
  stages,
  waitsOn,
  type JobView,
  type StepView,
} from "./jobModel";
import type { JobActions } from "./teamCardActions";
import "../gallery/gallery.css";

/** How often a live-looking job card re-reads the job. */
const JOB_REFRESH_MS = 8000;

export interface JobCardProps {
  readonly card: BlobCardRef;
  readonly actions: JobActions;
  /** The blob's look (from the roster); default is the id's deterministic outfit. */
  readonly outfitFor?: (blobId: string, blobName: string) => BlobOutfit;
  /** Jump to a step's "from Kora" thread. Omitted => no link. */
  readonly onOpenThread?: (threadId: string) => void;
  /** Ask Kora to change a not-yet-started step (the host prefills the composer). Omitted => no Edit. */
  readonly onEditStep?: (job: JobView, step: StepView) => void;
  /** Open / reveal a finished output (a path in the producing blob's folder). */
  readonly onOpenOutput?: (path: string) => void;
  /** The thread the card sits in is running a turn: a finished job then reads "Combining…" until Kora's turn settles. */
  readonly koraWorking?: boolean;
  /** Injectable clock (tests). */
  readonly now?: number;
}

export function JobCard(props: JobCardProps) {
  const incoming = useMemo(() => parseJob(props.card), [props.card]);
  // Latest version wins, whether it arrives as a new card row or as the result of a cancel.
  const best = useRef<JobView | null>(null);
  if (incoming) best.current = latestJob(best.current, incoming);
  const [, force] = useState(0);
  const job = best.current;
  const [open, setOpen] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rated, setRated] = useState<Record<string, "good" | "redo">>({});
  // A card in the transcript can be an older snapshot of the job (the finishing version never reached this row, or the
  // page was reloaded): while it still looks live, ask for the real state, now and every few seconds, so Cancel never
  // sits on a job that has already ended.
  const liveJobId = job && !isFinal(job.status) ? job.cardId : null;
  const refresh = props.actions.refresh;
  useEffect(() => {
    if (!liveJobId || !refresh) return;
    let stopped = false;
    const sync = () => {
      void refresh(liveJobId)
        .then((result) => {
          if (stopped || !result.ok) return;
          const next = parseJobPayload(result.value, { cardId: liveJobId, version: 0 });
          if (next && next.version >= (best.current?.version ?? 0)) {
            best.current = next;
            force((n) => n + 1);
          }
        })
        .catch(() => undefined);
    };
    sync();
    const timer = setInterval(sync, JOB_REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [liveJobId, refresh]);
  if (!job) return null;

  const final = isFinal(job.status);
  const combining = isCombining(job, props.koraWorking === true, props.now);
  // Done and cancelled jobs go compact; a failed one stays open so you can see which step broke.
  const expanded = open ?? (job.status !== "done" && job.status !== "cancelled");
  const progress = jobProgress(job);
  const outfitFor = props.outfitFor ?? ((id: string) => defaultOutfitFor(id));
  const outputs = allOutputs(job);
  const grouped = stages(job.steps);

  const apply = (value: Record<string, unknown>) => {
    const next = parseJobPayload(value, { cardId: job.cardId, version: job.version });
    if (next) {
      best.current = latestJob(best.current, next);
      force((n) => n + 1);
    }
  };
  const run = async (
    key: string,
    fn: () => Promise<
      { ok: true; value: Record<string, unknown> } | { ok: false; message: string }
    >,
  ) => {
    setBusy(key);
    setError(null);
    const result = await fn();
    setBusy(null);
    if (!result.ok) setError(result.message);
    else apply(result.value);
  };

  return (
    <section
      data-blob-card="job"
      data-job-status={job.status}
      data-job-combining={combining ? "true" : "false"}
      data-job-needs-you={needsYouCount(job) > 0 ? "true" : "false"}
      data-job-version={job.version}
      aria-label={`Job: ${job.title}`}
      className={cn(
        "w-full max-w-[38rem] rounded-2xl border bg-card transition-[border-color] duration-300",
        job.status === "running" ? "border-border" : "border-border/60",
      )}
    >
      <header className="flex items-center gap-3 px-4 py-3">
        <BriefcaseBusinessIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[14px] leading-5 font-semibold tracking-[-0.01em] text-foreground">
            {job.title}
          </h3>
          <p className="text-[12px] leading-4 text-muted-foreground" data-job-summary>
            <span className="font-medium text-foreground/80" data-job-word>
              {jobWord(job, combining)}
            </span>
            {" · "}
            {final ? compactSummary(job, combining) : `${progress.done} of ${progress.total} done`}
          </p>
        </div>
        {!final ? (
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={busy !== null}
            onClick={() => void run("job", () => props.actions.cancelJob(job.cardId))}
            data-job-cancel
          >
            {busy === "job" ? <Spinner className="size-3" /> : null}
            Cancel job
          </Button>
        ) : null}
        {final ? (
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-expanded={expanded}
            aria-label={expanded ? "Hide steps" : "Show steps"}
            onClick={() => setOpen(!expanded)}
            data-job-toggle
          >
            <ChevronDownIcon className={cn("transition-transform", expanded && "rotate-180")} />
          </Button>
        ) : null}
      </header>

      {job.status === "running" && progress.total > 0 ? (
        <div className="mx-4 h-px overflow-hidden rounded-full bg-border/70" aria-hidden>
          <div
            className="h-px bg-foreground/70 transition-[width] duration-500"
            style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
          />
        </div>
      ) : null}

      {expanded ? (
        <ol className="px-4 pt-2 pb-3" data-job-steps>
          {grouped.map((group, stageIdx) => (
            <li
              key={group.map((s) => s.id).join("|")}
              className="list-none"
              data-job-stage={stageIdx}
            >
              {group.length > 1 ? (
                <p className="mt-1 mb-0.5 pl-12 text-[10.5px] font-medium tracking-wide text-muted-foreground/70 uppercase">
                  At the same time
                </p>
              ) : null}
              <ul>
                {group.map((step) => (
                  <StepRow
                    key={step.id}
                    step={step}
                    job={job}
                    wait={waitsOn(step, job.steps)}
                    outfit={outfitFor(step.blobId, step.blobName)}
                    busy={busy}
                    rated={rated[step.id] ?? null}
                    onOpenThread={props.onOpenThread}
                    onEdit={props.onEditStep ? () => props.onEditStep?.(job, step) : undefined}
                    onOpenOutput={props.onOpenOutput}
                    onCancel={() =>
                      void run(`step:${step.id}`, () =>
                        props.actions.cancelStep(job.cardId, step.id),
                      )
                    }
                    onRate={async (reaction) => {
                      setRated((r) => ({ ...r, [step.id]: reaction }));
                      const result = await props.actions.feedback(job.cardId, step.id, reaction);
                      if (!result.ok) {
                        setRated((r) => {
                          const { [step.id]: _drop, ...rest } = r;
                          return rest;
                        });
                        setError(result.message);
                      }
                    }}
                  />
                ))}
              </ul>
            </li>
          ))}
        </ol>
      ) : null}

      {final && outputs.length > 0 ? (
        <div
          className="flex flex-wrap items-center gap-1.5 border-t border-border/50 px-4 py-2.5"
          data-job-outputs
        >
          <span className="mr-0.5 text-[11.5px] text-muted-foreground">Outputs</span>
          {outputs.map((path, outputIdx) => (
            <Hint key={`${path}:${outputIdx}`} label={path}>
              <button
                type="button"
                disabled={!props.onOpenOutput}
                onClick={() => props.onOpenOutput?.(path)}
                className="inline-flex max-w-[14rem] items-center gap-1 rounded-full border border-border/70 px-2 py-px text-[11.5px] text-foreground/85 outline-none enabled:hover:border-foreground/40 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
              >
                <FileIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate">{outputName(path)}</span>
              </button>
            </Hint>
          ))}
        </div>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="border-t border-border/50 px-4 py-2 text-[12.5px] text-foreground/80"
          data-job-error
        >
          {error}
        </p>
      ) : null}
    </section>
  );
}

function StepRow(props: {
  readonly step: StepView;
  readonly job: JobView;
  readonly wait: string | null;
  readonly outfit: BlobOutfit;
  readonly busy: string | null;
  readonly rated: "good" | "redo" | null;
  readonly onOpenThread: ((threadId: string) => void) | undefined;
  readonly onEdit: (() => void) | undefined;
  readonly onOpenOutput: ((path: string) => void) | undefined;
  readonly onCancel: () => void;
  readonly onRate: (reaction: "good" | "redo") => void;
}) {
  const { step, job } = props;
  const changeable = canChangeStep(job, step);
  const cancellable = canCancelStep(job, step);
  const inactive = step.status === "queued" || step.status === "cancelled";
  const who = step.blobName || "A blob";

  return (
    <li
      data-job-step={step.id}
      data-step-status={step.status}
      className="relative flex gap-3 py-2 not-last:after:absolute not-last:after:top-[46px] not-last:after:bottom-[-6px] not-last:after:left-[19px] not-last:after:w-px not-last:after:bg-border/60"
    >
      <div
        className={cn(
          "grid size-10 shrink-0 place-items-center transition-opacity",
          inactive && "opacity-55",
        )}
      >
        <BlobAvatar
          outfit={props.outfit}
          state={avatarStateFor(step.status)}
          size={32}
          eyesFollowCursor={false}
          seed={step.blobId || step.id}
          label={`${who}, ${STEP_WORD[step.status]}`}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[13.5px] leading-5 font-medium text-foreground">{step.title}</span>
          <span className="text-[12px] leading-5 text-muted-foreground" data-step-word>
            {who} · {STEP_WORD[step.status]}
            {props.wait && step.status === "queued" ? ` · ${props.wait}` : ""}
          </span>
        </div>

        {step.resultGist && step.status === "done" ? (
          <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-[18px] text-muted-foreground">
            {step.resultGist}
          </p>
        ) : null}

        {step.status === "needs-you" ? (
          <div
            className="mt-1.5 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-foreground/[0.05] px-3 py-2"
            data-step-question
            role="status"
          >
            <MessageCircleQuestionIcon className="size-4 shrink-0 text-foreground/80" aria-hidden />
            <span className="min-w-0 flex-1 text-[12.5px] leading-[18px] text-foreground/90">
              {step.resultGist ?? `${who} needs something from you to keep going.`}
            </span>
            {step.threadId && props.onOpenThread ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => props.onOpenThread?.(step.threadId!)}
                data-step-jump
              >
                Answer in {who}’s thread
                <ArrowUpRightIcon />
              </Button>
            ) : null}
          </div>
        ) : null}

        {step.status === "failed" ? (
          <p className="mt-0.5 text-[12.5px] leading-[18px] text-foreground/75" data-step-failure>
            {step.resultGist ??
              `${who} could not finish this step. Retry it, or open the thread to see what happened.`}
          </p>
        ) : null}

        {step.outputs.length > 0 && step.status === "done" && !isFinal(job.status) ? (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {step.outputs.map((path, outputIdx) => (
              <Hint key={`${path}:${outputIdx}`} label={path}>
                <span className="inline-flex max-w-[12rem] items-center gap-1 rounded-full border border-border/70 px-2 py-px text-[11px] text-foreground/80">
                  <FileIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate">{outputName(path)}</span>
                </span>
              </Hint>
            ))}
          </div>
        ) : null}

        <div className="mt-1 flex flex-wrap items-center gap-1">
          {step.threadId && props.onOpenThread && step.status !== "needs-you" ? (
            <Button
              size="micro"
              variant="ghost-muted"
              onClick={() => props.onOpenThread?.(step.threadId!)}
              data-step-open
            >
              From Kora
              <ArrowUpRightIcon />
            </Button>
          ) : null}
          {changeable && props.onEdit ? (
            <Button size="micro" variant="ghost-muted" onClick={props.onEdit} data-step-edit>
              <PencilIcon />
              Edit
            </Button>
          ) : null}
          {cancellable ? (
            <Button
              size="micro"
              variant="ghost-muted"
              disabled={props.busy !== null}
              onClick={props.onCancel}
              data-step-cancel
            >
              {props.busy === `step:${step.id}` ? <Spinner className="size-3" /> : <XIcon />}
              Cancel step
            </Button>
          ) : null}
          {step.status === "failed" ? (
            <Button
              size="micro"
              variant="ghost-muted"
              disabled={props.rated !== null || props.busy !== null}
              onClick={() => props.onRate("redo")}
              data-step-retry
            >
              <RotateCcwIcon />
              {props.rated === "redo" ? "Retrying…" : "Retry"}
            </Button>
          ) : null}
          {step.status === "done" ? (
            <>
              <Button
                size="icon-micro"
                variant="ghost-muted"
                aria-label={`${who}’s work was good`}
                aria-pressed={props.rated === "good"}
                disabled={props.rated !== null}
                onClick={() => props.onRate("good")}
                className={cn(props.rated === "good" && "text-foreground")}
                data-step-good
              >
                <ThumbsUpIcon />
              </Button>
              <Button
                size="icon-micro"
                variant="ghost-muted"
                aria-label={`Ask for ${who}’s step to be redone`}
                aria-pressed={props.rated === "redo"}
                disabled={props.rated !== null}
                onClick={() => props.onRate("redo")}
                className={cn(props.rated === "redo" && "text-foreground")}
                data-step-redo
              >
                <ThumbsDownIcon />
              </Button>
            </>
          ) : null}
        </div>
      </div>
    </li>
  );
}
