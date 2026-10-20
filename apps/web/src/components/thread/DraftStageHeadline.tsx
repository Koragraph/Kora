import type { DraftId } from "~/stores/promptDraftStore";

import { KoraMark } from "../KoraWordmark";
import { DraftParticles } from "./DraftParticles";

interface DraftStageHeadlineProps {
  readonly draftId: DraftId | null;
}

// A calm, upbeat greeting instead of a literal instruction. Nothing that assumes history or a time
// of day: the first draft of a brand-new project said "Let's pick up where we left off." at 3 a.m.
const DRAFT_GREETINGS = [
  "Good to see you. What are we building?",
  "What should we work on?",
  "Ready when you are.",
  "A fresh start always feels good.",
  "What's first?",
  "Glad you're here. Let's build.",
] as const;

/** One greeting per draft, stable for its lifetime — not re-rolled on every keystroke, but
 *  different from the last draft. `draftId` is null on the very first render of a fresh app
 *  window, so that case just takes the first line rather than hashing nothing. */
function pickGreeting(draftId: DraftId | null): string {
  const fallback = DRAFT_GREETINGS[0];
  if (!draftId) return fallback;
  let hash = 0;
  for (let i = 0; i < draftId.length; i++) hash = (hash * 31 + draftId.charCodeAt(i)) >>> 0;
  return DRAFT_GREETINGS[hash % DRAFT_GREETINGS.length] ?? fallback;
}

export function DraftStageHeadline({ draftId }: DraftStageHeadlineProps) {
  const greeting = pickGreeting(draftId);

  // The dot mark needs ~250px above the composer; on a short window the small mark stands in for it.
  return (
    <>
      <DraftParticles className="mx-auto mb-2 hidden touch-none [@media(min-height:860px)]:block" />
      <h1 className="mx-auto flex w-full max-w-5xl items-center justify-center gap-2.5 text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
        <KoraMark className="size-6 shrink-0 opacity-90 sm:size-8 [@media(min-height:860px)]:hidden" />
        <span>{greeting}</span>
      </h1>
    </>
  );
}
