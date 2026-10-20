// One starter blob in the gallery: the blob in its outfit (idle animation, nods when you hover), name · role, a
// one-line job, three example asks and what it works best with. Select it (multi-select) or Hire it right away.
import { Hint } from "~/components/ui/hint";
import { CalendarClockIcon, CheckIcon, PlugIcon } from "lucide-react";
import { useState } from "react";

import { BlobAvatar } from "~/components/blobs/avatar";
import { cn } from "~/util/utils";
import { Button } from "../../ui/button";
import { Spinner } from "../../ui/spinner";
import { ConnectChip } from "../apps/ConnectChip";
import { appLabel } from "../apps/appsModel";
import type { TemplateView } from "./galleryModel";
import "./gallery.css";

export interface TemplateCardProps {
  readonly view: TemplateView;
  readonly index: number;
  readonly selected: boolean;
  readonly hired: boolean;
  readonly pending: boolean;
  readonly onToggle: (id: string) => void;
  readonly onHire: (id: string) => void;
  /** The card element, for the fly-in's take-off rectangle. */
  readonly registerElement?: (id: string, element: HTMLElement | null) => void;
}

export function TemplateCard(props: TemplateCardProps) {
  const { view, selected, hired, pending } = props;
  const [nod, setNod] = useState(0);
  const locked = hired || pending;
  // The "Works best with Gmail and Calendar" sentence becomes real Connect chips; other notes ("a morning routine") stay as text.
  const appNames = view.apps.map((a) => appLabel(a).toLowerCase());
  // The routine has its own line below (from the template's real routines), so a "comes with a routine" want would say it twice.
  const otherWants = view.wants
    .filter((w) => !appNames.some((n) => w.toLowerCase().includes(n)) && !/routine/i.test(w))
    .map((w) => w.replace(/^works best with\s+/i, ""));
  const routine = view.routines[0] ?? null;

  return (
    <article
      ref={(el) => props.registerElement?.(view.id, el)}
      data-template-card={view.id}
      data-selected={selected ? "true" : "false"}
      data-hired={hired ? "true" : "false"}
      aria-label={`${view.name}, ${view.title}${hired ? ", on the team" : ""}`}
      style={{ "--i": props.index } as React.CSSProperties}
      onPointerEnter={() => setNod((n) => n + 1)}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("button")) return;
        if (!locked) props.onToggle(view.id);
      }}
      className={cn(
        "p2-rise group/tpl relative flex min-w-0 flex-col gap-3 rounded-2xl border bg-card p-4 transition-[border-color,background-color,transform] duration-200",
        locked
          ? "cursor-default"
          : "cursor-pointer hover:-translate-y-px hover:border-foreground/25",
        selected ? "border-foreground/60 bg-card" : "border-border/60",
        hired && "p2-gone border-border/40",
      )}
    >
      {hired ? null : (
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          aria-label={`Select ${view.name}`}
          disabled={pending}
          data-template-select={view.id}
          onClick={() => props.onToggle(view.id)}
          className={cn(
            "absolute top-3 right-3 grid size-6 place-items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            selected
              ? "border-foreground bg-foreground text-background"
              : "border-border bg-transparent text-transparent hover:border-foreground/50",
          )}
        >
          <CheckIcon className="size-3.5" strokeWidth={3} aria-hidden />
        </button>
      )}

      <div className="flex items-start gap-3 pr-8">
        <div className="grid size-16 shrink-0 place-items-center" data-template-avatar>
          <BlobAvatar
            outfit={view.outfit}
            state="idle"
            size={56}
            eyesFollowCursor={false}
            seed={view.id}
            reaction={nod > 0 && !hired ? "nod" : null}
            reactionKey={nod}
          />
        </div>
        <div className="min-w-0">
          <h3 className="truncate text-[15px] font-semibold leading-5 tracking-[-0.01em] text-foreground">
            {view.name}
            <span className="font-normal text-muted-foreground"> · {view.title}</span>
          </h3>
          {/* three lines are reserved, so every card's example asks start at the same height */}
          <p
            className="mt-0.5 line-clamp-3 min-h-[3.375rem] text-[13px] leading-[18px] text-muted-foreground"
            data-template-job
          >
            {view.job}
          </p>
        </div>
      </div>

      {view.exampleAsks.length > 0 ? (
        <ul className="space-y-1" aria-label={`Things to ask ${view.name}`}>
          {view.exampleAsks.map((ask) => (
            <Hint label={ask}>
              <li
                key={ask}
                className="line-clamp-2 rounded-lg bg-foreground/[0.045] px-2.5 py-1 text-[12px] leading-[18px] text-foreground/75"
              >
                “{ask}”
              </li>
            </Hint>
          ))}
        </ul>
      ) : null}

      <div
        className="mt-auto flex min-h-6 flex-wrap content-start items-center gap-1.5"
        data-template-wants
      >
        {view.apps.length > 0 || otherWants.length > 0 ? (
          <>
            <span className="text-[11px] text-muted-foreground/80">Works best with</span>
            {view.apps.map((app) => (
              <ConnectChip key={app} app={app} label={appLabel(app)} />
            ))}
            {otherWants.map((want) => (
              <span
                key={want}
                className="inline-flex items-center gap-1 rounded-full border border-border/70 px-2 py-px text-[11px] leading-4 text-foreground/80"
              >
                <PlugIcon className="size-3 text-muted-foreground" aria-hidden />
                {want}
              </span>
            ))}
          </>
        ) : (
          <span className="text-[11px] text-muted-foreground/70">Needs nothing to get started</span>
        )}
      </div>

      {routine ? (
        <p
          className="flex min-w-0 items-start gap-1.5 text-[11.5px] leading-4 text-muted-foreground"
          data-template-routine
        >
          <CalendarClockIcon className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span className="line-clamp-2">Suggested routine · {routine.cadence} (paused)</span>
        </p>
      ) : null}

      {hired ? (
        <div
          className="flex h-8 items-center justify-center gap-1.5 rounded-full border border-border/50 text-[13px] font-medium text-muted-foreground"
          data-template-state="hired"
        >
          <CheckIcon className="size-3.5" aria-hidden />
          On the team
        </div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          data-template-hire={view.id}
          aria-label={`Hire ${view.name}`}
          onClick={() => props.onHire(view.id)}
        >
          {pending ? <Spinner className="size-3.5" /> : null}
          {pending ? "Hiring" : "Hire"}
        </Button>
      )}
    </article>
  );
}
