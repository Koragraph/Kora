// Reveal a file in Finder. The desktop shell has no general "reveal a path" bridge yet (only a browser-artifact one),
// so this feature-detects `shellBridge.revealPath` and otherwise copies the path with a visible toast, which is the
// fallback every output card has always had.

import { toastManager } from "~/components/ui/toast";
import { pastePathHint } from "~/util/utils";

interface RevealBridge {
  readonly revealPath?: (path: string) => Promise<void>;
}

export async function revealInFinder(
  absolutePath: string,
  copy: (value: string) => void,
): Promise<"revealed" | "copied"> {
  const bridge =
    typeof window === "undefined"
      ? undefined
      : (window.shellBridge as unknown as RevealBridge | undefined);
  if (bridge?.revealPath) {
    try {
      await bridge.revealPath(absolutePath);
      return "revealed";
    } catch {
      // fall through to the copy fallback
    }
  }
  copy(absolutePath);
  toastManager.add({
    description: pastePathHint(),
    title: "Path copied",
    type: "success",
  });
  return "copied";
}
