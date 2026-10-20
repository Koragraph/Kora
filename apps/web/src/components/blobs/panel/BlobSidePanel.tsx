// The blob's right side panel: Profile · Memory · Files · Computer · Runs. Inline (resizable, animated) on a wide
// window, a sheet on a narrow one. Replaces the dock for blob threads while no file is open in it.
import type { HostThreadRef } from "@kora/contracts";
import { ChevronsRightIcon } from "lucide-react";
import { type ReactNode } from "react";

import { isNative } from "~/env";
import { cn } from "~/util/utils";
import { BLOB_CHAT_MIN_WIDTH } from "../../../dockLayout";
import { WebPanelShell, type WebPanelMode } from "../../web/WebPanelShell";
import { BLOB_PANEL_TABS, useBlobPanel, type BlobPanelTab } from "../chat/blobPanelStore";
import { useBlobRoster } from "../shell/useBlobRoster";
import { ComputerTab } from "./ComputerTab";
import { FilesTab } from "./FilesTab";
import { MemoryTab } from "./MemoryTab";
import { RoutinesPanel } from "../routines/RoutinesPanel";
import { useRoutineNav } from "../routines/useRoutineNav";
import { PanelEmpty } from "./PanelEmpty";
import { ProfileTab } from "./ProfileTab";

const TAB_LABEL: Record<BlobPanelTab, string> = {
  profile: "Profile",
  memory: "Memory",
  files: "Files",
  computer: "Computer",
  runs: "Runs",
};

export function BlobSidePanel(props: {
  readonly mode: WebPanelMode;
  readonly open: boolean;
  readonly blobId: string;
  readonly threadRef: HostThreadRef | null;
  readonly refreshKey: string | null;
  readonly widthStorageKey?: string;
}) {
  const panel = useBlobPanel();
  const { entries } = useBlobRoster();
  const entry = entries.get(props.blobId) ?? null;
  const routineNav = useRoutineNav();
  const ownsTitleBar = isNative && props.mode === "inline";

  const body: Record<BlobPanelTab, ReactNode> = {
    profile: entry ? <ProfileTab entry={entry} /> : null,
    memory: <MemoryTab blobId={props.blobId} />,
    files: entry ? (
      <FilesTab
        blobId={props.blobId}
        workspace={entry.blob.workspace}
        threadRef={props.threadRef}
        refreshKey={props.refreshKey}
      />
    ) : null,
    computer: <ComputerTab blobId={props.blobId} blobName={entry?.blob.name ?? "This blob"} />,
    runs: entry ? (
      <RoutinesPanel blobId={props.blobId} blobName={entry.blob.name} nav={routineNav} />
    ) : null,
  };

  return (
    <WebPanelShell
      mode={props.mode}
      open={props.open}
      defaultWidth={380}
      // A blob's panel docks from 1100 px up (below that it is a sheet over the chat); the chat column keeps at least BLOB_CHAT_MIN_WIDTH
      minWidth={300}
      siblingMinWidth={BLOB_CHAT_MIN_WIDTH}
      {...(props.widthStorageKey ? { widthStorageKey: props.widthStorageKey } : {})}
    >
      <div
        className={cn(
          "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1 border-b border-border pr-2 pl-2",
          ownsTitleBar && "drag-region",
        )}
        data-blob-panel-tabbar
      >
        <div
          role="tablist"
          aria-label="Blob panel"
          className="flex h-full min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [-webkit-app-region:no-drag] [scrollbar-width:none]"
        >
          {BLOB_PANEL_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={panel.tab === tab}
              data-blob-panel-tab={tab}
              onClick={() => panel.setTab(tab)}
              className={cn(
                "relative h-full shrink-0 px-2 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                panel.tab === tab
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {TAB_LABEL[tab]}
              <span
                aria-hidden
                className={cn(
                  "absolute inset-x-2 bottom-0 h-0.5 rounded-full transition-colors",
                  panel.tab === tab ? "bg-foreground" : "bg-transparent",
                )}
              />
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-label="Hide the blob panel"
          onClick={() => panel.setOpen(false)}
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground [-webkit-app-region:no-drag]"
        >
          <ChevronsRightIcon className="size-3.5" />
        </button>
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        role="tabpanel"
        data-blob-panel-body={panel.tab}
      >
        {props.open
          ? (body[panel.tab] ?? (
              <PanelEmpty icon={ChevronsRightIcon} title="Nothing here">
                This blob is no longer on your team.
              </PanelEmpty>
            ))
          : null}
      </div>
    </WebPanelShell>
  );
}
