// One roster row. Members: 32 px blob + name + one status word. The Chief ("Kora"): a larger blob with its crown,
// a "Chief" badge, always on top. The row is a button (open the blob); a hover chevron expands its threads.
import { ChevronRightIcon } from "lucide-react";
import type { KeyboardEvent, MouseEvent } from "react";

import { BlobAvatar } from "~/components/blobs/avatar";
import { cn } from "~/util/utils";
import { rollupThreadDots } from "../../ThreadNav.logic";
import { useBlobCreatedWave } from "./blobReaction";
import { withoutRecoveredFailures } from "./blobStatus";
import type { RosterEntry } from "./useBlobRoster";

const ATTENTION_TONES = new Set(["approval", "input", "plan", "failed", "offline", "unread"]);

export function BlobRosterRow(props: {
  readonly entry: RosterEntry;
  readonly active: boolean;
  readonly expanded: boolean;
  readonly onOpen: () => void;
  readonly onToggle: () => void;
  readonly onContextMenu: (event: MouseEvent) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}) {
  const { entry, active, expanded } = props;
  const { blob, chief, status } = entry;
  // The same recovery rule as the status word: an old failed thread is not an alarm once a newer one ran fine (it used to
  // keep the dot red beside "working" - and beside a job step that was busy asking for an answer).
  const top = rollupThreadDots(withoutRecoveredFailures(entry.threads.map((t) => t.dot)));
  const attention = top !== null && ATTENTION_TONES.has(top.tone) ? top : null;
  const waveKey = useBlobCreatedWave(blob.id);

  return (
    <div
      className={cn(
        "group/blob relative flex items-center rounded-xl transition-colors",
        chief ? "min-h-[60px]" : "min-h-[46px]",
        active
          ? "bg-sidebar-row-active text-sidebar-foreground lift-select"
          : "text-sidebar-foreground/90 hover:bg-sidebar-row-hover",
        chief && !active && "bg-sidebar-row-hover/50 ring-1 ring-sidebar-border/60",
        // Pitch: Kora's card is the one lifted card in the sidebar (selected or not).
        chief && "lift dark:ring-0 border border-transparent",
      )}
      onContextMenu={props.onContextMenu}
      data-blob-id={blob.id}
      data-blob-chief={chief ? "true" : "false"}
      data-blob-status={status.word}
    >
      <button
        type="button"
        data-blob-row
        aria-current={active ? "true" : undefined}
        aria-label={`${blob.name}${chief ? ", Chief" : ""}, ${status.word}`}
        onClick={props.onOpen}
        onKeyDown={props.onKeyDown}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2.5 rounded-xl py-1.5 pr-8 pl-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          chief ? "gap-3 pl-2.5" : "",
        )}
      >
        <span
          className={cn(
            "relative grid shrink-0 place-items-center",
            chief ? "size-[52px]" : "size-9",
          )}
        >
          <BlobAvatar
            outfit={entry.outfit}
            state={status.visual}
            size={chief ? 40 : 32}
            chief={chief}
            eyesFollowCursor={false}
            {...(waveKey !== null ? { reaction: "wave" as const, reactionKey: waveKey } : {})}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className={cn(
                "truncate font-medium",
                chief ? "text-[14.5px] tracking-[-0.01em]" : "text-[13.5px]",
              )}
            >
              {blob.name}
            </span>
            {chief ? (
              <span className="shrink-0 rounded-full bg-sidebar-foreground/90 px-1.5 py-px text-[9.5px] font-semibold tracking-wide text-sidebar uppercase">
                Chief
              </span>
            ) : null}
          </span>
          <span className="mt-px flex min-w-0 items-center gap-1.5 text-[11.5px] text-sidebar-muted-foreground">
            {/* the title sits under the name; the status word replaces it only while there is something to say */}
            {status.word !== "idle" ? (
              <span
                className={cn(
                  "truncate transition-colors",
                  status.word === "needs you" || status.word === "asking"
                    ? "text-sidebar-foreground/90"
                    : "",
                  status.word === "error" && "text-destructive",
                )}
              >
                {status.word}
              </span>
            ) : null}
            {blob.title.trim().length > 0 ? (
              <>
                {status.word !== "idle" ? <span aria-hidden>·</span> : null}
                <span className="truncate" data-blob-title>
                  {blob.title}
                </span>
              </>
            ) : null}
          </span>
        </span>
        {attention ? (
          <span
            aria-hidden
            data-blob-dot={attention.tone}
            className={cn(
              "size-2 shrink-0 rounded-full transition-opacity group-hover/blob:opacity-0",
              attention.dotClass,
            )}
          />
        ) : null}
      </button>
      <button
        type="button"
        aria-label={expanded ? `Hide ${blob.name}'s threads` : `Show ${blob.name}'s threads`}
        aria-expanded={expanded}
        onClick={(event) => {
          event.stopPropagation();
          props.onToggle();
        }}
        className={cn(
          "absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 place-items-center rounded-md text-sidebar-muted-foreground transition-[opacity,color,background-color] hover:bg-sidebar-row-active hover:text-sidebar-foreground focus-visible:opacity-100",
          expanded ? "opacity-100" : "opacity-0 group-hover/blob:opacity-100",
        )}
      >
        <ChevronRightIcon
          className={cn("size-3.5 transition-transform duration-200", expanded && "rotate-90")}
        />
      </button>
    </div>
  );
}
