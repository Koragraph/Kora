// The flat menu rows under the sidebar header (concept 1, docs/ui/SIDEBAR-BRIEF.md): New thread, Search, Needs you.
// Plain rows, no fills at rest, hairline only on the focused search field. The ⌘ hints are real: ThreadNav binds ⌘N
// and ⌘K (useSidebarShortcuts), and Ctrl on other platforms.
import { useState, type RefObject } from "react";
import { FlagIcon, SearchIcon, SquarePenIcon, XIcon } from "lucide-react";

import { cn, isMacPlatform } from "../../util/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { needsYouLabel, type NeedsYouEntry, type NeedsYouThread } from "./needsYou";

const ROW =
  "flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[13px] text-sidebar-foreground/90 outline-none transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-sidebar-ring";
const HINT = "ml-auto shrink-0 font-mono text-[11px] text-sidebar-muted-foreground/70";
const ICON = "size-4 shrink-0 text-sidebar-muted-foreground";
const AMBER = "text-amber-500 dark:text-amber-300/90";

/** "⌘N" on a Mac, "Ctrl+N" elsewhere. */
export function shortcutHint(key: string): string {
  const mac = typeof navigator !== "undefined" && isMacPlatform(navigator.platform);
  return mac ? `⌘${key}` : `Ctrl+${key}`;
}

export function NewThreadRow(props: { readonly onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-keyshortcuts="Meta+N Control+N"
      className={cn(ROW, "font-medium")}
    >
      <SquarePenIcon className={ICON} aria-hidden />
      <span className="min-w-0 flex-1 truncate">New chat</span>
      <span className={HINT} aria-hidden>
        {shortcutHint("N")}
      </span>
    </button>
  );
}

/** The Search row IS the field: it reads as a row until focused, then gets a hairline. Filters the thread list. */
export function SearchRow(props: {
  readonly query: string;
  readonly onQueryChange: (next: string) => void;
  readonly onOpenFirst: () => void;
  readonly inputRef: RefObject<HTMLInputElement | null>;
}) {
  const { query, onQueryChange, inputRef } = props;
  return (
    <div
      className={cn(
        ROW,
        "relative gap-2.5 border border-transparent focus-within:border-white/7 focus-within:bg-sidebar-row-hover",
        query && "border-white/7",
      )}
    >
      <SearchIcon className={ICON} aria-hidden />
      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onQueryChange("");
            e.currentTarget.blur();
          }
          if (e.key === "Enter") props.onOpenFirst();
        }}
        placeholder="Search"
        aria-label="Search chats"
        aria-keyshortcuts="Meta+K Control+K"
        spellCheck={false}
        className="peer min-w-0 flex-1 bg-transparent text-[13px] text-sidebar-foreground outline-none placeholder:text-sidebar-foreground/90 [&::-webkit-search-cancel-button]:hidden"
      />
      {query ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            onQueryChange("");
            inputRef.current?.focus();
          }}
          className="grid size-5 shrink-0 place-items-center rounded text-sidebar-muted-foreground hover:text-sidebar-foreground"
        >
          <XIcon className="size-3" />
        </button>
      ) : (
        <span className={cn(HINT, "pointer-events-none")} aria-hidden>
          {shortcutHint("K")}
        </span>
      )}
    </div>
  );
}

/**
 * Threads blocked on you (approvals, questions), with an amber count. One goes straight to it; several open a small
 * list. Hidden at zero.
 */
export function NeedsYouRow<T extends NeedsYouThread>(props: {
  readonly entries: ReadonlyArray<NeedsYouEntry<T>>;
  readonly projectTitle: (thread: T) => string | null;
  readonly onOpen: (thread: T) => void;
}) {
  const { entries } = props;
  const [open, setOpen] = useState(false);
  if (entries.length === 0) return null;
  const label = needsYouLabel(entries.length);
  const body = (
    <>
      <FlagIcon className={cn(ICON, AMBER)} aria-hidden />
      <span className="min-w-0 flex-1 truncate">Needs you</span>
      <span
        className={cn("ml-auto shrink-0 font-mono text-[11px] tabular-nums", AMBER)}
        data-needs-you-count=""
      >
        {entries.length}
      </span>
    </>
  );
  if (entries.length === 1) {
    return (
      <button
        type="button"
        aria-label={`${label}. Open it`}
        onClick={() => props.onOpen(entries[0]!.thread)}
        className={ROW}
        data-needs-you=""
      >
        {body}
      </button>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<button type="button" aria-label={`${label}. Show the list`} className={ROW} />}
        data-needs-you=""
      >
        {body}
      </PopoverTrigger>
      <PopoverPopup align="start" side="right" tooltipStyle className="w-72">
        <ul className="flex flex-col py-0.5" aria-label={label}>
          {entries.map(({ thread, reason }) => {
            const project = props.projectTitle(thread);
            return (
              <li key={`${thread.hostId}:${thread.id}`}>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    props.onOpen(thread);
                  }}
                  className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="line-clamp-2 text-[12.5px] text-foreground">{thread.title}</span>
                  <span className="text-[11px] text-muted-foreground">
                    <span className={AMBER}>
                      {reason === "approval" ? "Needs your approval" : "Waiting for your answer"}
                    </span>
                    {project ? ` · ${project}` : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverPopup>
    </Popover>
  );
}
