import type { BrowserHistoryEntry } from "~/stores/webHistoryStore";
import { WebRecentUrlCard } from "./WebRecentUrlCard";
import type { HostThreadRef } from "@kora/contracts";

interface Props {
  threadRef: HostThreadRef;
  onOpenUrl: (url: string) => void;
  onRemoveRecent: (url: string) => void;
  recentEntries: ReadonlyArray<BrowserHistoryEntry>;
}

/** The dev-server ports people reach for first; one click opens them, no typing. */
const COMMON_LOCAL_PORTS = [3000, 5173, 8080, 4321] as const;

export function WebEmptyState({ threadRef, recentEntries, onRemoveRecent, onOpenUrl }: Props) {
  const recents = recentEntries.filter((entry) => URL.canParse(entry.url)).slice(0, 8);

  return (
    <div className="flex h-full min-h-0 overflow-y-auto px-5 py-8" data-web-empty-state>
      <div className="mx-auto flex w-full max-w-xl flex-col gap-7">
        <section className="flex flex-col gap-2.5">
          <div>
            <h2 className="text-sm font-medium text-foreground">Nothing loaded</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Paste a link above, or jump straight to a local dev server. Pages stay beside the
              thread while you work.
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {COMMON_LOCAL_PORTS.map((port) => (
              <button
                key={port}
                type="button"
                onClick={() => onOpenUrl(`http://localhost:${port}`)}
                className="cursor-pointer rounded-md border border-dashed border-border px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:border-solid hover:border-foreground/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                localhost:{port}
              </button>
            ))}
          </div>
        </section>
        {recents.length > 0 ? (
          <section className="flex flex-col gap-2.5">
            <h2 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Pick up where you left off
            </h2>
            <div className="grid grid-cols-1 gap-2 @[28rem]/dock:grid-cols-2">
              {recents.map((entry) => (
                <WebRecentUrlCard
                  onRemove={() => onRemoveRecent(entry.url)}
                  onOpen={() => onOpenUrl(entry.url)}
                  threadRef={threadRef}
                  key={entry.url}
                  entry={entry}
                />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
