// "Claude is at its limit · Continue on a free model". The only card with a real button: the thread is stuck, and
// the offer is the way out. It stays calm (no warning colour); the limit is a fact, not an error.
import { TimerIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { engineDisplayName } from "./parseCard";

function resetLabel(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null || !Number.isFinite(resetsAt) || resetsAt <= now) return null;
  const date = new Date(resetsAt);
  const sameDay = date.toDateString() === new Date(now).toDateString();
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return sameDay
    ? `Resets around ${time}.`
    : `Resets ${date.toLocaleDateString([], { weekday: "short" })} ${time}.`;
}

export function RateLimitCard(props: {
  readonly engine: string;
  readonly resetsAt: number | null;
  /** Starts the carry-on thread; resolves false (after showing why) when it could not. */
  readonly onContinue: () => Promise<{ readonly ok: boolean; readonly message?: string }>;
  readonly now?: number;
}) {
  const [busy, setBusy] = useState(false);
  const reset = resetLabel(props.resetsAt, props.now ?? Date.now());
  const run = async () => {
    setBusy(true);
    const result = await props.onContinue();
    setBusy(false);
    if (!result.ok) {
      toastManager.add({
        type: "error",
        title: "Could not continue",
        description: result.message ?? "Try again in a moment.",
      });
    }
  };
  return (
    <div
      data-blob-card="rate-limit"
      className="flex min-w-0 max-w-[26rem] items-center gap-3 rounded-xl border border-border/60 bg-card/60 px-3 py-2"
    >
      <TimerIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium leading-5 text-foreground">
          {props.engine === "opencode" ? "This free model" : engineDisplayName(props.engine)} is at
          its limit
        </p>
        <p className="text-[11.5px] leading-4 text-muted-foreground">
          {reset ? `${reset} ` : ""}
          {props.engine === "opencode" ? "Another free model" : "A free model"} can pick up where
          you left off.
        </p>
      </div>
      <Button size="xs" variant="secondary" disabled={busy} onClick={() => void run()}>
        {busy ? <Spinner className="size-3" /> : null}
        Continue on a free model
      </Button>
    </div>
  );
}
