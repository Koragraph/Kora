/**
 * "Kora saved you $0.88": the top of the usage sign's popover. Session (this thread) / Week / All, the money in big type,
 * what it would have cost at API prices, and one chip per lever. Fetched when the popover opens; the numbers are
 * API-price estimates (runtime `ledger/savings.ts`) and the popover says so under the number (a subscription user pays
 * none of these amounts).
 */
import { useEffect, useState } from "react";

import { cn } from "~/util/utils";
import {
  fetchSavings,
  formatSavedUsd,
  LEVER_LABELS,
  leverChips,
  reportForThread,
  SAVINGS_ESTIMATE_NOTE,
  type HeldSavings,
  type SavingsReport,
  type SavingsScope,
  unpricedNote,
} from "~/util/koraSavings";

const SCOPES: ReadonlyArray<{ id: SavingsScope; label: string }> = [
  { id: "session", label: "Session" },
  { id: "week", label: "Week" },
  { id: "all", label: "All" },
];

/** Fetches once per open (the daemon caches on the log files, so this is cheap). */
export function useKoraSavings(
  httpBaseUrl: string | null | undefined,
  threadId: string | null | undefined,
  open: boolean,
  enabled: boolean,
): SavingsReport | null {
  // Keyed by thread: switching threads must not show the previous thread's numbers until the new fetch lands.
  const [held, setHeld] = useState<HeldSavings | null>(null);
  useEffect(() => {
    if (!open || !enabled || !httpBaseUrl) return;
    let live = true;
    const key = threadId ?? null;
    fetchSavings(httpBaseUrl, key)
      .then((r) => {
        if (live) setHeld({ threadId: key, report: r });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [open, enabled, httpBaseUrl, threadId]);
  return enabled ? reportForThread(held, threadId) : null;
}

export function KoraSavingsHero({ report }: { report: SavingsReport }) {
  const hasSession = report.session !== null && report.session.savedUsd > 0;
  const [scope, setScope] = useState<SavingsScope>(hasSession ? "session" : "week");
  const totals = scope === "session" ? report.session : report[scope];
  const scopes = report.session === null ? SCOPES.filter((s) => s.id !== "session") : SCOPES;
  const saved = totals?.savedUsd ?? 0;
  const paid = totals?.paidUsd ?? 0;
  const chips = totals ? leverChips(totals) : [];
  return (
    <div className="flex flex-col gap-2.5" data-kora-savings="">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium text-muted-foreground text-xs">Kora saved you</span>
        <div
          aria-label="Savings period"
          className="inline-flex rounded-full bg-muted/40 p-0.5 ring-1 ring-border/60"
          role="tablist"
        >
          {scopes.map((s) => (
            <button
              aria-selected={scope === s.id}
              className={cn(
                "cursor-pointer rounded-full px-2.5 py-0.5 text-[11px] text-muted-foreground leading-4 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                scope === s.id && "bg-background text-foreground ring-1 ring-border/60",
              )}
              key={s.id}
              onClick={() => setScope(s.id)}
              role="tab"
              type="button"
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span
          className="font-light text-[38px] text-success tabular-nums leading-none tracking-tight"
          data-kora-saved=""
        >
          {formatSavedUsd(saved)}
        </span>
        {saved > 0 ? (
          <span className="text-[11px] text-muted-foreground tabular-nums">
            of {formatSavedUsd(saved + paid)} · {formatSavedUsd(paid)} spent
          </span>
        ) : (
          <span className="text-[11px] text-muted-foreground">
            {scope === "session" ? "nothing yet in this thread" : "nothing yet"}
          </span>
        )}
      </div>
      <span className="-mt-1.5 text-[11px] text-muted-foreground/80" data-kora-savings-note="">
        {SAVINGS_ESTIMATE_NOTE}
      </span>
      {unpricedNote(report.unpriced) ? (
        <span
          className="-mt-1.5 text-[11px] text-muted-foreground/80"
          data-kora-savings-unpriced=""
        >
          {unpricedNote(report.unpriced)}
        </span>
      ) : null}
      {chips.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <span
              className="rounded-full bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground leading-4 ring-1 ring-border/60"
              key={c.lever}
            >
              {LEVER_LABELS[c.lever]}{" "}
              <span className="font-medium text-foreground tabular-nums">
                {formatSavedUsd(c.usd)}
              </span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
