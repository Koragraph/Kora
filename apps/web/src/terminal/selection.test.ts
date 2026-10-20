import { describe, expect, it } from "vite-plus/test";

import {
  shouldClearTerminalSelectionAction,
  shouldHandleTerminalExit,
  terminalContextMenuItems,
  terminalSelectionLineRange,
  terminalSelectionMenuItems,
} from "./selection";

const ids = (items: ReadonlyArray<{ id: string }>) => items.map((item) => item.id);

describe("selection line numbers", () => {
  it("turns 0-based rows into an inclusive 1-based range", () => {
    expect(terminalSelectionLineRange({ start: { y: 0 }, end: { y: 0 } })).toEqual({
      lineStart: 1,
      lineEnd: 1,
    });
    expect(terminalSelectionLineRange({ start: { y: 9 }, end: { y: 11 } })).toEqual({
      lineStart: 10,
      lineEnd: 12,
    });
  });

  it("never reports an end before the start", () => {
    expect(terminalSelectionLineRange({ start: { y: 5 }, end: { y: 2 } })).toEqual({
      lineStart: 6,
      lineEnd: 6,
    });
  });
});

describe("selection menus", () => {
  it("offers Add to chat and Copy by default, Copy alone without a chat", () => {
    expect(ids(terminalSelectionMenuItems())).toEqual(["add-to-chat", "copy"]);
    expect(ids(terminalSelectionMenuItems({ canAddToChat: true }))).toEqual([
      "add-to-chat",
      "copy",
    ]);
    expect(ids(terminalSelectionMenuItems({ canAddToChat: false }))).toEqual(["copy"]);
  });

  it("appends an always-enabled Paste to the right-click menu", () => {
    const withChat = terminalContextMenuItems({ hasSelection: true });
    expect(ids(withChat)).toEqual(["add-to-chat", "copy", "paste"]);
    expect(withChat.every((item) => !("disabled" in item) || item.disabled === false)).toBe(true);
    expect(ids(terminalContextMenuItems({ hasSelection: true, canAddToChat: false }))).toEqual([
      "copy",
      "paste",
    ]);
  });

  it("greys out the selection actions when nothing is selected", () => {
    const menu = terminalContextMenuItems({ hasSelection: false });
    expect(
      menu.filter((item) => "disabled" in item && item.disabled).map((item) => item.id),
    ).toEqual(["add-to-chat", "copy"]);
    expect(menu.at(-1)).toEqual({ id: "paste", label: "Paste" });
  });
});

describe("closing the selection menu", () => {
  const rule = shouldClearTerminalSelectionAction;

  it("closes a pending request or the newest open menu", () => {
    expect(rule({ actionPending: true, openMenuRequestId: null, currentRequestId: 7 })).toBe(true);
    expect(rule({ actionPending: false, openMenuRequestId: 7, currentRequestId: 7 })).toBe(true);
  });

  it("leaves a newer menu alone and does nothing when no menu is open", () => {
    expect(rule({ actionPending: false, openMenuRequestId: 6, currentRequestId: 7 })).toBe(false);
    expect(rule({ actionPending: false, openMenuRequestId: null, currentRequestId: 7 })).toBe(
      false,
    );
  });
});

describe("terminal exit handling", () => {
  it("fires on the first transition into an ended state", () => {
    expect(shouldHandleTerminalExit("exited", "running", false)).toBe(true);
    expect(shouldHandleTerminalExit("closed", "running", false)).toBe(true);
    expect(shouldHandleTerminalExit("exited", "closed", false)).toBe(true);
  });

  it("does not fire twice, without a change, or while running", () => {
    expect(shouldHandleTerminalExit("closed", "running", true)).toBe(false);
    expect(shouldHandleTerminalExit("exited", "exited", false)).toBe(false);
    expect(shouldHandleTerminalExit("running", "exited", false)).toBe(false);
  });
});
