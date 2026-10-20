import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";

import { ShellApplicationMenuActionError } from "../window/ShellApplicationMenu.ts";
import { ShellLifecycleRelaunchError } from "./ShellLifecycle.ts";

// Actions that run detached (a relaunch, a menu click) report their whole cause, failures and defects together.
const mixedCause = (failure: string, defect: string) =>
  Cause.combine(Cause.fail(new Error(failure)), Cause.die(new Error(defect)));

describe("errors of detached desktop actions", () => {
  it("a relaunch error keeps the reason and the full cause", () => {
    const cause = mixedCause("backend would not stop", "relaunch threw");
    const e = new ShellLifecycleRelaunchError({ reason: "install update", cause });
    assert.deepEqual([e.reason, e.cause === cause], ["install update", true]);
    assert.equal(e.message, 'Desktop relaunch failed for reason "install update".');
  });

  it("a menu action error keeps the action and the full cause", () => {
    const cause = mixedCause("no window", "dispatch threw");
    const e = new ShellApplicationMenuActionError({ action: "open-settings", cause });
    assert.deepEqual([e.action, e.cause === cause], ["open-settings", true]);
    assert.equal(e.message, 'Desktop menu action "open-settings" failed.');
  });
});
