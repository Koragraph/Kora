// The small pieces of the browser panel: address pill, status chip, tab strip, the "You're driving" banner, the
// approval bar, and the empty / closed / reconnecting states. Presentational: state and callbacks come in as props.
import { GlobeIcon, HandIcon, LockIcon, ShieldAlertIcon } from "lucide-react";
import { cloneElement, useEffect, useState, type ReactElement, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/util/utils";
import {
  COUNTDOWN_SHOWS_AT_MS,
  countdownSeconds,
  hostOf,
  humanizeApproval,
  prettyUrl,
  tabLabel,
  type PanelStatus,
  type StatusView,
  type WireApproval,
  type WireTab,
} from "./browserModel";

/** A hover hint through the app's Tooltip (never the native `title`): `render` is the element that carries the children. */
export function Hint(props: {
  readonly hint: string | null | undefined;
  readonly render: ReactElement<Record<string, unknown>>;
  readonly children: ReactNode;
}) {
  if (!props.hint) return cloneElement(props.render, undefined, props.children);
  return (
    <Tooltip>
      <TooltipTrigger render={props.render}>{props.children}</TooltipTrigger>
      <TooltipPopup side="bottom" className="max-w-72 break-all">
        {props.hint}
      </TooltipPopup>
    </Tooltip>
  );
}

// ------------------------------------------------------------------ address + status

export function UrlPill(props: {
  readonly url: string;
  readonly title: string;
  readonly placeholder: string;
}) {
  const pretty = prettyUrl(props.url);
  return (
    <Hint
      hint={props.url || undefined}
      render={
        <div
          className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-card px-2 text-[12px] ring-1 ring-border/70"
          data-browser-url
        />
      }
    >
      {pretty ? (
        pretty.secure ? (
          <LockIcon
            className="size-3 shrink-0 text-muted-foreground"
            aria-label="Secure connection"
          />
        ) : (
          <GlobeIcon className="size-3 shrink-0 text-muted-foreground" aria-label="Not encrypted" />
        )
      ) : (
        <GlobeIcon className="size-3 shrink-0 text-muted-foreground/60" aria-hidden />
      )}
      {pretty ? (
        <span className="min-w-0 truncate">
          <span className="text-foreground">{pretty.host}</span>
          <span className="text-muted-foreground">{pretty.rest}</span>
        </span>
      ) : (
        <span className="truncate text-muted-foreground">{props.placeholder}</span>
      )}
      {props.title && pretty ? <span className="sr-only">{props.title}</span> : null}
    </Hint>
  );
}

const DOT: Record<PanelStatus, string> = {
  setup: "bg-muted-foreground/40",
  idle: "bg-muted-foreground",
  working: "bg-foreground motion-safe:animate-pulse",
  "needs-you": "bg-amber-400",
  driving: "bg-green-400",
  closed: "bg-transparent ring-1 ring-muted-foreground/60",
  offline: "bg-muted-foreground/40",
};

export function StatusChip(props: { readonly view: StatusView }) {
  const { view } = props;
  return (
    <Hint
      hint={view.detail}
      render={
        <span
          className={cn(
            "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11px] font-medium ring-1",
            view.status === "needs-you"
              ? "bg-amber-400/10 text-amber-200 ring-amber-400/30"
              : "bg-card text-muted-foreground ring-border/70",
            view.status === "driving" && "text-foreground",
            view.status === "working" && "text-foreground",
          )}
          role="status"
          aria-live="polite"
          data-browser-status={view.status}
        />
      }
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", DOT[view.status])} />
      <span>{view.label}</span>
    </Hint>
  );
}

// ------------------------------------------------------------------ tabs

export function TabStrip(props: {
  readonly tabs: ReadonlyArray<WireTab>;
  readonly onPick: (index: number) => void;
  readonly disabled?: boolean;
}) {
  if (props.tabs.length < 2) return null;
  return (
    <div
      role="tablist"
      aria-label="Browser tabs"
      className="flex min-w-0 gap-1 overflow-x-auto pb-0.5 [scrollbar-width:none]"
      data-browser-tabs
    >
      {props.tabs.map((t) => (
        <Hint
          key={`${t.index}:${t.url}`}
          hint={t.url}
          render={
            <button
              type="button"
              role="tab"
              aria-selected={t.active}
              disabled={props.disabled}
              onClick={() => props.onPick(t.index)}
              className={cn(
                "h-6 max-w-[150px] shrink-0 truncate rounded-md px-2 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                t.active
                  ? "bg-card text-foreground ring-1 ring-border/70"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            />
          }
        >
          {tabLabel(t)}
        </Hint>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ take-over

/** A clock that ticks only while `active`, so an idle panel schedules nothing. */
export function useNow(active: boolean, everyMs = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [active, everyMs]);
  return now;
}

export function TakeoverBanner(props: {
  readonly name: string;
  /** Milliseconds until the daemon hands back on its own. */
  readonly remainingMs: number | null;
  readonly releaseAfterMs: number;
  readonly onHandBack: () => void;
}) {
  const near = props.remainingMs !== null && props.remainingMs <= COUNTDOWN_SHOWS_AT_MS;
  const pct =
    props.remainingMs === null
      ? 100
      : Math.max(0, Math.min(100, (props.remainingMs / Math.max(1, props.releaseAfterMs)) * 100));
  return (
    <div
      className="relative flex items-center gap-2.5 overflow-hidden rounded-xl bg-foreground px-3 py-2 text-background"
      role="status"
      aria-live="polite"
      data-browser-takeover
    >
      <HandIcon className="size-3.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 text-[12px] leading-tight">
        <div className="font-medium">You're driving</div>
        <div className="truncate opacity-70" data-browser-countdown={near ? "on" : "off"}>
          {near
            ? `${props.name} takes it back in ${countdownSeconds(props.remainingMs ?? 0)}s`
            : `${props.name} is paused until you hand back`}
        </div>
      </div>
      <button
        type="button"
        onClick={props.onHandBack}
        className="h-7 shrink-0 rounded-lg bg-background px-2.5 text-[12px] font-medium text-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-background/60"
      >
        Hand back
      </button>
      {near ? (
        <span
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-0.5 bg-background/30"
          style={{
            clipPath: `inset(0 ${100 - pct}% 0 0)`,
            background: "currentColor",
            opacity: 0.35,
          }}
        />
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ approval

export function ApprovalBar(props: {
  readonly name: string;
  readonly approval: WireApproval;
  readonly more: number;
  readonly answered: boolean;
  readonly onAnswer: (allow: boolean) => void;
}) {
  const where = hostOf(props.approval.url);
  const words = humanizeApproval(props.approval.summary);
  return (
    <div
      className="rounded-xl bg-amber-400/10 p-3 ring-1 ring-amber-400/30"
      role="group"
      aria-label="Approval needed"
      data-browser-approval={props.approval.id}
    >
      <div className="flex items-start gap-2.5">
        <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-300" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-medium text-foreground">{props.name} needs your OK</div>
          <p
            className="mt-0.5 text-[13px] leading-snug font-medium break-words text-foreground"
            data-browser-approval-what
          >
            {words.title}
          </p>
          {words.detail ? (
            <p
              className="mt-0.5 text-[12px] leading-snug text-foreground/75"
              data-browser-approval-detail
            >
              {words.detail}
            </p>
          ) : null}
          {where ? (
            <p
              className="mt-1 truncate text-[11.5px] text-muted-foreground"
              data-browser-approval-where
            >
              On {where}
            </p>
          ) : null}
          {props.more > 0 ? (
            <p className="mt-1 text-[11.5px] text-muted-foreground">
              {props.more} more waiting after this one
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-2.5 flex justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={props.answered}
          onClick={() => props.onAnswer(false)}
          data-browser-deny
        >
          Deny
        </Button>
        <Button
          size="sm"
          disabled={props.answered}
          onClick={() => props.onAnswer(true)}
          data-browser-allow
        >
          Allow once
        </Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ states drawn over the stage

export function StageNote(props: {
  readonly icon?: ReactNode;
  readonly title: string;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
  readonly tone?: "plain" | "veil";
}) {
  return (
    <div
      className={cn(
        "absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center",
        props.tone === "veil" && "bg-background/75 backdrop-blur-[2px]",
      )}
    >
      {props.icon}
      <div className="text-[13px] font-medium text-foreground">{props.title}</div>
      {props.children ? (
        <p className="max-w-[260px] text-[12px] leading-snug text-muted-foreground">
          {props.children}
        </p>
      ) : null}
      {props.action}
    </div>
  );
}

export function ReconnectingNote(props: {
  readonly unavailable: boolean;
  readonly onRetry: () => void;
}) {
  return props.unavailable ? (
    <StageNote
      tone="veil"
      title="Couldn't connect"
      action={
        <Button size="sm" variant="outline" onClick={props.onRetry} data-browser-retry>
          Retry
        </Button>
      }
    >
      Kora's browser view didn't answer after a few tries. It may be restarting; Retry connects
      again.
    </StageNote>
  ) : (
    <StageNote
      tone="veil"
      icon={<Spinner className="size-4 text-muted-foreground" />}
      title="Reconnecting"
    />
  );
}
