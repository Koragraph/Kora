import type { ContextMenuItem } from "@kora/contracts";
import type { PtySessionState } from "@kora/client-runtime/store/terminal";

/** 1-based, inclusive line numbers for a selection given in 0-based buffer rows (wrapped rows count separately). */
export function terminalSelectionLineRange(position: {
  start: { y: number };
  end: { y: number };
}): { lineStart: number; lineEnd: number } {
  const lineStart = position.start.y + 1;
  const lineEnd = Math.max(position.end.y + 1, lineStart);
  return { lineStart, lineEnd };
}

export type TerminalContextMenuAction = "add-to-chat" | "copy" | "paste";
type SelectionAction = Exclude<TerminalContextMenuAction, "paste">;

/** The popup shown over a fresh selection. "Add to chat" only exists when the terminal belongs to a chat. */
export function terminalSelectionMenuItems(
  options: { canAddToChat?: boolean } = {},
): ContextMenuItem<SelectionAction>[] {
  const copy: ContextMenuItem<SelectionAction> = { id: "copy", label: "Copy" };
  return options.canAddToChat === false
    ? [copy]
    : [{ id: "add-to-chat", label: "Add to chat" }, copy];
}

/** The right-click menu: the selection actions (greyed out without a selection), then Paste, which is always live. */
export function terminalContextMenuItems(options: {
  hasSelection: boolean;
  canAddToChat?: boolean;
}): ContextMenuItem<TerminalContextMenuAction>[] {
  const forSelection = terminalSelectionMenuItems(
    options.canAddToChat === undefined ? {} : { canAddToChat: options.canAddToChat },
  );
  return [
    ...forSelection.map((item) => ({ ...item, disabled: !options.hasSelection })),
    { id: "paste", label: "Paste" },
  ];
}

/**
 * When the selection goes away, close the selection menu only if it is still the one in charge: a request that is
 * pending, or the open menu belonging to the newest request. An older popup must not close a newer right-click menu.
 */
export function shouldClearTerminalSelectionAction(state: {
  actionPending: boolean;
  openMenuRequestId: number | null;
  currentRequestId: number;
}): boolean {
  if (state.actionPending) return true;
  return state.openMenuRequestId !== null && state.openMenuRequestId === state.currentRequestId;
}

/** True once per transition into closed/exited (also when the surface is still loading as it happens). */
export function shouldHandleTerminalExit(
  status: PtySessionState["status"],
  previous: PtySessionState["status"],
  alreadyHandled: boolean,
): boolean {
  const ended = status === "closed" || status === "exited";
  return ended && !alreadyHandled && status !== previous;
}
