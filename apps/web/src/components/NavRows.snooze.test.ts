import { describe, expect, test } from "vite-plus/test";

import { resolveSnoozePresets, snoozeWakeDescription } from "./NavRows.snooze";

// Built from local components so the maths does not depend on the machine's timezone.
const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min);
const WED_MORNING = at(2026, 4, 8, 10);
const ids = (now: Date) => resolveSnoozePresets(now, "locale").map((p) => p.id);
const preset = (now: Date, id: string, clock: "locale" | "12-hour" | "24-hour" = "locale") =>
  resolveSnoozePresets(now, clock).find((p) => p.id === id)!;

describe("snoozeWakeDescription", () => {
  const describeAt = (when: Date, clock: "locale" | "12-hour" | "24-hour") =>
    snoozeWakeDescription(when.toISOString(), WED_MORNING, clock);

  test("honours the clock preference", () => {
    expect(describeAt(at(2026, 4, 8, 18), "12-hour")).toMatch(/PM/i);
    expect(describeAt(at(2026, 4, 8, 18), "24-hour")).toBe("18:00");
  });

  test("later today is a bare time, the next day says 'tomorrow', later in the week names the day", () => {
    expect(describeAt(at(2026, 4, 8, 18), "locale")).not.toContain("tomorrow");
    expect(describeAt(at(2026, 4, 9, 9), "locale")).toContain("tomorrow");
    expect(describeAt(at(2026, 4, 13, 9), "locale")).toMatch(/Mon/);
  });
});

describe("resolveSnoozePresets", () => {
  test("a weekday morning offers all five presets at the expected times", () => {
    expect(ids(WED_MORNING)).toEqual(["hour", "three-hours", "evening", "tomorrow", "next-week"]);
    expect(new Date(preset(WED_MORNING, "three-hours").snoozedUntil).getHours()).toBe(13);
    expect(new Date(preset(WED_MORNING, "evening").snoozedUntil).getHours()).toBe(18);

    const tomorrow = new Date(preset(WED_MORNING, "tomorrow").snoozedUntil);
    expect([tomorrow.getDate(), tomorrow.getHours()]).toEqual([9, 9]);

    const nextWeek = new Date(preset(WED_MORNING, "next-week").snoozedUntil);
    expect([nextWeek.getDay(), nextWeek.getDate()]).toEqual([1, 13]);
  });

  test("on a Monday, next week is a full seven days away", () => {
    const monday = at(2026, 4, 6, 10);
    const when = new Date(preset(monday, "next-week").snoozedUntil);
    expect([when.getDay(), when.getDate()]).toEqual([1, 13]);
  });

  test.each([
    ["17:30", at(2026, 4, 8, 17, 30)],
    ["21:00", at(2026, 4, 8, 21)],
  ])("the evening preset disappears at %s", (_label, now) => {
    expect(ids(now)).toEqual(["hour", "three-hours", "tomorrow", "next-week"]);
  });

  test("preset times follow the clock preference", () => {
    expect(preset(WED_MORNING, "evening", "12-hour").whenLabel).toMatch(/PM/i);
    expect(preset(WED_MORNING, "evening", "24-hour").whenLabel).toBe("18:00");
  });

  test("the time column never repeats the day words from the label column", () => {
    for (const p of resolveSnoozePresets(WED_MORNING, "locale")) {
      expect(p.whenLabel.toLowerCase()).not.toContain("tomorrow");
    }
    expect(preset(WED_MORNING, "tomorrow").whenLabel).toMatch(/9/);
    expect(preset(WED_MORNING, "next-week").whenLabel).toMatch(/Mon/);
  });
});
