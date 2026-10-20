import { cn } from "~/util/utils";
import { useRoutinesApi } from "./routinesApi";
import type { RoutineConfirmCardWire, RoutineReportCardWire } from "./routineModel";
import { Button } from "../../ui/button";
import ReplyMarkdown from "../../ReplyMarkdown";
import { useEffect, useState } from "react";
// What lands in a results thread: a dated report per run, with Open run (the hidden execution thread, where approvals
// are answered). Inside that thread, RoutineRunBanner offers Back to results. RoutineConfirmCard is the ask-first card
// for a routine change Kora proposes for another blob (or the 21st active routine).
import {
  CalendarClockIcon,
  ArrowUpRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleSlashIcon,
  ArrowLeftIcon,
} from "lucide-react";

const FOLD_CHARS = 700;

/** The first `max` characters, cut at a word edge and with any half-open `**`/`` ` `` closed, so a fold never shows raw markers. */
export function foldMarkdown(text: string, max: number): string {
  let cut = text.slice(0, max);
  const edge = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(" "));
  if (edge > max * 0.6) cut = cut.slice(0, edge);
  cut = cut.trimEnd();
  if ((cut.match(/\*\*/g)?.length ?? 0) % 2 === 1) cut += "**";
  if ((cut.match(/`/g)?.length ?? 0) % 2 === 1) cut += "`";
  return `${cut}…`;
}

function stamp(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    minute: "2-digit",
    weekday: "short",
    hour: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function RoutineReportCard(props: {
  readonly card: RoutineReportCardWire;
  readonly onOpenRun: (threadId: string) => void;
  /** false = the run's hidden thread was cleaned up (each routine keeps its last 50 runs): the report stays, Open run goes. */
  readonly runKept?: boolean | undefined;
}) {
  const { card } = props;
  const [open, setOpen] = useState(false);
  const long = card.text.length > FOLD_CHARS;
  const body = !long || open ? card.text : foldMarkdown(card.text, FOLD_CHARS);
  const Icon =
    card.status === "completed"
      ? CircleCheckIcon
      : card.status === "failed"
        ? CircleAlertIcon
        : CircleSlashIcon;
  return (
    <article
      data-routine-report={card.runId}
      className="my-2 w-full max-w-[640px] rounded-2xl bg-card p-3.5 ring-1 ring-border/70"
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
            <CalendarClockIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate">{card.title}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-1 text-[11.5px] text-muted-foreground">
            <Icon
              className={cn(
                "size-3",
                card.status === "completed" && "text-success-foreground",
                card.status === "failed" && "text-destructive-foreground",
              )}
              aria-hidden
            />
            {stamp(card.ranAt)}
            {card.status === "failed"
              ? " · failed"
              : card.status === "cancelled"
                ? " · cancelled"
                : ""}
          </div>
        </div>
        {card.executionThreadId && props.runKept !== false ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => props.onOpenRun(card.executionThreadId!)}
            data-open-run
          >
            Open run <ArrowUpRightIcon />
          </Button>
        ) : card.executionThreadId ? (
          <span className="shrink-0 text-[11.5px] text-muted-foreground" data-run-cleaned-up>
            Old run cleaned up
          </span>
        ) : null}
      </header>
      {/* A report is markdown (the model writes **bold**, lists, headings): rendered, never shown with its asterisks. */}
      <div className="mt-2.5 text-foreground/90" data-routine-report-body>
        <ReplyMarkdown
          text={body}
          cwd={undefined}
          isStreaming={false}
          lineBreaks={false}
          headingLevelOffset={3}
          className="text-[13px] leading-relaxed"
        />
      </div>
      {long ? (
        <button
          type="button"
          className="mt-1 text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => setOpen(!open)}
        >
          {open ? "Show less" : "Show the whole report"}
        </button>
      ) : null}
      {card.outputs.length > 0 ? (
        <div className="mt-2 text-[11.5px] text-muted-foreground">
          {card.outputs.length} file{card.outputs.length === 1 ? "" : "s"} made in this run
        </div>
      ) : null}
    </article>
  );
}

/** Top of a routine's hidden execution thread: where you are and the way back. */
export function RoutineRunBanner(props: {
  readonly title: string;
  readonly ranAt: number;
  readonly resultsThreadId: string | null;
  readonly onBack: (threadId: string) => void;
}) {
  return (
    <div
      data-routine-run-banner
      className="flex items-center justify-between gap-3 border-b border-border/60 bg-card/60 px-4 py-2 text-[12.5px]"
    >
      <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        <CalendarClockIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">
          Routine run · <span className="text-foreground">{props.title}</span> ·{" "}
          {stamp(props.ranAt)}
        </span>
      </div>
      {props.resultsThreadId ? (
        <Button
          size="xs"
          variant="outline"
          onClick={() => props.onBack(props.resultsThreadId!)}
          data-back-to-results
        >
          <ArrowLeftIcon /> Back to results
        </Button>
      ) : null}
    </div>
  );
}

export function RoutineConfirmCard(props: { readonly card: RoutineConfirmCardWire }) {
  const api = useRoutinesApi();
  const [answered, setCard] = useState<RoutineConfirmCardWire | null>(null);
  // the transcript's own copy moves on (a newer version of this card): it wins over what this click returned
  useEffect(() => setCard(null), [props.card.state, props.card.result]);
  const card = answered ?? props.card;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = async (accept: boolean) => {
    setBusy(true);
    setError(null);
    const r = await api.confirm(card.token, accept);
    setBusy(false);
    if (r.ok) setCard(r.value);
    else setError(r.message);
  };
  return (
    <div
      data-routine-confirm={card.state}
      className="my-2 w-full max-w-[560px] rounded-2xl bg-card p-3.5 ring-1 ring-border/70"
    >
      <div className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
        <CalendarClockIcon className="size-3.5 text-muted-foreground" aria-hidden /> {card.summary}
      </div>
      <ul className="mt-1.5 space-y-0.5 text-[12.5px] text-muted-foreground">
        {card.details.map((d) => (
          <li key={d} className="line-clamp-3">
            {d}
          </li>
        ))}
      </ul>
      {card.state === "open" ? (
        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" disabled={busy} onClick={() => void answer(true)}>
            Approve
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void answer(false)}>
            Not now
          </Button>
          {error ? <span className="text-[12px] text-destructive-foreground">{error}</span> : null}
        </div>
      ) : (
        <div className="mt-2 text-[12px] text-muted-foreground">
          {card.state === "confirmed"
            ? (card.result ?? "Done.")
            : card.state === "failed"
              ? (card.result ?? "That did not work.")
              : "Dismissed. Nothing changed."}
        </div>
      )}
    </div>
  );
}
