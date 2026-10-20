import { cn } from "~/util/utils";
import {
  formatResetPhrase,
  activePlanLimit,
  planWindowViews,
  type PlanWindowView,
  usageTone,
} from "~/util/planUsage";
import {
  formatContextWindowTokens,
  type ContextUsageSnapshot,
  formatUsd,
} from "~/util/contextWindow";
import { promptFloatingLayerProps } from "./promptEventScope";
import { formatContextWindowCompactionMessage } from "./ContextWindowMeter.logic";
import { PopoverTrigger, PopoverPopup, Popover } from "../ui/popover";
import { Button } from "../ui/button";
import type { AgentUsageLimits } from "@kora/contracts";
import type { ReactNode } from "react";
import { ArrowUpRightIcon, Minimize2Icon } from "lucide-react";

const RING_RADIUS = 9.75;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const HOVER_DELAY_MS = 150;

type Tone = PlanWindowView["tone"];

const RING_STROKE: Record<Tone, string> = {
  normal: "color-mix(in srgb, var(--color-muted-foreground) 72%, transparent)",
  warning: "var(--color-warning)",
  critical: "var(--color-error)",
};

const FILL_CLASS: Record<Tone, string> = {
  normal: "bg-muted-foreground/72",
  warning: "bg-warning",
  critical: "bg-error",
};

function formatPercent(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value < 10) return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  return `${Math.round(value)}%`;
}

function Bar({
  value,
  tone,
  height,
  label,
}: {
  value: number;
  tone: Tone;
  height: "h-1.5" | "h-1";
  label?: string;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={Math.round(clamped)}
      className={cn("w-full overflow-hidden rounded-full bg-muted/60", height)}
      role={label ? "progressbar" : undefined}
    >
      <div
        className={cn("h-full rounded-full transition-[width] duration-500", FILL_CLASS[tone])}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{children}</span>
    </div>
  );
}

function PlanUsageRows({ limits, now }: { limits: AgentUsageLimits; now: number }) {
  const windows = planWindowViews(limits, now);
  const limit = activePlanLimit(limits, now);
  const limitPhrase = limit ? formatResetPhrase(limit.resetsAt, now) : null;

  return (
    <div className="flex flex-col gap-1.5" data-testid="plan-usage-rows">
      {limit ? (
        <p className="text-[11px] text-destructive leading-4">
          {`Limit reached${limitPhrase ? ` · ${limitPhrase}` : ""}`}
        </p>
      ) : null}
      {windows.map((view) => {
        const reset = formatResetPhrase(view.resetsAt, now);
        return (
          <div className="flex flex-col gap-1" key={view.id}>
            <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
              <span className="truncate">{view.label}</span>
              <span className="shrink-0 tabular-nums">
                {`${Math.round(view.usedPercent)}%`}
                {reset ? <span className="text-muted-foreground"> {reset}</span> : null}
              </span>
            </div>
            <Bar height="h-1" tone={view.tone} value={view.usedPercent} />
          </div>
        );
      })}
    </div>
  );
}

type ContextWindowDetailsProps = {
  compactDisabledReason?: string | null;
  compactDisabled?: boolean;
  onCompact?: (() => void) | undefined;
  modelDisplayName?: string | null;
  usage: ContextUsageSnapshot;
};

/** The context-window section on its own (the composer's usage sprite shows it above plan usage). */
export function ContextWindowDetails({
  usage,
  modelDisplayName,
  onCompact,
  compactDisabled = false,
  compactDisabledReason,
}: ContextWindowDetailsProps) {
  const percent = usage.usedPercentage;
  const percentLabel = formatPercent(percent);
  const knownMax = usage.maxTokens !== null;
  const tone: Tone = knownMax && percent !== null ? usageTone(percent) : "normal";
  const usedLabel = formatContextWindowTokens(usage.usedTokens);
  const cost = formatUsd(usage.costUsd);
  return (
    <div className="flex flex-col gap-2 text-[11px] leading-4" data-context-window-details="">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium text-muted-foreground text-xs">Context window</span>
        <span className="text-secondary-label tabular-nums">
          {knownMax && percentLabel
            ? `${percentLabel} · ${usedLabel}/${formatContextWindowTokens(usage.maxTokens)}`
            : usedLabel}
        </span>
      </div>
      {knownMax && percent !== null ? (
        <Bar height="h-1.5" label="Context window usage" tone={tone} value={percent} />
      ) : null}
      {usage.totalProcessedTokens && usage.totalProcessedTokens > 0 ? (
        <Row label="Tokens this session">
          {formatContextWindowTokens(usage.totalProcessedTokens)}
        </Row>
      ) : null}
      {usage.compactsAutomatically ? (
        <p className="text-muted-foreground">
          {formatContextWindowCompactionMessage(modelDisplayName, usage.autoCompactThreshold)}
        </p>
      ) : null}
      {cost ? <Row label="Session cost (API-price estimate)">{cost}</Row> : null}
      {onCompact ? (
        <Button
          size="xs"
          variant="outline"
          onClick={onCompact}
          disabled={compactDisabled}
          className="mt-1 w-full justify-center"
        >
          <Minimize2Icon />
          Compact context
        </Button>
      ) : null}
      {onCompact && compactDisabled && compactDisabledReason ? (
        <p className="text-muted-foreground">{compactDisabledReason}</p>
      ) : null}
    </div>
  );
}

export function ContextWindowMeter({
  usage,
  modelDisplayName,
  onCompact,
  compactDisabled = false,
  compactDisabledReason,
  planUsage,
  onOpenUsage,
  now = Date.now(),
}: {
  onOpenUsage?: (() => void) | undefined;
  compactDisabledReason?: string | null;
  onCompact?: (() => void) | undefined;
  planUsage?: AgentUsageLimits | null;
  modelDisplayName?: string | null;
  usage: ContextUsageSnapshot;
  compactDisabled?: boolean;
  now?: number;
}) {
  const percent = usage.usedPercentage;
  const percentLabel = formatPercent(percent);
  const knownMax = usage.maxTokens !== null;
  const tone: Tone = knownMax && percent !== null ? usageTone(percent) : "normal";
  const usedLabel = formatContextWindowTokens(usage.usedTokens);

  const triggerLabel =
    knownMax && percentLabel
      ? `Context window ${percentLabel} used`
      : `Context window ${usedLabel} tokens used`;

  const dashOffset = RING_CIRCUMFERENCE * (1 - Math.max(0, Math.min(100, percent ?? 0)) / 100);
  const cost = formatUsd(usage.costUsd);
  const hasPlan =
    !!planUsage && (planUsage.windows.length > 0 || activePlanLimit(planUsage, now) !== null);
  const interactive = onCompact !== undefined || onOpenUsage !== undefined;
  const delay = interactive ? HOVER_DELAY_MS : 0;

  return (
    <Popover>
      <PopoverTrigger
        closeDelay={delay}
        delay={delay}
        openOnHover
        render={
          <Button
            aria-label={triggerLabel}
            className="size-7 rounded-full hover:text-muted-foreground data-pressed:text-muted-foreground"
            data-context-window-meter=""
            size="icon-sm"
            title={triggerLabel}
            variant="ghost-muted"
          />
        }
      >
        <svg aria-hidden="true" className="-rotate-90 size-5" viewBox="0 0 24 24">
          <circle
            cx="12"
            cy="12"
            fill="none"
            r={RING_RADIUS}
            stroke="color-mix(in srgb, var(--color-muted-foreground) 24%, transparent)"
            strokeWidth="3"
          />
          <circle
            className="transition-[stroke,stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
            cx="12"
            cy="12"
            fill="none"
            r={RING_RADIUS}
            stroke={RING_STROKE[tone]}
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
            strokeWidth="3"
          />
        </svg>
      </PopoverTrigger>
      <PopoverPopup
        align="end"
        className="w-72"
        side="top"
        tooltipStyle
        {...promptFloatingLayerProps}
      >
        <div className="flex flex-col gap-2 p-(--floating-content-inset) text-[11px] leading-4">
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium text-muted-foreground text-xs">Context window</span>
            <span className="text-secondary-label tabular-nums">
              {knownMax && percentLabel
                ? `${percentLabel} · ${usedLabel}/${formatContextWindowTokens(usage.maxTokens)}`
                : usedLabel}
            </span>
          </div>
          {knownMax && percent !== null ? (
            <Bar height="h-1.5" label="Context window usage" tone={tone} value={percent} />
          ) : null}
          {usage.totalProcessedTokens && usage.totalProcessedTokens > 0 ? (
            <Row label="Tokens this session">
              {formatContextWindowTokens(usage.totalProcessedTokens)}
            </Row>
          ) : null}
          {usage.compactsAutomatically ? (
            <p className="text-muted-foreground">
              {formatContextWindowCompactionMessage(modelDisplayName, usage.autoCompactThreshold)}
            </p>
          ) : null}
          {cost ? <Row label="Session cost (API-price estimate)">{cost}</Row> : null}
          {hasPlan && planUsage ? (
            <div className="flex flex-col gap-1.5 border-border/60 border-t pt-2">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium text-muted-foreground text-xs">Plan usage</span>
                {planUsage.plan ? (
                  <span className="text-secondary-label">{planUsage.plan}</span>
                ) : null}
              </div>
              <PlanUsageRows limits={planUsage} now={now} />
            </div>
          ) : null}
          {onOpenUsage ? (
            <button
              className="mt-0.5 inline-flex w-fit cursor-pointer items-center gap-1 text-secondary-label hover:text-foreground hover:underline"
              onClick={onOpenUsage}
              type="button"
            >
              Usage details
              <ArrowUpRightIcon className="size-3" />
            </button>
          ) : null}
          {onCompact ? (
            <Button
              size="xs"
              variant="outline"
              onClick={onCompact}
              disabled={compactDisabled}
              className="mt-1 w-full justify-center"
            >
              <Minimize2Icon />
              Compact context
            </Button>
          ) : null}
          {onCompact && compactDisabled && compactDisabledReason ? (
            <p className="text-muted-foreground">{compactDisabledReason}</p>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function ContextWindowMeterPlaceholder() {
  return <span className="size-7 shrink-0" aria-hidden="true" />;
}
