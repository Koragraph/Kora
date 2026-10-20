// "Popo updated its personality · Details · Undo". A blob changed itself (SOUL, model, routine); the receipt is one
// line, with the full sentence one click away and an Undo that restores the journalled value.
import { PencilLineIcon, Undo2Icon } from "lucide-react";
import { useState } from "react";

import { toastManager } from "~/components/ui/toast";
import type { BlobCardActions } from "./cardActions";
import { CardLine, CardLink } from "./CardLine";

export function SelfChangeCard(props: {
  readonly what: string;
  readonly undoToken: string;
  readonly undone: boolean;
  readonly actions: Pick<BlobCardActions, "undoSelfChange">;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"idle" | "busy" | "undone">("idle");
  const undone = props.undone || state === "undone";

  const undo = async () => {
    setState("busy");
    const result = await props.actions.undoSelfChange(props.undoToken);
    if (result.ok) setState("undone");
    else {
      setState("idle");
      toastManager.add({ type: "error", title: "Undo", description: result.message });
    }
  };

  if (undone) {
    return (
      <CardLine icon={Undo2Icon} kind="self-change-undone" muted>
        <span className="line-through">{props.what}</span> <span>· Undone</span>
      </CardLine>
    );
  }
  return (
    <div data-blob-card-group="self-change">
      <CardLine
        icon={PencilLineIcon}
        kind="self-change"
        actions={
          <>
            <CardLink aria-expanded={open} onClick={() => setOpen((current) => !current)}>
              Details
            </CardLink>
            <CardLink disabled={state === "busy"} onClick={() => void undo()}>
              Undo
            </CardLink>
          </>
        }
      >
        <span className={open ? "text-foreground/90" : "block truncate text-foreground/90"}>
          {props.what}
        </span>
      </CardLine>
      {open ? (
        <p className="pb-0.5 pl-[22px] text-[11.5px] leading-4 text-muted-foreground/70">
          Applies from the next conversation. Undo puts the previous setting back.
        </p>
      ) : null}
    </div>
  );
}
