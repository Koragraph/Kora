// The price book: what one token costs on any model any of Kora's agents runs (Claude Code, Codex, OpenCode,
// Antigravity), so the savings meter prices a GPT call at OpenAI's list price and a Gemini call at Google's, never at
// Claude's. It keeps itself current: a new model needs no Kora release.
//
// Lookup, first hit wins:
//   1. <KORA_HOME>/prices.json, the user's own rows: {"<model substring>": {in, out, cacheWrite, cacheRead}} ($/M).
//   2. The catalog: a daily snapshot of models.dev (the model's maker first; a reseller's price only for a model whose
//      maker models.dev does not list, never for Claude, GPT or Gemini, and never a reseller's $0 coding-plan row) (the public price list OpenCode itself uses), compacted to
//      <KORA_HOME>/model-prices.json. Written by `refreshPriceCatalog` (daemon start + every 6 h, a no-op while the
//      snapshot is under a day old; OpenCode's own copy is used when it is fresh, so usually no network at all) and by
//      the Swarm catalog refresh, which fetches the same file. Never fetched on the pricing path.
//   3. The built-in table below (offline floor; checked 2026-10-19).
//   4. A Claude family row for an unknown Claude id (`claude-opus-6` prices as the newest Opus until the catalog has it).
//   5. Unpriced: zero rates, `source: 'unpriced'`. The meter counts such calls and says so; it never guesses.
//
// Provider semantics. Anthropic: `cacheWrite` is the 1-hour write (2x input; Kora's Claude lanes write with the 1-hour
// TTL), `write5m` the 5-minute one (1.25x); models.dev lists the 5-minute price as `cache_write`. Everyone else: a cache
// write costs the listed `cache_write`, else plain input (OpenAI and Google bill no write premium on most models).
// Long-context tiers come from the catalog (`tiers[].tier.size`): Haiku 5.5 past 100k, GPT past 272k, Gemini Pro past
// 200k; the whole request is billed at the tier's rates.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { koraHome } from '../protocol/types';

export type PriceProvider = 'anthropic' | 'openai' | 'google' | 'other';
export type PriceSource = 'user' | 'catalog' | 'built-in' | 'family' | 'unpriced';
/** $ per million tokens. */
export interface Rate { in: number; out: number; cacheWrite: number; cacheRead: number }
export interface Price extends Rate {
  /** The 5-minute cache write (Anthropic); equal to `cacheWrite` elsewhere. */
  write5m: number;
  long?: Rate & { above: number; write5m: number };
  /** The row that matched (a catalog id, a built-in key), for display. */
  key: string;
  provider: PriceProvider;
  source: PriceSource;
}

type Row = { in: number; out: number; cacheWrite?: number; cacheRead?: number; long?: { above: number; in: number; out: number; cacheWrite?: number; cacheRead?: number } };

// Anthropic rows: per-million list prices (platform.claude.com/docs/en/about-claude/pricing). cacheWrite is the 1-hour
// write. Cache reads are 0.1x input, except Opus 5.5 and Sonnet 5.5 (0.05x) and Fable 5.1 / Mythos 5.1 (0.025x). Only
// Haiku 5.5 has a long-prompt tier (over 100K, every price 5x). The first key contained in the id wins, so specific rows
// come first; the bare family rows (`haiku`, `sonnet`, `opus`, `fable`, `mythos`) are the fallback for a new Claude id.
const ANTHROPIC: Record<string, Row> = {
  'haiku-5': { in: 0.1, out: 0.5, cacheWrite: 0.2, cacheRead: 0.01, long: { above: 100_000, in: 0.5, out: 2.5, cacheWrite: 1, cacheRead: 0.05 } },
  '3-5-haiku': { in: 0.8, out: 4, cacheWrite: 1.6, cacheRead: 0.08 },
  'haiku': { in: 1, out: 5, cacheWrite: 2, cacheRead: 0.1 },
  'sonnet-5-5': { in: 2, out: 10, cacheWrite: 4, cacheRead: 0.1 },
  'sonnet-4': { in: 3, out: 15, cacheWrite: 6, cacheRead: 0.3 },
  '3-7-sonnet': { in: 3, out: 15, cacheWrite: 6, cacheRead: 0.3 },
  '3-5-sonnet': { in: 3, out: 15, cacheWrite: 6, cacheRead: 0.3 },
  'sonnet': { in: 2, out: 10, cacheWrite: 4, cacheRead: 0.2 },
  'opus-5-5': { in: 4, out: 20, cacheWrite: 8, cacheRead: 0.2 },
  'opus-4-1': { in: 15, out: 75, cacheWrite: 30, cacheRead: 1.5 },
  'opus-4-2025': { in: 15, out: 75, cacheWrite: 30, cacheRead: 1.5 },
  'opus': { in: 5, out: 25, cacheWrite: 10, cacheRead: 0.5 },
  'fable-5-1': { in: 10, out: 50, cacheWrite: 20, cacheRead: 0.25 },
  'mythos-5-1': { in: 10, out: 50, cacheWrite: 20, cacheRead: 0.25 },
  'fable': { in: 10, out: 50, cacheWrite: 20, cacheRead: 1 },
  'mythos': { in: 10, out: 50, cacheWrite: 20, cacheRead: 1 },
};
const ANTHROPIC_FAMILIES = new Set(['haiku', 'sonnet', 'opus', 'fable', 'mythos']);

// OpenAI and Google: the models Codex and Antigravity run today (models.dev, 2026-10-19). Exact ids only: a newer GPT or
// Gemini is priced from the catalog, not guessed from a neighbour.
const GPT_LONG = 272_000;
const OTHERS: Record<string, Row & { provider: PriceProvider }> = {
  'gpt-6.1-sol': { provider: 'openai', in: 2, out: 10, cacheRead: 0.1, cacheWrite: 2.5, long: { above: GPT_LONG, in: 4, out: 15, cacheRead: 0.2, cacheWrite: 5 } },
  'gpt-6-astra': { provider: 'openai', in: 10, out: 50, cacheRead: 1, cacheWrite: 12.5, long: { above: GPT_LONG, in: 20, out: 75, cacheRead: 2, cacheWrite: 25 } },
  'gpt-6-sol': { provider: 'openai', in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5, long: { above: GPT_LONG, in: 4, out: 15, cacheRead: 0.4, cacheWrite: 5 } },
  'gpt-6-luna': { provider: 'openai', in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125, long: { above: GPT_LONG, in: 0.2, out: 0.75, cacheRead: 0.02, cacheWrite: 0.25 } },
  'gpt-5.6': { provider: 'openai', in: 4, out: 20, cacheRead: 0.4, cacheWrite: 5, long: { above: GPT_LONG, in: 8, out: 30, cacheRead: 0.8, cacheWrite: 10 } },
  'gpt-5.6-sol': { provider: 'openai', in: 4, out: 20, cacheRead: 0.4, cacheWrite: 5, long: { above: GPT_LONG, in: 8, out: 30, cacheRead: 0.8, cacheWrite: 10 } },
  'gpt-5.6-terra': { provider: 'openai', in: 2, out: 12, cacheRead: 0.2, cacheWrite: 2.5, long: { above: GPT_LONG, in: 4, out: 18, cacheRead: 0.4, cacheWrite: 5 } },
  'gpt-5.6-luna': { provider: 'openai', in: 0.2, out: 1.2, cacheRead: 0.02, cacheWrite: 0.25, long: { above: GPT_LONG, in: 0.4, out: 1.8, cacheRead: 0.04, cacheWrite: 0.5 } },
  'gpt-5.5': { provider: 'openai', in: 5, out: 30, cacheRead: 0.5, long: { above: GPT_LONG, in: 10, out: 45, cacheRead: 1 } },
  'gpt-5.4': { provider: 'openai', in: 2.5, out: 15, cacheRead: 0.25, long: { above: GPT_LONG, in: 5, out: 22.5, cacheRead: 0.5 } },
  'gpt-5.4-mini': { provider: 'openai', in: 0.75, out: 4.5, cacheRead: 0.075 },
  'gpt-5.3-codex': { provider: 'openai', in: 1.75, out: 14, cacheRead: 0.175 },
  'gemini-3.8-flash': { provider: 'google', in: 0.75, out: 3.75, cacheRead: 0.075 },
  'gemini-3.7-flash': { provider: 'google', in: 0.75, out: 3.75, cacheRead: 0.075 },
  'gemini-3.6-flash': { provider: 'google', in: 0.75, out: 3.75, cacheRead: 0.075 },
  'gemini-3.5-flash': { provider: 'google', in: 1.5, out: 9, cacheRead: 0.15 },
  'gemini-3.5-flash-lite': { provider: 'google', in: 0.3, out: 2.5, cacheRead: 0.03 },
  'gemini-3.1-pro-preview': { provider: 'google', in: 2, out: 12, cacheRead: 0.2, long: { above: 200_000, in: 4, out: 18, cacheRead: 0.4 } },
};

// ── id normalisation ──────────────────────────────────────────────────────────────────────────────────────────────

/** Effort / mode suffixes some harnesses put on a model id (Antigravity: `gemini-3.8-flash-high`, `claude-opus-4-6-thinking`). */
const EFFORT_SUFFIX = /-(minimal|none|low|medium|high|xhigh|max|thinking)$/;
const PROVIDER_ALIASES: Record<string, PriceProvider> = { anthropic: 'anthropic', openai: 'openai', google: 'google', 'google-vertex': 'google', gemini: 'google' };

/** `{ provider, id }` from any form a harness reports: `anthropic/claude-x`, `openrouter/qwen/qwen3`, Bedrock's
 *  `us.anthropic.claude-x-v1:0`, Vertex's `claude-x@20250805`, `claude-x[1m]`, `claude-x-20251001`. */
export function normalizeModelId(model: string): { provider: string | null; id: string } {
  let m = model.trim().toLowerCase().replace(/\[[^\]]*\]$/, '');
  let provider: string | null = null;
  const bedrock = /^(?:[a-z]{2}\.)?(anthropic|openai|google|meta|mistral|amazon|cohere)\.(.+)$/.exec(m);
  if (bedrock && !m.includes('/')) { provider = bedrock[1]!; m = bedrock[2]!.replace(/-v\d+(?::\d+)?$/, ''); }
  const slash = m.indexOf('/');
  if (slash > 0) { provider = m.slice(0, slash); m = m.slice(slash + 1); }
  m = m.replace(/@.*$/, '').replace(/-20\d{6}$/, '').replace(/-latest$/, '');
  return { provider, id: m };
}

const providerOfId = (id: string): PriceProvider =>
  /claude|haiku|sonnet|opus|fable|mythos/.test(id) ? 'anthropic' : /^(gpt|o\d|codex|chatgpt)/.test(id) ? 'openai' : /^gemini|^gemma/.test(id) ? 'google' : 'other';

// ── the catalog snapshot ───────────────────────────────────────────────────────────────────────────────────────────

/** One model in the compact snapshot: [in, out, cacheRead|null, cacheWrite|null, contextWindow|null, tierAbove|null,
 *  tierIn, tierOut, tierCacheRead, tierCacheWrite]. */
type CatalogRow = (number | null)[];
export interface PriceCatalog { v: 2; fetchedAt: number; source: string; providers: Record<string, Record<string, CatalogRow>> }

export function priceCatalogPath(home: string = koraHome()): string { return path.join(home, 'model-prices.json'); }

const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** models.dev's api.json → the compact snapshot (every provider, every model that lists a price). Pure. */
export function compactModelsDev(api: unknown, fetchedAt: number, source: string): PriceCatalog | null {
  if (!api || typeof api !== 'object') return null;
  const providers: PriceCatalog['providers'] = {};
  let count = 0;
  for (const [pid, p] of Object.entries(api as Record<string, any>)) {
    const models = p?.models; if (!models || typeof models !== 'object') continue;
    const rows: Record<string, CatalogRow> = {};
    for (const [mid, m] of Object.entries(models as Record<string, any>)) {
      const c = m?.cost; const input = n(c?.input); const output = n(c?.output);
      if (input === null || output === null) continue;
      const t = Array.isArray(c.tiers) ? c.tiers.find((x: any) => x?.tier?.type === 'context' && n(x?.tier?.size)) : null;
      rows[mid.toLowerCase()] = [input, output, n(c.cache_read), n(c.cache_write), n(m?.limit?.context), ...(t ? [n(t.tier.size), n(t.input), n(t.output), n(t.cache_read), n(t.cache_write)] : [])];
      count++;
    }
    if (Object.keys(rows).length) providers[pid.toLowerCase()] = rows;
  }
  return count ? { v: 2, fetchedAt, source, providers } : null;
}

/** priceFor results, cleared whenever the catalog or the user's rows are re-read. */
const priceMemo = new Map<string, Price>();
let catalogMemo: { at: number; stamp: string; cat: PriceCatalog | null; home: string } | null = null;
function loadCatalog(home: string): PriceCatalog | null {
  const now = Date.now();
  if (catalogMemo && catalogMemo.home === home && now - catalogMemo.at < 30_000) return catalogMemo.cat;
  const f = priceCatalogPath(home);
  let stamp = '-'; try { const s = fs.statSync(f); stamp = `${s.size}:${s.mtimeMs}`; } catch { /* none */ }
  if (catalogMemo && catalogMemo.home === home && catalogMemo.stamp === stamp) { catalogMemo.at = now; return catalogMemo.cat; }
  let cat: PriceCatalog | null = null;
  priceMemo.clear();
  try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (j?.v === 2 && j.providers && typeof j.fetchedAt === 'number') cat = j; } catch { /* none yet */ }
  catalogMemo = { at: now, stamp, cat, home };
  return cat;
}

let userMemo: { at: number; home: string; rows: Record<string, Row> } | null = null;
function loadUserRows(home: string): Record<string, Row> {
  const now = Date.now();
  if (userMemo && userMemo.home === home && now - userMemo.at < 30_000) return userMemo.rows;
  let rows: Record<string, Row> = {};
  priceMemo.clear();
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, 'prices.json'), 'utf8'));
    if (j && typeof j === 'object') for (const [k, v] of Object.entries(j as Record<string, any>)) if (n(v?.in) !== null && n(v?.out) !== null) rows[k.toLowerCase()] = v;
  } catch { rows = {}; }
  userMemo = { at: now, home, rows };
  return rows;
}

/** Tests: forget the memoised catalog and user rows. */
export function resetPricesForTests(): void { catalogMemo = null; userMemo = null; priceMemo.clear(); }

// ── building a Price ───────────────────────────────────────────────────────────────────────────────────────────────

function rateOf(provider: PriceProvider, r: { in: number; out: number; cacheRead?: number | null; cacheWrite?: number | null }, listedWriteIs5m: boolean): Rate & { write5m: number } {
  if (provider === 'anthropic') {
    // models.dev lists the 5-minute write; Kora's lanes write 1-hour entries (2x input).
    const write5m = listedWriteIs5m ? (r.cacheWrite ?? r.in * 1.25) : r.in * 1.25;
    const cacheWrite = listedWriteIs5m ? r.in * 2 : (r.cacheWrite ?? r.in * 2);
    return { in: r.in, out: r.out, cacheRead: r.cacheRead ?? r.in * 0.1, cacheWrite, write5m };
  }
  // a listed write of $0 means no write surcharge, not a free token: an admitted token still costs input
  const w = r.cacheWrite ? r.cacheWrite : r.in;
  return { in: r.in, out: r.out, cacheRead: r.cacheRead ?? r.in, cacheWrite: w, write5m: w };
}

function fromRow(row: Row, key: string, provider: PriceProvider, source: PriceSource): Price {
  const base = rateOf(provider, row, false);
  const long = row.long ? { above: row.long.above, ...rateOf(provider, row.long, false) } : undefined;
  return { ...base, ...(long ? { long } : {}), key, provider, source };
}

function fromCatalog(row: CatalogRow, key: string, provider: PriceProvider): Price {
  const [i, o, cr, cw, , above, ti, to, tcr, tcw] = row;
  const base = rateOf(provider, { in: i ?? 0, out: o ?? 0, cacheRead: cr, cacheWrite: cw }, true);
  const long = above && ti !== null && ti !== undefined && to !== null && to !== undefined
    ? { above, ...rateOf(provider, { in: ti, out: to, cacheRead: tcr ?? null, cacheWrite: tcw ?? null }, true) } : undefined;
  return { ...base, ...(long ? { long } : {}), key, provider, source: 'catalog' };
}

/** Candidate ids for one model, most specific first (the id, then without an effort suffix, then dots ↔ dashes). */
function variants(id: string): string[] {
  const out = [id];
  const bare = id.replace(EFFORT_SUFFIX, '');
  if (bare !== id) out.push(bare);
  for (const v of [...out]) { if (/\d-\d/.test(v)) out.push(v.replace(/(\d)-(\d)/g, '$1.$2')); if (/\d\.\d/.test(v)) out.push(v.replace(/(\d)\.(\d)/g, '$1-$2')); }
  return [...new Set(out)];
}

/** The maker's own models.dev provider(s) for a model id, by family. A maker's price is the list price; a reseller's
 *  is not (it may be a markup, a discount or a coding plan's $0). */
const MAKERS: [RegExp, string[]][] = [
  [/claude|haiku|sonnet|opus|fable|mythos/, ['anthropic']],
  [/^(gpt|o\d|codex|chatgpt)/, ['openai']],
  [/^(gemini|gemma)/, ['google', 'google-vertex']],
  [/^(qwen|qwq)/, ['alibaba']],
  [/^kimi/, ['moonshotai']],
  [/^glm/, ['zhipuai', 'zai']],
  [/^deepseek/, ['deepseek']],
  [/^grok/, ['xai']],
  [/^(mistral|devstral|codestral|magistral|ministral|pixtral)/, ['mistral']],
  [/^llama/, ['meta', 'llama']],
  [/^minimax/, ['minimax']],
  [/^nemotron/, ['nvidia']],
  [/^command/, ['cohere']],
];
const makersOf = (id: string): string[] => MAKERS.find(([re]) => re.test(id))?.[1] ?? [];
/** A reseller row that bills nothing is a free tier or a coding plan, not a price for this model. */
const isZero = (row: CatalogRow) => !row[0] && !row[1];

/**
 * The catalog row for a model. Variants outer (an exact id at any trusted source beats a trimmed one), sources inner:
 * the provider the harness named (an OpenCode `provider/model`: what actually ran, $0 included), then the model's maker.
 * Claude, GPT and Gemini ids stop there (the built-in and family rows come next, never a reseller); any other model may
 * take a reseller's price, OpenRouter first, skipping $0 rows.
 */
/** Each provider's rows keyed by the normalised id too (`claude-3-7-sonnet-20250219` → `claude-3-7-sonnet`, OpenRouter's
 *  `moonshotai/kimi-k2` → `kimi-k2`), built once per snapshot. The exact key wins over a normalised twin. */
const indexMemo = new WeakMap<PriceCatalog, Record<string, Record<string, CatalogRow>>>();
function indexOf(cat: PriceCatalog): Record<string, Record<string, CatalogRow>> {
  let idx = indexMemo.get(cat);
  if (idx) return idx;
  idx = {};
  for (const [pid, rows] of Object.entries(cat.providers)) {
    const out: Record<string, CatalogRow> = {};
    for (const [k, row] of Object.entries(rows)) { const bare = normalizeModelId(k.slice(k.lastIndexOf('/') + 1)).id; if (!(bare in out)) out[bare] = row; }
    for (const [k, row] of Object.entries(rows)) out[k] = row;
    idx[pid] = out;
  }
  indexMemo.set(cat, idx);
  return idx;
}

/** Claude, GPT and Gemini have one list price, their maker's: never a reseller's. */
const MAKER_ONLY = /claude|haiku|sonnet|opus|fable|mythos|^(gpt-(?!oss)|o\d|codex|chatgpt)|^gemini/;

/**
 * The catalog row for a model. Variants outer (an exact id at any trusted source beats a trimmed one), sources inner:
 * the provider the harness named (an OpenCode `provider/model`: what actually ran, $0 included), then the model's maker.
 * Claude, GPT and Gemini ids stop there (the built-in and family rows come next, never a reseller); any other model may
 * take a reseller's price, OpenRouter first, skipping $0 rows.
 */
function catalogRow(cat: PriceCatalog, provider: string | null, id: string): { row: CatalogRow; pid: string; v: string } | null {
  const ids = variants(id);
  const idx = indexOf(cat);
  const trusted = [...new Set([...(provider ? [provider] : []), ...makersOf(id)])];
  for (const v of ids) for (const pid of trusted) { const row = idx[pid]?.[v]; if (row) return { row, pid, v }; }
  if (MAKER_ONLY.test(id)) return null;
  const resellers = ['openrouter', ...Object.keys(idx).filter((p) => p !== 'openrouter' && !trusted.includes(p)).sort()];
  for (const v of ids) for (const pid of resellers) { const row = idx[pid]?.[v]; if (row && !isZero(row)) return { row, pid, v }; }
  return null;
}

function catalogLookup(cat: PriceCatalog, provider: string | null, id: string): Price | null {
  const hit = catalogRow(cat, provider, id);
  if (!hit) return null;
  return fromCatalog(hit.row, `${hit.pid}/${hit.v}`, PROVIDER_ALIASES[hit.pid] ?? providerOfId(hit.v));
}

/** A model's context window from the catalog (tokens), or null when the snapshot does not list it. Lets a context meter
 *  show the limit of a model Kora has never heard of. */
export function catalogContextWindow(model: string | null | undefined, home: string = koraHome()): number | null {
  if (!model) return null;
  const cat = loadCatalog(home); if (!cat) return null;
  const { provider, id } = normalizeModelId(model);
  const ctx = catalogRow(cat, provider, id)?.row[4];
  return typeof ctx === 'number' && ctx > 0 ? ctx : null;
}

const UNPRICED = (key: string, provider: PriceProvider): Price => ({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0, write5m: 0, key, provider, source: 'unpriced' });

/** The price of `model` (see the header for the lookup order). Never throws; an unknown model is `source: 'unpriced'`. */
export function priceFor(model: string | null | undefined, home: string = koraHome()): Price {
  const raw = (model || '').trim();
  if (!raw) return UNPRICED('unknown', 'other');
  const user = loadUserRows(home); const cat = loadCatalog(home);
  const memoKey = `${home}\0${raw}`;
  const hit = priceMemo.get(memoKey);
  if (hit) return hit;
  const p = lookup(raw, user, cat);
  priceMemo.set(memoKey, p);
  return p;
}

function lookup(raw: string, user: Record<string, Row>, cat: PriceCatalog | null): Price {
  const lower = raw.toLowerCase();
  const { provider, id } = normalizeModelId(raw);
  const prov = provider && PROVIDER_ALIASES[provider] ? PROVIDER_ALIASES[provider]! : providerOfId(id);
  for (const [k, v] of Object.entries(user)) if (lower.includes(k)) return fromRow(v, k, prov, 'user');
  if (cat) { const hit = catalogLookup(cat, provider, id); if (hit) return hit; }
  for (const v of variants(id)) { const o = OTHERS[v]; if (o) return fromRow(o, v, o.provider, 'built-in'); }
  if (prov === 'anthropic' || /claude/.test(id)) {
    for (const [k, v] of Object.entries(ANTHROPIC)) if (id.includes(k)) return fromRow(v, k, 'anthropic', ANTHROPIC_FAMILIES.has(k) ? 'family' : 'built-in');
  }
  return UNPRICED(id, prov);
}

/** The catalog's age, for Settings (null = no snapshot yet: built-in prices only). */
export function priceCatalogInfo(home: string = koraHome()): { fetchedAt: number; source: string; models: number } | null {
  const cat = loadCatalog(home);
  if (!cat) return null;
  return { fetchedAt: cat.fetchedAt, source: cat.source, models: Object.values(cat.providers).reduce((a, p) => a + Object.keys(p).length, 0) };
}

// ── refresh ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const PRICE_CATALOG_URL = 'https://models.dev/api.json';
export const PRICE_CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Write a snapshot from a models.dev payload (also called by the Swarm catalog refresh, which fetches the same file). */
export function writePriceCatalog(api: unknown, source: string, home: string = koraHome(), now: number = Date.now()): boolean {
  const cat = compactModelsDev(api, now, source);
  if (!cat) return false;
  // A truncated or partial payload never replaces a fuller snapshot (models.dev lists ~8,000 priced models).
  const have = loadCatalog(home);
  const count = (c: PriceCatalog) => Object.values(c.providers).reduce((a, p) => a + Object.keys(p).length, 0);
  if (have && count(cat) < 0.5 * count(have)) return false;
  try {
    const f = priceCatalogPath(home);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cat));
    fs.renameSync(tmp, f);
    catalogMemo = null;
    return true;
  } catch { return false; }
}

/** OpenCode's own copy of models.dev (it refreshes it while it runs). */
function opencodeModelsFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'opencode', 'models.json');
}

/** Off with KORA_PRICE_CATALOG=0 (then only OpenCode's local copy, the built-in table and prices.json are used). */
const networkOff = (env: NodeJS.ProcessEnv) => ['0', 'off', 'false'].includes((env.KORA_PRICE_CATALOG ?? '').trim().toLowerCase());

/**
 * Keep the snapshot under a day old. Prefers OpenCode's local copy when it is fresher than ours (no network); else one
 * GET of models.dev (public, no identifiers sent). Never throws; returns what it did.
 */
export async function refreshPriceCatalog(opts: { home?: string; now?: number; fetch?: typeof fetch; env?: NodeJS.ProcessEnv; force?: boolean } = {}): Promise<'fresh' | 'opencode' | 'fetched' | 'failed' | 'off'> {
  const home = opts.home ?? koraHome(); const now = opts.now ?? Date.now(); const env = opts.env ?? process.env;
  const have = loadCatalog(home);
  if (!opts.force && have && now - have.fetchedAt < PRICE_CATALOG_MAX_AGE_MS) return 'fresh';
  try {
    const oc = opencodeModelsFile(env);
    const st = await fs.promises.stat(oc);
    if (now - st.mtimeMs < PRICE_CATALOG_MAX_AGE_MS && (!have || st.mtimeMs > have.fetchedAt)) {
      if (writePriceCatalog(JSON.parse(await fs.promises.readFile(oc, 'utf8')), 'models.dev (via OpenCode)', home, st.mtimeMs)) return 'opencode';
    }
  } catch { /* no OpenCode copy */ }
  if (networkOff(env)) return 'off';
  try {
    const res = await (opts.fetch ?? globalThis.fetch)(PRICE_CATALOG_URL, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return 'failed';
    return writePriceCatalog(await res.json(), 'models.dev', home, now) ? 'fetched' : 'failed';
  } catch { return 'failed'; }
}

/** The daemon's refresh: once shortly after start, then every 6 hours (each a no-op while the snapshot is fresh). */
export function startPriceCatalogRefresh(): () => void {
  const run = () => { void refreshPriceCatalog().catch(() => undefined); };
  const first = setTimeout(run, 30_000); first.unref?.();
  const iv = setInterval(run, 6 * 60 * 60 * 1000); iv.unref?.();
  return () => { clearTimeout(first); clearInterval(iv); };
}
