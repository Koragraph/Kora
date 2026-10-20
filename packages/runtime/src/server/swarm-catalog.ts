// The free-model catalog: a ranked static seed filtered against models.dev (cost.input === 0), cached 24 h in
// ~/.kora/swarm/catalog.json. refreshSwarmCatalog is async (network) and must never sit on a spawn's hot path —
// callers fire it in the background; the seed (or the last cached list) is always usable.
// Also here: the cheap PAID OpenRouter tier (seed ∩ models.dev, with live prices; BYO OpenRouter key, opt-in) and
// orderBySupply, which lays the tiers out per the user's `swarm.supply` preference.
import fs from 'node:fs';
import path from 'node:path';
import { koraHome } from '../protocol/types';
import type { SwarmModelInfo, SwarmProviderId } from '../protocol/types';
import type { SwarmSupplyPolicy } from '../config';
import { modelTier } from './swarm-health';
import { writePriceCatalog } from '../ledger/prices';

const label = (id: string): string => id.split('/').slice(-1)[0].replace(/:free$/, '');
const m = (id: string, provider: SwarmProviderId, rank: number, maxConcurrent: number | null): SwarmModelInfo => ({ id, provider, label: label(id), rank, maxConcurrent });

/**
 * Ranked seed (Zen → OpenRouter `:free` → Cerebras). Only free ids ever (R7: never "any opencode/*" — with a Zen key
 * opencode also loads PAID Zen models). Cerebras: 1 worker per model (5 requests/min). OpenRouter's shared 20/min is
 * enforced per provider by the picker (SwarmService), not per model.
 */
export const SWARM_MODEL_SEED: readonly SwarmModelInfo[] = [
  // Zen (no key; ids from models.dev `opencode`, cost 0, tool calling, not deprecated) — 2026-10-17. Only the offline
  // fallback: the live catalog (refreshSwarmCatalog) drops retired ids and adds new ones.
  m('opencode/big-pickle', 'zen', 0, 2),
  m('opencode/deepseek-v4.1-flash-free', 'zen', 1, 2),
  m('opencode/glm-5.3-flash-free', 'zen', 2, 2),
  m('opencode/nemotron-3.5-lightning-free', 'zen', 3, 2),
  m('opencode/mimo-v2.6-flash-free', 'zen', 4, 2),
  m('opencode/nemotron-3-ultra-free', 'zen', 5, 2),
  m('opencode/longcat-2.5-preview-free', 'zen', 6, 2),
  // OpenRouter `:free` (key; 20 requests/min shared — the picker caps concurrent OpenRouter workers)
  m('openrouter/qwen/qwen3.8-27b:free', 'openrouter', 20, null),
  m('openrouter/nvidia/nemotron-3-super-120b-a12b:free', 'openrouter', 21, null),
  m('openrouter/poolside/laguna-s-2.1:free', 'openrouter', 22, null),
  m('openrouter/google/gemma-4-31b-it:free', 'openrouter', 23, null),
  m('openrouter/nvidia/nemotron-3-ultra-550b-a55b:free', 'openrouter', 24, null),
  // Cerebras (key; a trial, off by default — PLAN D-f; 5 requests/min per model)
  m('cerebras/gpt-oss-120b', 'cerebras', 40, 1),
  m('cerebras/qwen-3.8-27b', 'cerebras', 41, 1),
];

/** $/M tokens, from models.dev (a label for caps and `kora swarm models`, not a bill). */
export interface SwarmModelPrice { input: number; output: number }

/**
 * Cheap PAID OpenRouter models (BYO key, only with `swarm.paid.enabled`). Tool-calling "flash" tier, picked for agentic
 * coding at ≈ $0.001–0.004 per worker task (STATUS: median 141K input mostly cached, 2.3K output). Prices are the
 * models.dev values of 2026-09-24; the live feed replaces them. A seed id models.dev no longer lists is dropped.
 */
export const SWARM_PAID_SEED: readonly { id: string; price: SwarmModelPrice }[] = [
  { id: 'openrouter/qwen/qwen3.7-flash', price: { input: 0.03, output: 0.13 } },
  { id: 'openrouter/deepseek/deepseek-v4-flash', price: { input: 0.086, output: 0.171 } },
  { id: 'openrouter/inclusionai/ling-3.0-flash', price: { input: 0.021, output: 0.063 } },
  { id: 'openrouter/openai/gpt-oss-20b', price: { input: 0.018, output: 0.09 } },
  { id: 'openrouter/z-ai/glm-4.7-flash', price: { input: 0.061, output: 0.4 } },
  { id: 'openrouter/qwen/qwen3-coder-30b-a3b-instruct', price: { input: 0.07, output: 0.28 } },
];
/** Above this a model is not "cheap": a user-listed paid model costlier than this is refused (a typo guard). */
export const PAID_MAX_PRICE: SwarmModelPrice = { input: 1, output: 4 };

const CATALOG_TTL_MS = 6 * 60 * 60 * 1000; // new free models show up the same day
const MODELS_DEV_URL = 'https://models.dev/api.json';
/** models.dev provider key for each swarm provider (opencode's own source of truth). */
const MODELS_DEV_PROVIDER: Record<SwarmProviderId, string> = { zen: 'opencode', openrouter: 'openrouter', cerebras: 'cerebras' };

function catalogFile(): string { return path.join(koraHome(), 'swarm', 'catalog.json'); }

function readCache(): { fetchedAt: number; models: SwarmModelInfo[]; paid?: { id: string; price: SwarmModelPrice }[] } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(catalogFile(), 'utf8'));
    if (raw && typeof raw.fetchedAt === 'number' && Array.isArray(raw.models)) return raw;
  } catch { /* none */ }
  return null;
}

/** Seed ∩ live models.dev (free only for Zen / OpenRouter; Cerebras is a trial so present is enough), plus any new
 *  free Zen model models.dev lists (ranked after the seed's Zen entries). Pure — exported for tests. */
export function filterCatalog(api: any): SwarmModelInfo[] {
  const live = (p: SwarmProviderId): Record<string, any> | null => {
    const prov = api?.[MODELS_DEV_PROVIDER[p]];
    return prov && typeof prov === 'object' && prov.models && typeof prov.models === 'object' ? prov.models : null;
  };
  const isFree = (x: any) => Number(x?.cost?.input ?? NaN) === 0 && Number(x?.cost?.output ?? 0) === 0;
  const out: SwarmModelInfo[] = [];
  for (const s of SWARM_MODEL_SEED) {
    const models = live(s.provider as SwarmProviderId); // the seed is remote providers only
    if (!models) { out.push(s); continue; } // provider missing from the feed: keep the seed rather than lose it
    const key = s.id.slice(s.id.indexOf('/') + 1);
    const hit = models[key];
    if (!hit) continue;
    if (s.provider !== 'cerebras' && !isFree(hit)) continue;
    if (hit.status === 'deprecated') continue; // the feed itself says it is on its way out
    out.push(s);
  }
  const zen = live('zen');
  if (zen) {
    let rank = 7; // after the seed's Zen entries, before OpenRouter (20+)
    for (const [key, x] of Object.entries(zen)) {
      const id = `opencode/${key}`;
      if (!isFree(x) || (x as any)?.tool_call === false || (x as any)?.status === 'deprecated' || out.some((o) => o.id === id)) continue;
      out.push(m(id, 'zen', Math.round(rank * 100) / 100, 2)); rank += 0.01;
    }
  }
  return out.sort((a, b) => a.rank - b.rank);
}

/** Paid seed ∩ live models.dev OpenRouter (tool calling, priced, cheap), with live prices. Pure — exported for tests. */
export function filterPaidCatalog(api: any): { id: string; price: SwarmModelPrice }[] {
  const models = api?.openrouter?.models;
  if (!models || typeof models !== 'object') return SWARM_PAID_SEED.map((x) => ({ id: x.id, price: { ...x.price } }));
  const out: { id: string; price: SwarmModelPrice }[] = [];
  for (const s of SWARM_PAID_SEED) {
    const hit = models[s.id.slice('openrouter/'.length)];
    if (!hit || hit.tool_call === false) continue;
    const input = Number(hit.cost?.input), output = Number(hit.cost?.output ?? 0);
    if (!(input > 0) || input > PAID_MAX_PRICE.input || output > PAID_MAX_PRICE.output) continue;
    out.push({ id: s.id, price: { input, output } });
  }
  return out;
}

/** The paid tier as picker models: `configured` (swarm.paid.models) wins when set, else the (cached) seed. */
export function paidCatalog(configured: string[] = []): { model: SwarmModelInfo; price: SwarmModelPrice | null }[] {
  const known = new Map<string, SwarmModelPrice>();
  for (const x of readCache()?.paid ?? SWARM_PAID_SEED) known.set(x.id, x.price);
  const ids = configured.length
    ? configured.map((id) => (id.startsWith('openrouter/') ? id : `openrouter/${id}`)).filter((id) => !id.endsWith(':free'))
    : [...known.keys()];
  return ids.map((id, i) => ({ model: m(id, 'openrouter', 60 + i, null), price: known.get(id) ?? null }));
}

/** Price of a paid model when known (catalog cache or seed), else null. */
export function paidPrice(id: string): SwarmModelPrice | null {
  for (const x of readCache()?.paid ?? SWARM_PAID_SEED) if (x.id === id) return { ...x.price };
  return null;
}

/**
 * Lay the tiers out per the user's preference (stable within a tier — the caller's provider/rank order stays):
 *   free-first  free remote → local → paid     (default: $0 first; local before paying)
 *   paid-first  paid → free remote → local     (reliability first: no shared per-IP free throttles)
 *   local-only  local only                      (privacy: nothing leaves the machine)
 */
export function orderBySupply<T extends { id: string }>(models: T[], policy: SwarmSupplyPolicy): T[] {
  const order: Record<SwarmSupplyPolicy, ('free' | 'paid' | 'local')[]> = {
    'free-first': ['free', 'local', 'paid'], 'paid-first': ['paid', 'free', 'local'], 'local-only': ['local'],
  };
  const tiers = order[policy] ?? order['free-first'];
  return tiers.flatMap((tier) => models.filter((x) => modelTier(x.id) === tier));
}

/** Seed ∩ live free models; cached for 24 h unless `force`. Never throws: a failed fetch returns the cache or the seed. */
export async function refreshSwarmCatalog(opts: { force?: boolean; fetch?: typeof fetch } = {}): Promise<SwarmModelInfo[]> {
  const cached = readCache();
  if (!opts.force && cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) return cached.models;
  const f = opts.fetch ?? globalThis.fetch;
  try {
    const res = await f(MODELS_DEV_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`models.dev ${res.status}`);
    const api = await res.json();
    writePriceCatalog(api, 'models.dev'); // the same file prices the savings meter (ledger/prices.ts)
    const models = filterCatalog(api);
    if (!models.length) throw new Error('models.dev listed none of the free models');
    const paid = filterPaidCatalog(api);
    try {
      fs.mkdirSync(path.dirname(catalogFile()), { recursive: true });
      const tmp = `${catalogFile()}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ fetchedAt: Date.now(), models, paid }, null, 2));
      fs.renameSync(tmp, catalogFile());
    } catch { /* cache is best effort */ }
    return models;
  } catch {
    return cached?.models ?? [...SWARM_MODEL_SEED];
  }
}
