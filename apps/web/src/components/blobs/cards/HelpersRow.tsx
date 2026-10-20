// "Popo used 2 helpers": the one quiet line that stands in for a blob's helper activity (the worker rows, the hand-off
// prompts and the "Worker updates" notes stay out of the conversation). Click for what each helper was asked.
import { ChevronRightIcon, UsersIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/util/utils";
import type { BlobCardRef } from "../../../thread/timeline";
import { useBlobSkin } from "../chat/blobSkin";

export interface HelpersView {
  readonly count: number;
  readonly working: number;
  readonly titles: ReadonlyArray<string>;
}

export function parseHelpers(card: BlobCardRef): HelpersView | null {
  const p = card.payload;
  if (p.cardKind !== "helpers") return null;
  const count = typeof p.count === "number" && p.count > 0 ? Math.floor(p.count) : 1;
  const working =
    typeof p.working === "number" && p.working > 0 ? Math.min(count, Math.floor(p.working)) : 0;
  const titles = Array.isArray(p.titles)
    ? p.titles.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    : [];
  return { count, working, titles };
}

export function helpersLine(who: string, v: HelpersView): string {
  const n = v.count === 1 ? "a helper" : `${v.count} helpers`;
  return v.working > 0 ? `${who} is using ${n}` : `${who} used ${n}`;
}

export function HelpersRow(props: { readonly card: BlobCardRef }) {
  const view = parseHelpers(props.card);
  const who = useBlobSkin()?.name ?? "This blob";
  const [open, setOpen] = useState(false);
  if (!view) return null;
  const canOpen = view.titles.length > 0;
  return (
    <div
      data-blob-card="helpers"
      data-helpers-working={view.working}
      className="flex max-w-[38rem] flex-col gap-0.5 text-[12px] leading-5 text-muted-foreground"
    >
      <button
        type="button"
        disabled={!canOpen}
        aria-expanded={canOpen ? open : undefined}
        onClick={() => setOpen((v) => !v)}
        className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left enabled:hover:text-foreground disabled:cursor-default"
      >
        <UsersIcon
          className={cn("size-3 shrink-0", view.working > 0 && "animate-pulse")}
          aria-hidden
        />
        <span className="min-w-0 truncate" data-helpers-line>
          {helpersLine(who, view)}
        </span>
        {canOpen ? (
          <ChevronRightIcon
            className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
            aria-hidden
          />
        ) : null}
      </button>
      {open ? (
        <ul className="ml-6 list-disc pl-3 text-[11.5px] leading-4 marker:text-muted-foreground/60">
          {view.titles.map((t) => (
            <li key={t} className="truncate">
              {t}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
