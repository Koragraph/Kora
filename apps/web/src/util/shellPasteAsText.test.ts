import type { ShellBridge } from "@kora/contracts";
import { describe, expect, test, vi } from "vite-plus/test";

import { SHELL_PASTE_AS_TEXT_EVENT, installShellPasteAsText } from "./shellPasteAsText";

function harness(composerMounted: boolean) {
  const bus = new EventTarget();
  const trail: string[] = [];
  let fireMenu: (action: string) => void = () => {};
  const bridge = {
    pasteAsText: vi.fn(async () => void trail.push("paste")),
    onMenuAction: (cb: (action: string) => void) => {
      fireMenu = cb;
      return () => {
        fireMenu = () => {};
      };
    },
  } satisfies Pick<ShellBridge, "onMenuAction" | "pasteAsText">;
  if (composerMounted) bus.addEventListener(SHELL_PASTE_AS_TEXT_EVENT, () => trail.push("armed"));
  const uninstall = installShellPasteAsText(bridge, bus);
  return { bridge, trail, uninstall, fire: (a: string) => fireMenu(a) };
}

describe("installShellPasteAsText", () => {
  test.each([
    [true, ["armed", "paste"]],
    [false, ["paste"]],
  ])("with a composer mounted=%s the menu paste runs as %j", (mounted, expected) => {
    const h = harness(mounted);
    h.fire("paste-as-text");
    expect(h.trail).toEqual(expected);
  });

  test("other menu actions are ignored", () => {
    const h = harness(true);
    h.fire("open-settings");
    expect(h.trail).toEqual([]);
  });

  test("uninstalling stops further pastes", () => {
    const h = harness(false);
    h.fire("paste-as-text");
    h.uninstall?.();
    h.fire("paste-as-text");
    expect(h.bridge.pasteAsText).toHaveBeenCalledOnce();
  });
});
