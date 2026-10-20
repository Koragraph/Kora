// Pure model for the starter gallery: a template's display fields and the multi-select rules. No React.
import type { BlobTemplate } from "@kora/contracts";

import { STARTER_OUTFITS, type BlobOutfit, type StarterBlobId } from "~/components/blobs/avatar";
import { toAvatarOutfit } from "../outfit";

export interface TemplateView {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  /** The one-line job. */
  readonly job: string;
  readonly exampleAsks: ReadonlyArray<string>;
  /** "Gmail", "a folder", "routine (paused)": shown as chips under "Works best with". */
  readonly wants: ReadonlyArray<string>;
  /** Toolkit slugs the template works with ("gmail"): their "works best with" chips are Connect chips. */
  readonly apps: ReadonlyArray<string>;
  readonly outfit: BlobOutfit;
  /** The routines it comes with (always paused until you turn them on). */
  readonly routines: ReadonlyArray<{ readonly title: string; readonly cadence: string }>;
}

export function toTemplateView(template: BlobTemplate): TemplateView {
  const { draft } = template;
  const starter = (STARTER_OUTFITS as Record<string, BlobOutfit | undefined>)[template.id];
  const outfit =
    draft.outfit !== null
      ? toAvatarOutfit(draft.outfit, template.id)
      : (starter ?? toAvatarOutfit(null, template.id));
  return {
    id: template.id,
    name: draft.name,
    title: draft.title,
    job: draft.job.trim() || template.blurb,
    exampleAsks: template.exampleAsks.slice(0, 3),
    wants: template.wants.filter((w) => w.trim().length > 0),
    apps: draft.apps.filter((a) => a.trim().length > 0),
    outfit,
    routines: draft.routines.map((r) => ({ title: r.title, cadence: r.cadence })),
  };
}

/** Toggle one template in the selection; hired templates can never be selected. */
export function toggleSelected(
  selected: ReadonlySet<string>,
  id: string,
  hired: ReadonlySet<string>,
): Set<string> {
  const next = new Set(selected);
  if (hired.has(id)) {
    next.delete(id);
    return next;
  }
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Drop selections that became hired (e.g. a roster refresh) or no longer exist. */
export function pruneSelection(
  selected: ReadonlySet<string>,
  known: ReadonlyArray<string>,
  hired: ReadonlySet<string>,
): Set<string> {
  const ok = new Set(known);
  return new Set([...selected].filter((id) => ok.has(id) && !hired.has(id)));
}

export function hireLabel(count: number): string {
  return count === 1 ? "Hire 1 blob" : `Hire ${count} blobs`;
}

/** Selected ids in gallery order (the order the blobs fly in). */
export function orderedSelection(
  selected: ReadonlySet<string>,
  order: ReadonlyArray<string>,
): string[] {
  return order.filter((id) => selected.has(id));
}

/** Kora's one-liner after a hire. */
export function koraHireLine(names: ReadonlyArray<string>): string | null {
  if (names.length === 0) return null;
  if (names.length === 1)
    return `${names[0]}'s on the team. Want me to give ${names[0]} a first task?`;
  const head = names.slice(0, -1).join(", ");
  return `${head} and ${names[names.length - 1]} are on the team. Want me to give any of them a first task?`;
}
