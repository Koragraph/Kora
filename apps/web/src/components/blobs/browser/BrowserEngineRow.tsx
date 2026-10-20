// The blob browser's one-time setup as a compact row, for places other than the Computer tab (a blob's browser settings,
// Settings › Blobs): status ("Ready" / "Not set up"), the size, a Set up button and real progress. Same plain-HTTP engine
// state as the Computer tab (`useBrowserEngine`), so it never depends on the live socket.

import { Button } from "~/components/ui/button";
import { useBrowserEngine } from "./useBrowserEngine";
import { downloadSizeLabel, installLabel } from "./browserModel";
import { DownloadIcon } from "lucide-react";

export function BrowserEngineRow() {
  const { snapshot, error, start } = useBrowserEngine();
  if (!snapshot) {
    return error ? (
      <p className="text-[11.5px] text-muted-foreground" data-browser-engine-row="unknown">
        Couldn&apos;t check the blob browser. Update Kora if this stays.
      </p>
    ) : null;
  }
  const { install } = snapshot;
  const running = install.state === "running";
  const pct = Math.round(Math.min(1, Math.max(0, install.fraction)) * 100);
  const size = downloadSizeLabel(snapshot);
  return (
    <div
      className="flex items-start gap-3"
      data-browser-engine-row={snapshot.installed ? "ready" : running ? "running" : "missing"}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium text-foreground">
          {snapshot.installed
            ? "Browser ready"
            : running
              ? "Setting up the browser"
              : "Browser not set up"}
        </div>
        <p className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">
          {!snapshot.supported
            ? "A blob's browser isn't available on this Mac yet."
            : snapshot.installed
              ? "Each blob has its own private browser on this Mac. Sites it signs in to stay signed in (kept as cookies in that blob's browser) until you clear its browser data. Watch it from the blob's Computer tab."
              : running
                ? installLabel(install)
                : install.state === "error"
                  ? `Setup didn't finish. ${installLabel(install)}`
                  : `Blobs need a one-time download (${size}) before they can browse the web.`}
        </p>
        {running ? (
          <div
            className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-card ring-1 ring-border/70"
            aria-label="Setting up the blob browser"
            aria-valuenow={pct}
            aria-valuemax={100}
            role="progressbar"
            aria-valuemin={0}
          >
            <div
              className="h-full rounded-full bg-foreground transition-[width] duration-200"
              style={{ width: `${install.total > 0 ? pct : 25}%` }}
            />
          </div>
        ) : null}
      </div>
      {!snapshot.installed && snapshot.supported && !running ? (
        <Button size="xs" variant="outline" onClick={start} data-browser-engine-install>
          <DownloadIcon className="size-3" />
          {install.state === "error" ? "Try again" : "Set up"}
        </Button>
      ) : null}
    </div>
  );
}
