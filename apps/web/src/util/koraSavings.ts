import { fetchPrimaryHost } from "../hosts/primary/shellAuth";

/** The daemon's money report (runtime `ledger/savings.ts`), priced at API list prices. */
export const SAVINGS_LEVERS = ["model", "swarm", "reads", "trims", "graph", "cache"] as const;
export type SavingsLever = (typeof SAVINGS_LEVERS)[number];
export type SavingsScope = "session" | "week" | "all";

export interface SavingsTotals {
  readonly savedUsd: number;
  readonly paidUsd: number;
  /** Kora's own prompt on every call, already taken off `savedUsd`. */
  readonly overheadUsd: number;
  readonly byLever: Readonly<Record<SavingsLever, number>>;
}
export interface SavingsReport {
  readonly session: SavingsTotals | null;
  readonly week: SavingsTotals;
  readonly all: SavingsTotals;
  readonly since: string | null;
  /** Models in the log no price list knows yet: their calls count $0 both ways (never priced as another model). */
  readonly unpriced: readonly string[];
}

// "cache" is Kora's keep-warm (the pings that kept a thread's prompt cache alive across a gap: the re-writes they
// avoided, minus the pings). It is NOT the provider's prompt-cache discount, which every request gets with or without
// Kora and which must never be credited to Kora — so it is never labelled plain "Cache".
export const LEVER_LABELS: Record<SavingsLever, string> = {
  model: "Auto model",
  swarm: "Swarm",
  reads: "Reads",
  trims: "Trims",
  graph: "Graph",
  cache: "Keep-warm",
};

/** What the popover shows under the big number: these are list-price estimates, not the user's bill. */
export const SAVINGS_ESTIMATE_NOTE = "Estimated at API prices";

/** A fetched report belongs to the thread it was fetched for: another thread's numbers are never shown (null until the
 *  new thread's report arrives). */
export interface HeldSavings {
  readonly threadId: string | null;
  readonly report: SavingsReport | null;
}
export function reportForThread(
  held: HeldSavings | null,
  threadId: string | null | undefined,
): SavingsReport | null {
  return held && held.threadId === (threadId ?? null) ? held.report : null;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function parseTotals(v: unknown): SavingsTotals | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  const by = (typeof r.byLever === "object" && r.byLever !== null ? r.byLever : {}) as Record<
    string,
    unknown
  >;
  const byLever = Object.fromEntries(
    SAVINGS_LEVERS.map((k) => [k, Math.max(0, num(by[k]))]),
  ) as Record<SavingsLever, number>;
  return {
    savedUsd: Math.max(0, num(r.savedUsd)),
    paidUsd: Math.max(0, num(r.paidUsd)),
    overheadUsd: Math.max(0, num(r.overheadUsd)),
    byLever,
  };
}

export function parseSavingsReport(v: unknown): SavingsReport | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  const week = parseTotals(r.week);
  const all = parseTotals(r.all);
  if (!week || !all) return null;
  return {
    session: parseTotals(r.session),
    week,
    all,
    since: typeof r.since === "string" ? r.since : null,
    unpriced: parseUnpriced(r.pricing),
  };
}

function parseUnpriced(v: unknown): string[] {
  const list = typeof v === "object" && v !== null ? (v as Record<string, unknown>).unpriced : null;
  return Array.isArray(list)
    ? list.filter((m): m is string => typeof m === "string").slice(0, 5)
    : [];
}

/** The line under the note when some calls could not be priced. */
export function unpricedNote(models: readonly string[]): string | null {
  return models.length ? `Not counted (no public price yet): ${models.join(", ")}` : null;
}

export async function fetchSavings(
  httpBaseUrl: string,
  threadId: string | null,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = fetchPrimaryHost,
): Promise<SavingsReport | null> {
  const url = new URL("/api/savings", httpBaseUrl);
  if (threadId) url.searchParams.set("threadId", threadId);
  const res = await fetchImpl(url.toString());
  if (!res.ok) return null;
  return parseSavingsReport(await res.json());
}

/** What the levers saved before Kora's own prompt is taken off (`savedUsd` is net of it, floored at 0). */
export function grossSavedUsd(t: SavingsTotals): number {
  return SAVINGS_LEVERS.reduce((sum, k) => sum + t.byLever[k], 0);
}

/** Money for the headline: cents under $10 ("$0.88", "<$0.01"), whole dollars above ("$1,204"). */
export function formatSavedUsd(value: number): string {
  if (!(value > 0)) return "$0.00";
  if (value < 0.01) return "<$0.01";
  if (value < 1000) return `$${value.toFixed(2)}`;
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

/** The chips: levers that saved at least a cent, biggest first. */
export function leverChips(t: SavingsTotals): Array<{ lever: SavingsLever; usd: number }> {
  return SAVINGS_LEVERS.map((lever) => ({ lever, usd: t.byLever[lever] }))
    .filter((c) => c.usd >= 0.005)
    .sort((a, b) => b.usd - a.usd);
}
