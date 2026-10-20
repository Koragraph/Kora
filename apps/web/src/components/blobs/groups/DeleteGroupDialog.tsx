// "Delete group…": the real delete. Type-the-name confirm. The group's chats and its members' sessions for them are
// deleted; the shared folder goes to the Trash; the blobs themselves, their memory and their own folders are untouched.

import type { ApiResult } from "../cards/blobCommand";
import { Input } from "../../ui/input";
import { Button } from "../../ui/button";
import {
  AlertDialog,
  AlertDialogTitle,
  AlertDialogPopup,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogDescription,
} from "../../ui/alert-dialog";
import { useState } from "react";

export function DeleteGroupDialog(props: {
  readonly group: { readonly id: string; readonly name: string } | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDelete: (groupId: string, confirmName: string) => Promise<ApiResult<object>>;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const group = props.group;
  const ok = group !== null && group.name.length > 0 && typed.trim() === group.name;

  const close = () => {
    setTyped("");
    setError(null);
    props.onOpenChange(false);
  };
  const run = async () => {
    if (!group || !ok || busy) return;
    setBusy(true);
    const r = await props.onDelete(group.id, typed.trim());
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
        data-group-delete-confirm
      >
        Delete group
      </Button>
    </AlertDialogFooter>
  );

  return (
    <AlertDialog open={group !== null} onOpenChange={(open) => !open && close()}>
      <AlertDialogPopup className="max-w-sm" data-group-delete-dialog>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {group?.name ?? "this group"}?</AlertDialogTitle>
          <AlertDialogDescription>
            The group's chats are deleted for good. Its shared folder is moved to the Trash, so you
            can still get the files back. The blobs in it, their memory and their own folders are
            not touched. Archiving instead keeps everything.
          </AlertDialogDescription>
          <label className="mt-2 flex flex-col gap-1.5 text-[13px] text-muted-foreground">
            Type <span className="font-medium text-foreground">{group?.name}</span> to confirm
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
              aria-label={`Type ${group?.name ?? "the name"} to confirm`}
              data-group-delete-input
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
