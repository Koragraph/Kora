/**
 * The composer's usage sign: Kora holding a tiny sign with the percent LEFT in the tightest plan window of the
 * selected provider (usageSign.logic.ts). Its mood follows the tier: eyes only on a fresh week, tired and blinking
 * past 80%, worried past 95%, asleep and sitting when limited. Pressing it opens the full details: every provider
 * with plan data (current one first, expanded), each window as a bar with its local reset time, Refresh, and a link
 * to Settings › Usage.
 *
 * The frames play on the shared sprite clock (frameClock.ts), pause off screen, and hold frame 0 under reduced motion.
 */
import type { AgentUsageLimits } from "@kora/contracts";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRightIcon, ChevronRightIcon, RefreshCwIcon } from "lucide-react";

import { cn } from "~/util/utils";
import { refreshPlanUsage } from "~/util/planUsageRefresh";
import { watchVisibleAnimation } from "~/util/visibleAnimation";
import { FramePaths, MONO, usePrefersReducedMotion } from "../sprite";
import { playFrames } from "../sprite/frameClock";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Spinner } from "../ui/spinner";
import { promptFloatingLayerProps } from "./promptEventScope";
import { ContextWindowDetails } from "./ContextWindowMeter";
import { grossSavedUsd } from "~/util/koraSavings";
import { KoraSavingsHero, useKoraSavings } from "./KoraSavings";
import { useClientPrefs } from "~/hooks/usePrefs";
import type { ContextUsageSnapshot } from "../../util/contextWindow";
import {
  checkedAgo,
  percentLeft,
  resetClock,
  sectionSummary,
  SIGN_H,
  signFrames,
  splitGroupLabel,
  usageReading,
  usageSections,
  usageSignLabel,
  usageTier,
  type UsageProviderInput,
  type UsageReading,
  type UsageSection,
} from "./usageSign.logic";

const SCALE = 2;
/** MONO plus the two semantic hues the board may take (red under 5% left, amber under 20%). */
const SIGN_PALETTE: Readonly<Record<string, string>> = { ...MONO, R: "#e5534b", A: "#e0a53a" };

const FILL: Record<"normal" | "warning" | "critical", string> = {
  normal: "bg-muted-foreground/72",
  warning: "bg-warning",
  critical: "bg-error",
};

export function UsageSignSprite(props: {
  readonly reading: Pick<UsageReading, "tier" | "left">;
  readonly reducedMotion?: boolean | undefined;
  /** Animate only while the pointer is over it (or it has keyboard focus); otherwise it holds frame 0. */
  readonly active?: boolean | undefined;
}) {
  const { tier, left } = props.reading;
  const frames = useMemo(() => signFrames(tier, left), [tier, left]);
  const systemReduced = usePrefersReducedMotion();
  const reduced = props.reducedMotion ?? systemReduced;
  const [idx, setIdx] = useState(0);
  const ref = useRef<HTMLSpanElement | null>(null);

  const active = props.active === true;
  useEffect(() => {
    if (reduced || !active || frames.length < 2) {
      setIdx(0);
      return;
    }
    const player = playFrames(
      frames.map((f) => f.ms),
      setIdx,
      true,
    );
    const stop = watchVisibleAnimation(ref.current, (running) => player.setRunning(running));
    return () => {
      stop?.();
      player.dispose();
    };
  }, [frames, reduced, active]);

  const shown = reduced || !active ? 0 : idx % frames.length;
  const rows = frames[shown]!.rows;
  const w = rows[0]!.length;
  return (
    <span
      ref={ref}
      aria-hidden
      className="px-anim relative -top-px inline-block"
      data-frame={shown}
      data-usage-tier={tier}
      style={{ width: w * SCALE, height: SIGN_H * SCALE }}
    >
      <svg
        aria-hidden
        focusable="false"
        height={SIGN_H * SCALE}
        shapeRendering="crispEdges"
        style={{ display: "block" }}
        viewBox={`0 0 ${w} ${SIGN_H}`}
        width={w * SCALE}
      >
        <FramePaths palette={SIGN_PALETTE} rows={rows} />
      </svg>
    </span>
  );
}

function WindowBar(props: {
  label: string;
  used: number;
  tone: keyof typeof FILL;
  reset: string | null;
}) {
  const used = Math.max(0, Math.min(100, props.used));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
        <span className="truncate">{props.label}</span>
        <span className="shrink-0 tabular-nums">
          {`${Math.round(used)}% used`}
          {props.reset ? <span className="text-muted-foreground"> · {props.reset}</span> : null}
        </span>
      </div>
      <div
        aria-label={`${props.label}: ${Math.round(used)}% used`}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={Math.round(used)}
        className="h-1 w-full overflow-hidden rounded-full bg-muted/60"
        role="progressbar"
      >
        <div
          className={cn("h-full rounded-full", FILL[props.tone])}
          style={{ width: `${used}%` }}
        />
      </div>
    </div>
  );
}

function SectionBody({ section, now }: { section: UsageSection; now: number }) {
  return (
    <div className="flex flex-col gap-2">
      {section.limit ? (
        <p className="text-[11px] text-destructive leading-4">
          {`Limit reached${section.limit.resetsAt !== null ? ` · ${resetClock(section.limit.resetsAt, now)}` : ""}`}
        </p>
      ) : null}
      {section.groups.map((g) => (
        <div className="flex flex-col gap-1.5" key={g.name ?? "_"}>
          {g.name ? <span className="text-[11px] text-muted-foreground">{g.name}</span> : null}
          {g.windows.map((w) => (
            <WindowBar
              key={w.id}
              label={g.name ? splitGroupLabel(w.label).span : w.label}
              reset={w.hasReset ? "reset since last check" : resetClock(w.resetsAt, now)}
              tone={w.tone}
              used={w.usedPercent}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function Section({ section, now }: { section: UsageSection; now: number }) {
  const [open, setOpen] = useState(section.current);
  const checked = checkedAgo(section.checkedAt, now);
  return (
    <section
      aria-label={`${section.name} usage`}
      className="flex flex-col gap-2"
      data-usage-section={section.driver}
    >
      {section.current ? (
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-medium text-foreground text-xs">
            {section.name}
            {section.plan ? <span className="text-secondary-label"> {section.plan}</span> : null}
          </span>
          {checked ? (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {section.stale ? `${checked} · couldn't refresh` : checked}
            </span>
          ) : null}
        </div>
      ) : (
        <button
          aria-expanded={open}
          className="flex w-full cursor-pointer items-center gap-1 text-left text-[11px] text-secondary-label hover:text-foreground"
          onClick={() => setOpen((v) => !v)}
          type="button"
        >
          <ChevronRightIcon
            className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
          />
          <span className="truncate">{sectionSummary(section, now)}</span>
        </button>
      )}
      {open ? <SectionBody now={now} section={section} /> : null}
    </section>
  );
}

export function UsageDetails(props: {
  readonly sections: ReadonlyArray<UsageSection>;
  readonly now: number;
  readonly onRefresh: ((force: boolean) => Promise<void>) | undefined;
  readonly onOpenUsage: (() => void) | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = async () => {
    if (!props.onRefresh || busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.onRefresh(true);
    } catch (cause) {
      // Never show transport internals here: the usual cause is Kora's background service restarting (an update).
      void cause;
      setError("Couldn't reach Kora's background service just now. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="flex flex-col gap-3 p-(--floating-content-inset) text-[11px] leading-4"
      data-usage-details=""
    >
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium text-muted-foreground text-xs">Plan usage</span>
        {props.onRefresh ? (
          <Button
            aria-busy={busy}
            disabled={busy}
            onClick={() => void refresh()}
            size="xs"
            variant="ghost"
          >
            {busy ? <Spinner className="size-3" /> : <RefreshCwIcon className="size-3" />}
            {busy ? "Checking…" : "Refresh"}
          </Button>
        ) : null}
      </div>
      {props.sections.map((s, i) => (
        <div className={cn(i > 0 && "border-border/60 border-t pt-2.5")} key={s.driver}>
          <Section now={props.now} section={s} />
        </div>
      ))}
      {error ? <p className="text-destructive">{error}</p> : null}
      {props.onOpenUsage ? (
        <button
          className="inline-flex w-fit cursor-pointer items-center gap-1 text-secondary-label hover:text-foreground hover:underline"
          onClick={props.onOpenUsage}
          type="button"
        >
          Usage details
          <ArrowUpRightIcon className="size-3" />
        </button>
      ) : null}
    </div>
  );
}

/** The thread's context window, shown at the top of the details (the composer has no separate ring any more). */
export interface ComposerContextInfo {
  readonly usage: ContextUsageSnapshot;
  readonly modelDisplayName: string | null;
  readonly onCompact: (() => void) | undefined;
  readonly compactDisabled: boolean;
  readonly compactDisabledReason: string | null;
}

export function UsageSignIndicator(props: {
  readonly reading: UsageReading;
  readonly sections: ReadonlyArray<UsageSection>;
  readonly now: number;
  readonly onRefresh: ((force: boolean) => Promise<void>) | undefined;
  readonly onOpenUsage: (() => void) | undefined;
  readonly reducedMotion?: boolean | undefined;
  readonly context?: ComposerContextInfo | null | undefined;
  /** The sidebar footer's form: "N% left" beside the sign, and the details open upward from the left edge. */
  readonly showLabel?: boolean | undefined;
  /** "Kora saved you" at the top: where to ask, and the thread for the Session view (null: Week / All only). */
  readonly savings?:
    | { readonly httpBaseUrl: string; readonly threadId: string | null }
    | null
    | undefined;
}) {
  const [open, setOpen] = useState(false);
  const showSavings = useClientPrefs((p) => p.showKoraSavings);
  const savings = useKoraSavings(
    props.savings?.httpBaseUrl,
    props.savings?.threadId,
    open,
    showSavings && !!props.savings,
  );
  const [hovered, setHovered] = useState(false);
  const label = usageSignLabel(props.reading, props.now);
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    // Opening the details re-reads only what is older than a minute (the daemon decides, one shared throttle); the
    // Refresh button inside is the explicit, forced read.
    if (next) void props.onRefresh?.(false);
  };
  return (
    <Popover onOpenChange={onOpenChange} open={open}>
      <PopoverTrigger
        render={
          <button
            aria-label={label}
            className={cn(
              "inline-flex h-7 shrink-0 cursor-pointer items-center justify-center rounded-md px-1 outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-muted/40",
              props.showLabel &&
                "min-w-0 justify-start gap-2 pr-2 text-[12px] text-muted-foreground",
            )}
            data-usage-left={percentLeft(props.reading.usedPercent, props.reading.limited)}
            data-usage-sign=""
            onBlur={() => setHovered(false)}
            onFocus={() => setHovered(true)}
            onPointerEnter={() => setHovered(true)}
            onPointerLeave={() => setHovered(false)}
            type="button"
          />
        }
      >
        <UsageSignSprite
          active={hovered || open}
          key={`${props.reading.tier}:${props.reading.left}`}
          reading={props.reading}
          reducedMotion={props.reducedMotion}
        />
        {props.showLabel ? (
          <span className="truncate tabular-nums" data-usage-label="">
            {props.reading.limited
              ? "Limit reached"
              : `${props.reading.left}% left${windowSuffix(props.reading)}`}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup
        align={props.showLabel ? "start" : "end"}
        className="w-80"
        side="top"
        tooltipStyle
        {...promptFloatingLayerProps}
      >
        {savings && (savings.all.savedUsd > 0 || grossSavedUsd(savings.all) > 0) ? (
          <div className="border-border/60 border-b p-(--floating-content-inset)">
            <KoraSavingsHero report={savings} />
          </div>
        ) : null}
        {props.context ? (
          <div className="border-border/60 border-b p-(--floating-content-inset)">
            <ContextWindowDetails
              compactDisabled={props.context.compactDisabled}
              compactDisabledReason={props.context.compactDisabledReason}
              modelDisplayName={props.context.modelDisplayName}
              onCompact={
                props.context.onCompact
                  ? () => {
                      setOpen(false);
                      props.context?.onCompact?.();
                    }
                  : undefined
              }
              usage={props.context.usage}
            />
          </div>
        ) : null}
        <UsageDetails
          now={props.now}
          onOpenUsage={
            props.onOpenUsage
              ? () => {
                  setOpen(false);
                  props.onOpenUsage?.();
                }
              : undefined
          }
          onRefresh={props.onRefresh}
          sections={props.sections}
        />
      </PopoverPopup>
    </Popover>
  );
}

/** " this week" / " · 5h" after the sidebar's "N% left", so the two signs never read as the same number. */
function windowSuffix(r: UsageReading): string {
  if (r.window?.kind === "weekly") return " this week";
  if (r.window?.kind === "session") return " · 5h";
  return "";
}

function contextReading(usage: ContextUsageSnapshot | null): UsageReading | null {
  const used = usage?.usedPercentage;
  if (used == null || !Number.isFinite(used)) return null;
  const u = Math.max(0, Math.min(100, Math.round(used)));
  return {
    driver: "claude",
    provider: "Context window",
    plan: null,
    group: null,
    window: null,
    usedPercent: u,
    left: 100 - u,
    limited: false,
    limitResetsAt: null,
    tier: usageTier(u, false),
    checkedAt: null,
  };
}

/** A clock for relative phrases ("checked 4 min ago", the reset times, a window that has reset). */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * The composer's sign for its current selection: reads the selected provider's plan (Antigravity: the quota group
 * of the selected model) and renders nothing when that provider has no plan data.
 */
export const ComposerUsageSign = memo(function ComposerUsageSign(props: {
  readonly driver: string | null | undefined;
  readonly model: string | null | undefined;
  readonly limits: AgentUsageLimits | null | undefined;
  readonly providers: ReadonlyArray<UsageProviderInput>;
  readonly httpBaseUrl: string | null | undefined;
  readonly onOpenUsage: (() => void) | undefined;
  readonly context?: ComposerContextInfo | null | undefined;
  readonly showLabel?: boolean | undefined;
  /**
   * The composer's sign is about THIS thread: the 5-hour session of its agent, and its popover lists only that agent
   * (plus the context window). The sidebar's is the overview: the week, every agent's plan.
   */
  readonly scope?: "thread" | "overview" | undefined;
  /** The open thread (the savings block's Session view); absent in the sidebar's overview. */
  readonly threadId?: string | null | undefined;
}) {
  const now = useMinuteClock();
  const overview = props.scope === "overview";
  const planReading = usageReading({
    driver: props.driver,
    model: props.model,
    limits: props.limits,
    now,
    prefer: overview ? "weekly" : "session",
  });
  const sections = useMemo(() => {
    const all = usageSections(props.providers, props.driver, now);
    if (overview) return all;
    const own = all.filter((s) => s.driver === props.driver);
    return own.length > 0 ? own : all;
  }, [props.providers, props.driver, now, overview]);
  const { httpBaseUrl } = props;
  const onRefresh = useMemo(
    () =>
      httpBaseUrl
        ? (force: boolean) => refreshPlanUsage(httpBaseUrl, undefined, undefined, force)
        : undefined,
    [httpBaseUrl],
  );
  // No plan data for this agent (OpenCode, an API key…): the sign shows the context window instead, so the
  // details always have a home now that the composer has no context ring.
  const reading = planReading ?? contextReading(props.context?.usage ?? null);
  if (!reading) return null;
  return (
    <UsageSignIndicator
      context={props.context ?? null}
      now={now}
      onOpenUsage={props.onOpenUsage}
      onRefresh={onRefresh}
      reading={reading}
      savings={
        httpBaseUrl ? { httpBaseUrl, threadId: overview ? null : (props.threadId ?? null) } : null
      }
      sections={sections}
      showLabel={props.showLabel}
    />
  );
});
