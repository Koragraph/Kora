// One tidy card for a change Kora wants approved: what will change, the details, Confirm / Not now. While it is open
// both buttons work; afterwards it collapses to a quiet receipt with the result. Latest version wins, so a late older
// frame never reopens a card the user already answered.
import { CheckIcon, ShieldQuestionIcon, XIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import type { BlobCardRef } from "../../../thread/timeline";
import { Button } from "../../ui/button";
import { Spinner } from "../../ui/spinner";
import type { ApiResult } from "./blobCommand";
import { CardLine } from "./CardLine";
import { CONFIRM_YES, parseConfirm, type ConfirmView } from "./confirmModel";
import { latestVersion } from "./proposalModel";

export interface ConfirmActions {
  /** `blobs.confirm.resolve({ cardId, accept })`. */
  resolve: (
    cardId: string,
    accept: boolean,
  ) => Promise<ApiResult<{ ok: boolean; message: string }>>;
}

export function ConfirmCard(props: {
  readonly card: BlobCardRef;
  readonly actions: ConfirmActions;
}) {
  const incoming = useMemo(() => parseConfirm(props.card), [props.card]);
  const seen = useRef<ConfirmView | null>(null);
  if (incoming) seen.current = latestVersion(seen.current, incoming);
  const view = seen.current;
  const [busy, setBusy] = useState<"yes" | "no" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The click's own answer shows at once; the next card version (same text) replaces it.
  const [local, setLocal] = useState<{
    state: "confirmed" | "dismissed" | "failed";
    message: string;
  } | null>(null);
  if (!view) return null;

  const state = view.state !== "open" ? view.state : (local?.state ?? "open");
  const result = view.state !== "open" ? view.result : (local?.message ?? null);

  if (state !== "open") {
    const word =
      state === "confirmed" ? "Done" : state === "dismissed" ? "Not done" : "Did not work";
    return (
      <CardLine
        icon={state === "confirmed" ? CheckIcon : XIcon}
        kind="confirm"
        muted={state !== "confirmed"}
      >
        <span data-confirm-state={state}>
          <span className="text-foreground/90">{view.summary}</span>
          <span> · {word}</span>
          {result ? (
            <span className="block text-[11.5px] text-muted-foreground/80">{result}</span>
          ) : null}
        </span>
      </CardLine>
    );
  }

  const answer = async (accept: boolean) => {
    setBusy(accept ? "yes" : "no");
    setError(null);
    const r = await props.actions.resolve(view.cardId, accept);
    setBusy(null);
    if (!r.ok) return setError(r.message);
    setLocal({
      state: !accept ? "dismissed" : r.value.ok ? "confirmed" : "failed",
      message: r.value.message,
    });
  };

  return (
    <section
      data-blob-card="confirm"
      data-confirm-state="open"
      aria-label={view.summary}
      className="my-1 w-full max-w-[460px] rounded-xl border border-border bg-card px-3.5 py-3 text-[13px] leading-5"
    >
      <div className="flex items-start gap-2">
        <ShieldQuestionIcon
          className="mt-[3px] size-3.5 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <div className="min-w-0">
          <p className="font-medium text-foreground">{view.summary}</p>
          {view.details.length > 0 ? (
            <ul
              className="mt-1 space-y-0.5 text-[12.5px] text-muted-foreground"
              data-confirm-details
            >
              {view.details.map((d) => (
                <li key={d} className="[overflow-wrap:anywhere]">
                  {d}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-[12.5px] text-foreground/80" data-confirm-error>
          {error}
        </p>
      ) : null}
      <div className="mt-3 flex items-center gap-2 pl-[22px]">
        <Button
          size="sm"
          disabled={busy !== null}
          onClick={() => void answer(true)}
          data-confirm-yes
        >
          {busy === "yes" ? <Spinner className="size-3.5" /> : null}
          {CONFIRM_YES[view.action]}
        </Button>
        <Button
          size="sm"
          variant="ghost-muted"
          disabled={busy !== null}
          onClick={() => void answer(false)}
          data-confirm-no
        >
          {busy === "no" ? <Spinner className="size-3.5" /> : null}
          Not now
        </Button>
      </div>
    </section>
  );
}
