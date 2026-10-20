import { describe, expect, test } from "vite-plus/test";

import {
  INITIAL_WEBVIEW_CRASH_RECOVERY_STATE,
  WEBVIEW_CRASH_RECOVERY_WINDOW_MS,
  planWebviewCrashRecovery,
} from "./webviewCrashRecovery";

/** Feed a list of crash timestamps through the planner; returns every plan (null = gave up). */
function replay(times: number[]) {
  const plans: Array<ReturnType<typeof planWebviewCrashRecovery>> = [];
  let state = INITIAL_WEBVIEW_CRASH_RECOVERY_STATE;
  for (const at of times) {
    const plan = planWebviewCrashRecovery(state, at);
    plans.push(plan);
    if (plan) state = plan.state;
  }
  return plans;
}

describe("planWebviewCrashRecovery", () => {
  test("rapid crashes back off 250 → 500 → 1000 ms and then stop", () => {
    const plans = replay([5_000, 5_100, 5_200, 5_300]);
    expect(plans.map((p) => p?.delayMs ?? null)).toEqual([250, 500, 1_000, null]);
  });

  test("giving up does not advance the state", () => {
    const plans = replay([0, 10, 20, 30]);
    expect(plans[3]).toBeNull();
    expect(planWebviewCrashRecovery(plans[2]!.state, 40)).toBeNull();
  });

  test("once the window has elapsed the attempt counter starts over", () => {
    const [, , third] = replay([2_000, 2_100, 2_200]);
    const later = 2_000 + WEBVIEW_CRASH_RECOVERY_WINDOW_MS;
    expect(planWebviewCrashRecovery(third!.state, later)).toEqual({
      delayMs: 250,
      state: { windowStartedAt: later, attempts: 1 },
    });
  });

  test("a crash just inside the window still counts against the budget", () => {
    const [, , third] = replay([2_000, 2_100, 2_200]);
    expect(
      planWebviewCrashRecovery(third!.state, 2_000 + WEBVIEW_CRASH_RECOVERY_WINDOW_MS - 1),
    ).toBeNull();
  });
});
