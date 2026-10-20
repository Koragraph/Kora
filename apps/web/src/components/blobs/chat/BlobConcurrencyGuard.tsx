import { useBlobRoster } from "../shell/useBlobRoster";
import { useBlobsApi } from "../shell/blobsApi";
import { shouldWarnConcurrency, paidBlobIdsOf } from "../shell/blobStatus";
import { Checkbox } from "../../ui/checkbox";
import { Button } from "../../ui/button";
import {
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialog,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogFooter,
} from "../../ui/alert-dialog";
// "Several blobs at once can hit your plan's limits": shown when the user starts work on a 3rd blob while two are
// already working. There are no caps; this only warns, once, with a persisted "Don't show again".
import { useCallback, useState, useMemo, useRef } from "react";

type SendFn<A extends unknown[]> = (...args: A) => unknown;

/**
 * Wraps a send handler. Returns the wrapped handler plus the dialog element to render once. A send that would not
 * warn passes straight through, synchronously (the composer's `preventDefault` must not be deferred).
 */
export function useBlobSendGuard<A extends unknown[]>(blobId: string | null, send: SendFn<A>) {
  const api = useBlobsApi();
  const { workingBlobIds, snapshot } = useBlobRoster();
  const dismissed = snapshot?.flags.concurrencyWarningDismissed ?? false;
  const paid = useMemo(() => paidBlobIdsOf(snapshot?.blobs ?? []), [snapshot]);
  const [pending, setPending] = useState<A | null>(null);
  const [dontShow, setDontShow] = useState(false);
  const sendRef = useRef(send);
  sendRef.current = send;

  const guarded = useCallback(
    (...args: A) => {
      if (
        blobId === null ||
        !shouldWarnConcurrency({
          workingBlobIds,
          startingBlobId: blobId,
          dismissed,
          paidBlobIds: paid,
        })
      ) {
        return sendRef.current(...args);
      }
      const first = args[0] as { preventDefault?: () => void } | undefined;
      first?.preventDefault?.();
      setDontShow(false);
      setPending(args);
      return undefined;
    },
    [blobId, workingBlobIds, dismissed, paid],
  );

  const close = (proceed: boolean) => {
    const args = pending;
    setPending(null);
    if (dontShow) void api.setFlag("concurrencyWarningDismissed", true);
    if (proceed && args) void sendRef.current(...args);
  };

  const alertDialogFooterPart = (
    <AlertDialogFooter variant="bare">
      <Button variant="ghost" onClick={() => close(false)}>
        Cancel
      </Button>
      <Button onClick={() => close(true)} data-concurrency-continue>
        Send anyway
      </Button>
    </AlertDialogFooter>
  );

  const dialog = (
    <AlertDialog open={pending !== null} onOpenChange={(open) => !open && close(false)}>
      <AlertDialogPopup className="max-w-sm" data-blob-concurrency-dialog>
        <AlertDialogHeader>
          <AlertDialogTitle>Several blobs at once can hit your plan’s limits</AlertDialogTitle>
          <AlertDialogDescription>
            Two blobs on your Claude or Codex plan are already working. A third shares the same
            plan, so you can run into its rate limit sooner. Nothing is capped, and you can always
            continue on a free model.
          </AlertDialogDescription>
          <label className="mt-1 flex cursor-pointer items-center gap-2 text-[13px] text-muted-foreground">
            <Checkbox
              checked={dontShow}
              onCheckedChange={(v) => setDontShow(v === true)}
              aria-label="Don’t show this warning again"
            />
            Don’t show again
          </label>
        </AlertDialogHeader>
        {alertDialogFooterPart}
      </AlertDialogPopup>
    </AlertDialog>
  );

  return { send: guarded, dialog };
}
