/**
 * The composer's usage sign (docs/ui/usage-sprite-gallery.html, concept #7 "Holds a sign"): which provider's plan it
 * reads, the tightest window, the percent LEFT it holds up, the mood tier, the frames it plays, and the rows of its
 * details popover. Pure; `now` is always passed in.
 *
 * Providers with plan data: Claude, Codex and Antigravity (agy's quota groups, windows labelled "<group> · Weekly").
 * Anything else (OpenCode, ACP agents, API-key accounts) has no reading and the sign is hidden: never a fake number.
 */
import type { AgentUsageLimits } from "@kora/contracts";

import type { AnimFrame } from "../sprite";
import {
  activePlanLimit,
  formatResetPhrase,
  planWindowViews,
  type PlanWindowView,
} from "~/util/planUsage";

export type UsageDriver = "claude" | "codex" | "antigravity";
export const USAGE_DRIVERS: ReadonlyArray<UsageDriver> = ["claude", "codex", "antigravity"];
const DRIVER_NAMES: Record<UsageDriver, string> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
};
export const isUsageDriver = (d: unknown): d is UsageDriver =>
  d === "claude" || d === "codex" || d === "antigravity";

/** 0 fresh (<50% used) · 1 (<80) · 2 tired (<95) · 3 worried · 4 limited (asleep, sitting). */
export type UsageTier = 0 | 1 | 2 | 3 | 4;

export function usageTier(usedPercent: number, limited: boolean): UsageTier {
  if (limited) return 4;
  if (usedPercent < 50) return 0;
  if (usedPercent < 80) return 1;
  if (usedPercent < 95) return 2;
  return 3;
}

/** What the sign holds up: the share LEFT, 0 when the provider is refusing turns. */
export function percentLeft(usedPercent: number, limited: boolean): number {
  if (limited) return 0;
  return Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
}

/** The sign board's colour key: red under 5% left, amber under 20%, else the M grey. */
export function signTone(left: number): "M" | "A" | "R" {
  if (left < 5) return "R";
  if (left < 20) return "A";
  return "M";
}

/** Which window a sign holds up: the composer's is the 5-hour session, the sidebar's the week. */
export type UsageWindowPreference = "session" | "weekly";

/**
 * The most used window (ties → the shorter one, session before weekly). With a preference, the tightest window of
 * that kind wins when the provider reports one; otherwise it falls back to the tightest of all.
 */
export function tightestWindow(
  views: ReadonlyArray<PlanWindowView>,
  prefer?: UsageWindowPreference,
): PlanWindowView | null {
  if (prefer) {
    const own = views.filter((v) => v.kind === prefer);
    if (own.length > 0) return tightestWindow(own);
  }
  const order = { session: 0, weekly: 1, monthly: 2, other: 3 } as const;
  let best: PlanWindowView | null = null;
  for (const v of views) {
    if (
      !best ||
      v.usedPercent > best.usedPercent ||
      (v.usedPercent === best.usedPercent && order[v.kind] < order[best.kind])
    )
      best = v;
  }
  return best;
}

// ── Antigravity groups ───────────────────────────────────────────────────────────────────────────────────────────
const GROUP_SEP = " · ";

/** "Gemini Models · Weekly" → { group: "Gemini Models", span: "Weekly" }; a label without a group keeps it whole. */
export function splitGroupLabel(label: string): { group: string | null; span: string } {
  const at = label.lastIndexOf(GROUP_SEP);
  if (at <= 0) return { group: null, span: label };
  return { group: label.slice(0, at), span: label.slice(at + GROUP_SEP.length) };
}

/** The agy quota group a model draws from: gemini-* → the Gemini group, claude-* / gpt-* → the Claude-and-GPT one. */
export function agyGroupForModel(
  model: string | null | undefined,
  groups: ReadonlyArray<string>,
): string | null {
  const m = (model ?? "").toLowerCase();
  const find = (re: RegExp) => groups.find((g) => re.test(g)) ?? null;
  if (m.startsWith("gemini")) return find(/gemini/i);
  if (m.startsWith("claude") || m.startsWith("gpt")) return find(/claude|gpt/i);
  return null;
}

function groupsOf(views: ReadonlyArray<PlanWindowView>): string[] {
  const out: string[] = [];
  for (const v of views) {
    const g = splitGroupLabel(v.label).group;
    if (g && !out.includes(g)) out.push(g);
  }
  return out;
}

// ── the reading ──────────────────────────────────────────────────────────────────────────────────────────────────
export interface UsageReading {
  readonly driver: UsageDriver;
  /** "Claude", "Codex", "Antigravity". */
  readonly provider: string;
  readonly plan: string | null;
  /** The agy quota group the reading is for (Antigravity only). */
  readonly group: string | null;
  readonly window: PlanWindowView | null;
  readonly usedPercent: number;
  readonly left: number;
  readonly limited: boolean;
  readonly limitResetsAt: number | null;
  readonly tier: UsageTier;
  /** When the daemon last read these numbers (epoch ms), for the sign's "checked 12 min ago". */
  readonly checkedAt: number | null;
}

/** Whether a provider's limits carry anything worth showing (windows, or a live limit). */
export function hasUsageData(limits: AgentUsageLimits | null | undefined, now: number): boolean {
  if (!limits) return false;
  if (limits.unavailable?.reason === "unsupported") return false;
  return limits.windows.length > 0 || activePlanLimit(limits, now) !== null;
}

/**
 * The sign's reading for the composer's current selection, or null (hide the sign): a provider without plan data,
 * no reading yet, or an account that never reports windows.
 */
export function usageReading(input: {
  readonly driver: string | null | undefined;
  readonly model?: string | null | undefined;
  readonly limits: AgentUsageLimits | null | undefined;
  readonly now: number;
  readonly prefer?: UsageWindowPreference | undefined;
}): UsageReading | null {
  const { driver, limits, now } = input;
  if (!isUsageDriver(driver) || !limits || !hasUsageData(limits, now)) return null;
  let views = planWindowViews(limits, now);
  let group: string | null = null;
  if (driver === "antigravity") {
    group = agyGroupForModel(input.model, groupsOf(views));
    if (group) views = views.filter((v) => splitGroupLabel(v.label).group === group);
  }
  if (driver === "claude") views = claudeWindowsForModel(views, input.model);
  const limit = activePlanLimit(limits, now);
  const window = tightestWindow(views, input.prefer);
  if (!window && !limit) return null;
  const checked = Date.parse(limits.checkedAt);
  const usedPercent = window?.usedPercent ?? 100;
  const limited = limit !== null;
  return {
    driver,
    provider: DRIVER_NAMES[driver],
    plan: limits.plan ?? null,
    group,
    window,
    usedPercent,
    left: percentLeft(usedPercent, limited),
    limited,
    limitResetsAt: limit?.resetsAt ?? null,
    tier: usageTier(usedPercent, limited),
    checkedAt: Number.isFinite(checked) ? checked : null,
  };
}

const CLAUDE_FAMILY = /(opus|sonnet|haiku|fable)/i;

/**
 * Claude splits the weekly cap per model family (`seven_day_fable`, "Weekly · Fable"). The sign holds up the windows
 * every turn draws on (5-hour session, all-models week) plus the per-model week of the thread's own model, so a
 * Fable bar at 95% does not drive the sign on a Haiku thread.
 */
export function claudeWindowsForModel(
  views: ReadonlyArray<PlanWindowView>,
  model: string | null | undefined,
): PlanWindowView[] {
  const family = CLAUDE_FAMILY.exec(model ?? "")?.[1]?.toLowerCase() ?? null;
  return views.filter((v) => {
    if (!v.id.startsWith("seven_day_")) return true;
    return family !== null && v.label.toLowerCase().includes(family);
  });
}

function windowPhrase(w: PlanWindowView | null): string {
  if (!w) return "the plan";
  const span = splitGroupLabel(w.label).span;
  if (w.kind === "weekly") return "this week";
  if (w.kind === "session") return "this 5-hour window";
  if (w.kind === "monthly") return "this month";
  return span;
}

/** "Claude plan: 2% of this week left. Show details" — the sign button's accessible name. */
export function usageSignLabel(r: UsageReading, now: number): string {
  if (r.provider === "Context window") return `Context window: ${r.left}% left. Show details`;
  const who = r.group ? `${r.provider} ${r.group}` : `${r.provider} plan`;
  if (r.limited) {
    const reset = formatResetPhrase(r.limitResetsAt, now);
    return `${who}: limit reached${reset ? `, ${reset}` : ""}. Show details`;
  }
  const age = r.checkedAt !== null ? checkedAgo(r.checkedAt, now) : null;
  return `${who}: ${r.left}% of ${windowPhrase(r.window)} left${age ? ` (${age})` : ""}. Show details`;
}

// ── popover rows ─────────────────────────────────────────────────────────────────────────────────────────────────
export interface UsageProviderInput {
  readonly instanceId: string;
  readonly driver: string;
  readonly displayName?: string | null | undefined;
  readonly usageLimits?: AgentUsageLimits | null | undefined;
}

export interface UsageSection {
  readonly instanceId: string;
  readonly driver: UsageDriver;
  readonly name: string;
  readonly plan: string | null;
  readonly checkedAt: number | null;
  readonly stale: boolean;
  readonly limit: { resetsAt: number | null } | null;
  /** Windows grouped (Antigravity's quota groups); one unnamed group otherwise. */
  readonly groups: ReadonlyArray<{
    readonly name: string | null;
    readonly windows: PlanWindowView[];
  }>;
  readonly current: boolean;
}

/**
 * Every provider with plan data, current one first. One section per driver (the instance that carries the
 * reading); names are the drivers' own ("Claude", not a renamed picker label) so the popover reads as plans.
 */
export function usageSections(
  providers: ReadonlyArray<UsageProviderInput>,
  currentDriver: string | null | undefined,
  now: number,
): UsageSection[] {
  const out: UsageSection[] = [];
  for (const d of USAGE_DRIVERS) {
    const p = providers.find((x) => x.driver === d && hasUsageData(x.usageLimits, now));
    if (!p || !p.usageLimits) continue;
    const limits = p.usageLimits;
    const views = planWindowViews(limits, now);
    const groups: { name: string | null; windows: PlanWindowView[] }[] = [];
    for (const v of views) {
      const name = d === "antigravity" ? splitGroupLabel(v.label).group : null;
      let g = groups.find((x) => x.name === name);
      if (!g) groups.push((g = { name, windows: [] }));
      g.windows.push(v);
    }
    const checked = Date.parse(limits.checkedAt);
    const limit = activePlanLimit(limits, now);
    out.push({
      instanceId: p.instanceId,
      driver: d,
      name: DRIVER_NAMES[d],
      plan: limits.plan ?? null,
      checkedAt: Number.isFinite(checked) ? checked : null,
      stale: limits.unavailable?.reason === "probeFailed",
      limit: limit ? { resetsAt: limit.resetsAt } : null,
      groups,
      current: d === currentDriver,
    });
  }
  return out.sort((a, b) => Number(b.current) - Number(a.current));
}

/** "Codex Free: limited, resets Fri 8:25 PM" / "Claude Max: 98% left" — a collapsed section's one line. */
export function sectionSummary(s: UsageSection, now: number): string {
  const who = s.plan ? `${s.name} ${s.plan}` : s.name;
  if (s.limit) {
    const reset = formatResetPhrase(s.limit.resetsAt, now);
    return `${who}: limited${reset ? `, ${reset}` : ""}`;
  }
  const all = s.groups.flatMap((g) => g.windows);
  const t = tightestWindow(all);
  if (!t) return `${who}: no windows reported`;
  return `${who}: ${percentLeft(t.usedPercent, false)}% left · ${t.label}`;
}

/** "checked 4 min ago" / "checked just now". */
export function checkedAgo(at: number | null, now: number): string | null {
  if (at === null) return null;
  const mins = Math.floor((now - at) / 60_000);
  if (mins < 1) return "checked just now";
  if (mins < 60) return `checked ${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `checked ${hours} h ago`;
  return `checked ${Math.floor(hours / 24)} d ago`;
}

/** "resets Fri 2:29 AM" in local time, always a clock time (the popover's rows; the ring keeps "in 2h"). */
export function resetClock(at: number | null, now: number, timeZone?: string): string | null {
  if (at === null) return null;
  if (at <= now) return "reset";
  const tz = timeZone ? { timeZone } : {};
  const day = new Intl.DateTimeFormat("en-US", { weekday: "short", ...tz }).format(at);
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    ...tz,
  }).format(at);
  if (at - now < 6 * 86_400_000) return `resets ${day} ${time}`;
  const date = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", ...tz }).format(
    at,
  );
  return `resets ${date}, ${time}`;
}

// ── the sprite ───────────────────────────────────────────────────────────────────────────────────────────────────
// A horizontal variant of the gallery's sign: the 8x8 Kora body on the left, the board beside it on a post, held by
// one hand pixel. Grid height 10 (rendered at 2x = 20 px, inside the footer's 28 px controls); width 9 + board.

export const SIGN_H = 10;
/** 3x5 pixel digits (the gallery's DIG). */
const DIG: Record<string, readonly string[]> = {
  0: ["QQQ", "Q.Q", "Q.Q", "Q.Q", "QQQ"],
  1: [".Q.", "QQ.", ".Q.", ".Q.", "QQQ"],
  2: ["QQQ", "..Q", "QQQ", "Q..", "QQQ"],
  3: ["QQQ", "..Q", ".QQ", "..Q", "QQQ"],
  4: ["Q.Q", "Q.Q", "QQQ", "..Q", "..Q"],
  5: ["QQQ", "Q..", "QQQ", "..Q", "QQQ"],
  6: ["QQQ", "Q..", "QQQ", "Q.Q", "QQQ"],
  7: ["QQQ", "..Q", ".Q.", ".Q.", ".Q."],
  8: ["QQQ", "Q.Q", "QQQ", "Q.Q", "QQQ"],
  9: ["QQQ", "Q.Q", "QQQ", "..Q", "QQQ"],
};

export type SignFace = "open" | "look" | "tired" | "closed" | "worried";

/** Grid width for a number: body (8) + hand column (1) + board (4 per digit + 1). */
export const signWidth = (left: number): number => 9 + String(left).length * 4 + 1;

/** One frame of the sign. Every face is eyes only: the sprite never has a mouth (user's call). */
export function signFrame(o: {
  readonly left: number;
  readonly face: SignFace;
  readonly sitting?: boolean;
  readonly wiggle?: boolean;
  readonly z?: 0 | 1 | null;
}): string[] {
  const n = String(o.left);
  const W = signWidth(o.left);
  const g: string[][] = Array.from({ length: SIGN_H }, () => Array<string>(W).fill("."));
  const put = (x: number, y: number, c: string) => {
    if (x >= 0 && x < W && y >= 0 && y < SIGN_H) g[y]![x] = c;
  };
  const stamp = (x: number, y: number, rows: readonly string[]) =>
    rows.forEach((r, j) =>
      [...r].forEach((ch, i) => {
        if (ch !== ".") put(x + i, y + j, ch);
      }),
    );
  // body (rows 2..8) + legs (row 9)
  stamp(0, 2, ["..WWWW..", ".WWWWWS.", "WWWWWWWS", "WWWWWWWS", "WWWWWWWS", "WWWWWWWS", ".WWWWWS."]);
  stamp(0, 9, [o.sitting ? "WS....WS" : ".WS..WS."]);
  const e = (i: number, j: number, c = "K") => put(i, 2 + j, c);
  switch (o.face) {
    case "open":
      e(1, 3);
      e(1, 4);
      e(5, 3);
      e(5, 4);
      break;
    case "look":
      e(2, 3);
      e(2, 4);
      e(6, 3);
      e(6, 4);
      break;
    case "tired": // half-lidded: lid (S) over a 1-px eye
      e(1, 3, "S");
      e(5, 3, "S");
      e(1, 4);
      e(5, 4);
      break;
    case "closed":
      e(1, 4);
      e(2, 4);
      e(4, 4);
      e(5, 4);
      break;
    case "worried": // eyes only (never a mouth): raised a pixel, looking up anxiously
      e(1, 2);
      e(1, 3);
      e(5, 2);
      e(5, 3);
      break;
  }
  if (o.z === 0) put(6, 1, "D");
  if (o.z === 1) put(7, 0, "L");
  // board on a post, held by the hand
  const tone = signTone(o.left);
  const bx = 9;
  const by = o.wiggle ? 1 : 0;
  const bw = n.length * 4 + 1;
  for (let y = by; y < by + 7; y++) for (let x = bx; x < bx + bw; x++) put(x, y, tone);
  const ink = tone === "A" ? "K" : "Q";
  [...n].forEach((ch, i) =>
    stamp(
      bx + 1 + i * 4,
      by + 1,
      DIG[ch]!.map((r) => r.replace(/Q/g, ink)),
    ),
  );
  const post = bx + Math.floor(bw / 2);
  for (let y = by + 7; y < SIGN_H; y++) put(post, y, "G");
  put(8, by + 5, "W");
  return g.map((r) => r.join(""));
}

/** The loop for a reading. Frame 0 is the resting pose (what reduced motion shows). */
export function signFrames(tier: UsageTier, left: number): AnimFrame[] {
  const F = (o: Parameters<typeof signFrame>[0], ms: number): AnimFrame => ({
    rows: signFrame(o),
    ms,
  });
  switch (tier) {
    case 0:
      return [
        F({ left, face: "open" }, 3200),
        F({ left, face: "open", wiggle: true }, 160),
        F({ left, face: "open" }, 160),
        F({ left, face: "open", wiggle: true }, 160),
        F({ left, face: "open" }, 2400),
        F({ left, face: "look" }, 700),
      ];
    case 1:
      return [
        F({ left, face: "open" }, 4200),
        F({ left, face: "open", wiggle: true }, 180),
        F({ left, face: "open" }, 180),
        F({ left, face: "open", wiggle: true }, 180),
      ];
    case 2:
      return [
        F({ left, face: "tired" }, 3600),
        F({ left, face: "closed" }, 420),
        F({ left, face: "tired" }, 2800),
        F({ left, face: "tired", wiggle: true }, 240),
      ];
    case 3:
      return [
        F({ left, face: "worried" }, 2200),
        F({ left, face: "worried", wiggle: true }, 130),
        F({ left, face: "worried" }, 130),
        F({ left, face: "worried", wiggle: true }, 130),
      ];
    case 4:
      return [
        F({ left: 0, face: "closed", sitting: true, z: 0 }, 1100),
        F({ left: 0, face: "closed", sitting: true, z: 1 }, 1100),
      ];
  }
}
