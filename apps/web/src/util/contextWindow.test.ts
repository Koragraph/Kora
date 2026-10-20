import { EventId, TurnId, type ChatThreadActivity } from "@kora/contracts";
import { describe, expect, test } from "vite-plus/test";

import { formatContextWindowTokens, formatUsd, latestContextWindowSnapshot } from "./contextWindow";

let counter = 0;
const activity = (kind: string, payload: unknown): ChatThreadActivity => ({
  id: EventId.make(`ev-${++counter}`),
  tone: "info",
  kind,
  summary: kind,
  payload,
  turnId: TurnId.make("turn-x"),
  createdAt: "2026-05-05T12:00:00.000Z",
});
const usage = (payload: unknown) => activity("context-window.updated", payload);

describe("latestContextWindowSnapshot", () => {
  test("picks the newest usage event and skips other kinds", () => {
    const snap = latestContextWindowSnapshot([
      usage({ usedTokens: 1_000 }),
      usage({
        usedTokens: 22_500,
        maxTokens: 400_000,
        compactsAutomatically: true,
        autoCompactThreshold: 320_000,
      }),
      activity("tool.started", {}),
    ]);
    expect(snap).toMatchObject({
      usedTokens: 22_500,
      maxTokens: 400_000,
      compactsAutomatically: true,
      autoCompactThreshold: 320_000,
      totalProcessedTokens: null,
    });
  });

  test("a newer malformed event does not hide an older valid one", () => {
    const snap = latestContextWindowSnapshot([usage({ usedTokens: 7 }), usage({ nonsense: true })]);
    expect(snap?.usedTokens).toBe(7);
  });

  test.each([
    ["no tokens", {}],
    ["negative tokens", { usedTokens: -1 }],
    ["non-numeric tokens", { usedTokens: "12" }],
    ["NaN tokens", { usedTokens: Number.NaN }],
    ["a non-object payload", "text"],
    ["a null payload", null],
  ])("%s yields no snapshot", (_label, payload) => {
    expect(latestContextWindowSnapshot([usage(payload)])).toBeNull();
  });

  test("no usage events at all yields no snapshot", () => {
    expect(latestContextWindowSnapshot([])).toBeNull();
    expect(latestContextWindowSnapshot([activity("tool.started", {})])).toBeNull();
  });

  test("zero usage is valid and derives the percentages", () => {
    expect(
      latestContextWindowSnapshot([usage({ usedTokens: 0, maxTokens: 80_000 })]),
    ).toMatchObject({
      usedTokens: 0,
      remainingTokens: 80_000,
      usedPercentage: 0,
      remainingPercentage: 100,
    });
  });

  test("usage beyond the window is capped at 100% with nothing remaining", () => {
    expect(latestContextWindowSnapshot([usage({ usedTokens: 150, maxTokens: 100 })])).toMatchObject(
      {
        usedPercentage: 100,
        remainingPercentage: 0,
        remainingTokens: 0,
      },
    );
  });

  test("without a window size no percentages are invented", () => {
    expect(latestContextWindowSnapshot([usage({ usedTokens: 50 })])).toMatchObject({
      maxTokens: null,
      usedPercentage: null,
      remainingPercentage: null,
      remainingTokens: null,
    });
  });

  test("lifetime tokens and cost/source metadata are carried through", () => {
    const snap = latestContextWindowSnapshot([
      usage({
        usedTokens: 44_850,
        totalProcessedTokens: 748_126,
        maxTokens: 1_000_000,
        costUsd: 0.0123,
        source: "provider",
      }),
    ]);
    expect(snap).toMatchObject({
      totalProcessedTokens: 748_126,
      costUsd: 0.0123,
      source: "provider",
    });
    expect(snap?.usedPercentage).toBeCloseTo(4.485);
  });

  test("an unknown source label is dropped", () => {
    expect(
      latestContextWindowSnapshot([usage({ usedTokens: 1, source: "guess" })])?.source,
    ).toBeNull();
  });
});

describe("formatters", () => {
  test.each([
    [null, "0"],
    [Number.NaN, "0"],
    [0, "0"],
    [999, "999"],
    [1_000, "1k"],
    [1_400, "1.4k"],
    [9_900, "9.9k"],
    [14_000, "14k"],
    [258_000, "258k"],
    [1_000_000, "1M"],
    [1_250_000, "1.3M"],
  ])("token count %s -> %s", (input, expected) => {
    expect(formatContextWindowTokens(input)).toBe(expected);
  });

  test.each([
    [null, null],
    [undefined, null],
    [0, null],
    [-3, null],
    [Number.NaN, null],
    [0.004, "<$0.01"],
    [0.0123, "$0.01"],
    [9.994, "$9.99"],
    [12.4, "$12"],
    [12_345.6, "$12,346"],
  ])("usd %s -> %s", (input, expected) => {
    expect(formatUsd(input)).toBe(expected);
  });
});
