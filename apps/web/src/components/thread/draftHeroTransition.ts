export const DRAFT_HERO_TRANSITION_ANIMATION_ID = "kora-draft-hero-transition";
export const DRAFT_HERO_TRANSITION_DURATION_MS = 180;
export const DRAFT_HERO_TRANSITION_EASING = "cubic-bezier(0.4, 0, 0.2, 1)";

export async function waitForDraftStageTransition(): Promise<void> {
  if (typeof document === "undefined" || typeof document.getAnimations !== "function") {
    return;
  }

  const running = document.getAnimations();
  const activeTransitions = running.filter(
    (animation) => animation.id === DRAFT_HERO_TRANSITION_ANIMATION_ID,
  );

  await Promise.all(
    activeTransitions.map(async (animation) => {
      try {
        await animation.finished;
      } catch {
        // A cancelled transition is already safe to hand off.
      }
    }),
  );
}
