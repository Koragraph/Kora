import { describe, expect, it } from "vite-plus/test";

import {
  cadenceFromDraft,
  cadenceLine,
  cadenceZone,
  cronWords,
  curlExample,
  draftFromCadence,
  draftSentence,
  formatNextTime,
  relativeUntil,
  routineState,
  type CadenceDraft,
  type RoutineWire,
} from "./routineModel";

const words = (expr: string) => {
  const r = cronWords(expr);
  return r.ok ? r.words : `ERR ${r.error}`;
};

describe("cron in plain words", () => {
  it("says calendar rules exactly", () => {
    expect(words("0 9 * * 1#1")).toBe("On the first Monday of the month at 9:00 AM");
    expect(words("0 9 L * *")).toBe("On the last day of the month at 9:00 AM");
    expect(words("0 17 * * 5L")).toBe("On the last Friday of the month at 5:00 PM");
    expect(words("0 8 * * 1-5")).toBe("Weekdays at 8:00 AM");
    expect(words("30 7 * * *")).toBe("Every day at 7:30 AM");
    expect(words("0 8,20 * * *")).toBe("Every day at 8:00 AM and 8:00 PM");
    expect(words("0 9 1,15 * *")).toBe("On the 1st and 15th of the month at 9:00 AM");
    expect(words("0 9 * JAN,JUL MON")).toBe("Every Monday in January and July at 9:00 AM");
    expect(words("*/15 9-17 * * 1-5")).toBe(
      "Every 15 minutes between 9:00 AM and 5:59 PM, weekdays",
    );
    expect(words("*/10 * * * *")).toBe("Every 10 minutes");
  });
  it("classic day-of-month OR day-of-week is stated as OR", () => {
    expect(words("0 0 13 * 5")).toBe("On the 13th of the month or every Friday at 12:00 AM");
  });
  it("refuses what it cannot say exactly or what is invalid", () => {
    expect(words("0 9 13 * 5L")).toMatch(/^Custom rule/);
    expect(words("* * * *")).toMatch(/^ERR A cron rule has 5 fields/);
    expect(words("61 * * * *")).toMatch(/^ERR Minute/);
    expect(words("0 0 30 2 *")).toMatch(/never happens/);
    expect(words("0 9 * * 9")).toMatch(/^ERR Day of week/);
  });
});

describe("editor draft", () => {
  const base = draftFromCadence(null, Date.UTC(2026, 9, 5, 12));
  it("defaults to weekdays at 08:00 in this Mac's zone", () => {
    expect(base.kind).toBe("weekly");
    expect(base.days).toEqual([1, 2, 3, 4, 5]);
    expect(base.time).toBe("08:00");
  });
  it("turns a draft into a cadence, and explains it in words", () => {
    const weekly: CadenceDraft = {
      ...base,
      tz: "America/New_York",
      days: [5, 1, 3],
      time: "07:30",
    };
    expect(cadenceFromDraft(weekly)).toEqual({
      ok: true,
      cadence: { kind: "weekly", days: [1, 3, 5], time: "07:30", tz: "America/New_York" },
    });
    expect(draftSentence(weekly)).toEqual({
      ok: true,
      text: "Mon, Wed and Fri at 7:30 AM (America/New_York)",
    });
    expect(draftSentence({ ...base, tz: "UTC" }).text).toBe("Weekdays at 8:00 AM (UTC)");
    expect(draftSentence({ ...base, kind: "interval", everyMinutes: "90" }).text).toBe(
      "Every 90 minutes",
    );
    expect(draftSentence({ ...base, kind: "interval", everyMinutes: "120" }).text).toBe(
      "Every 2 hours",
    );
    expect(
      draftSentence({ ...base, kind: "cron", cron: "0 9 * * 1#1", tz: "Europe/London" }).text,
    ).toBe("On the first Monday of the month at 9:00 AM (Europe/London)");
  });
  it("rejects bad input with a sentence a person can act on", () => {
    expect(draftSentence({ ...base, kind: "interval", everyMinutes: "3" })).toEqual({
      ok: false,
      text: "Choose between 5 and 1,440 minutes.",
    });
    expect(draftSentence({ ...base, kind: "interval", everyMinutes: "1441" }).ok).toBe(false);
    expect(draftSentence({ ...base, days: [] })).toEqual({
      ok: false,
      text: "Pick at least one day.",
    });
    expect(draftSentence({ ...base, tz: "Nope/Zone" }).text).toMatch(/time zone/);
    expect(draftSentence({ ...base, kind: "cron", cron: "x", tz: "UTC" }).ok).toBe(false);
    expect(draftSentence({ ...base, kind: "cron", cron: "0 9 * * 1", tz: "" }).text).toMatch(
      /needs a time zone/,
    );
  });
  it("round-trips an existing cadence", () => {
    const c = { kind: "cron", expr: "0 9 L * *", tz: "UTC" } as const;
    const d = draftFromCadence(c, 0);
    expect(cadenceFromDraft(d)).toEqual({ ok: true, cadence: c });
  });
});

describe("labels", () => {
  const r = (over: Partial<RoutineWire> = {}): RoutineWire => ({
    id: "rt_1",
    blobId: "b",
    title: "Brief",
    prompt: "p",
    cadence: { kind: "weekly", days: [1, 2, 3, 4, 5], time: "08:00", tz: "UTC" },
    paused: false,
    results: { mode: "dedicated", threadId: null },
    rememberLastRun: false,
    maxRunMinutes: null,
    catchUp: "one",
    triggers: [],
    nextRunAt: 10 * 3_600_000,
    live: null,
    lastRun: null,
    suggestedCadence: null,
    createdBy: "user",
    skipped: 0,
    ...over,
  });
  it("one-line cadence", () => expect(cadenceLine(r().cadence)).toBe("Weekdays at 8:00 AM · UTC"));
  it("relative times", () => {
    expect(relativeUntil(5 * 60_000, 0)).toBe("in 5 min");
    expect(relativeUntil(5 * 3_600_000, 0)).toBe("in 5 hr");
    expect(relativeUntil(3 * 86_400_000, 0)).toBe("in 3 days");
    expect(relativeUntil(10, 100)).toBe("due now");
  });
  it("routine state", () => {
    expect(routineState(r(), 0).label).toBe("Next in 10 hr");
    expect(routineState(r({ paused: true }), 0).label).toBe("Paused");
    expect(routineState(r({ paused: true, createdBy: "template" }), 0).label).toBe("Suggested");
  });
  it("curl example embeds url and secret", () => {
    expect(curlExample("http://127.0.0.1:8800/hooks/wh_1", "whsec_abc")).toContain(
      "Bearer whsec_abc",
    );
    expect(curlExample("http://127.0.0.1:8800/hooks/wh_1", null)).toContain("<your-secret>");
  });
});

describe("formatNextTime (the preview bug: 08:00 Asia/Calcutta must read as 8:00 AM, whatever zone the viewer is in)", () => {
  const monday0230Z = Date.UTC(2026, 9, 12, 2, 30);

  it("prints the instant in the routine's zone, with the viewer's clock as a second line when they differ", () => {
    const viewerLA = formatNextTime(monday0230Z, "Asia/Calcutta", "America/Los_Angeles", "en-US");
    expect(viewerLA.label).toBe("Mon, Oct 12, 8:00 AM");
    expect(viewerLA.here).toBe("Sun, Oct 11, 7:30 PM");
    const viewerHere = formatNextTime(monday0230Z, "Asia/Calcutta", "Asia/Calcutta", "en-US");
    expect(viewerHere).toEqual({ label: "Mon, Oct 12, 8:00 AM", here: null });
    // zones with the same offset at that instant say nothing extra
    expect(formatNextTime(monday0230Z, "Asia/Kolkata", "Asia/Calcutta", "en-US").here).toBeNull();
  });

  it("every-N-minutes and once have no zone: they print in the viewer's own", () => {
    const f = formatNextTime(monday0230Z, null, "America/New_York", "en-US");
    expect(f.label).toBe("Sun, Oct 11, 10:30 PM");
    expect(f.here).toBeNull();
    expect(cadenceZone({ kind: "interval", everyMinutes: 30, anchor: 0 })).toBeNull();
    expect(cadenceZone({ kind: "weekly", days: [1], time: "08:00", tz: "Asia/Calcutta" })).toBe(
      "Asia/Calcutta",
    );
    expect(cadenceZone({ kind: "cron", expr: "0 8 * * *", tz: "UTC" })).toBe("UTC");
  });

  it("an invalid zone falls back to the viewer's rather than throwing", () => {
    expect(formatNextTime(monday0230Z, "Not/AZone", "UTC", "en-US").label).toBe(
      "Mon, Oct 12, 2:30 AM",
    );
  });

  it("DST: the 08:00 in New York keeps reading 8:00 AM across the change (EST -> EDT)", () => {
    const fri = Date.UTC(2027, 2, 12, 13, 0); // 08:00 EST
    const mon = Date.UTC(2027, 2, 15, 12, 0); // 08:00 EDT
    expect(formatNextTime(fri, "America/New_York", "UTC", "en-US").label).toBe(
      "Fri, Mar 12, 8:00 AM",
    );
    expect(formatNextTime(mon, "America/New_York", "UTC", "en-US").label).toBe(
      "Mon, Mar 15, 8:00 AM",
    );
  });
});

describe("a once-routine in the past", () => {
  it("is rejected with a plain sentence; a future time is accepted", () => {
    const base = draftFromCadence({ kind: "once", at: Date.now() - 60_000 }, 0);
    const past = cadenceFromDraft(base);
    expect(past.ok).toBe(false);
    expect(past.ok ? "" : past.error).toMatch(/already passed/);
    expect(
      cadenceFromDraft(draftFromCadence({ kind: "once", at: Date.now() + 3_600_000 }, 0)).ok,
    ).toBe(true);
  });
});
