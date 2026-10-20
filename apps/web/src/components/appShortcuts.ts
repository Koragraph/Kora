export type AppShortcut = "toggle-sidebar" | "open-settings";

/**
 * ⌘B toggles the sidebar and ⌘, opens Settings (Ctrl off the Mac). Bare chords only, like the sidebar's ⌘N / ⌘K:
 * no Shift or Alt, and the other platform's modifier must be up.
 */
export function resolveAppShortcut(
  event: {
    readonly key: string;
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
    readonly shiftKey: boolean;
    readonly isComposing?: boolean;
  },
  mac: boolean,
): AppShortcut | null {
  if (event.isComposing || event.altKey || event.shiftKey) return null;
  const chord = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!chord) return null;
  const key = event.key.toLowerCase();
  if (key === "b") return "toggle-sidebar";
  if (key === ",") return "open-settings";
  return null;
}
