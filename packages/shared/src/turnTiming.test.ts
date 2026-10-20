import { describe, expect, it } from "vite-plus/test";

import { deriveActiveWorkStartedAt, formatDuration } from "./turnTiming.ts";

describe("duration labels", () => {
  const table: Array<[number, string]> = [
    [0, "1ms"],
    [42, "42ms"],
    [2_340, "2.3s"],
    [9_960, "10s"],
    [31_000, "31s"],
    [60_000, "1m"],
    [74_000, "1m 14s"],
    [179_600, "3m"],
    [3_599_400, "59m 59s"],
    [3_599_600, "1h"],
    [3_600_000, "1h"],
    [3_602_000, "1h 2s"],
    [3_720_000, "1h 2m"],
    [3_723_000, "1h 2m 3s"],
    [10_799_500, "3h"],
    [36_000_000 - 10_000, "9h 59m 50s"],
    [93_784_000, "26h 3m 4s"],
  ];

  for (const [ms, label] of table) {
    it(`${ms} ms reads "${label}"`, () => expect(formatDuration(ms)).toBe(label));
  }

  it("prints 0ms for negative or non-finite input", () => {
    for (const bad of [-5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(formatDuration(bad)).toBe("0ms");
    }
  });
});

describe("working-indicator start time", () => {
  const T0 = "2025-03-01T08:00:00.000Z";
  const T1 = "2025-03-01T08:00:04.000Z";
  const T2 = "2025-03-01T08:00:11.000Z";

  const turn = (fields: { startedAt?: string | null; completedAt?: string | null } = {}) => ({
    turnId: "t-1",
    requestedAt: T0,
    startedAt: fields.startedAt ?? null,
    completedAt: fields.completedAt ?? null,
  });
  const session = (status: string, activeTurnId: string | null = null) => ({
    status,
    activeTurnId,
  });

  it("uses the send time when another turn is the active one", () => {
    for (const sent of [null, T2]) {
      expect(deriveActiveWorkStartedAt(turn(), session("running", "t-2"), sent)).toBe(sent);
    }
  });

  it("counts from the request while the provider is still spinning up", () => {
    // startedAt is only stamped once the session runs, so a starting session has none yet.
    expect(deriveActiveWorkStartedAt(turn(), session("starting"), null)).toBe(T0);
  });

  it("switches to the provider's start time once known", () => {
    expect(
      deriveActiveWorkStartedAt(turn({ startedAt: T1 }), session("running", "t-1"), null),
    ).toBe(T1);
  });

  it.each([
    ["failed before starting", turn({ completedAt: T1 }), session("error")],
    ["finished and idle", turn({ startedAt: T1, completedAt: T2 }), session("idle")],
    [
      "finished while a fresh session starts",
      turn({ startedAt: T1, completedAt: T2 }),
      session("starting"),
    ],
  ])("stops once the turn %s", (_label, latest, current) => {
    expect(deriveActiveWorkStartedAt(latest, current, null)).toBeNull();
  });

  it("falls back to the send time before any turn exists", () => {
    expect(deriveActiveWorkStartedAt(null, null, T2)).toBe(T2);
  });
});
