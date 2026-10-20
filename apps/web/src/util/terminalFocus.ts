export type TerminalFocusOwner = "drawer" | "right-panel";

const OWNERS: ReadonlySet<string> = new Set<TerminalFocusOwner>(["right-panel", "drawer"]);

export function terminalFocusOwner(): TerminalFocusOwner | null {
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement) || !focused.isConnected) return null;
  const holder = focused.closest<HTMLElement>("[data-terminal-owner]")?.dataset.terminalOwner;
  return holder !== undefined && OWNERS.has(holder) ? (holder as TerminalFocusOwner) : null;
}
