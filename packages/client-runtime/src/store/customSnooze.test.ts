// @effect-diagnostics globalDate:off -- Tests exercise local calendar and elapsed-time snooze input.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { localSnoozeDate, localSnoozeTime, resolveCustomSnooze } from "./threadSettled.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Tuesday 3 March 2026, 10:00 local time. */
const NOW = new Date(2026, 2, 3, 10, 0);

const onDate = (date: string, time: string, from = NOW) =>
  resolveCustomSnooze({ mode: "date", date, time }, from);
const after = (amount: string, unit: "minutes" | "hours" | "days", from = NOW) =>
  resolveCustomSnooze({ mode: "duration", amount, unit }, from);

afterEach(() => vi.unstubAllEnvs());

describe("custom snooze: calendar mode", () => {
  it("turns a local date and time into the matching instant", () => {
    expect(onDate("2026-03-04", "07:45")).toBe(new Date(2026, 2, 4, 7, 45).toISOString());
  });

  it.each([
    ["now exactly", "2026-03-03", "10:00"],
    ["the past", "2026-03-02", "18:00"],
    ["a day that does not exist", "2026-02-30", "09:00"],
    ["month 13", "2026-13-02", "09:00"],
    ["hour 24", "2026-03-04", "24:00"],
    ["minute 60", "2026-03-04", "08:60"],
    ["an empty date", "", "08:00"],
    ["an empty time", "2026-03-04", ""],
  ])("refuses %s", (_label, date, time) => {
    expect(onDate(date, time)).toBeNull();
  });

  it("refuses a local time skipped by the spring clock change", () => {
    vi.stubEnv("TZ", "Europe/Berlin");
    expect(onDate("2026-03-29", "02:30", new Date("2026-03-20T00:00:00Z"))).toBeNull();
  });
});

describe("custom snooze: duration mode", () => {
  const confirmed = new Date(NOW.getTime() + 2 * MINUTE);

  it.each([
    ["minutes", "20", 20 * MINUTE],
    ["hours", "2.5", 150 * MINUTE],
    ["days", "3", 72 * HOUR],
  ] as const)("adds %s to the moment of confirmation", (unit, amount, elapsed) => {
    expect(after(amount, unit, confirmed)).toBe(
      new Date(confirmed.getTime() + elapsed).toISOString(),
    );
  });

  it.each(["", "0", "-3", "abc", "Infinity", "9e999"])("refuses %j", (amount) => {
    expect(after(amount, "minutes")).toBeNull();
  });

  it("counts a day as 24 hours even across a clock change", () => {
    vi.stubEnv("TZ", "Europe/Berlin");
    const start = new Date(2026, 2, 28, 12);
    expect(after("1", "days", start)).toBe(new Date(start.getTime() + 24 * HOUR).toISOString());
    expect(after("1", "days", start)).toBe(new Date(2026, 2, 29, 13).toISOString());
  });
});

describe("snooze input values", () => {
  it("formats local date and time fields without shifting to UTC", () => {
    const moment = new Date(2026, 10, 7, 8, 9);
    expect([localSnoozeDate(moment), localSnoozeTime(moment)]).toEqual(["2026-11-07", "08:09"]);
  });
});
