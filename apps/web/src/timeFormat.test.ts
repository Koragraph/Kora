import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import {
  formatDayAwareTimestamp,
  formatRelativeTime,
  formatRelativeTimeLabel,
  formatShortTimestamp,
  resolveTimestampLocale,
} from "./timeFormat";

// Built from local-time components, so calendar-day logic is the same in every timezone and locale.
const local = (y: number, month: number, d: number, h = 0, min = 0) =>
  new Date(y, month - 1, d, h, min);
const isoLocal = (...args: Parameters<typeof local>) => local(...args).toISOString();
const plainSpaces = (text: string) => text.replace(/[  ]/g, " ");

/** Re-import the module as if the desktop host reported `systemLocale`. */
async function moduleForHostLocale(systemLocale: string) {
  vi.stubGlobal("window", { shellBridge: { getSystemLocale: () => systemLocale } });
  vi.resetModules();
  return import("./timeFormat");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("unparseable input", () => {
  test("relative time is null / an empty label, never 'NaN ago'", () => {
    expect(formatRelativeTime("garbage")).toBeNull();
    expect(formatRelativeTimeLabel("garbage")).toBe("");
  });

  test("short and day-aware timestamps are empty instead of throwing", () => {
    expect(formatShortTimestamp("garbage", "12-hour")).toBe("");
    expect(formatDayAwareTimestamp("garbage", "12-hour", Date.now())).toBe("");
  });
});

describe("formatDayAwareTimestamp", () => {
  const NOW = local(2026, 8, 14, 12).getTime();
  const clock = (iso: string) => formatShortTimestamp(iso, "12-hour");
  const dayAware = (iso: string, now = NOW) => formatDayAwareTimestamp(iso, "12-hour", now);

  test("today shows the time alone", () => {
    const at = isoLocal(2026, 8, 14, 9, 30);
    expect(dayAware(at)).toBe(clock(at));
  });

  test("the previous calendar day is 'yesterday', even when it was under 24 hours ago", () => {
    const at = isoLocal(2026, 8, 13, 23, 30);
    expect(dayAware(at, local(2026, 8, 14, 0, 30).getTime())).toBe(`yesterday at ${clock(at)}`);
  });

  test("older messages this year get the numeric date first", () => {
    const at = isoLocal(2026, 8, 12, 12, 34);
    const date = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "numeric" }).format(
      new Date(at),
    );
    expect(dayAware(at)).toBe(`${date} ${clock(at)}`);
  });

  test("messages from another year also show the year", () => {
    const at = isoLocal(2025, 12, 31, 18);
    const date = new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }).format(new Date(at));
    expect(dayAware(at)).toBe(`${date} ${clock(at)}`);
  });

  test("the host's locale drives both the date order and the clock", async () => {
    const mod = await moduleForHostLocale("en-GB");
    expect(mod.formatDayAwareTimestamp(isoLocal(2026, 8, 12, 15, 44), "locale", NOW)).toBe(
      "12/08 15:44",
    );
  });
});

describe("formatShortTimestamp", () => {
  test.each([
    ["en-GB", "15:44"],
    ["en-US", "3:44 PM"],
  ])(
    "with host locale %s: 'locale' reads %s, and explicit 12/24-hour settings override it",
    async (tag, expected) => {
      const { formatShortTimestamp: format } = await moduleForHostLocale(tag);
      const at = isoLocal(2026, 4, 7, 15, 44);
      expect(plainSpaces(format(at, "locale"))).toBe(expected);
      expect(plainSpaces(format(at, "12-hour"))).toMatch(/^3:44 [ap]m$/i);
      expect(format(at, "24-hour")).toBe("15:44");
    },
  );
});

describe("formatChatTimestampTooltip", () => {
  test.each(["de-DE", "it-IT"])(
    "stays an English date label under a %s runtime",
    async (runtimeLocale) => {
      const RealDateTimeFormat = Intl.DateTimeFormat;
      vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (locales, options) {
        return new RealDateTimeFormat(locales ?? runtimeLocale, options);
      });
      vi.resetModules();
      const { formatChatTimestampTooltip } = await import("./timeFormat");

      expect(formatChatTimestampTooltip(isoLocal(2026, 6, 4, 14, 4), "24-hour")).toBe(
        "14:04, 4th June 2026",
      );
    },
  );
});

describe("resolveTimestampLocale", () => {
  test.each(["en-GB", "de-DE", "pt-BR"])("a BCP-47 tag (%s) is used as given", (tag) => {
    expect(resolveTimestampLocale(tag)).toBe(tag);
  });

  test.each([null, undefined, "", "   "])("%j means 'use the runtime default'", (value) => {
    expect(resolveTimestampLocale(value)).toBeUndefined();
  });

  test.each(["not a locale", "en_GB"])(
    "an unusable tag (%j) falls back rather than throwing",
    (tag) => {
      expect(resolveTimestampLocale(tag)).toBeUndefined();
    },
  );
});
