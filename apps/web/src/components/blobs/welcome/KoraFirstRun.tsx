// Kora's first-run canvas: the welcome, which turns into the gallery on "Browse the roster". After a hire Kora says her
// one line ("Popo's on the team. Want me to give Popo a first task?") floating over the canvas (no layout shift). Hooks live in
// `KoraFirstRunHost`; this component takes everything as props.
import type { BlobProfile } from "@kora/contracts";
import { useState, type ReactNode } from "react";

import { koraHireLine } from "../gallery/galleryModel";
import { BlobAvatar, STARTER_OUTFITS } from "~/components/blobs/avatar";
import { Button } from "../../ui/button";
import { StarterGallery, type StarterGalleryProps } from "../gallery/StarterGallery";
import { useStarterGallery } from "../gallery/useStarterGallery";
import { SetupCheck } from "../../onboarding/SetupCheck";
import { KoraWelcome } from "./KoraWelcome";

export interface KoraFirstRunProps {
  readonly gallery: Pick<
    StarterGalleryProps,
    "templates" | "hiredTemplateIds" | "loading" | "onHire" | "flyIn"
  >;
  /** "Build me a blob": the host sends it to Kora as a message / focuses the composer. */
  readonly onBuild: () => void;
  /** "Give X a first task": the host opens that blob's thread. */
  readonly onFirstTask?: (blob: BlobProfile) => void;
  /** Maybe later / done: the host sets the `galleryDismissed` flag and shows the normal chat. */
  readonly onDismiss?: () => void;
  readonly initialView?: "welcome" | "gallery";
  /** Sign-in / setup card shown inside the welcome (the gate covers the transcript, so it cannot live beneath). */
  readonly setup?: ReactNode;
}

export function KoraFirstRun(props: KoraFirstRunProps) {
  const [view, setView] = useState<"welcome" | "gallery">(props.initialView ?? "welcome");
  const [hired, setHired] = useState<ReadonlyArray<BlobProfile>>([]);

  if (view === "welcome") {
    return (
      <KoraWelcome
        onBrowse={() => setView("gallery")}
        onBuild={props.onBuild}
        {...(props.setup ? { setup: props.setup } : {})}
      />
    );
  }
  const line = koraHireLine(hired.map((b) => b.name));
  return (
    <div className="relative flex h-full min-h-0 flex-col" data-kora-first-run>
      <div className="min-h-0 flex-1">
        <StarterGallery
          {...props.gallery}
          onHired={(profiles) => setHired(profiles)}
          onBack={() => setView("welcome")}
          {...(props.onDismiss ? { onClose: props.onDismiss } : {})}
        />
      </div>
      {/* Kora's line sits in its own strip BELOW the grid (never over a card, never above it: the cards do not move,
          the scroll area just gets a little shorter). */}
      {line ? (
        <div
          className="p2-rise mx-auto flex w-full max-w-[64rem] shrink-0 items-center gap-3 px-5 pt-2 pb-3 sm:px-8"
          data-kora-hire-line
          role="status"
        >
          <div className="flex min-w-0 max-w-full items-center gap-3 rounded-2xl border border-border/70 bg-popover py-2 pr-2.5 pl-2.5 shadow-xl">
            <BlobAvatar
              outfit={STARTER_OUTFITS.kora}
              state="talking"
              size={32}
              chief
              eyesFollowCursor={false}
            />
            <p className="min-w-0 flex-1 text-[13.5px] leading-5 text-foreground">{line}</p>
            {hired.length === 1 && props.onFirstTask ? (
              <Button size="sm" variant="outline" onClick={() => props.onFirstTask?.(hired[0]!)}>
                Give {hired[0]!.name} a task
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The wired version: templates, hire and the on-the-team set from the daemon. */
export function KoraFirstRunHost(props: Omit<KoraFirstRunProps, "gallery">) {
  const gallery = useStarterGallery();
  return (
    <KoraFirstRun
      {...props}
      gallery={gallery}
      setup={<SetupCheck problemsOnly className="w-full" />}
    />
  );
}
