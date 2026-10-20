// The monthly free calls: a quiet meter while there are some left, and a plain card when they are used up. Never a
// dead end: the card says what happens (Kora Pro is coming) and offers the one thing that works today (your own key).
import { KeyRoundIcon, SparklesIcon } from "lucide-react";

import { cn } from "~/util/utils";
import { Button } from "../../ui/button";
import type { AppsStatus } from "./appsApi";
import { capState, resetsLabel, usageFraction, usageLine } from "./appsModel";

export function UsageMeter(props: {
  readonly status: AppsStatus | null;
  readonly className?: string;
}) {
  const state = capState(props.status);
  const u = props.status?.usage ?? null;
  if (state === "byo") {
    return (
      <div className={cn("text-[12px] text-muted-foreground", props.className)} data-usage="byo">
        Using your Composio key. No limit on app calls.
      </div>
    );
  }
  if (state === "unavailable" || !u || u.limit === null) return null;
  const f = usageFraction(u);
  const resets = resetsLabel(u.resetsAt);
  return (
    <div className={cn("space-y-1.5", props.className)} data-usage={state}>
      <div className="flex items-baseline justify-between gap-3 text-[12px]">
        <span className="text-muted-foreground">{usageLine(u)}</span>
        {resets ? <span className="shrink-0 text-muted-foreground/75">Resets {resets}</span> : null}
      </div>
      <div
        className="h-1 overflow-hidden rounded-full bg-foreground/[0.09]"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={u.limit}
        aria-valuenow={u.used}
        aria-label="Free app calls used this month"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width]",
            state === "near" ? "bg-warning-foreground" : "bg-foreground/70",
          )}
          style={{ width: `${Math.max(f * 100, u.used > 0 ? 2 : 0)}%` }}
        />
      </div>
    </div>
  );
}

export function CapCard(props: {
  readonly status: AppsStatus;
  /** Scroll to / focus the key field. */
  readonly onPasteKey: () => void;
  readonly className?: string;
}) {
  const u = props.status.usage;
  const resets = resetsLabel(u?.resetsAt ?? null);
  return (
    <section
      data-cap-card
      role="status"
      className={cn("rounded-2xl bg-card p-4 ring-1 ring-border/70", props.className)}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-foreground/[0.07] text-foreground/80">
          <SparklesIcon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold text-foreground">
            Free app calls used up for this month
          </h3>
          <p className="mt-0.5 text-[13px] leading-snug text-muted-foreground">
            {u?.limit
              ? `All ${u.limit.toLocaleString("en-US")} calls are used`
              : "The monthly allowance is used"}
            {resets ? `, and they reset on ${resets}` : ""}. Your blobs still do everything that
            does not need an app. Kora Pro is coming.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={props.onPasteKey} data-cap-byo>
              <KeyRoundIcon /> Paste your own Composio key
            </Button>
            <span className="text-[12px] text-muted-foreground">
              No limit, and it takes two minutes.
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
