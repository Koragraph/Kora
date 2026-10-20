// Pure maths for "how full is my context" and "how much of my plan is left", shared by the Claude and Codex
// drivers. Every input is a provider's own record (Claude Agent SDK messages / control responses, Codex exec JSON,
// Codex rollout `token_count` events, `codex app-server` account/rateLimits/read); nothing here touches the network
// or reads credentials.
import type { TokenUsage, UsageLimitsReport, UsageWindow } from './events';
import { costOf } from '../ledger/transcript';

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const clampPct = (v: number): number => Math.max(0, Math.min(100, Math.round(v * 10) / 10));
/** Epoch seconds or milliseconds (or an ISO string) → epoch ms. */
export function toEpochMs(v: unknown): number | undefined {
  const n = num(v);
  if (n !== undefined && n > 0) return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  const s = str(v);
  if (s) { const t = Date.parse(s); if (Number.isFinite(t)) return t; }
  return undefined;
}

// ── Claude: context ───────────────────────────────────────────────────────────────

/**
 * The context a Claude request occupied: every input token the model read (fresh + cache reads + cache writes) plus
 * what it wrote, which becomes input on the next request. With prompt caching nearly all of the context is
 * `cache_read_input_tokens` — leaving it out (input+output only) reads as a few hundred tokens on a 100k thread.
 */
export function claudeContextTokens(usage: unknown): number | undefined {
  const u = usage as Record<string, unknown> | null | undefined;
  if (!u || typeof u !== 'object') return undefined;
  const parts = [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens, u.output_tokens].map(num);
  if (parts.every((p) => p === undefined)) return undefined;
  return parts.reduce<number>((a, b) => a + (b ?? 0), 0);
}

/** Only an explicit `[1m]` id is known without asking the harness; anything else waits for the SDK's own answer. */
export function knownClaudeContextWindow(model: string | null | undefined): number | undefined {
  return model && /\[1m\]/i.test(model) ? 1_000_000 : undefined;
}

/**
 * The context window of the model that served a result, from the SDK's per-model `modelUsage` (cumulative per
 * query). Prefers the entry for `model`, then the largest window among the models that did any input (the main
 * loop; side calls such as a title generator use small models).
 */
/**
 * Models the bundled CLI prices wrong, re-priced from Kora's table: Haiku 5.5 it doesn't know at all (priced like its
 * default, about 6x-40x too high: pl2 S3-5, SAV-E), and Sonnet 5.5 cache reads it bills at $0.20/M where the pricing page
 * says $0.10/M (0.05x; checked 2026-10-15). 96% of tokens are cache reads, so that alone overstated Sonnet sessions ~1.5x.
 */
const SDK_UNPRICED_CLAUDE_MODELS = /claude-(haiku|sonnet)-5-5/;

/** The session cost to show: the SDK's `total_cost_usd`, with the rows of models it can't price re-priced. */
export function claudeResultCostUsd(totalCostUsd: unknown, modelUsage: unknown): number | undefined {
  const total = num(totalCostUsd);
  if (total === undefined || !(total > 0)) return undefined;
  if (!modelUsage || typeof modelUsage !== 'object') return total;
  let fixed = total;
  for (const [model, r] of Object.entries(modelUsage as Record<string, any>)) {
    if (!SDK_UNPRICED_CLAUDE_MODELS.test(model)) continue;
    const sdk = num(r?.costUSD);
    if (sdk === undefined) continue;
    const ours = costOf({ input: num(r?.inputTokens) ?? 0, output: num(r?.outputTokens) ?? 0, cacheRead: num(r?.cacheReadInputTokens) ?? 0, cacheWrite: num(r?.cacheCreationInputTokens) ?? 0 }, model);
    fixed += ours - sdk;
  }
  return fixed > 0 ? fixed : total;
}

export function claudeResultContextWindow(modelUsage: unknown, model?: string | null): number | undefined {
  if (!modelUsage || typeof modelUsage !== 'object') return undefined;
  const rows = Object.entries(modelUsage as Record<string, any>);
  const exact = model ? rows.find(([k]) => k === model || k.startsWith(`${model}`)) : undefined;
  const fromExact = num(exact?.[1]?.contextWindow);
  if (fromExact && fromExact > 0) return fromExact;
  let best: number | undefined;
  for (const [, r] of rows) {
    const w = num(r?.contextWindow);
    const used = (num(r?.inputTokens) ?? 0) + (num(r?.cacheReadInputTokens) ?? 0) + (num(r?.cacheCreationInputTokens) ?? 0);
    if (w && w > 0 && used > 0 && (best === undefined || w > best)) best = w;
  }
  return best;
}

/** `query.getContextUsage()` (Claude Code's own /context numbers) → TokenUsage. Null when the shape is unusable. */
export function claudeContextUsageToTokenUsage(resp: unknown): TokenUsage | null {
  const r = resp as Record<string, unknown> | null | undefined;
  const total = num(r?.totalTokens);
  const max = num(r?.maxTokens);
  if (total === undefined || total < 0) return null;
  const threshold = num(r?.autoCompactThreshold);
  return {
    usedTokens: Math.round(total),
    ...(max && max > 0 ? { maxTokens: Math.round(max) } : {}),
    ...(threshold && threshold > 0 ? { autoCompactThreshold: Math.round(threshold) } : {}),
    ...(typeof r?.isAutoCompactEnabled === 'boolean' ? { compactsAutomatically: r.isAutoCompactEnabled } : {}),
    source: 'provider',
  };
}

// ── Claude: plan limits ───────────────────────────────────────────────────────────

const PLAN_LABELS: Record<string, string> = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise', free: 'Free', plus: 'Plus', business: 'Business', edu: 'Edu' };
export function planLabel(plan: unknown): string | undefined {
  const p = str(plan);
  if (!p) return undefined;
  return PLAN_LABELS[p.toLowerCase()] ?? p.charAt(0).toUpperCase() + p.slice(1);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** Ids match the SDK's `rate_limit_event.rateLimitType`, so a live event lands on the row a probe produced. */
function claudeWindowMeta(id: string, scopeName?: string): Pick<UsageWindow, 'kind' | 'label' | 'windowMinutes'> {
  if (id === 'five_hour') return { kind: 'session', label: '5-hour session', windowMinutes: 300 };
  if (id === 'seven_day') return { kind: 'weekly', label: 'Weekly · all models', windowMinutes: 10080 };
  if (id.startsWith('seven_day_')) {
    const rest = scopeName ?? id.slice('seven_day_'.length).replace(/_/g, ' ');
    const name = rest.replace(/\b\w/g, (c) => c.toUpperCase());
    return { kind: 'weekly', label: `Weekly · ${name}`, windowMinutes: 10080 };
  }
  if (id === 'overage') return { kind: 'other', label: 'Extra usage' };
  return { kind: 'other', label: id.replace(/_/g, ' ') };
}

function claudeWindow(id: string, usedPercent: unknown, resetsAt: unknown, scopeName?: string): UsageWindow | null {
  const pct = num(usedPercent);
  if (pct === undefined) return null;
  const at = toEpochMs(resetsAt);
  return { id, ...claudeWindowMeta(id, scopeName), usedPercent: clampPct(pct), ...(at ? { resetsAt: at } : {}) };
}

/**
 * The SDK's experimental `/usage` control response → a full report. Reads the generic `limits[]` rows when present
 * (they carry per-model weekly caps), else the named windows. `rate_limits_available:false` (API key, Bedrock…) is a
 * complete report with no windows: the account has no plan limits to show.
 */
export function claudeUsageReport(resp: unknown): UsageLimitsReport | null {
  const r = resp as Record<string, any> | null | undefined;
  if (!r || typeof r !== 'object') return null;
  const plan = planLabel(r.subscription_type);
  if (r.rate_limits_available === false || !r.rate_limits) {
    return { provider: 'claude', windows: [], complete: true, ...(plan ? { plan } : {}) };
  }
  const rl = r.rate_limits as Record<string, any>;
  const windows: UsageWindow[] = [];
  const push = (w: UsageWindow | null) => { if (w && !windows.some((x) => x.id === w.id)) windows.push(w); };
  if (Array.isArray(rl.limits) && rl.limits.length > 0) {
    for (const row of rl.limits) {
      const kind = str(row?.kind);
      if (!kind) continue;
      const scope = str(row?.scope?.model?.display_name);
      const id = kind === 'session' ? 'five_hour' : kind === 'weekly_all' ? 'seven_day' : kind === 'weekly_scoped' && scope ? `seven_day_${slug(scope)}` : slug(kind);
      push(claudeWindow(id, row?.percent ?? row?.utilization, row?.resets_at, scope));
    }
  } else {
    for (const id of ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']) {
      const w = rl[id];
      if (w && typeof w === 'object') push(claudeWindow(id, w.utilization, w.resets_at));
    }
    if (Array.isArray(rl.model_scoped)) {
      for (const m of rl.model_scoped) {
        const name = str(m?.display_name);
        if (name) push(claudeWindow(`seven_day_${slug(name)}`, m?.utilization, m?.resets_at, name));
      }
    }
  }
  const limited = windows.some((w) => w.usedPercent >= 100);
  return { provider: 'claude', windows, complete: true, ...(plan ? { plan } : {}), ...(limited ? { limited } : {}) };
}

/**
 * One SDK `rate_limit_event` (sent on every request for claude.ai subscribers) → a sparse report. `utilization` is a
 * fraction (0–1); a value above 1 is read as a percentage. `status: 'rejected'` is the limit being hit.
 */
export function claudeRateLimitEventReport(info: unknown): UsageLimitsReport | null {
  const i = info as Record<string, unknown> | null | undefined;
  if (!i || typeof i !== 'object') return null;
  const id = str(i.rateLimitType);
  const util = num(i.utilization);
  const resetsAt = toEpochMs(i.resetsAt);
  const windows: UsageWindow[] = [];
  const limited = i.status === 'rejected';
  // A rejection without a utilization still names its window: it is at its limit (plan headroom filters on the id).
  if (id && (util !== undefined || limited)) {
    const w = claudeWindow(id, util === undefined ? 100 : util <= 1 ? util * 100 : util, i.resetsAt);
    if (w) windows.push(w);
  }
  if (!windows.length && !limited) return null;
  return { provider: 'claude', windows, ...(limited ? { limited: true } : {}), ...(resetsAt ? { resetsAt } : {}) };
}

// ── Codex: plan limits ────────────────────────────────────────────────────────────

function codexWindowMeta(minutes: number | undefined): Pick<UsageWindow, 'kind' | 'label'> {
  if (minutes === undefined) return { kind: 'other', label: 'Usage' };
  if (minutes <= 24 * 60) return { kind: 'session', label: minutes % 60 === 0 ? `${minutes / 60}-hour window` : `${minutes}-minute window` };
  if (minutes <= 7 * 24 * 60) return { kind: 'weekly', label: 'Weekly' };
  return { kind: 'monthly', label: minutes >= 28 * 24 * 60 ? 'Monthly' : `${Math.round(minutes / 1440)}-day window` };
}

/**
 * A Codex rate-limit snapshot → report. Accepts both spellings: snake_case from `codex exec` / rollout `token_count`
 * events (`used_percent`, `window_minutes`, `resets_at` seconds) and camelCase from `codex app-server`
 * (`usedPercent`, `windowDurationMins`, `resetsAt`).
 */
export function codexRateLimitsReport(rl: unknown): UsageLimitsReport | null {
  const r = rl as Record<string, any> | null | undefined;
  if (!r || typeof r !== 'object') return null;
  const windows: UsageWindow[] = [];
  for (const id of ['primary', 'secondary'] as const) {
    const w = r[id];
    if (!w || typeof w !== 'object') continue;
    const pct = num(w.used_percent ?? w.usedPercent);
    if (pct === undefined) continue;
    const minutes = num(w.window_minutes ?? w.windowDurationMins ?? w.window_duration_mins);
    const at = toEpochMs(w.resets_at ?? w.resetsAt) ?? (num(w.resets_in_seconds) !== undefined ? Date.now() + num(w.resets_in_seconds)! * 1000 : undefined);
    windows.push({ id, ...codexWindowMeta(minutes), usedPercent: clampPct(pct), ...(at ? { resetsAt: at } : {}), ...(minutes ? { windowMinutes: minutes } : {}) });
  }
  const plan = planLabel(r.plan_type ?? r.planType);
  const reached = str(r.rate_limit_reached_type ?? r.rateLimitReachedType);
  const limited = !!reached || windows.some((w) => w.usedPercent >= 100);
  const resetsAt = limited ? windows.filter((w) => w.usedPercent >= 100).map((w) => w.resetsAt).find((t) => t !== undefined) : undefined;
  if (!windows.length && !plan && !limited) return null;
  return { provider: 'codex', windows, complete: true, ...(plan ? { plan } : {}), ...(limited ? { limited } : {}), ...(resetsAt ? { resetsAt } : {}) };
}

/** `codex app-server` `account/rateLimits/read` result → report (null when the account reports nothing). */
export function codexAppServerRateLimitsReport(result: unknown): UsageLimitsReport | null {
  const r = result as Record<string, any> | null | undefined;
  const base = codexRateLimitsReport(r?.rateLimits ?? r?.rate_limits);
  if (!base) return null;
  return r?.ordinaryUsageAllowed === false && !base.limited ? { ...base, limited: true } : base;
}

/** The last `token_count` event in a Codex rollout (JSONL lines) → context occupancy + the rate-limit snapshot. */
export function codexRolloutUsage(lines: ReadonlyArray<string>): { context: TokenUsage | null; limits: UsageLimitsReport | null } {
  let context: TokenUsage | null = null;
  let limits: UsageLimitsReport | null = null;
  for (let i = lines.length - 1; i >= 0 && (!context || !limits); i--) {
    const line = lines[i];
    if (!line || !line.includes('"token_count"')) continue;
    let evt: any;
    try { evt = JSON.parse(line); } catch { continue; }
    const p = evt?.payload ?? evt?.msg ?? evt;
    if (p?.type !== 'token_count') continue;
    if (!limits && p.rate_limits) limits = codexRateLimitsReport(p.rate_limits);
    if (!context && p.info) {
      const last = p.info.last_token_usage ?? {};
      const total = p.info.total_token_usage ?? {};
      // Codex's own "context left" maths reads last_token_usage.total_tokens against model_context_window.
      const used = num(last.total_tokens) ?? (num(last.input_tokens) ?? 0) + (num(last.output_tokens) ?? 0);
      const max = num(p.info.model_context_window);
      if (used !== undefined) {
        context = {
          usedTokens: Math.round(used),
          ...(max && max > 0 ? { maxTokens: Math.round(max) } : {}),
          ...(num(total.input_tokens) !== undefined ? { inputTokens: num(total.input_tokens) } : {}),
          ...(num(total.cached_input_tokens) !== undefined ? { cachedInputTokens: num(total.cached_input_tokens) } : {}),
          ...(num(total.output_tokens) !== undefined ? { outputTokens: num(total.output_tokens) } : {}),
          ...(num(total.total_tokens) !== undefined ? { totalProcessedTokens: num(total.total_tokens) } : {}),
          compactsAutomatically: true,
          source: 'provider',
        };
      }
    }
  }
  return { context, limits };
}

/** One model request of a Codex thread, for the cost log: `in` is fresh input (Codex's input_tokens include the cached
 *  and the written share), `ts` the token_count event's time, `model` the turn's (from the latest `turn_context`). */
export interface CodexRequestUsage { ts: number; model: string | null; in: number; cr: number; cc: number; out: number }
/** Every model request in a rollout's lines, oldest first. A token_count whose totals did not move (Codex repeats one when
 *  only the rate limits changed) is not a request. */
export function codexRequestUsages(lines: ReadonlyArray<string>): CodexRequestUsage[] {
  const out: CodexRequestUsage[] = [];
  let model: string | null = null; let lastTotal = -1;
  for (const line of lines) {
    if (!line || (!line.includes('"token_count"') && !line.includes('"turn_context"'))) continue;
    let evt: any;
    try { evt = JSON.parse(line); } catch { continue; }
    const p = evt?.payload ?? evt?.msg ?? evt;
    if (evt?.type === 'turn_context' || p?.type === 'turn_context') { if (typeof p?.model === 'string') model = p.model; continue; }
    if (p?.type !== 'token_count' || !p.info?.last_token_usage) continue;
    const total = num(p.info.total_token_usage?.total_tokens) ?? -1;
    if (total >= 0 && total === lastTotal) continue;
    lastTotal = total;
    const u = p.info.last_token_usage;
    const input = num(u.input_tokens) ?? 0; const cr = num(u.cached_input_tokens) ?? 0; const cc = num(u.cache_write_input_tokens) ?? 0;
    const ts = typeof evt.timestamp === 'string' ? Date.parse(evt.timestamp) : NaN;
    out.push({ ts: Number.isFinite(ts) ? ts : 0, model, in: Math.max(0, input - cr - cc), cr, cc, out: num(u.output_tokens) ?? 0 });
  }
  return out;
}

// ── limit messages (the text a provider prints when it refuses a turn) ──────────────

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "Oct 16th, 2026 8:25 PM" / "October 16, 2026 20:25" → local epoch ms. */
function parseHumanDate(text: string): number | undefined {
  const m = /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?:,?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([AaPp][Mm])?)?/.exec(text);
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase());
  if (month < 0) return undefined;
  let hour = m[4] ? Number(m[4]) : 0;
  const minute = m[5] ? Number(m[5]) : 0;
  const ampm = m[6]?.toLowerCase();
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  const t = new Date(Number(m[3]), month, Number(m[2]), hour, minute).getTime();
  return Number.isFinite(t) ? t : undefined;
}

const LIMIT_TEXT = /usage limit|rate[- ]limit|hit your (?:usage )?limit|out of (?:\w+ )?messages|limit reached/i;

/**
 * A provider's "you are out of quota" text → when it lifts. Recognises Codex's
 * "You've hit your usage limit … try again at Oct 16th, 2026 8:25 PM." and Claude Code's
 * "Claude AI usage limit reached|1759500000". Null when the text is not a usage-limit refusal.
 */
export function parseUsageLimitMessage(text: string | null | undefined): { resetsAt?: number } | null {
  if (!text || !LIMIT_TEXT.test(text)) return null;
  const epoch = /usage limit reached\|(\d{9,13})/i.exec(text);
  if (epoch) return { resetsAt: toEpochMs(Number(epoch[1])) };
  const at = /try again (?:at|on|after)\s+(.+?)(?:\.\s|\.$|$)/i.exec(text);
  const resetsAt = at ? parseHumanDate(at[1]!) : undefined;
  return resetsAt ? { resetsAt } : {};
}
