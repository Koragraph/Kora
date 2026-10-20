/** The typed name must match exactly (the daemon compares the trimmed text). */

import type { ApiResult } from "./blobsApi";
import { Input } from "../../ui/input";
import { Button } from "../../ui/button";
import {
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialog,
  AlertDialogTitle,
  AlertDialogFooter,
  AlertDialogDescription,
} from "../../ui/alert-dialog";
// "Delete permanently…" for a retired blob: the real delete behind Retire. Type-the-name confirm, plain words about what
// goes (chats, memory, profile) and where the folder goes (the Trash, so it can still be got back). Kora, the Chief,
// can't be deleted (the daemon refuses too).
import { useState } from "react";

export function deleteConfirmMatches(typed: string, name: string): boolean {
  return typed.trim() === name && name.length > 0;
}

export function DeleteBlobDialog(props: {
  readonly blob: { readonly id: string; readonly name: string; readonly slug?: string } | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDelete: (blobId: string, confirmName: string) => Promise<ApiResult<object>>;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blob = props.blob;
  const ok = blob ? deleteConfirmMatches(typed, blob.name) : false;

  const close = () => {
    setTyped("");
    setError(null);
    props.onOpenChange(false);
  };
  const run = async () => {
    if (!blob || !ok || busy) return;
    setBusy(true);
    const r = await props.onDelete(blob.id, typed.trim());
    setBusy(false);
    if (r.ok) close();
    else setError(r.message);
  };

  const alertDialogFooterPart = (
    <AlertDialogFooter variant="bare">
      <Button variant="ghost" onClick={close}>
        Cancel
      </Button>
      <Button
        variant="destructive"
        disabled={!ok || busy}
        onClick={() => void run()}
        data-blob-delete-confirm
      >
        Delete permanently
      </Button>
    </AlertDialogFooter>
  );

  return (
    <AlertDialog open={blob !== null} onOpenChange={(open) => !open && close()}>
      <AlertDialogPopup className="max-w-sm" data-blob-delete-dialog>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {blob?.name ?? "this blob"} permanently?</AlertDialogTitle>
          <AlertDialogDescription>
            Its chats, memory and profile are deleted for good. Its folder
            {blob?.slug ? ` (${blob.slug})` : ""} is moved to the Trash, so you can still get the
            files back from there. Retiring instead keeps everything.
          </AlertDialogDescription>
          <label className="mt-2 flex flex-col gap-1.5 text-[13px] text-muted-foreground">
            <span>
              Type <span className="font-medium text-foreground">{blob?.name}</span> to confirm
            </span>
            <Input
              value={typed}
              onChange={(e) => {
                setTyped(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void run();
              }}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              aria-label={`Type ${blob?.name ?? "the name"} to confirm`}
              data-blob-delete-input
            />
          </label>
          {error ? (
            <p role="alert" className="text-[12px] text-destructive-foreground">
              {error}
            </p>
          ) : null}
        </AlertDialogHeader>
        {alertDialogFooterPart}
      </AlertDialogPopup>
    </AlertDialog>
  );
}
