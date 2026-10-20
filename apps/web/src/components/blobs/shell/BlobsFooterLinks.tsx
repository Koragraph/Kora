// The blobs sidebar's footer, left of the settings gear: Apps (connect Gmail, Calendar, Slack...) and Routines (the
// selected blob's Runs tab: what it does on its own).
import { useLocation, useParams, useRouter } from "@tanstack/react-router";
import { CalendarClockIcon, PlugIcon } from "lucide-react";

import { useThreadSummaries } from "~/atoms/entities";
import { cn } from "~/util/utils";
import { useBlobPanel } from "../chat/blobPanelStore";
import { useBlobRoster } from "./useBlobRoster";

const LINK =
  "inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring";

export function BlobsFooterLinks() {
  const router = useRouter();
  const pathname = useLocation({ select: (l) => l.pathname });
  const panel = useBlobPanel();
  const { roster, entries } = useBlobRoster();
  const threads = useThreadSummaries();
  const threadId = useParams({ strict: false, select: (p) => p.threadId as string | undefined });
  const routeBlobId = useParams({ strict: false, select: (p) => p.blobId as string | undefined });

  const currentBlobId = (() => {
    if (threadId) {
      const t = threads.find((x) => x.id === threadId);
      if (t && entries.has(t.projectId)) return t.projectId;
    }
    return routeBlobId && entries.has(routeBlobId) ? routeBlobId : null;
  })();
  const onApps = pathname === "/apps";

  const openRoutines = () => {
    const target = currentBlobId ?? roster.chief?.id ?? roster.team[0]?.id ?? null;
    if (!target) return;
    panel.show("runs");
    // already inside one of its threads: the panel is enough; otherwise land on the blob (its latest thread)
    if (currentBlobId !== target || pathname === "/apps")
      void router.navigate({ to: "/blobs/$blobId", params: { blobId: target } });
  };

  return (
    <div className="flex shrink-0 items-center gap-0.5" data-blobs-footer>
      <button
        type="button"
        data-footer-apps
        aria-current={onApps ? "page" : undefined}
        onClick={() => void router.navigate({ to: "/apps" })}
        className={cn(LINK, onApps && "bg-sidebar-row-active text-sidebar-foreground")}
      >
        <PlugIcon className="size-3.5" aria-hidden />
        Apps
      </button>
      <button type="button" data-footer-routines onClick={openRoutines} className={LINK}>
        <CalendarClockIcon className="size-3.5" aria-hidden />
        Routines
      </button>
    </div>
  );
}
