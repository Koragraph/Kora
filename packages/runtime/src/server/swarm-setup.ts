// SwarmSetup — the setup side of Swarm: readiness (SwarmStatus), the OpenCode install, keys, probes, consent and
// preferences. `runtime.swarmSetup`; the ui-server reaches it in-process as `UiHost.swarm` (its structural type is
// `KoraSwarmLike` in packages/ui-server/src/host.ts — verb names are identical on every layer, R1).
//
// Readiness rule (R2), owned here:
//   opencode.installed && opencode.versionOk && consent.acceptedVersion >= consent.requiredVersion
//   && providers.some(p => p.enabled && (p.provider === 'zen' ? p.lastTest?.ok !== false : p.hasKey))
//   && models.available.length > 0
// Every unmet term is one SwarmBlocker; ready ⇔ no blockers.
//
// Nothing here blocks the event loop for long: opencode detection is stat() only, `--version` and the login-shell
// probe are child processes, probes and the install are async fetches. Provider test results live in memory (a daemon
// restart forgets them; Zen then counts as usable until a test says otherwise, per the rule above).
import type {
  SwarmBlocker, SwarmConsentState, SwarmInstallState, SwarmLocalProviderId, SwarmModelCooling, SwarmModelInfo, SwarmOpencodeStatus, SwarmPreferences,
  SwarmProviderId, SwarmProviderStatus, SwarmProviderTestResult, SwarmStatus, SwarmWorkerBackendStatus,
} from '../protocol/types';
import type { SwarmHealth } from './swarm-health';
import path from 'node:path';
import { loadConfig, saveConfig, invalidateConfig, type KoraConfig, type SwarmSupplyPolicy } from '../config';
import {
  OPENCODE_MIN_VERSION, OPENCODE_PINNED_VERSION, compareOpencodeVersions, installOpencode, opencodeVersion, refreshOpencodeBinary, resolveOpencodeBinary,
} from './swarm-install';
import { clearSwarmKey, getSwarmKey, keyHint, setSwarmKey, swarmKeySource } from './swarm-secrets';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { probeCerebras, probeLmStudio, probeOllama, probeOpenRouter, probeZen } from './swarm-probe';
import { SWARM_MODEL_SEED, orderBySupply, paidCatalog, refreshSwarmCatalog } from './swarm-catalog';
import { isProEdition, proOnlyMessage } from '../edition';
import { winCommand } from '../util/win-exec';

/** Mirrors contracts `SWARM_PRIVACY_NOTICE_VERSION` (the runtime does not import @kora/contracts). Bump both together. */
const PRIVACY_NOTICE_VERSION = 1;
const PROVIDERS: readonly SwarmProviderId[] = ['zen', 'openrouter', 'cerebras'];
export const LOCAL_PROVIDERS: readonly SwarmLocalProviderId[] = ['ollama', 'lmstudio'];
const SUPPLY_POLICIES: readonly SwarmSupplyPolicy[] = ['free-first', 'paid-first', 'local-only'];

/** A local model server as `kora swarm models` / the UI see it (runtime-only; not part of SwarmStatus on the wire). */
export interface SwarmLocalStatus {
  provider: SwarmLocalProviderId; enabled: boolean; baseUrl: string;
  /** Configured model filter ([] = every tool-capable model the server lists). */ models: string[];
  lastTest: SwarmProviderTestResult | null;
}
/** The supply settings (runtime + CLI; the UI builds on the same shape). */
export interface SwarmSupplyState {
  policy: SwarmSupplyPolicy;
  paid: { enabled: boolean; maxTaskUsd: number; models: string[]; hasKey: boolean };
  local: SwarmLocalStatus[];
}
const VERSION_TTL_MS = 60_000;
/** A `--version` that gave nothing (timeout under load) is retried soon: it must not hold Swarm blocked for a whole TTL. */
const VERSION_MISS_TTL_MS = 5_000;
const versionFresh = (c: { at: number; version: string | null }) => Date.now() - c.at < (c.version ? VERSION_TTL_MS : VERSION_MISS_TTL_MS);

const SWARM_FRESH_MS = 15 * 60_000;
/** size:mtime of a file (following symlinks), '' when it can't be read. */
const fileSig = (f: string): string => { try { const st = fs.statSync(f); return `${st.size}:${st.mtimeMs}`; } catch { return ''; } };

const IDLE_INSTALL: SwarmInstallState = {
  operationId: null, phase: 'idle', downloadedBytes: 0, totalBytes: null, version: null, installedVersion: null, message: null,
};

/** Optional seams (tests; the daemon passes only `health`). */
interface SwarmSetupDeps {
  health: SwarmHealth;
  /** fetch for the provider probes and the catalog refresh. */
  fetch?: typeof fetch;
  /** The notice version consent must reach (default: the contracts' SWARM_PRIVACY_NOTICE_VERSION). */
  noticeVersion?: number;
  /** OpenCode detection. */
  resolveOpencode?: (opts: { probe: boolean }) => Promise<{ path: string | null; source: SwarmOpencodeStatus['source'] }>;
  opencodeVersion?: (bin: string) => Promise<string | null>;
  install?: typeof installOpencode;
  /** Koragent detection (swarm.workerBackend = 'koragent'); default koragent-backend.ts resolveKoragentBinary. */
  resolveKoragent?: () => { path: string | null; source: string | null };
  /** `koragent --version` (default koragent-install.ts koragentVersion). */
  koragentVersion?: (bin: string) => Promise<string | null>;
  /** The sha256 pin check (default koragent-install.ts checkKoragentPin; null = not installed by Kora). */
  koragentPin?: (bin: string) => Promise<{ pinned: string; actual: string; ok: boolean } | null>;
  /** `koragent models …` for the koragent backend's free catalog (default: koragent-catalog.ts). */
  koragentModels?: (bin: string) => Promise<string[] | null>;
  /** The free-model catalog (default: S2's refreshed catalog, else SWARM_MODEL_SEED, else what the probes found). */
  catalog?: () => SwarmModelInfo[];
  probes?: Partial<{
    zen: typeof probeZen; openrouter: typeof probeOpenRouter; cerebras: typeof probeCerebras;
    ollama: typeof probeOllama; lmstudio: typeof probeLmStudio;
  }>;
}

/**
 * The koragent backend's pickable ids for one provider: the probe's free list ∩ what the installed Koragent says it can
 * run. `known === null` means Koragent couldn't say (keep the probe's list); a known list with none of these ids means
 * Koragent can't run this provider (e.g. Zen with no key) → none, never ids whose workers die on their first step.
 */
export function koragentRunnable(probeFree: string[], known: string[] | null): string[] {
  return known ? probeFree.filter((m) => known.includes(m)) : probeFree;
}

export class SwarmSetup {
  private readonly listeners = new Set<(status: SwarmStatus) => void>();
  private install: SwarmInstallState = { ...IDLE_INSTALL };
  private installAbort: AbortController | null = null;
  private installRun: Promise<SwarmInstallState> | null = null;
  private readonly tests = new Map<SwarmProviderId, SwarmProviderTestResult>();
  private readonly localTests = new Map<SwarmLocalProviderId, SwarmProviderTestResult>();
  private versionCache: { bin: string; at: number; version: string | null } | null = null;
  private kgVersionCache: { bin: string; at: number; version: string | null } | null = null;
  private readonly goodVersion = new Map<string, { sig: string; version: string }>();
  private refreshedCatalog: SwarmModelInfo[] | null = null;
  private emitQueued = false;

  constructor(readonly deps: SwarmSetupDeps) {}

  // ---- status ----------------------------------------------------------------------------------------------------

  /** probe = re-detect opencode (fixed search + login shell), re-read its version and config, refresh the catalog. */
  async getStatus(opts: { probe?: boolean } = {}): Promise<SwarmStatus> {
    const probe = !!opts.probe;
    // Zen adds and retires free models every few days: refresh in the background on any status read (at most every
    // 10 min; the catalog's own cache decides when the network is used). Before this only a probe refreshed it, so a
    // daemon that was never re-checked offered the compiled-in seed for weeks (live: 6 of 7 retired by Zen).
    if (!probe && !this.deps.catalog && Date.now() - this.catalogKickAt > 10 * 60_000) { this.catalogKickAt = Date.now(); void this.refreshCatalog(); }
    if (probe) {
      invalidateConfig();
      this.versionCache = null;
      this.catalogKickAt = Date.now();
      void this.refreshCatalog(true);
      // Local servers are localhost and fast: re-probe the enabled ones (a CLI `models local … on` lands here).
      const local = loadConfig().swarm.local;
      for (const p of LOCAL_PROVIDERS) if (local[p].enabled) void this.testLocal({ provider: p }).catch(() => {});
    }
    const cfg = loadConfig();
    const opencode = await this.opencodeStatus(probe);
    const consent = this.consentState(cfg);
    const providers = this.providerStatuses(cfg);
    const cooling = this.cooling();
    const available = this.pickableModels();
    const workerBackend = await this.workerBackendStatus(cfg, probe);
    const blockers = this.blockers({ opencode, consent, providers, available, cooling, workerBackend });
    return {
      ready: blockers.length === 0,
      blockers,
      opencode,
      // Idle/failed/cancelled still names the version an install would fetch (the button reads "… OpenCode <ver>").
      install: { ...this.install, version: this.install.version ?? (['idle', 'failed', 'cancelled'].includes(this.install.phase) ? OPENCODE_PINNED_VERSION : null) },
      consent,
      providers,
      models: { available, cooling },
      preferences: this.preferences(cfg),
      supplyState: wireSupply(cfg.swarm),
      keyStorage: 'file',
      checkedAt: Date.now(),
      // Only when it is not the default: an opencode daemon's status stays exactly what it was.
      ...(workerBackend.id === 'koragent' ? { workerBackend } : {}),
    };
  }

  /**
   * The configured worker backend; for koragent, where its binary is, its `--version` against KORAGENT_MIN_VERSION
   * (cached like OpenCode's: an unchanged binary keeps its last good answer through a timeout) and, when Kora installed
   * it, whether it still matches its sha256 pin.
   */
  private async workerBackendStatus(cfg: KoraConfig, probe = false): Promise<SwarmWorkerBackendStatus> {
    if (cfg.swarm.workerBackend !== 'koragent') return { id: 'opencode', installed: true, path: null, source: null };
    const ki = require('./koragent-install') as typeof import('./koragent-install');
    let found: { path: string | null; source: string | null } = { path: null, source: null };
    try { found = this.deps.resolveKoragent ? this.deps.resolveKoragent() : (require('./koragent-backend') as typeof import('./koragent-backend')).resolveKoragentBinary(); } catch { /* not found */ }
    const base = { id: 'koragent' as const, installed: !!found.path, path: found.path, source: found.path ? found.source : null, minVersion: ki.KORAGENT_MIN_VERSION };
    if (!found.path) return { ...base, version: null, versionOk: false, pinned: null, pinOk: null };
    let version: string | null = null;
    const c = this.kgVersionCache;
    if (!probe && c && c.bin === found.path && versionFresh(c)) version = c.version;
    else {
      version = await (this.deps.koragentVersion ?? ki.koragentVersion)(found.path).catch(() => null);
      this.kgVersionCache = { bin: found.path, at: Date.now(), version };
    }
    const sig = fileSig(found.path);
    if (version) this.goodVersion.set(`kg:${found.path}`, { sig, version });
    else { const g = this.goodVersion.get(`kg:${found.path}`); if (g && g.sig === sig) version = g.version; }
    const pin = await (this.deps.koragentPin ?? ki.checkKoragentPin)(found.path).catch(() => null);
    return { ...base, version, versionOk: ki.koragentVersionOk(version), pinned: pin ? pin.pinned : null, pinOk: pin ? pin.ok : null };
  }

  /** Called with every new status (install progress included). Returns the unsubscribe function. */
  onStatus(fn: (status: SwarmStatus) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** Recompute and push the status to every listener; coalesces bursts into one computation. */
  private emit(): void {
    if (!this.listeners.size || this.emitQueued) return;
    this.emitQueued = true;
    queueMicrotask(() => {
      this.emitQueued = false;
      this.getStatus().then((s) => {
        for (const fn of [...this.listeners]) { try { fn(s); } catch { /* a listener's problem */ } }
      }, () => { /* status unavailable; the next change retries */ });
    });
  }

  private async opencodeStatus(probe: boolean): Promise<SwarmOpencodeStatus> {
    const found = this.deps.resolveOpencode
      ? await this.deps.resolveOpencode({ probe })
      : probe ? await refreshOpencodeBinary() : resolveOpencodeBinary();
    let version: string | null = null;
    if (found.path) {
      const c = this.versionCache;
      if (c && c.bin === found.path && versionFresh(c)) version = c.version;
      else {
        version = await (this.deps.opencodeVersion ?? opencodeVersion)(found.path).catch(() => null);
        this.versionCache = { bin: found.path, at: Date.now(), version };
      }
      // An unchanged binary cannot change version: a `--version` that timed out under load (found live: 10 leaders
      // spawning at once) must not flip Swarm to "OpenCode missing" and send Claude off to do the work itself.
      const sig = fileSig(found.path);
      if (version) this.goodVersion.set(found.path, { sig, version });
      else { const g = this.goodVersion.get(found.path); if (g && g.sig === sig) { version = g.version; if (this.versionCache) this.versionCache.version = version; } }
    }
    const pathDirs = (process.env.PATH ?? '').split(path.delimiter);
    return {
      installed: !!found.path,
      path: found.path,
      source: found.path ? found.source : null,
      version,
      minVersion: OPENCODE_MIN_VERSION,
      versionOk: version != null && compareOpencodeVersions(version, OPENCODE_MIN_VERSION) >= 0,
      onDaemonPath: !!found.path && pathDirs.includes(path.dirname(found.path)),
    };
  }

  private requiredNotice(): number { return this.deps.noticeVersion ?? PRIVACY_NOTICE_VERSION; }

  private consentState(cfg: KoraConfig): SwarmConsentState {
    const c = cfg.swarm.consent;
    return { requiredVersion: this.requiredNotice(), acceptedVersion: c ? c.noticeVersion : null, acceptedAt: c ? c.acceptedAt : null };
  }

  private preferences(cfg: KoraConfig): SwarmPreferences {
    return { providerOrder: [...cfg.swarm.providerOrder], defaultModel: cfg.swarm.defaultModel, maxWorkers: cfg.swarm.maxWorkers };
  }

  private providerStatus(cfg: KoraConfig, provider: SwarmProviderId): SwarmProviderStatus {
    const source = swarmKeySource(provider);
    const key = source ? getSwarmKey(provider) : null;
    const lastTest = this.tests.get(provider) ?? null;
    return {
      provider,
      enabled: cfg.swarm.providers[provider],
      // Zen: whatever the probe found (D-h) — a key is required only once Zen rejected a keyless request.
      keyRequired: provider === 'zen' ? lastTest?.outcome === 'invalid-key' : true,
      hasKey: !!key,
      keySource: key ? source : null,
      keyHint: key ? keyHint(key) : null,
      lastTest: lastTest ? { ...lastTest, freeModels: [...lastTest.freeModels], limits: lastTest.limits ? { ...lastTest.limits } : null } : null,
      limits: lastTest?.limits ? { ...lastTest.limits } : null,
    };
  }

  private providerStatuses(cfg: KoraConfig): SwarmProviderStatus[] {
    return cfg.swarm.providerOrder.map((p) => this.providerStatus(cfg, p));
  }

  /** R2's provider term: enabled, and (Zen) not failed its last test / (others) has a key. */
  private static providerUsable(p: SwarmProviderStatus): boolean {
    return p.enabled && (p.provider === 'zen' ? p.lastTest?.ok !== false : p.hasKey);
  }

  private cooling(now = Date.now()): SwarmModelCooling[] {
    try { return this.deps.health.cooling(now); } catch { return []; } // S2's SwarmHealth may still be the W0 stub
  }

  private isAvailable(model: string, now: number): boolean {
    try { return this.deps.health.isAvailable(model, now); } catch { return true; }
  }

  private blockers(s: {
    opencode: SwarmOpencodeStatus; consent: SwarmConsentState; providers: SwarmProviderStatus[];
    available: SwarmModelInfo[]; cooling: SwarmModelCooling[]; workerBackend?: SwarmWorkerBackendStatus;
  }): SwarmBlocker[] {
    const out: SwarmBlocker[] = [];
    // Koragent workers need Koragent, not OpenCode (the optional foreman reviewer still uses OpenCode when present).
    if (s.workerBackend?.id === 'koragent') {
      const wb = s.workerBackend;
      if (!wb.installed) out.push({ code: 'koragent-missing', message: (require('./koragent-backend') as typeof import('./koragent-backend')).KORAGENT_NOT_INSTALLED });
      else if (wb.pinOk === false) out.push({ code: 'koragent-missing', message: `Koragent at ${wb.path} changed since Kora installed it (sha256 no longer matches the pin); reinstall: kora swarm install --backend koragent` });
      else if (!wb.versionOk) {
        out.push({
          code: 'koragent-too-old',
          message: wb.version
            ? `Koragent ${wb.version} is older than ${wb.minVersion}; update it (kora swarm install --backend koragent)`
            : `Koragent at ${wb.path} did not report a version (needs ${wb.minVersion} or newer)`,
        });
      }
    } else if (!s.opencode.installed) out.push({ code: 'opencode-missing', message: 'OpenCode is not installed' });
    else if (!s.opencode.versionOk) {
      out.push({
        code: 'opencode-too-old',
        message: s.opencode.version
          ? `OpenCode ${s.opencode.version} is older than ${s.opencode.minVersion}; update it`
          : `OpenCode at ${s.opencode.path} did not report a version (needs ${s.opencode.minVersion} or newer)`,
      });
    }
    const { acceptedVersion, requiredVersion } = s.consent;
    if (acceptedVersion == null || acceptedVersion < requiredVersion) {
      out.push({
        code: 'consent-missing',
        message: acceptedVersion == null
          ? 'Accept the Swarm privacy notice (free-model providers may log prompts and code)'
          : `The Swarm privacy notice changed (v${requiredVersion}); accept the new version`,
      });
    }
    const cfg = loadConfig();
    const localOnly = cfg.swarm.supply === 'local-only';
    const localUsable = LOCAL_PROVIDERS.filter((p) => cfg.swarm.local[p].enabled && this.localTests.get(p)?.ok !== false);
    const usable = localOnly ? [] : s.providers.filter(SwarmSetup.providerUsable);
    if (!usable.length && !localUsable.length) {
      out.push({ code: 'no-provider', message: localOnly
        ? `Local-only mode: no local model server is usable. ${this.localHint(cfg)}`
        : 'No free-model provider is usable: enable OpenCode Zen, or add an OpenRouter key' });
    } else if (!s.available.length) {
      out.push(s.cooling.length
        ? { code: 'all-models-cooling', message: 'every free model is cooling down after rate limits' }
        : { code: 'no-provider', message: localOnly ? `Local-only mode: no local model is ready. ${this.localHint(cfg)}` : 'The enabled providers offer no free model right now; test them in Settings → Swarm' });
    }
    return out;
  }

  /** The most useful next step for local-only mode (the last probe's own message when there is one). */
  private localHint(cfg: KoraConfig): string {
    const enabled = LOCAL_PROVIDERS.filter((p) => cfg.swarm.local[p].enabled);
    if (!enabled.length) return 'Enable Ollama or LM Studio: kora swarm models local ollama on';
    const failed = enabled.map((p) => this.localTests.get(p)).find((t) => t && !t.ok);
    if (failed?.message) return failed.message;
    return `Test it: kora swarm test ${enabled[0]}`;
  }

  // ---- models ----------------------------------------------------------------------------------------------------

  private catalogKickAt = 0;
  /** force = a user's re-check: fetch models.dev now instead of trusting the cache. */
  private async refreshCatalog(force = false): Promise<void> {
    try {
      const list = await refreshSwarmCatalog({ ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}), ...(force ? { force } : {}) });
      if (Array.isArray(list) && list.length) { this.refreshedCatalog = list; this.emit(); }
    } catch { /* S2's catalog not landed, or offline: keep the seed */ }
  }

  /** The catalog: an injected one, else S2's refreshed list, else the seed, else the free ids the probes found. */
  private catalog(): SwarmModelInfo[] {
    if (this.deps.catalog) return this.deps.catalog();
    if (this.refreshedCatalog?.length) return this.refreshedCatalog;
    if (SWARM_MODEL_SEED.length) return [...SWARM_MODEL_SEED];
    const out: SwarmModelInfo[] = [];
    for (const p of PROVIDERS) {
      const t = this.tests.get(p);
      if (!t?.ok) continue;
      t.freeModels.forEach((id, i) => out.push({ id, provider: p, label: id.slice(id.indexOf('/') + 1), rank: 1000 + i, maxConcurrent: null }));
    }
    return out;
  }

  /** Free models the picker may use right now, in preference order (enabled providers, not cooling). For S2. */
  pickableModels(): SwarmModelInfo[] {
    const cfg = loadConfig();
    const now = Date.now();
    const order = cfg.swarm.providerOrder;
    const usable = new Map<SwarmProviderId, SwarmProviderStatus>();
    for (const p of PROVIDERS) {
      const st = this.providerStatus(cfg, p);
      // A provider whose last test failed (bad key, no free models) contributes nothing, whatever the key state.
      if (usableForPick(st)) usable.set(p, st);
    }
    const seen = new Set<string>();
    const models = this.catalog().filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      const st = usable.get(m.provider as SwarmProviderId);
      if (!st) return false;
      // The provider's own listing is fresher than the catalog: a model it no longer lists is gone.
      // An ok listing is authoritative even when empty (koragent backend with no Zen key: 0 runnable → none offered).
      if (st.lastTest?.ok && !st.lastTest.freeModels.includes(m.id)) return false;
      return this.isAvailable(m.id, now);
    });
    // Live free ids the catalog does not know yet (Zen adds models between catalog refreshes): spawnable too, ranked
    // after the catalog's own. Found live: the picker offered only big-pickle while Zen listed 8 usable free models.
    for (const [provider, st] of usable) {
      if (!st.lastTest?.ok) continue;
      st.lastTest.freeModels.forEach((id, i) => {
        if (seen.has(id) || !this.isAvailable(id, now)) return;
        seen.add(id);
        models.push({ id, provider, label: id.split('/').pop()!.replace(/:free$/, ''), rank: 1000 + i, maxConcurrent: null });
      });
    }
    models.sort((a, b) => (order.indexOf(a.provider as SwarmProviderId) - order.indexOf(b.provider as SwarmProviderId)) || (a.rank - b.rank));
    // Paid OpenRouter (opt-in, BYO key): only with a usable OpenRouter provider.
    if (cfg.swarm.paid.enabled && usable.has('openrouter')) {
      for (const { model } of paidCatalog(cfg.swarm.paid.models)) {
        if (seen.has(model.id) || !this.isAvailable(model.id, now)) continue;
        seen.add(model.id); models.push(model);
      }
    }
    // Local servers: whatever their last probe found (tool-capable), narrowed to the configured list. One worker per
    // model at a time — a laptop runs one generation well, not four.
    LOCAL_PROVIDERS.forEach((p, pi) => {
      const l = cfg.swarm.local[p]; const t = this.localTests.get(p);
      if (!l.enabled || !t?.ok) return;
      const want = l.models.map((x) => (x.startsWith(`${p}/`) ? x : `${p}/${x}`));
      t.freeModels.filter((id) => !want.length || want.includes(id)).forEach((id, i) => {
        if (seen.has(id) || !this.isAvailable(id, now)) return;
        seen.add(id);
        models.push({ id, provider: p, label: id.slice(p.length + 1), rank: 80 + pi * 10 + i, maxConcurrent: 1 });
      });
    });
    const ordered = orderBySupply(models, cfg.swarm.supply);
    const dflt = cfg.swarm.defaultModel;
    if (dflt) { const i = ordered.findIndex((m) => m.id === dflt); if (i > 0) ordered.unshift(...ordered.splice(i, 1)); }
    return ordered.map((m) => ({ ...m }));
  }

  // ---- supply: paid OpenRouter tier, local servers, ordering ---------------------------------------------------------

  supplyState(): SwarmSupplyState {
    const cfg = loadConfig();
    const s = cfg.swarm;
    return {
      policy: s.supply,
      paid: { enabled: s.paid.enabled, maxTaskUsd: s.paid.maxTaskUsd, models: [...s.paid.models], hasKey: !!getSwarmKey('openrouter') },
      local: LOCAL_PROVIDERS.map((p) => {
        const t = this.localTests.get(p) ?? null;
        return { provider: p, enabled: s.local[p].enabled, baseUrl: s.local[p].baseUrl, models: [...s.local[p].models], lastTest: t ? { ...t, freeModels: [...t.freeModels] } : null };
      }),
    };
  }

  /**
   * Change the supply settings. Enabling paid needs an OpenRouter key (clear error otherwise); enabling a local server
   * probes it and refuses with the probe's own message (not running / no tool-capable model) unless `force`.
   */
  async setSupply(input: {
    policy?: SwarmSupplyPolicy;
    paid?: { enabled?: boolean; maxTaskUsd?: number; models?: readonly string[] };
    local?: { provider: SwarmLocalProviderId; enabled?: boolean; baseUrl?: string; models?: readonly string[]; force?: boolean };
  }): Promise<SwarmSupplyState> {
    const i = input ?? {};
    const patch: Record<string, any> = {};
    if (i.policy !== undefined) {
      if (!SUPPLY_POLICIES.includes(i.policy)) throw new Error(`supply must be one of ${SUPPLY_POLICIES.join(', ')}`);
      patch.supply = i.policy;
    }
    if (i.paid) {
      const pp: Record<string, unknown> = {};
      if (i.paid.enabled !== undefined) {
        if (i.paid.enabled && !getSwarmKey('openrouter')) throw new Error('paid models run on your OpenRouter key — add one first: kora swarm key set openrouter');
        pp.enabled = !!i.paid.enabled;
      }
      if (i.paid.maxTaskUsd !== undefined) {
        const c = Number(i.paid.maxTaskUsd);
        if (!Number.isFinite(c) || c <= 0 || c > 10) throw new Error('the per-task spend cap must be between $0.001 and $10');
        pp.maxTaskUsd = c;
      }
      if (i.paid.models !== undefined) {
        if (!Array.isArray(i.paid.models) || i.paid.models.some((m) => typeof m !== 'string' || /:free$/.test(m))) throw new Error('paid models are OpenRouter ids without :free (e.g. qwen/qwen3.7-flash)');
        pp.models = i.paid.models;
      }
      patch.paid = pp;
    }
    if (i.local) {
      const p = i.local.provider;
      if (!LOCAL_PROVIDERS.includes(p)) throw new Error(`unknown local server: ${String(p)} (ollama or lmstudio)`);
      const lp: Record<string, unknown> = {};
      if (i.local.baseUrl !== undefined) {
        let u: URL;
        try { u = new URL(i.local.baseUrl); } catch { throw new Error(`not a URL: ${i.local.baseUrl}`); }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('the local server URL must be http(s)');
        lp.baseUrl = u.origin;
      }
      if (i.local.models !== undefined) lp.models = i.local.models;
      if (i.local.enabled !== undefined) lp.enabled = !!i.local.enabled;
      patch.local = { [p]: lp };
      if (i.local.enabled && !i.local.force) {
        const baseUrl = (lp.baseUrl as string | undefined) ?? loadConfig().swarm.local[p].baseUrl;
        const r = await this.probeLocal(p, baseUrl);
        if (!r.ok) throw new Error(r.message ?? `${p} is not usable`);
      }
    }
    if (Object.keys(patch).length) saveConfig({ swarm: patch });
    this.emit();
    return this.supplyState();
  }

  private async probeLocal(provider: SwarmLocalProviderId, baseUrl: string): Promise<SwarmProviderTestResult> {
    const o = this.deps.fetch ? { fetch: this.deps.fetch } : {};
    const probes = this.deps.probes ?? {};
    const r = provider === 'ollama' ? await (probes.ollama ?? probeOllama)(baseUrl, o) : await (probes.lmstudio ?? probeLmStudio)(baseUrl, o);
    const prev = this.localTests.get(provider);
    // A local server that is down IS a verdict (localhost has no transient network), but a timeout under load is not.
    const transient = !r.ok && r.outcome === 'unreachable' && /no answer within/.test(r.message ?? '') && prev?.ok;
    if (!transient) this.localTests.set(provider, r);
    return r;
  }

  /** Probe a local server (its configured URL) and record the result. */
  async testLocal(input: { provider: SwarmLocalProviderId }): Promise<SwarmLocalStatus> {
    const p = input?.provider;
    if (!LOCAL_PROVIDERS.includes(p)) throw new Error(`unknown local server: ${String(p)} (ollama or lmstudio)`);
    await this.probeLocal(p, loadConfig().swarm.local[p].baseUrl);
    this.emit();
    return this.supplyState().local.find((x) => x.provider === p)!;
  }

  // ---- install ---------------------------------------------------------------------------------------------------

  /** `confirm: true` is the explicit install click (not the privacy consent). Progress rides onStatus. */
  async installStart(input: { confirm: true; version?: string }): Promise<SwarmInstallState> {
    if (input?.confirm !== true) throw new Error('installing OpenCode needs confirm: true');
    if (this.installRun) return { ...this.install };
    const ac = new AbortController();
    this.installAbort = ac;
    // installOpencode reports its first state (with the operation id) before its first await; until then, this.
    this.install = { ...IDLE_INSTALL, phase: 'downloading', version: input.version ?? OPENCODE_PINNED_VERSION };
    const run = (this.deps.install ?? installOpencode)({
      ...(input.version ? { version: input.version } : {}),
      signal: ac.signal,
      onProgress: (s) => { this.install = { ...s }; this.emit(); },
    });
    this.installRun = run;
    void run.then((final) => { this.install = { ...final }; }, (e: any) => {
      this.install = { ...this.install, phase: 'failed', message: `install failed: ${e?.message || e}` };
    }).finally(() => {
      this.installRun = null; this.installAbort = null; this.versionCache = null;
      const redetect = this.deps.resolveOpencode ? Promise.resolve() : refreshOpencodeBinary().then(() => {}, () => {});
      void redetect.finally(() => this.emit());
    });
    this.emit();
    return { ...this.install };
  }

  async installCancel(input: { operationId: string }): Promise<SwarmInstallState> {
    const run = this.installRun;
    if (!run || !this.installAbort || (input?.operationId && this.install.operationId && input.operationId !== this.install.operationId)) {
      return { ...this.install };
    }
    this.installAbort.abort();
    await Promise.race([run.catch(() => null), new Promise((r) => setTimeout(r, 5000))]);
    return { ...this.install };
  }

  // ---- keys and probes ---------------------------------------------------------------------------------------------

  async setKey(input: { provider: SwarmProviderId; apiKey: string }): Promise<SwarmProviderStatus> {
    assertProvider(input?.provider);
    setSwarmKey(input.provider, input.apiKey);
    this.tests.delete(input.provider); // the old result was for the old key
    this.emit();
    return this.providerStatus(loadConfig(), input.provider);
  }

  async clearKey(input: { provider: SwarmProviderId }): Promise<SwarmProviderStatus> {
    assertProvider(input?.provider);
    clearSwarmKey(input.provider);
    this.tests.delete(input.provider);
    this.emit();
    return this.providerStatus(loadConfig(), input.provider);
  }

  /** Runs the provider probe and records it as that provider's `lastTest`. */
  async testProvider(input: { provider: SwarmProviderId }): Promise<SwarmProviderStatus> {
    const provider = input?.provider;
    assertProvider(provider);
    const o = this.deps.fetch ? { fetch: this.deps.fetch } : {};
    const key = getSwarmKey(provider);
    const probes = this.deps.probes ?? {};
    let r: SwarmProviderTestResult;
    if (provider === 'zen') {
      r = await (probes.zen ?? probeZen)({ ...o, apiKey: key });
      // Zen's API lists models the installed CLI may not know yet (and the catalog lists ones Zen dropped): spawn only
      // what BOTH accept — `opencode models opencode` is what `-m` will take (found live: a stale catalog id). On the
      // koragent backend, Koragent's own free list (`koragent models`) is the authority instead.
      if (r.ok && !this.deps.probes?.zen) {
        if (loadConfig().swarm.workerBackend === 'koragent') {
          // Koragent's list is the authority: a KNOWN list with no Zen ids means Koragent can't run Zen (no key), so
          // offer none — keeping Zen's list would route workers to models that die on their first step.
          r = { ...r, freeModels: koragentRunnable(r.freeModels, await this.koragentFree()) };
        } else {
          const cli = await this.cliZenModels();
          if (cli.length) {
            const both = r.freeModels.filter((m) => cli.includes(m));
            if (both.length) r = { ...r, freeModels: both };
          }
        }
      }
    }
    else if (provider === 'openrouter') {
      r = await (probes.openrouter ?? probeOpenRouter)(key ?? '', o);
      // Koragent lists OpenRouter's models only with a key; when it does, run only the free ids it knows.
      if (r.ok && !probes.openrouter && loadConfig().swarm.workerBackend === 'koragent') {
        r = { ...r, freeModels: koragentRunnable(r.freeModels, await this.koragentFree()) };
      }
    }
    else r = await (probes.cerebras ?? probeCerebras)(key ?? '', o);
    // Keep the last GOOD result over a transient failure, so the picker keeps the provider's live list.
    const prev = this.tests.get(provider);
    const transient = !r.ok && (r.outcome === 'unreachable' || r.outcome === 'rate-limited');
    if (!(transient && prev?.ok)) this.tests.set(provider, r);
    this.emit();
    return this.providerStatus(loadConfig(), provider);
  }

  private kgFree: { bin: string; at: number; ids: string[] } | null = null;
  /**
   * The free ($0) ids the installed Koragent can run (`koragent models --json`, falling back to `--verbose` + cost 0;
   * koragent-catalog.ts), null when it can't say. Cached 5 min per binary (a source run takes ~1.5 s).
   */
  private async koragentFree(): Promise<string[] | null> {
    const wb = await this.workerBackendStatus(loadConfig()).catch(() => null);
    const bin = wb?.path;
    if (!bin) return null;
    const c = this.kgFree;
    if (c && c.bin === bin && Date.now() - c.at < 5 * 60_000) return c.ids;
    const ids = await (this.deps.koragentModels ?? (require('./koragent-catalog') as typeof import('./koragent-catalog')).koragentFreeModels)(bin).catch(() => null);
    if (!ids) return c && c.bin === bin ? c.ids : null;
    this.kgFree = { bin, at: Date.now(), ids };
    return ids;
  }

  /** The free Zen ids the installed CLI accepts (`opencode models opencode`), [] when it can't say. Async child. */
  private async cliZenModels(): Promise<string[]> {
    const bin = (await this.opencodeStatus(false).catch(() => null))?.path;
    if (!bin) return [];
    return new Promise((resolve) => {
      const w = winCommand(bin, ['models', 'opencode']);
      execFile(w.command, w.args, { timeout: 20_000, encoding: 'utf8', env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: '1' }, windowsHide: true, windowsVerbatimArguments: w.windowsVerbatimArguments }, (err, out) => {
        if (err) return resolve([]);
        resolve(String(out).split('\n').map((l) => l.trim()).filter((l) => /^opencode\/\S+$/.test(l)));
      });
    });
  }

  private freshAt = 0;
  private freshRun: Promise<void> | null = null;
  /**
   * Re-test Zen (and every keyed provider) when the last test is older than SWARM_FRESH_MS, so the picker works from
   * the providers' live lists, not a stale catalog. Bounded: a spawn waits at most `maxWaitMs` for it.
   */
  async ensureFresh(maxWaitMs = 10_000): Promise<void> {
    if (Date.now() - this.freshAt < SWARM_FRESH_MS) return;
    if (!this.freshRun) {
      this.freshRun = (async () => {
        const jobs: Promise<unknown>[] = [this.testProvider({ provider: 'zen' })];
        for (const p of ['openrouter', 'cerebras'] as const) if (getSwarmKey(p)) jobs.push(this.testProvider({ provider: p }));
        const local = loadConfig().swarm.local;
        for (const p of LOCAL_PROVIDERS) if (local[p].enabled) jobs.push(this.testLocal({ provider: p }));
        await Promise.allSettled(jobs);
        // Fresh for 15 min only when Zen answered; a failed refresh is retried after a minute.
        this.freshAt = this.tests.get('zen')?.ok ? Date.now() : Date.now() - SWARM_FRESH_MS + 60_000;
      })().finally(() => { this.freshRun = null; });
    }
    await new Promise<void>((resolve) => { const t = setTimeout(resolve, maxWaitMs); this.freshRun!.then(() => { clearTimeout(t); resolve(); }, () => { clearTimeout(t); resolve(); }); });
  }

  /** Whether the user has accepted the current Swarm privacy notice (nothing talks to free providers before that). */
  private consented(): boolean {
    const c = this.consentState(loadConfig());
    return c.acceptedVersion !== null && c.acceptedVersion >= c.requiredVersion;
  }

  /**
   * Daemon start: test the providers now and every SWARM_FRESH_MS (unref'd; never blocks start-up) — but only once the
   * user has accepted Swarm. Before that, no request to OpenCode Zen and no `opencode models` run happens on its own.
   */
  startAutoRefresh(): () => void {
    const tick = () => { if (this.consented()) void this.ensureFresh(0); };
    tick();
    const iv = setInterval(tick, SWARM_FRESH_MS);
    iv.unref?.();
    return () => clearInterval(iv);
  }

  // ---- consent and preferences ---------------------------------------------------------------------------------------

  /** Global, versioned consent (config swarm.consent). accepted:false withdraws it. */
  async setConsent(input: { noticeVersion: number; accepted: boolean }): Promise<SwarmConsentState> {
    if (input?.accepted === true) {
      if (!Number.isInteger(input.noticeVersion) || input.noticeVersion < 1) throw new Error('noticeVersion must be a positive integer');
      if (input.noticeVersion > this.requiredNotice()) throw new Error(`unknown privacy notice version ${input.noticeVersion} (current: ${this.requiredNotice()})`);
      saveConfig({ swarm: { consent: { noticeVersion: input.noticeVersion, acceptedAt: Date.now() } } });
    } else {
      saveConfig({ swarm: { consent: null } });
    }
    this.emit();
    return this.consentState(loadConfig());
  }

  async setPreferences(input: {
    providerOrder?: SwarmProviderId[];
    defaultModel?: string | null;
    maxWorkers?: number;
    enabled?: { provider: SwarmProviderId; enabled: boolean }[];
    /** The UI's paid / local supply patch (contracts SwarmSetSupplyInput); applied through setSupply's checks. */
    supplyState?: WireSupplyPatch;
    /** swarm.workerBackend: which program runs NEW swarm workers (running ones keep theirs). */
    workerBackend?: 'opencode' | 'koragent';
  }): Promise<SwarmPreferences> {
    const patch: Record<string, unknown> = {};
    const i = input ?? {};
    if (i.supplyState) {
      const sp = i.supplyState;
      if (sp.supply !== undefined || sp.paid) await this.setSupply({ ...(sp.supply !== undefined ? { policy: sp.supply } : {}), ...(sp.paid ? { paid: sp.paid } : {}) });
      for (const provider of LOCAL_PROVIDERS) { const l = sp.local?.[provider]; if (l) await this.setSupply({ local: { provider, ...l } }); }
    }
    if (i.providerOrder !== undefined) {
      if (!Array.isArray(i.providerOrder)) throw new Error('providerOrder must be a list of providers');
      const order: SwarmProviderId[] = [];
      for (const p of i.providerOrder) { assertProvider(p); if (!order.includes(p)) order.push(p); }
      for (const p of PROVIDERS) if (!order.includes(p)) order.push(p);
      patch.providerOrder = order;
    }
    if (i.defaultModel !== undefined) {
      if (i.defaultModel !== null && (typeof i.defaultModel !== 'string' || !i.defaultModel.trim())) throw new Error('defaultModel must be a model id or null');
      patch.defaultModel = i.defaultModel === null ? null : i.defaultModel.trim();
    }
    if (i.workerBackend !== undefined) {
      if (i.workerBackend !== 'opencode' && i.workerBackend !== 'koragent') throw new Error('workerBackend must be opencode or koragent');
      if (i.workerBackend === 'koragent' && !isProEdition()) throw new Error(proOnlyMessage('Koragent'));
      patch.workerBackend = i.workerBackend;
      this.kgVersionCache = null;
    }
    if (i.maxWorkers !== undefined) {
      if (!Number.isInteger(i.maxWorkers) || i.maxWorkers < 1 || i.maxWorkers > 16) throw new Error('maxWorkers must be a whole number from 1 to 16');
      patch.maxWorkers = i.maxWorkers;
    }
    if (i.enabled !== undefined) {
      if (!Array.isArray(i.enabled)) throw new Error('enabled must be a list of {provider, enabled}');
      const providers: Record<string, boolean> = {};
      for (const e of i.enabled) { assertProvider(e?.provider); if (typeof e.enabled !== 'boolean') throw new Error('enabled must be true or false'); providers[e.provider] = e.enabled; }
      patch.providers = providers;
    }
    const cfg = Object.keys(patch).length ? saveConfig({ swarm: patch }) : loadConfig();
    this.emit();
    return this.preferences(cfg);
  }
}

type WireLocal = { enabled?: boolean; baseUrl?: string; models?: readonly string[] };
/** contracts SwarmSetSupplyInput: `supply` is the runtime's `policy`, and local servers are keyed, not listed. */
type WireSupplyPatch = {
  supply?: SwarmSupplyPolicy;
  paid?: { enabled?: boolean; maxTaskUsd?: number; models?: readonly string[] };
  local?: { ollama?: WireLocal; lmstudio?: WireLocal };
};

/** The `swarm` config block in the wire shape of contracts `SwarmSupplyState` (the UI's supply controls read it). */
function wireSupply(s: ReturnType<typeof loadConfig>['swarm']) {
  const local = (p: SwarmLocalProviderId) => ({ enabled: s.local[p].enabled, baseUrl: s.local[p].baseUrl, models: [...s.local[p].models] });
  return {
    supply: s.supply,
    paid: { enabled: s.paid.enabled, maxTaskUsd: s.paid.maxTaskUsd, models: [...s.paid.models] },
    local: { ollama: local('ollama'), lmstudio: local('lmstudio') },
  };
}

function assertProvider(p: unknown): asserts p is SwarmProviderId {
  if (!(PROVIDERS as readonly unknown[]).includes(p)) throw new Error(`unknown swarm provider: ${String(p)} (zen, openrouter or cerebras)`);
}

/** Pick eligibility: R2's provider term, plus a failed last test (invalid key, no free models) excludes it. */
function usableForPick(p: SwarmProviderStatus): boolean {
  // A transient failure (unreachable / rate-limited) is not a verdict on the provider: found live, one Zen probe that
  // coincided with a daemon stall ("response was not JSON", 13.8 s) disabled Swarm for 15 min and every leader did
  // the work on its own tokens. Only a definite answer (bad key, no free models, opencode missing) disables it.
  const transient = p.lastTest && !p.lastTest.ok && (p.lastTest.outcome === 'unreachable' || p.lastTest.outcome === 'rate-limited');
  return p.enabled && (p.lastTest?.ok !== false || !!transient) && (p.provider === 'zen' || p.hasKey);
}
