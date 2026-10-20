import { AgentId, AgentProfileId } from "@kora/contracts";
import { CLAUDE_RESUME_COMPACTION_NEVER_ANSWER as NEVER } from "@kora/shared/claudeResumeCompaction";
import { describe, expect, it } from "vite-plus/test";

import { deriveAgentProfileEntries } from "../../agentProfiles";
import * as Meter from "./ContextWindowMeter.logic";

const CLAUDE = AgentId.make("claude");

/** A Claude profile in a continuation group; `compact` says whether it offers /compact. */
const claudeProfile = (
  instance: string,
  group: string,
  extra: { enabled?: boolean; compact?: boolean } = {},
) =>
  deriveAgentProfileEntries([
    {
      instanceId: AgentProfileId.make(instance),
      driver: CLAUDE,
      continuation: { groupKey: group },
      enabled: extra.enabled ?? true,
      slashCommands: extra.compact === false ? [] : [{ name: "compact", description: "" }],
      ...{ installed: true, status: "ready", version: null, auth: { status: "authenticated" } },
      ...{ models: [], skills: [], checkedAt: "2026-05-05T10:00:00.000Z" },
    },
  ])[0]!;

describe("contextWindowForComposer", () => {
  const usage = (usedPercentage: number | null) => ({ usedTokens: 900, usedPercentage });

  it("passes usage through untouched outside blob threads", () => {
    const tiny = usage(2);
    expect(Meter.contextWindowForComposer(tiny, false)).toBe(tiny);
    expect(Meter.contextWindowForComposer(null, false)).toBeNull();
  });

  it("shows a blob's ring only once the window is filling up", () => {
    const threshold = Meter.BLOB_CONTEXT_RING_MIN_PERCENT;
    expect(Meter.contextWindowForComposer(null, true)).toBeNull();
    expect(Meter.contextWindowForComposer(usage(null), true)).toBeNull();
    expect(Meter.contextWindowForComposer(usage(threshold - 0.5), true)).toBeNull();
    const full = usage(threshold);
    expect(Meter.contextWindowForComposer(full, true)).toBe(full);
  });
});

describe("shouldReserveContextWindowMeter", () => {
  const ALL_ON = Object.fromEntries(
    ["providerReportsContextWindow", "threadStarted", "detailLoading", "meterEnabled"].map(
      (key) => [key, true],
    ),
  ) as Parameters<typeof Meter.shouldReserveContextWindowMeter>[0];
  const reserve = (
    change: Partial<Parameters<typeof Meter.shouldReserveContextWindowMeter>[0]> = {},
  ) =>
    Meter.shouldReserveContextWindowMeter({
      ...ALL_ON,
      ...change,
    });

  it("holds the slot while a started thread's detail loads", () => {
    expect(reserve()).toBe(true);
    // A provider not in the catalog yet might still report usage.
    expect(reserve({ providerReportsContextWindow: null })).toBe(true);
  });

  it.each([
    ["the meter is off", { meterEnabled: false }],
    ["the provider never reports usage", { providerReportsContextWindow: false }],
    ["no turn ever ran", { threadStarted: false }],
    ["the detail already arrived", { detailLoading: false }],
  ])("reserves nothing when %s", (_why, change) => {
    expect(reserve(change)).toBe(false);
  });
});

describe("hasDismissedResumeCompaction", () => {
  const resolved = (answers: unknown) => ({ kind: "user-input.resolved", payload: { answers } });
  const resumeQuestion =
    "This session is 3h 5m old and uses 180,000 tokens. Compact it before continuing?";

  it("spots a permanent dismissal of Claude's resume prompt", () => {
    expect(Meter.hasDismissedResumeCompaction([resolved({ [resumeQuestion]: NEVER })])).toBe(true);
  });

  it("ignores other answers, other questions and malformed records", () => {
    expect(
      Meter.hasDismissedResumeCompaction([
        resolved({ [resumeQuestion]: "Compact now" }),
        resolved({ "Remind me about setup?": NEVER }),
        resolved({ "The log is huge. Compact it before continuing?": NEVER }),
        resolved([NEVER]),
        resolved(null),
        { kind: "user-input.resolved", payload: null },
        { kind: "user-input.requested", payload: { answers: { [resumeQuestion]: NEVER } } },
      ]),
    ).toBe(false);
  });
});

describe("shouldOfferResumeCompaction", () => {
  const now = "2026-05-05T12:00:00.000Z";
  const offer = (change: Partial<Parameters<typeof Meter.shouldOfferResumeCompaction>[0]> = {}) =>
    Meter.shouldOfferResumeCompaction({
      now,
      provider: "claude",
      usedTokens: 100_000,
      updatedAt: "2026-05-05T10:50:00.000Z",
      ...change,
    });

  it("offers for a Claude session of 100k tokens idle for 70 minutes or more", () => {
    expect(offer()).toBe(true);
  });

  it.each([
    ["another provider", { provider: "codex" }],
    ["a smaller session", { usedTokens: 99_999 }],
    ["unknown usage", { usedTokens: null }],
    ["a session used a minute too recently", { updatedAt: "2026-05-05T10:51:00.000Z" }],
    ["no update time", { updatedAt: null }],
    ["an unreadable time", { updatedAt: "yesterday" }],
  ])("does not offer for %s", (_why, change) => {
    expect(offer(change)).toBe(false);
  });
});

describe("compaction copy", () => {
  it("prefers the configured threshold, then the model, then neutral wording", () => {
    expect(Meter.formatContextWindowCompactionMessage("Opus", 150_000)).toBe(
      "Compacts automatically at 150,000 tokens.",
    );
    expect(Meter.formatContextWindowCompactionMessage("Opus", 0)).toBe(
      "Context for Opus compacts automatically when needed.",
    );
    expect(Meter.formatContextWindowCompactionMessage(null)).toBe(
      "Context compacts automatically when needed.",
    );
  });

  it("names the model as the selected instance lists it, or by slug", () => {
    const mine = AgentProfileId.make("codex-team");
    const options = new Map([
      [
        AgentProfileId.make("codex"),
        [{ slug: "m-1", name: "Other profile's name", shortName: "Other" }],
      ],
      [mine, [{ slug: "m-1", name: "Model One", shortName: "M1" }]],
    ]);
    expect(
      Meter.resolveContextWindowModelDisplayName({ instanceId: mine, model: "m-1" }, options),
    ).toBe("M1");
    expect(
      Meter.resolveContextWindowModelDisplayName({ instanceId: mine, model: "m-2" }, options),
    ).toBe("m-2");
    expect(Meter.resolveContextWindowModelDisplayName(null, options)).toBeNull();
  });
});

describe("compaction availability", () => {
  const home = "claude:home:/a";

  it("needs a profile that offers /compact", () => {
    expect(Meter.agentSupportsManualCompaction(claudeProfile("c1", home))).toBe(true);
    expect(Meter.agentSupportsManualCompaction(claudeProfile("c2", home, { compact: false }))).toBe(
      false,
    );
    expect(Meter.agentSupportsManualCompaction(undefined)).toBe(false);
  });

  it("falls back to another enabled profile only within the locked continuation group", () => {
    const original = claudeProfile("original", home, { enabled: false });
    const ask = (fallbackGroup: string) =>
      Meter.hasAvailableCompactionAgent({
        driverKind: CLAUDE,
        instanceId: original.instanceId,
        lockedInstanceId: original.instanceId,
        providers: [original, claudeProfile("fallback", fallbackGroup)],
      });
    expect(ask(home)).toBe(true);
    expect(ask("claude:home:/b")).toBe(false);
  });
});
