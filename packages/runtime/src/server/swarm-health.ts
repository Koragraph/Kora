// SwarmHealth — per-model cooldowns (429 / quota / model gone), persisted in ~/.kora/swarm/health.json so they survive a
// daemon restart. The file is tiny ({ [model]: { until, reason, provider, failures, gone? } }); it is read lazily on
// first use and rewritten (atomically) on every markCooling. Expired entries are pruned on read.
import fs from 'node:fs';
import path from 'node:path';
import { koraHome } from '../protocol/types';
import type { SwarmModelCooling, SwarmSupplyProviderId } from '../protocol/types';

interface HealthRow { until: number; reason: string; provider: SwarmSupplyProviderId; failures: number; gone?: boolean }

/** The provider an opencode `-m` id belongs to (`opencode/…` is Zen; `ollama/…` / `lmstudio/…` are local servers). */
export function providerOfModel(model: string): SwarmSupplyProviderId {
  if (model.startsWith('openrouter/')) return 'openrouter';
  if (model.startsWith('cerebras/')) return 'cerebras';
  if (model.startsWith('ollama/')) return 'ollama';
  if (model.startsWith('lmstudio/')) return 'lmstudio';
  return 'zen';
}

/** Which supply tier a model id is: `local` (on-machine server), `paid` (OpenRouter without `:free`) or `free`. */
export type SwarmModelTier = 'free' | 'paid' | 'local';
export function modelTier(model: string): SwarmModelTier {
  const p = providerOfModel(model);
  if (p === 'ollama' || p === 'lmstudio') return 'local';
  if (p === 'openrouter' && !model.endsWith(':free')) return 'paid';
  return 'free';
}

export class SwarmHealth {
  private rows: Record<string, HealthRow> | null = null;

  /** @param file defaults to ~/.kora/swarm/health.json. The constructor must stay cheap and never throw. */
  constructor(readonly file?: string) {}

  private get path(): string { return this.file ?? path.join(koraHome(), 'swarm', 'health.json'); }

  private load(): Record<string, HealthRow> {
    if (this.rows) return this.rows;
    let rows: Record<string, HealthRow> = {};
    try {
      const raw = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      if (raw && typeof raw === 'object') {
        for (const [model, r] of Object.entries(raw as Record<string, any>)) {
          if (r && typeof r.until === 'number') rows[model] = { until: r.until, reason: String(r.reason ?? ''), provider: r.provider ?? providerOfModel(model), failures: Number(r.failures) || 1, ...(r.gone ? { gone: true } : {}) };
        }
      }
    } catch { rows = {}; }
    this.rows = rows;
    return rows;
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.rows ?? {}, null, 2));
      fs.renameSync(tmp, this.path);
    } catch { /* health is advisory; an unwritable home must not break a spawn */ }
  }

  /** Cool `model` until `until` (epoch ms). `gone` marks it missing until the catalog refreshes. */
  markCooling(model: string, until: number, reason: string, opts: { gone?: boolean } = {}): void {
    const rows = this.load();
    const prev = rows[model];
    rows[model] = {
      until: Math.max(until, prev && prev.until > Date.now() ? prev.until : 0),
      reason, provider: providerOfModel(model), failures: (prev?.failures ?? 0) + 1,
      ...(opts.gone || (prev?.gone && prev.until > Date.now()) ? { gone: true } : {}),
    };
    this.save();
  }

  /** Models cooling (or gone) at `now`. */
  cooling(now = Date.now()): SwarmModelCooling[] {
    const rows = this.load();
    const out: SwarmModelCooling[] = [];
    for (const [model, r] of Object.entries(rows)) if (r.until > now) out.push({ model, provider: r.provider, until: r.until, reason: r.reason });
    return out.sort((a, b) => a.until - b.until);
  }

  isAvailable(model: string, now = Date.now()): boolean {
    const r = this.load()[model];
    return !r || r.until <= now;
  }
}
