import { describe, expect, it } from "@effect/vitest";

import { compareDateTimeStrings } from "./isoTimes.ts";

const sign = (left: string, right: string) => Math.sign(compareDateTimeStrings(left, right));

describe("dateTime", () => {
  describe("well-formed instants", () => {
    it("orders by the instant, not by the text", () => {
      // 10:15 in New York (-04:00) is 14:15 UTC.
      expect(sign("2025-06-10T14:15:00Z", "2025-06-10T10:15:00-04:00")).toBe(0);
      expect(sign("2025-06-10T14:15:00.500Z", "2025-06-10T14:15:00Z")).toBe(1);
      expect(sign("2025-06-10T14:15:00Z", "2025-06-10T14:15:00.500Z")).toBe(-1);
    });

    const sameInstant: ReadonlyArray<readonly [string, string]> = [
      ["2028-02-29T08:00:00Z", "2028-02-29T13:45:00+05:45"],
      ["1996-03-01T01:00:00.250Z", "1996-02-29T21:30:00.25-03:30"],
      ["0000-01-01T00:00:00Z", "+000000-01-01T00:00:00+00:00"],
      ["+010000-01-01T00:00:00Z", "9999-12-31T22:00:00-02:00"],
      ["2025-06-10T24:00:00Z", "2025-06-11T00:00:00Z"],
      ["2025-06-10T24:00:00.00000Z", "2025-06-11T00:00:00.000Z"],
      ["2028-02-29T24:00:00-08:00", "2028-03-01T00:00:00-08:00"],
      ["2025-12-31T24:00:00+01:00", "2025-12-31T23:00:00Z"],
      ["2025-06-10T09:30Z", "2025-06-10T09:30:00.000Z"],
      ["2025-06-10T02:30-07:00", "2025-06-10T09:30:00Z"],
      ["2025-06-10T24:00Z", "2025-06-11T00:00:00Z"],
      ["2025-06-10T24:00-03:00", "2025-06-11T00:00:00-03:00"],
    ];

    for (const [left, right] of sameInstant) {
      it(`treats ${left} and ${right} as the same moment`, () => {
        expect(compareDateTimeStrings(left, right)).toBe(0);
        expect(compareDateTimeStrings(right, left)).toBe(0);
      });
    }
  });

  describe("malformed values", () => {
    const epoch = "1970-01-01T00:00:00Z";

    it("puts any malformed value ahead of a valid one", () => {
      expect(sign("garbage", epoch)).toBe(-1);
      expect(sign(epoch, "garbage")).toBe(1);
    });

    const rejected = [
      "2025-06-10",
      "2023-02-29",
      "2025-06-10T00:00:00",
      "2025-06-10T00:00:00.000",
      "06/10/2025",
      "June 10, 2025",
      "Tue, 10 Jun 2025 00:00:00 GMT",
      " 2025-06-10T00:00:00Z",
      "2025-06-10T00:00:00Z\t",
      "2025-02-30T00:00:00Z",
      "2100-02-29T00:00:00+02:00",
      "2025-06-31T00:00:00-05:00",
      "2025-06-10T08:00:00+24:00",
      "2025-06-10T24:30:00Z",
      "2025-06-10T24:00:30Z",
      "2025-06-10T24:00:00.01Z",
      "2025-06-10T24:15Z",
      "2025-06-10T26:00Z",
    ];

    for (const bad of rejected) {
      it(`rejects ${JSON.stringify(bad)} instead of letting Date guess`, () => {
        expect(sign(bad, epoch)).toBe(-1);
        expect(sign(epoch, bad)).toBe(1);
        expect(compareDateTimeStrings(bad, bad)).toBe(0);
        // Two malformed values fall back to plain string order.
        const other = "~~~";
        expect(sign(bad, other)).toBe(bad < other ? -1 : 1);
      });
    }

    it("compares two malformed values by UTF-16 code units", () => {
      expect(sign("x-lower", "x-Upper")).toBe(1);
      expect(sign("x-Upper", "x-lower")).toBe(-1);
      expect(sign("same", "same")).toBe(0);
    });
  });

  it("sorts a mixed list identically whatever the starting order", () => {
    const morning = "2025-06-10T07:00:00+13:00";
    const evening = "2025-06-09T23:00:00-11:00";
    const junk = "2025-06-10T??";

    const starts = [
      [junk, morning, evening],
      [junk, evening, morning],
      [morning, junk, evening],
      [morning, evening, junk],
      [evening, junk, morning],
      [evening, morning, junk],
    ];

    const results = new Set(starts.map((list) => list.toSorted(compareDateTimeStrings).join("|")));
    expect([...results]).toEqual([[junk, morning, evening].join("|")]);
  });
});
