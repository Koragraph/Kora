// The starter gallery: ten blobs to hire, in the chat canvas (not a modal). Select several and hire them together
// from the sticky bar, or hire one from its card. Each hired blob then flies from its card to its roster row.
import type { BlobProfile, BlobTemplate } from "@kora/contracts";
import { ArrowLeftIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../../ui/button";
import { Spinner } from "../../ui/spinner";
import { landAndWave } from "./HireFlyIn";
import { flyToRoster, rectOf } from "./flyToRoster";
import {
  hireLabel,
  orderedSelection,
  pruneSelection,
  toTemplateView,
  toggleSelected,
} from "./galleryModel";
import { TemplateCard } from "./TemplateCard";
import "./gallery.css";

export type HireResult =
  | { readonly ok: true; readonly profiles: ReadonlyArray<BlobProfile> }
  | { readonly ok: false; readonly message: string };

export interface StarterGalleryProps {
  readonly templates: ReadonlyArray<BlobTemplate>;
  /** Template ids already on the team (a blob hired from them exists). */
  readonly hiredTemplateIds: ReadonlySet<string>;
  readonly loading?: boolean;
  /** Hires the templates (in order) and resolves the new profiles. */
  readonly onHire: (templateIds: ReadonlyArray<string>) => Promise<HireResult>;
  /** After a hire, once the profiles exist (before their fly-in ends). */
  readonly onHired?: (profiles: ReadonlyArray<BlobProfile>) => void;
  /** "Back" in the header; omitted => no back button. */
  readonly onBack?: () => void;
  readonly onClose?: () => void;
  /** Skip the flight (tests, screenshots of the settled state). */
  readonly flyIn?: boolean;
}

export function StarterGallery(props: StarterGalleryProps) {
  const { templates, hiredTemplateIds } = props;
  const views = useMemo(() => templates.map(toTemplateView), [templates]);
  const order = useMemo(() => views.map((v) => v.id), [views]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [justHired, setJustHired] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const elements = useRef(new Map<string, HTMLElement>());

  const hired = useMemo(
    () => new Set([...hiredTemplateIds, ...justHired]),
    [hiredTemplateIds, justHired],
  );

  useEffect(() => {
    setSelected((current) => pruneSelection(current, order, hired));
  }, [order, hired]);

  const register = useCallback((id: string, element: HTMLElement | null) => {
    if (element) elements.current.set(id, element);
    else elements.current.delete(id);
  }, []);

  const toggle = useCallback(
    (id: string) => setSelected((current) => toggleSelected(current, id, hired)),
    [hired],
  );

  const hire = useCallback(
    async (ids: ReadonlyArray<string>) => {
      if (ids.length === 0) return;
      setError(null);
      setPending((current) => new Set([...current, ...ids]));
      // Take-off rectangles are read before the cards re-render as "On the team".
      const starts = new Map(
        ids.map((id) => [
          id,
          rectOf(elements.current.get(id)?.querySelector("[data-template-avatar]")),
        ]),
      );
      const result = await props.onHire(ids);
      setPending((current) => new Set([...current].filter((id) => !ids.includes(id))));
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setJustHired((current) => new Set([...current, ...ids]));
      setSelected((current) => new Set([...current].filter((id) => !ids.includes(id))));
      props.onHired?.(result.profiles);
      if (props.flyIn === false) return;
      result.profiles.forEach((profile, index) => {
        const templateId =
          (profile.templateId !== null && ids.includes(profile.templateId)
            ? profile.templateId
            : ids[index]) ?? null;
        const from = templateId ? starts.get(templateId) : null;
        if (!from) return;
        const view = views.find((v) => v.id === templateId);
        void flyToRoster(from, profile.id, {
          name: profile.name,
          delayMs: index * 130,
          onLand: landAndWave,
          ...(view ? { outfit: view.outfit } : {}),
        });
      });
    },
    [props, views],
  );

  const chosen = orderedSelection(selected, order);
  const anyPending = pending.size > 0;

  return (
    <section
      className="relative flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain"
      data-starter-gallery
      aria-label="The roster"
    >
      <div className="mx-auto w-full max-w-[64rem] px-5 pt-6 pb-28 sm:px-8">
        <header className="p2-fade mb-5 flex items-start gap-3">
          {props.onBack ? (
            <Button
              size="icon-sm"
              variant="ghost-muted"
              aria-label="Back"
              onClick={props.onBack}
              data-gallery-back
            >
              <ArrowLeftIcon />
            </Button>
          ) : null}
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold tracking-[-0.015em] text-foreground">
              The roster
            </h2>
            <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">
              Pick a few to hire. You can message any of them directly; bring me the bigger jobs.
            </p>
          </div>
          {props.onClose ? (
            <Button size="sm" variant="ghost-muted" onClick={props.onClose} data-gallery-close>
              Maybe later
            </Button>
          ) : null}
        </header>

        {props.loading && views.length === 0 ? (
          <div className="grid place-items-center py-24" aria-busy>
            <Spinner className="size-5 text-muted-foreground" />
          </div>
        ) : views.length === 0 ? (
          <p className="py-20 text-center text-sm text-muted-foreground" data-gallery-empty>
            The roster isn’t available right now. Tell me what you need and I’ll build a blob for
            it.
          </p>
        ) : (
          <div
            className="grid auto-rows-fr grid-cols-[repeat(auto-fill,minmax(min(17.5rem,100%),1fr))] gap-3.5"
            data-gallery-grid
          >
            {views.map((view, index) => (
              <TemplateCard
                key={view.id}
                view={view}
                index={index}
                selected={selected.has(view.id)}
                hired={hired.has(view.id)}
                pending={pending.has(view.id)}
                onToggle={toggle}
                onHire={(id) => void hire([id])}
                registerElement={register}
              />
            ))}
          </div>
        )}
      </div>

      {chosen.length > 0 || error ? (
        <div className="pointer-events-none sticky bottom-0 z-10 mt-auto flex justify-center px-4 pb-5">
          <div
            className="p2-bar-in pointer-events-auto flex max-w-full items-center gap-2 rounded-full border border-border/70 bg-popover py-1.5 pr-1.5 pl-4 shadow-xl"
            data-hire-bar
            role="region"
            aria-label="Hire selected blobs"
          >
            <span className="min-w-0 truncate text-[13px] text-muted-foreground" aria-live="polite">
              {error ? (
                <span role="alert" className="text-foreground/90">
                  {error}
                </span>
              ) : (
                `${chosen.length} selected`
              )}
            </span>
            {chosen.length > 0 ? (
              <>
                <Button
                  size="sm"
                  variant="ghost-muted"
                  aria-label="Clear selection"
                  onClick={() => setSelected(new Set())}
                  disabled={anyPending}
                >
                  <XIcon />
                  Clear
                </Button>
                <Button
                  size="sm"
                  disabled={anyPending}
                  onClick={() => void hire(chosen)}
                  data-hire-selected
                >
                  {anyPending ? <Spinner className="size-3.5" /> : null}
                  {hireLabel(chosen.length)}
                </Button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
