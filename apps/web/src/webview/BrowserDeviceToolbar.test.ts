import type { WebViewportSetting } from "@kora/contracts";
import { describe, expect, test, vi } from "vite-plus/test";

import { commitViewportAndAspectRatio } from "./browserDeviceToolbarState";

function latch<T = void>() {
  const hooks = {} as { resolve: (v: T) => void };
  const promise = new Promise<T>((resolve) => Object.assign(hooks, { resolve }));
  return { promise, resolve: hooks.resolve };
}

describe("commitViewportAndAspectRatio", () => {
  test("a rejected viewport commit leaves the aspect ratio alone and surfaces the error", async () => {
    const remember = vi.fn();
    const failing = () => Promise.reject(new Error("resize failed"));

    await expect(
      commitViewportAndAspectRatio({ _tag: "fill" }, null, failing, remember),
    ).rejects.toThrow("resize failed");
    expect(remember).not.toHaveBeenCalled();
  });

  test("the ratio is recorded only once the viewport commit has resolved", async () => {
    const remember = vi.fn();
    const gate = latch();
    const next: WebViewportSetting = { _tag: "freeform", width: 900, height: 600 };

    const run = commitViewportAndAspectRatio(next, 1.5, () => gate.promise, remember);
    await Promise.resolve();
    expect(remember).not.toHaveBeenCalled();

    gate.resolve();
    await run;
    expect(remember).toHaveBeenCalledExactlyOnceWith(1.5);
  });

  test("the viewport handler receives the requested setting", async () => {
    const apply = vi.fn(async () => undefined);
    const next: WebViewportSetting = { _tag: "freeform", width: 390, height: 844 };
    await commitViewportAndAspectRatio(next, null, apply, vi.fn());
    expect(apply).toHaveBeenCalledWith(next);
  });
});
