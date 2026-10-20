// "Remembered: you live in Dallas · Undo". One quiet line per memory change a turn produced; a held memory (health,
// money, other people's details) asks first. The daemon re-emits the card with `undone: true` after an undo, so the
// optimistic state here only bridges the round trip.
import { BookmarkCheckIcon, BookmarkIcon, BookmarkXIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { toastManager } from "~/components/ui/toast";
import { registerHeldMemory, resolveHeldMemory } from "../memory/heldStore";
import type { BlobCardActions } from "./cardActions";
import { CardLine, CardLink } from "./CardLine";
import type { ParsedMemoryReceipt } from "./parseCard";

const COLLAPSED_COUNT = 3;

type Local = "busy" | "undone" | "saved" | "declined";

function ReceiptLine(props: {
  readonly receipt: ParsedMemoryReceipt;
  readonly local: Local | undefined;
  readonly onUndo: () => void;
  readonly onConfirm: (save: boolean) => void;
}) {
  const { receipt, local } = props;
  const busy = local === "busy";
  const held = receipt.kind === "held" && !receipt.undone && local === undefined;
  if (held || (receipt.kind === "held" && busy)) {
    return (
      <CardLine
        icon={BookmarkIcon}
        kind="memory-held"
        actions={
          <>
            <CardLink disabled={busy} onClick={() => props.onConfirm(true)}>
              Approve
            </CardLink>
            <CardLink disabled={busy} onClick={() => props.onConfirm(false)}>
              Not this
            </CardLink>
          </>
        }
      >
        <span>
          Save to memory: <span className="text-foreground">{receipt.text}</span>
        </span>
        {receipt.reason ? (
          <span className="mt-0.5 block text-[11.5px] text-muted-foreground/70">
            {receipt.reason}
          </span>
        ) : null}
      </CardLine>
    );
  }
  if (receipt.kind === "held") {
    const saved = local === "saved";
    return (
      <CardLine icon={saved ? BookmarkCheckIcon : BookmarkXIcon} kind="memory-held" muted={!saved}>
        <span>
          {saved ? "Remembered" : "Not saved"}:{" "}
          <span className={saved ? "text-foreground/90" : "line-through"}>{receipt.text}</span>
        </span>
      </CardLine>
    );
  }
  if (receipt.undone || local === "undone") {
    return (
      <CardLine icon={BookmarkXIcon} kind="memory-undone" muted>
        <span>
          Undone: <span className="line-through">{receipt.text}</span>
        </span>
      </CardLine>
    );
  }
  const verb =
    receipt.kind === "updated" ? "Updated" : receipt.kind === "retired" ? "Forgot" : "Remembered";
  return (
    <CardLine
      icon={BookmarkCheckIcon}
      kind={`memory-${receipt.kind}`}
      actions={
        <CardLink disabled={busy} onClick={props.onUndo}>
          Undo
        </CardLink>
      }
    >
      <span>
        {verb}: <span className="text-foreground/90">{receipt.text}</span>
        {receipt.kind === "updated" && receipt.previousText ? (
          <span className="text-muted-foreground/70"> (was: {receipt.previousText})</span>
        ) : null}
      </span>
    </CardLine>
  );
}

export function MemoryReceiptCard(props: {
  readonly receipts: ReadonlyArray<ParsedMemoryReceipt>;
  readonly actions: Pick<BlobCardActions, "undoMemory" | "confirmMemory">;
  /** The blob whose thread shows this card: held memories are listed under Pending in its Memory tab. */
  readonly blobId?: string | null;
}) {
  const [local, setLocal] = useState<Readonly<Record<string, Local>>>({});
  const [expanded, setExpanded] = useState(false);
  const { blobId = null, receipts } = props;
  useEffect(() => {
    if (blobId === null) return;
    for (const receipt of receipts) {
      if (receipt.kind === "held" && !receipt.undone && local[receipt.id] === undefined) {
        registerHeldMemory({
          receiptId: receipt.id,
          blobId,
          text: receipt.text,
          reason: receipt.reason,
          scope: receipt.scope,
        });
      } else {
        resolveHeldMemory(receipt.id);
      }
    }
  }, [blobId, receipts, local]);
  const set = (id: string, value: Local | undefined) =>
    setLocal((current) => {
      const next = { ...current };
      if (value === undefined) delete next[id];
      else next[id] = value;
      return next;
    });
  const fail = (message: string) =>
    toastManager.add({ type: "error", title: "Memory", description: message });

  const undo = async (receipt: ParsedMemoryReceipt) => {
    set(receipt.id, "busy");
    const result = await props.actions.undoMemory(receipt.id);
    if (result.ok) set(receipt.id, "undone");
    else {
      set(receipt.id, undefined);
      fail(result.message);
    }
  };
  const confirm = async (receipt: ParsedMemoryReceipt, save: boolean) => {
    set(receipt.id, "busy");
    const result = await props.actions.confirmMemory(receipt.id, save);
    if (result.ok) {
      set(receipt.id, save ? "saved" : "declined");
      // the card may come back with the approval's own receipt (a new id): the Memory tab's Pending list drops this one now
      resolveHeldMemory(receipt.id);
    } else {
      set(receipt.id, undefined);
      fail(result.message);
    }
  };

  const hidden = expanded ? 0 : Math.max(0, props.receipts.length - COLLAPSED_COUNT);
  const visible = hidden > 0 ? props.receipts.slice(0, COLLAPSED_COUNT) : props.receipts;
  return (
    <div data-blob-card-group="memory">
      {visible.map((receipt) => (
        <ReceiptLine
          key={receipt.id}
          receipt={receipt}
          local={local[receipt.id]}
          onUndo={() => void undo(receipt)}
          onConfirm={(save) => void confirm(receipt, save)}
        />
      ))}
      {hidden > 0 ? (
        <div className="pl-[22px]">
          <CardLink onClick={() => setExpanded(true)}>and {hidden} more</CardLink>
        </div>
      ) : null}
    </div>
  );
}
