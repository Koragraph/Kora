// What this blob did with your connected apps, newest first (the last 50): every allow and deny, in words, with the
// reason. Arguments are never in the log (they can hold message bodies): only which tool, which app, which account.
import { CheckIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "~/util/utils";
import { useAppsApi, type AppDecisionWire } from "./appsApi";
import { appLabel, reasonWords, toolWords } from "./appsModel";

function when(ms: number, now: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (new Date(now).toDateString() === d.toDateString()) return time;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

export function DecisionLog(props: {
  readonly blobId: string;
  readonly limit?: number;
  readonly now?: number;
}) {
  const api = useAppsApi();
  const [rows, setRows] = useState<ReadonlyArray<AppDecisionWire> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      void api.decisions(props.blobId, props.limit ?? 50).then((r) => {
        if (!live) return;
        if (r.ok) {
          // a "result" row repeats its decision: the log shows decisions, with the outcome when the call failed
          setRows(r.value);
          setError(null);
        } else setError(r.message);
      });
    load();
    const t = setInterval(load, 20_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [api, props.blobId, props.limit]);

  if (error)
    return (
      <p className="text-[12px] text-muted-foreground" data-decisions-error>
        {error}
      </p>
    );
  if (rows === null) return <p className="text-[12px] text-muted-foreground">Loading…</p>;
  const decisions = rows.filter((r) => r.kind === "decision");
  if (decisions.length === 0) {
    return (
      <p className="text-[12px] text-muted-foreground" data-decisions-empty>
        Nothing yet. Every time this blob uses a connected app, it shows up here.
      </p>
    );
  }
  const now = props.now ?? Date.now();
  return (
    <ul className="divide-y divide-border/50 rounded-xl ring-1 ring-border/70" data-decision-log>
      {decisions.map((r, i) => {
        const allowed = r.decision === "allow";
        const failed = rows.some(
          (x) =>
            x.kind === "result" &&
            x.at >= r.at &&
            x.at - r.at < 120_000 &&
            x.tool === r.tool &&
            x.outcome === "error",
        );
        return (
          <li
            key={`${r.at}-${i}`}
            className="flex items-start gap-2.5 px-3 py-2 text-[12.5px]"
            data-decision={r.decision}
            data-decision-reason={r.reason}
          >
            <span
              className={cn(
                "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full",
                allowed
                  ? "bg-success/12 text-success-foreground"
                  : "bg-destructive/10 text-destructive-foreground",
              )}
              aria-label={allowed ? "Allowed" : "Not allowed"}
            >
              {allowed ? (
                <CheckIcon className="size-2.5" aria-hidden />
              ) : (
                <XIcon className="size-2.5" aria-hidden />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-foreground">
                {toolWords(r.tool)}{" "}
                <span className="font-normal text-muted-foreground">
                  on {appLabel(r.toolkit)}
                  {r.account ? ` (${r.account})` : ""}
                </span>
              </span>
              <span className="block text-[11.5px] text-muted-foreground">
                {reasonWords(r.reason)}
                {r.outbound ? " · sends or changes something" : ""}
                {failed ? " · the app reported an error" : ""}
              </span>
            </span>
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {when(r.at, now)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
