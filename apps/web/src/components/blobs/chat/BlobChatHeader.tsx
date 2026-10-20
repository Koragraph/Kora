/** The small mark for a thread Kora started ("from Kora"): the roster thread list and the thread header share it. */

import { cn } from "~/util/utils";
import { STARTER_OUTFITS, BlobAvatar } from "~/components/blobs/avatar";
import { usePrimaryHost } from "~/atoms/hosts";
import { useBlobPanel } from "./blobPanelStore";
import { BlobUsageChip } from "./BlobUsageChip";
import { useBlobRoster } from "../shell/useBlobRoster";
import { claudeAccountOf } from "../shell/engineLabel";
import { useBlobsApi } from "../shell/blobsApi";
import { BlobModelChip } from "../shell/BlobModelPicker";
import { TooltipTrigger, TooltipPopup, Tooltip } from "../../ui/tooltip";
import { toastManager } from "../../ui/toast";
// The blob chat's top bar. Left: who you are talking to (avatar, name · title; opens the profile panel). Right:
// usage chip, model chip (the blob's model), and the panel toggle. The thread title in the middle stays the app's own
// `ChatHeader`, so rename and the thread menu behave exactly as everywhere else.
import { PanelRightIcon, WifiOffIcon } from "lucide-react";

export function FromKoraMark(props: { readonly size?: number }) {
  return (
    <span
      data-from-kora-mark
      role="img"
      aria-label="From Kora"
      className="grid shrink-0 place-items-center"
    >
      <BlobAvatar
        outfit={STARTER_OUTFITS.kora}
        state="idle"
        size={props.size ?? 14}
        chief
        eyesFollowCursor={false}
      />
    </span>
  );
}

/** Stays on while Kora's background service is down or restarting (a toast alone is gone in seconds). */
function OfflineChip() {
  const host = usePrimaryHost();
  const phase = host?.connection.phase ?? "connected";
  if (phase === "connected" || phase === "available") return null;
  return (
    <span
      data-offline-chip
      role="status"
      className="flex shrink-0 items-center gap-1 rounded-full bg-foreground/[0.07] px-2 py-0.5 text-[11.5px] font-medium text-muted-foreground"
    >
      <WifiOffIcon className="size-3" aria-hidden />
      Offline, reconnecting. Anything shown as working may not be.
    </span>
  );
}

export function BlobHeaderIdentity(props: {
  readonly blobId: string;
  /** This thread is work Kora handed over (origin.kind === "kora"). */
  readonly fromKora?: boolean;
}) {
  const { entries } = useBlobRoster();
  const panel = useBlobPanel();
  const entry = entries.get(props.blobId);
  if (!entry) return null;
  const { blob, chief, status } = entry;
  return (
    <button
      type="button"
      data-blob-header-identity
      onClick={() => panel.show("profile")}
      aria-label={`${blob.name}${blob.title ? `, ${blob.title}` : ""}. Open profile`}
      className="group/identity -ms-1 flex h-9 min-w-0 shrink-0 items-center gap-2 rounded-full pe-2.5 ps-1 transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [-webkit-app-region:no-drag]"
    >
      <span className="grid size-8 shrink-0 place-items-center">
        <BlobAvatar
          outfit={entry.outfit}
          state={status.visual}
          size={24}
          chief={chief}
          eyesFollowCursor={false}
        />
      </span>
      <span className="flex min-w-0 items-baseline gap-1.5 text-sm">
        <span className="truncate font-semibold text-foreground">{blob.name}</span>
        {blob.title ? (
          <span className="truncate text-muted-foreground max-md:hidden @max-[44rem]/chat-header:hidden">
            · {blob.title}
          </span>
        ) : null}
      </span>
      <OfflineChip />
      {props.fromKora ? (
        <span
          data-from-kora-label
          className="flex shrink-0 items-center gap-1 rounded-full bg-foreground/[0.07] px-2 py-0.5 text-[11.5px] font-medium text-muted-foreground"
        >
          <FromKoraMark size={14} />
          from Kora
        </span>
      ) : null}
    </button>
  );
}

export function BlobHeaderActions(props: {
  readonly blobId: string;
  readonly threadId: string | null;
  readonly refreshKey: string | null;
  /** The model this thread is on right now (it can differ from the blob's default once the composer picker changed it). */
  readonly threadModel?: { readonly instanceId: string; readonly model: string } | null;
  /** A file is open in the dock: the panel yields to it, and the toggle closes the dock to bring the panel back. */
  readonly dockOpen: boolean;
  readonly onCloseDock: () => void;
}) {
  const { entries } = useBlobRoster();
  const api = useBlobsApi();
  const panel = useBlobPanel();
  const entry = entries.get(props.blobId);
  if (!entry) return null;
  const panelShown = panel.open && !props.dockOpen;
  const tooltipTriggerPart = (
    <TooltipTrigger
      render={
        <button
          type="button"
          data-blob-panel-toggle
          aria-label={panelShown ? "Hide the blob panel" : "Show the blob panel"}
          aria-pressed={panelShown}
          onClick={() => {
            if (props.dockOpen) {
              props.onCloseDock();
              panel.setOpen(true);
            } else panel.toggle();
          }}
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            panelShown
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          )}
        />
      }
    >
      <PanelRightIcon className="size-4" />
    </TooltipTrigger>
  );

  const tooltipPopupPart = (
    <TooltipPopup side="bottom">
      {panelShown ? "Hide panel" : "Profile, memory, files"}
    </TooltipPopup>
  );

  return (
    <div className="flex shrink-0 items-center gap-1.5 ps-1 [-webkit-app-region:no-drag]">
      <BlobUsageChip
        blobId={props.blobId}
        threadId={props.threadId}
        refreshKey={props.refreshKey}
        className="@max-[30rem]/chat-header:px-1.5"
      />
      <AccountChip instanceId={props.threadModel?.instanceId ?? entry.blob.engine.instanceId} />
      <BlobModelChip
        className="min-w-24 max-w-44 @max-[30rem]/chat-header:max-w-28"
        value={
          props.threadModel
            ? {
                ...entry.blob.engine,
                instanceId: props.threadModel.instanceId,
                model: props.threadModel.model,
              }
            : entry.blob.engine
        }
        onChange={(engine) => {
          void api.update(props.blobId, { engine }).then((r) => {
            if (!r.ok) toastManager.add({ type: "error", title: r.message });
          });
        }}
      />
      <Tooltip>
        {tooltipTriggerPart}
        {tooltipPopupPart}
      </Tooltip>
    </div>
  );
}

/** Which Claude account this blob / thread runs on, when it is not the default login ("Work"). Nothing otherwise. */
function AccountChip(props: { readonly instanceId: string }) {
  const account = claudeAccountOf(props.instanceId);
  if (!account) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-account-chip
            className="max-w-24 shrink-0 truncate rounded-full bg-foreground/[0.07] px-2 py-0.5 text-[11.5px] font-medium text-muted-foreground max-sm:hidden @max-[38rem]/chat-header:hidden"
          />
        }
      >
        {account}
      </TooltipTrigger>
      <TooltipPopup side="bottom">Running on your {account} Claude account</TooltipPopup>
    </Tooltip>
  );
}
