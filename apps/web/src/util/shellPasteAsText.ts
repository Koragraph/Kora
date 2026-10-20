import type { ShellBridge } from "@kora/contracts";

export const SHELL_PASTE_AS_TEXT_EVENT = "kora:paste-plain";

/** Arm composer paste handling before Electron delivers the native clipboard event. */
export function installShellPasteAsText(
  bridge: Pick<ShellBridge, "onMenuAction" | "pasteAsText"> | undefined,
  dest: EventTarget,
): (() => void) | undefined {
  return bridge?.onMenuAction((actionName) => {
    if (actionName !== "paste-as-text") return;
    dest.dispatchEvent(new Event(SHELL_PASTE_AS_TEXT_EVENT));
    void bridge.pasteAsText?.();
  });
}
