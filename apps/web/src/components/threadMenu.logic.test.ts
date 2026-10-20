import { describe, expect, test } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadMenu.logic";

const ALL_ON = { settlement: true, snooze: true, pinning: true, titleRegeneration: true };
const ALL_OFF = { settlement: false, snooze: false, pinning: false, titleRegeneration: false };

const STATE: ThreadActionMenuState = {
  supports: ALL_ON,
  isRunning: false,
  isRegeneratingTitle: false,
  canSnoozeNow: true,
  isSnoozed: false,
  isSettled: false,
  isPinned: false,
  branch: null,
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

const menu = (over: Partial<ThreadActionMenuState> = {}) =>
  buildThreadActionMenuItems({ ...STATE, ...over });
const topIds = (over?: Partial<ThreadActionMenuState>) => menu(over).map((i) => i.id);
const everyId = (over?: Partial<ThreadActionMenuState>) => {
  const walk = (items: ReturnType<typeof menu>): string[] =>
    items.flatMap((i) => [i.id, ...(i.children ? walk(i.children) : [])]);
  return walk(menu(over));
};
const item = (id: string, over?: Partial<ThreadActionMenuState>) =>
  menu(over).find((i) => i.id === id);

describe("ending items", () => {
  test("archive sits just before delete, separated, and is not destructive", () => {
    const items = menu();
    const archive = items.at(-2);
    expect(archive).toMatchObject({ id: "archive", icon: "archive", separatorBefore: true });
    expect(archive?.destructive).toBeFalsy();
    expect(items.at(-1)?.id).toBe("delete");
  });

  test("delete is always last and destructive", () => {
    expect(menu({ branch: "main" }).at(-1)).toMatchObject({ id: "delete", destructive: true });
  });

  test("archive is disabled while the turn is running", () => {
    expect(item("archive", { isRunning: true })?.disabled).toBe(true);
    expect(item("archive")?.disabled).toBeFalsy();
  });

  test("project settings come right after copy, before archive", () => {
    const items = menu();
    const at = items.findIndex((i) => i.id === "copy");
    expect(items[at + 1]).toMatchObject({
      id: "project-settings",
      icon: "settings",
      label: "Project settings",
    });
    expect(items[at + 2]?.id).toBe("archive");
  });
});

describe("capability gating", () => {
  test("without any optional capability only the basics remain", () => {
    expect(topIds({ supports: ALL_OFF })).toEqual([
      "rename",
      "mark-unread",
      "copy",
      "project-settings",
      "archive",
      "delete",
    ]);
  });

  test("archive survives having no capabilities at all", () => {
    expect(topIds({ supports: ALL_OFF })).toContain("archive");
  });
});

describe("state-dependent items", () => {
  test("pin, settle and snooze flip to their undo forms with the thread's state", () => {
    expect(topIds()).toEqual(expect.arrayContaining(["pin", "settle", "snooze"]));
    expect(topIds({ isPinned: true, isSettled: true, isSnoozed: true })).toEqual(
      expect.arrayContaining(["unpin", "unsettle", "unsnooze"]),
    );
  });

  test("a title regeneration in flight is shown as busy and disabled", () => {
    expect(item("regenerate-title", { isRegeneratingTitle: true })).toMatchObject({
      label: "Regenerating…",
      disabled: true,
    });
  });

  test("a thread that cannot snooze right now still lists its presets, disabled", () => {
    const snooze = item("snooze", { canSnoozeNow: false });
    expect(snooze?.disabled).toBe(true);
    expect(snooze?.children?.map((c) => c.id)).toEqual(["snooze:hour", "snooze:custom"]);
  });

  test("branch actions exist only when the thread has a branch", () => {
    expect(everyId({ branch: "feat/x" })).toEqual(
      expect.arrayContaining(["new-thread-on-branch", "copy-branch"]),
    );
    expect(everyId()).not.toContain("new-thread-on-branch");
    expect(everyId()).not.toContain("copy-branch");
  });
});
