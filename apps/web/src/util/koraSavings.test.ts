import { describe, expect, it } from "vite-plus/test";

import {
  formatSavedUsd,
  LEVER_LABELS,
  leverChips,
  parseSavingsReport,
  reportForThread,
  SAVINGS_ESTIMATE_NOTE,
  unpricedNote,
} from "./koraSavings";

const totals = (saved: number, by: Record<string, number> = {}) => ({
  savedUsd: saved,
  paidUsd: 0.39,
  byLever: by,
});

describe("koraSavings", () => {
  it("parses the daemon report and fills missing levers with zero", () => {
    const r = parseSavingsReport({
      session: totals(0.88, { swarm: 0.52 }),
      week: totals(14.2),
      all: totals(61),
      since: "2026-10-14",
    });
    expect(r?.session?.byLever.swarm).toBe(0.52);
    expect(r?.session?.byLever.graph).toBe(0);
    expect(r?.since).toBe("2026-10-14");
    expect(parseSavingsReport({ week: null })).toBeNull();
  });

  it("says which models it could not price instead of guessing", () => {
    const r = parseSavingsReport({
      week: totals(1),
      all: totals(1),
      pricing: { catalogAt: 1, unpriced: ["mystery-9", 4] },
    });
    expect(r?.unpriced).toEqual(["mystery-9"]);
    expect(unpricedNote(r!.unpriced)).toBe("Not counted (no public price yet): mystery-9");
    expect(unpricedNote([])).toBeNull();
    expect(parseSavingsReport({ week: totals(1), all: totals(1) })?.unpriced).toEqual([]);
  });

  it("formats money for the headline", () => {
    expect(formatSavedUsd(0)).toBe("$0.00");
    expect(formatSavedUsd(0.004)).toBe("<$0.01");
    expect(formatSavedUsd(0.876)).toBe("$0.88");
    expect(formatSavedUsd(1204.4)).toBe("$1,204");
  });

  it("shows only levers worth a cent, biggest first", () => {
    const t = parseSavingsReport({
      session: null,
      week: totals(1, { reads: 0.19, swarm: 0.52, cache: 0.001 }),
      all: totals(1),
    })!.week;
    expect(leverChips(t).map((c) => c.lever)).toEqual(["swarm", "reads"]);
  });
});

// Audit 2026-10-15 (6-ux-code-surface #11): the popover credited "Cache" to Kora, never said the numbers are API-price
// estimates, and kept the previous thread's report on screen until the new fetch finished.
describe("koraSavings honesty", () => {
  it("labels the keep-warm lever as Kora's, never the provider's plain prompt cache", () => {
    expect(LEVER_LABELS.cache).not.toBe("Cache");
    expect(SAVINGS_ESTIMATE_NOTE).toBe("Estimated at API prices");
  });

  it("shows a report only for the thread it was fetched for", () => {
    const report = parseSavingsReport({ session: totals(1), week: totals(1), all: totals(1) });
    expect(reportForThread({ threadId: "a", report }, "a")).toBe(report);
    expect(reportForThread({ threadId: "a", report }, "b")).toBeNull();
    expect(reportForThread({ threadId: null, report }, undefined)).toBe(report);
    expect(reportForThread(null, "a")).toBeNull();
  });
});
