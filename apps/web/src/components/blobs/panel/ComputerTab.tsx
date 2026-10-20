// The Computer tab: the blob's own browser, live (watch, take over, approve), with the Local VM option parked under it
// and the browser's settings. The browser panel owns the one-time setup screen (98 MB, real progress).
import { ChevronDownIcon, ServerIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/util/utils";
import { BrowserPanel } from "../browser";
import { BrowserSettings } from "../browser/BrowserSettings";
import { useBlobRoster } from "../shell/useBlobRoster";

export function ComputerTab(props: { readonly blobId: string; readonly blobName: string }) {
  const { entries } = useBlobRoster();
  const profile = entries.get(props.blobId)?.blob ?? null;
  const [open, setOpen] = useState(false);
  return (
    <div className="flex h-full flex-col overflow-y-auto" data-computer-tab>
      <div className="shrink-0">
        <BrowserPanel blobId={props.blobId} blobName={props.blobName} />
      </div>
      <div className="mt-auto space-y-2 px-3 pb-3">
        <div
          className="flex items-center gap-2.5 rounded-xl bg-card px-3 py-2.5 ring-1 ring-border/70 opacity-80"
          data-local-vm
          aria-disabled="true"
        >
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent/60 text-muted-foreground">
            <ServerIcon className="size-3.5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium text-foreground">Local VM</div>
            <div className="text-[11.5px] leading-snug text-muted-foreground">
              A sandboxed computer for running code and tools.
            </div>
          </div>
          <span className="rounded-full bg-accent px-1.5 py-px text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            Coming soon
          </span>
        </div>
        {profile ? (
          <div>
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              data-browser-settings-toggle
              className="flex h-7 w-full items-center justify-between rounded-md px-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Browser settings
              <ChevronDownIcon
                className={cn("size-3.5 transition-transform", open && "rotate-180")}
                aria-hidden
              />
            </button>
            {open ? <BrowserSettings profile={profile} /> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
