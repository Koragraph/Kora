import { describe, expect, it } from "vite-plus/test";
import type { AgentUsageLimits } from "@kora/contracts";

import {
  agyGroupForModel,
  percentLeft,
  resetClock,
  sectionSummary,
  signFrame,
  signFrames,
  signTone,
  signWidth,
  tightestWindow,
  usageReading,
  usageSections,
  usageSignLabel,
  usageTier,
} from "./usageSign.logic";
import { planWindowViews } from "~/util/planUsage";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const limits = (o: Partial<AgentUsageLimits> = {}): AgentUsageLimits =>
  ({
    checkedAt: "2026-10-13T11:56:00Z",
    windows: [
      {
        id: "five_hour",
        kind: "session",
        label: "5-hour session",
        usedPercent: 40,
        resetsAt: "2026-10-13T14:00:00Z",
      },
      {
        id: "seven_day",
        kind: "weekly",
        label: "Weekly · all models",
        usedPercent: 98,
        resetsAt: "2026-10-16T09:29:00Z",
      },
    ],
    plan: "Max",
    ...o,
  }) as AgentUsageLimits;

// agy's /usage groups, as the daemon maps them (usedPercent = round((1 - remaining_fraction) * 100)).
const { plan: _noPlan, ...noPlan } = limits();
const AGY = {
  ...noPlan,
  windows: [
    {
      id: "gemini-5h",
      kind: "session",
      label: "Gemini Models · 5-hour",
      usedPercent: 0,
      resetsAt: "2026-10-13T15:00:00Z",
    },
    {
      id: "gemini-weekly",
      kind: "weekly",
      label: "Gemini Models · Weekly",
      usedPercent: 12,
      resetsAt: "2026-10-19T12:57:19Z",
    },
    {
      id: "3p-5h",
      kind: "session",
      label: "Claude and GPT models · 5-hour",
      usedPercent: 81,
      resetsAt: "2026-10-13T15:00:00Z",
    },
    {
      id: "3p-weekly",
      kind: "weekly",
      label: "Claude and GPT models · Weekly",
      usedPercent: 63,
      resetsAt: "2026-10-20T06:04:17Z",
    },
  ],
} as AgentUsageLimits;

/** The face region of a frame: body columns 0..7, rows 4..8 (eyes + where a mouth would go). */
const face = (rows: readonly string[]) => rows.slice(4, 9).map((r) => r.slice(0, 8));
const darkPixels = (rows: readonly string[]) => face(rows).join("").split("K").length - 1;

describe("usage tiers", () => {
  it("maps percent used to tiers, limited to 4", () => {
    expect([0, 49, 50, 79, 80, 94, 95, 100].map((u) => usageTier(u, false))).toEqual([
      0, 0, 1, 1, 2, 2, 3, 3,
    ]);
    expect(usageTier(10, true)).toBe(4);
  });
  it("tier 0 (fresh week) has eyes only: no mouth", () => {
    for (const f of signFrames(0, 90)) {
      expect(face(f.rows)[3]).not.toContain("K"); // the mouth row (body row 5) stays white
      expect(darkPixels(f.rows)).toBe(4); // two 1x2 eyes, nothing else
    }
  });
  it("no tier ever draws a mouth (eyes only)", () => {
    for (const tier of [0, 1, 2, 3, 4] as const)
      for (const f of signFrames(tier, 3)) expect(face(f.rows)[3]).not.toContain("K");
  });
  it("tier 3 is worried (eyes raised, no mouth); tier 2 blinks; tier 4 sits asleep with a z", () => {
    const worried = signFrames(3, 3)[0]!.rows;
    expect(darkPixels(worried)).toBe(4);
    expect(face(worried)[3]).not.toContain("K");
    const tired = signFrames(2, 10);
    expect(tired.some((f) => f.rows.join("").includes("S") && darkPixels(f.rows) === 2)).toBe(true);
    expect(tired.some((f) => darkPixels(f.rows) === 4 && face(f.rows)[2]!.includes("KK"))).toBe(
      true,
    ); // closed
    const asleep = signFrames(4, 0);
    expect(asleep[0]!.rows[9]!.startsWith("WS....WS")).toBe(true);
    expect(
      asleep.map((f) =>
        f.rows
          .slice(0, 2)
          .map((r) => r.slice(0, 8))
          .join("")
          .replace(/\./g, ""),
      ),
    ).toEqual(["D", "L"]);
  });
});

describe("the sign", () => {
  it("holds percent LEFT, 0 when limited", () => {
    expect(percentLeft(98, false)).toBe(2);
    expect(percentLeft(0, false)).toBe(100);
    expect(percentLeft(30, true)).toBe(0);
  });
  it("is grey, amber under 20% left, red under 5%", () => {
    expect([50, 19, 4, 0].map(signTone)).toEqual(["M", "A", "R", "R"]);
    expect(signFrame({ left: 2, face: "worried" }).join("")).toContain("R");
    expect(signFrame({ left: 60, face: "open" }).join("")).not.toMatch(/[RA]/);
  });
  it("fits a 10-row grid (20 px at 2x) and sizes the board to the digits", () => {
    expect(signWidth(42)).toBe(18);
    expect(signWidth(100)).toBe(22);
    const rows = signFrame({ left: 42, face: "open" });
    expect(rows).toHaveLength(10);
    expect(rows.every((r) => r.length === 18)).toBe(true);
  });
});

describe("the reading", () => {
  it("composer holds up the 5-hour session, sidebar the week; falls back when the kind is missing", () => {
    const views = planWindowViews(limits(), NOW);
    expect(tightestWindow(views, "session")?.kind).toBe("session");
    expect(tightestWindow(views, "weekly")?.id).toBe("seven_day");
    const weeklyOnly = views.filter((v) => v.kind === "weekly");
    expect(tightestWindow(weeklyOnly, "session")?.kind).toBe("weekly");
    const composer = usageReading({
      driver: "claude",
      limits: limits(),
      now: NOW,
      prefer: "session",
    })!;
    const sidebar = usageReading({
      driver: "claude",
      limits: limits(),
      now: NOW,
      prefer: "weekly",
    })!;
    expect(composer.window?.kind).toBe("session");
    expect(sidebar.window?.kind).toBe("weekly");
  });
  it("picks the tightest window (highest used)", () => {
    expect(tightestWindow(planWindowViews(limits(), NOW))?.id).toBe("seven_day");
    const r = usageReading({ driver: "claude", limits: limits(), now: NOW })!;
    expect(r).toMatchObject({ provider: "Claude", left: 2, tier: 3, limited: false });
    expect(usageSignLabel(r, NOW)).toBe(
      "Claude plan: 2% of this week left (checked 4 min ago). Show details",
    );
  });
  it("a live limit reads 0 left, tier 4", () => {
    const r = usageReading({
      driver: "codex",
      limits: limits({ limited: { resetsAt: "2026-10-16T20:25:00Z" } }),
      now: NOW,
    })!;
    expect(r).toMatchObject({ provider: "Codex", left: 0, tier: 4, limited: true });
    expect(usageSignLabel(r, NOW)).toMatch(/^Codex plan: limit reached/);
  });
  it("hides for providers with no plan data, no reading, or an API-key account", () => {
    expect(usageReading({ driver: "opencode", limits: limits(), now: NOW })).toBeNull();
    expect(usageReading({ driver: "claude", limits: null, now: NOW })).toBeNull();
    expect(
      usageReading({
        driver: "claude",
        limits: limits({ windows: [], unavailable: { reason: "unsupported" } }),
        now: NOW,
      }),
    ).toBeNull();
  });
  it("Antigravity: the selected model's quota group, its tightest window", () => {
    const groups = ["Gemini Models", "Claude and GPT models"];
    expect(agyGroupForModel("gemini-3.8-flash-high", groups)).toBe("Gemini Models");
    expect(agyGroupForModel("claude-sonnet-4-6", groups)).toBe("Claude and GPT models");
    expect(agyGroupForModel("gpt-oss-120b-medium", groups)).toBe("Claude and GPT models");
    const gem = usageReading({
      driver: "antigravity",
      model: "gemini-3.1-pro-high",
      limits: AGY,
      now: NOW,
    })!;
    expect(gem).toMatchObject({ group: "Gemini Models", left: 88, tier: 0 });
    const third = usageReading({
      driver: "antigravity",
      model: "claude-opus-4-6-thinking",
      limits: AGY,
      now: NOW,
    })!;
    expect(third).toMatchObject({ group: "Claude and GPT models", left: 19, tier: 2 });
    expect(usageSignLabel(third, NOW)).toBe(
      "Antigravity Claude and GPT models: 19% of this 5-hour window left (checked 4 min ago). Show details",
    );
  });
});

describe("the Claude sign and the thread's model", () => {
  const scoped = limits({
    windows: [
      { id: "five_hour", kind: "session", label: "5-hour session", usedPercent: 20 },
      { id: "seven_day", kind: "weekly", label: "Weekly · all models", usedPercent: 30 },
      { id: "seven_day_fable", kind: "weekly", label: "Weekly · Fable", usedPercent: 95 },
    ],
  } as Partial<AgentUsageLimits>);
  it("a Fable week at 95% does not drive the sign on a Haiku thread", () => {
    const haiku = usageReading({
      driver: "claude",
      model: "claude-haiku-5-5",
      limits: scoped,
      now: NOW,
    })!;
    expect(haiku.usedPercent).toBe(30);
    const none = usageReading({ driver: "claude", model: "default", limits: scoped, now: NOW })!;
    expect(none.usedPercent).toBe(30);
  });
  it("on a Fable thread the Fable week is the one that shows", () => {
    const fable = usageReading({
      driver: "claude",
      model: "claude-fable-5-1",
      limits: scoped,
      now: NOW,
    })!;
    expect(fable.usedPercent).toBe(95);
    expect(fable.window?.label).toBe("Weekly · Fable");
  });
});

describe("popover sections", () => {
  const providers = [
    {
      instanceId: "codex",
      driver: "codex",
      usageLimits: limits({ plan: "Free", limited: { resetsAt: "2026-10-16T20:25:00Z" } }),
    },
    { instanceId: "claude", driver: "claude", usageLimits: limits() },
    { instanceId: "antigravity", driver: "antigravity", usageLimits: AGY },
    { instanceId: "opencode", driver: "opencode", usageLimits: limits() },
  ];
  it("lists every provider with data, current first, Antigravity grouped", () => {
    const s = usageSections(providers, "antigravity", NOW);
    expect(s.map((x) => [x.driver, x.current])).toEqual([
      ["antigravity", true],
      ["claude", false],
      ["codex", false],
    ]);
    expect(s[0]!.groups.map((g) => [g.name, g.windows.length])).toEqual([
      ["Gemini Models", 2],
      ["Claude and GPT models", 2],
    ]);
    expect(sectionSummary(s[2]!, NOW)).toMatch(/^Codex Free: limited, resets \w{3} \d/);
  });
  it("rounds a reset reported at hh:59:59.89 to the minute", () => {
    const l = limits({
      windows: [
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly · all models",
          usedPercent: 10,
          resetsAt: "2026-10-16T20:59:59.890Z",
        },
      ],
    } as Partial<AgentUsageLimits>);
    const [w] = planWindowViews(l, NOW);
    expect(w!.resetsAt).toBe(Date.parse("2026-10-16T21:00:00Z"));
    expect(resetClock(w!.resetsAt, NOW, "UTC")).toBe("resets Fri 9:00 PM");
  });
  it("formats resets as a local clock time", () => {
    expect(resetClock(Date.parse("2026-10-16T09:29:00Z"), NOW, "UTC")).toBe("resets Fri 9:29 AM");
  });
});
