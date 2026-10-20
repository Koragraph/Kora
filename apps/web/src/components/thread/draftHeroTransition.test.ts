import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import {
  DRAFT_HERO_TRANSITION_ANIMATION_ID,
  waitForDraftStageTransition,
} from "./draftHeroTransition";

const withAnimations = (animations: Array<{ id: string; finished: Promise<unknown> }>) =>
  vi.stubGlobal("document", { getAnimations: () => animations });

afterEach(() => vi.unstubAllGlobals());

describe("waitForDraftStageTransition", () => {
  test("with no animations it resolves at once", async () => {
    withAnimations([]);
    await expect(waitForDraftStageTransition()).resolves.toBeUndefined();
  });

  test("the hand-off waits for the hero animation but not for unrelated ones", async () => {
    let end!: () => void;
    const heroDone = new Promise<void>((resolve) => (end = resolve));
    withAnimations([
      { id: "something-else", finished: new Promise(() => undefined) },
      { id: DRAFT_HERO_TRANSITION_ANIMATION_ID, finished: heroDone },
    ]);

    let released = false;
    const waiting = waitForDraftStageTransition().then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);

    end();
    await waiting;
    expect(released).toBe(true);
  });

  test("a cancelled hero animation does not block the hand-off", async () => {
    withAnimations([
      { id: DRAFT_HERO_TRANSITION_ANIMATION_ID, finished: Promise.reject(new Error("cancelled")) },
    ]);
    await expect(waitForDraftStageTransition()).resolves.toBeUndefined();
  });
});
