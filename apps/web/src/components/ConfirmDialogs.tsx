import { Button } from "./ui/button";
import {
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialog,
  AlertDialogHeader,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogClose,
} from "./ui/alert-dialog";
import {
  completeConfirmDialogClose,
  respondToConfirmDialog,
  readConfirmDialogState,
  registerConfirmDialogHost,
  subscribeConfirmDialog,
} from "../confirm";
import { useSyncExternalStore, useEffect } from "react";

type ConfirmationCopy = {
  readonly description: string | null;
  readonly title: string;
};

function resolveConfirmDialogCopy(message: string): ConfirmationCopy {
  const trimmed = message.trim();
  const rows = trimmed.split("\n");
  const questionRow = rows.findIndex((row) => row.trim().endsWith("?"));

  if (questionRow !== -1) {
    const rest = rows.filter((_, position) => position !== questionRow);
    return { title: rows[questionRow]!.trim(), description: rest.join("\n").trim() || null };
  }

  const firstQuestionMark = trimmed.indexOf("?");
  if (firstQuestionMark !== -1) {
    return {
      description: trimmed.slice(firstQuestionMark + 1).trim() || null,
      title: trimmed.slice(0, firstQuestionMark + 1).trim(),
    };
  }

  return {
    description: trimmed || "This action requires your confirmation.",
    title: "Confirm action",
  };
}

export function ConfirmDialogHost() {
  const snapshot = readConfirmDialogState;
  const state = useSyncExternalStore(subscribeConfirmDialog, snapshot, snapshot);

  useEffect(() => registerConfirmDialogHost(), []);

  const idle = state.status === "idle";
  const copy = resolveConfirmDialogCopy(idle ? "" : state.message);
  const description = (idle ? undefined : state.description) ?? copy.description;
  const confirmLabel = (idle ? undefined : state.confirmLabel) ?? "Confirm";
  const confirmVariant = idle ? "default" : state.variant;
  const onConfirm = () => respondToConfirmDialog(true);
  const onCancel = () => respondToConfirmDialog(false);

  const alertDialogDescriptionBlock = description ? (
    <AlertDialogDescription className="whitespace-pre-line">{description}</AlertDialogDescription>
  ) : null;

  const alertDialogHeaderPart = (
    <AlertDialogHeader>
      <AlertDialogTitle>{copy.title}</AlertDialogTitle>
      {alertDialogDescriptionBlock}
    </AlertDialogHeader>
  );

  const alertDialogFooterPart = (
    <AlertDialogFooter>
      <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
      <Button onClick={onConfirm} variant={confirmVariant}>
        {confirmLabel}
      </Button>
    </AlertDialogFooter>
  );

  return (
    <AlertDialog
      onOpenChangeComplete={(open) => {
        if (!open) completeConfirmDialogClose();
      }}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      open={state.status === "confirming"}
    >
      <AlertDialogPopup className="max-w-lg">
        {alertDialogHeaderPart}
        {alertDialogFooterPart}
      </AlertDialogPopup>
    </AlertDialog>
  );
}
