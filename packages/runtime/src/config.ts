// ~/.kora/config.json — the few knobs a user may want. Every value has a default; env vars override for one run.
// Nested objects merge key by key (a file with only {"autoCompact":{"enabled":true}} keeps the other defaults).
import { koraHome } from './protocol/types';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './util/atomic-write';
import os from 'node:os';
import { isProEdition } from './edition';

export type RestartMode = 'resume' | 'cheap' | 'fresh';

/** Swarm mode settings (`swarm.*` in config.json). Keys never live here — see server/swarm-secrets.ts. */
export interface KoraSwarmConfig {
  opencodePath: string | null;                                   // explicit opencode binary (else resolveOpencodeBinary's search)
  providers: { zen: boolean; openrouter: boolean; cerebras: boolean }; // enabled switches; Cerebras off by default (a paid-card trial, PLAN D-f)
  providerOrder: ('zen' | 'openrouter' | 'cerebras')[];         // picker preference
  defaultModel: string | null;                                   // an opencode -m id, or null = automatic
  maxWorkers: number;                                            // concurrent swarm workers per thread
  consent: { noticeVersion: number; acceptedAt: number } | null; // global, versioned privacy consent (PLAN D-b)
  autoVerify: boolean;                                           // X2: run the merge gate on a worker's worktree when it reports
  maxBounces: number;                                            // X2: times findings go back to the same worker before Claude hears
  // Worker supply beyond the free remote tiers. `supply` orders the tiers: free-first = free remote → local → paid;
  // paid-first = paid → free remote → local; local-only = local servers only (privacy: no code leaves the machine).
  supply: SwarmSupplyPolicy;
  paid: { enabled: boolean; maxTaskUsd: number; models: string[] };  // BYO OpenRouter key, cheap PAID models; spend capped per task
  local: { ollama: SwarmLocalServer; lmstudio: SwarmLocalServer };   // local model servers (no key)
  watchdog: { nudgeAfterMs: number; reassignAfterMs: number };       // slow/silent workers: nudge at T1, reassign at T2 (0 = off)
  foremanRetries: number;                                        // foreman: automatic retries (same worktree) before Claude hears a failure; 0 = off
  foremanReview: boolean;                                        // foreman: a free-model reviewer reads task + diff before Claude hears a pass
  workerBackend: 'opencode' | 'koragent';                        // WorkerBackend: which program runs swarm workers (koragent = event-driven)
}
export type SwarmSupplyPolicy = 'free-first' | 'paid-first' | 'local-only';
/** `models` empty = every tool-capable model the server lists. */
export interface SwarmLocalServer { enabled: boolean; baseUrl: string; models: string[] }

export interface KoraConfig {
  strictMcp: boolean;            // Claude panes exclude user-level MCP servers (KORA_STRICT_MCP=0 overrides)
  mcp: 'auto' | 'on' | 'off';    // kora's own MCP server: auto = off for claude, on for hookless agents (KORA_MCP)
  // git worktrees for agents. 'auto' (default): the main checkout holds ONE agent (it sees your uncommitted work,
  // no merge needed); a SECOND concurrent agent in the same repo gets its own worktree so they don't collide.
  // 'always': every agent its own worktree. 'never': every agent in the main checkout.
  worktrees: 'auto' | 'always' | 'never';
  waitIndex: boolean;            // opt-in: block the agent launch behind a first-index progress bar. Off by default —
                                 // the agent launches instantly and the graph warms in the background (KORA_WAIT_INDEX=1 to gate)
  grepCap: number;               // shims cap grep/rg output lines inside a pane (0 = no cap; off by default — a truncated grep is a missed reference)
  concise: boolean;              // system-prompt line asking for terse output (output tokens cost 5x input)
  minimalCode: boolean;          // rulebook line: write the least code that works (graph/howto.ts MINIMAL_CODE_LINE)
  autoCompact: { enabled: boolean; contextTokens: number; onlyWhenIdle: boolean }; // send /compact when context passes the threshold
  compactWarnTokens: number;     // sidebar warns above this context size
  readDedupe: boolean;           // hook nudges a Read of a file already in context and unchanged
  graphCache: boolean;           // identical graph query in one session returns a pointer, not the result again
  cacheTtlMs: number;            // prompt-cache lifetime to show in the warmth countdown (Claude Code: 1h)
  promptInject: boolean;         // UserPromptSubmit hook attaches the graph's top declarations for a code-shaped prompt (KORA_PROMPT_INJECT=0)
  // ---- runtime intelligence ----
  restartMode: RestartMode;      // R / pane.restart default. resume = the whole conversation comes back (costs a cache write of it); cheap = fresh session + ~700-token brief — opt in, mid-task it can lose more than it saves
  // answer known-safe dialogs, logged. trustFolder / mcpFound only ever fire in a folder the USER trusted in Kora
  // (trust/store.ts, `<KORA_HOME>/trust.json`); readOutsideWorktree stays scoped to trustedRoots.
  autoAnswer: { trustFolder: boolean; mcpFound: boolean; readOutsideWorktree: boolean };
  // How an ORCHESTRATOR's workers handle their own tool-permission prompts (edit/command approvals). The #1 thing
  // between a steerable fleet and walk-away autonomy — a worker that silently parks on "Accept this file edit?"
  // stalls the fleet. 'escalate' (default, safe): the worker blocks, its orchestrator is told via a fleet event,
  // a human decides. 'allowlist': auto-accept in-worktree FILE EDITS, still escalate command/exec approvals.
  // 'auto': launch workers with the agent's skip-permissions mode — no prompts at all (max automation, least safe).
  workerPermission: 'escalate' | 'allowlist' | 'auto';
  // Project roots: where Kora auto-indexes and where a read outside a worktree is auto-allowed. NOT trust: since
  // folder trust (trust/store.ts) a folder under ~/Projects runs none of its own agent config until the user trusts it.
  trustedRoots: string[];
  defaultBudgetUsd: number;      // dollar budget for new agent panes (0 = none); warn at 80%, tell the agent to stop at 100%
  swarm: KoraSwarmConfig;        // Swarm mode (free-model OpenCode workers)
  autoIndexMaxFiles: number;     // opening a git repo indexes it in the background only up to this many tracked files; a bigger one asks first (0 = always ask; KORA_AUTO_INDEX_MAX_FILES)
  uiPort: number;                // `kora server run` also serves the chat UI's websocket/HTTP API on 127.0.0.1:<uiPort> (0 = off; KORA_UI_PORT)
}
export const DEFAULTS: KoraConfig = {
  strictMcp: true, mcp: 'auto', worktrees: 'auto', waitIndex: false, grepCap: 0, concise: true, minimalCode: true,
  autoCompact: { enabled: false, contextTokens: 150_000, onlyWhenIdle: true }, compactWarnTokens: 100_000,
  readDedupe: true, graphCache: true, cacheTtlMs: 60 * 60 * 1000, promptInject: true,
  restartMode: 'resume',
  // mcpFound off by default: "New MCP server found" is a repository's own .mcp.json asking to RUN a command, and
  // ~/Projects is where people clone code they have not read. trustFolder answers only in user-trusted folders. Panes run --strict-mcp-config by
  // default, so the dialog does not appear in the normal flow; a user who turns strictMcp off opts in here too.
  autoAnswer: { trustFolder: true, mcpFound: false, readOutsideWorktree: true },
  workerPermission: 'escalate',
  trustedRoots: [path.join(os.homedir(), 'Projects'), path.join(koraHome(), 'worktrees')],
  defaultBudgetUsd: 0,
  swarm: {
    opencodePath: null,
    providers: { zen: true, openrouter: true, cerebras: false },
    providerOrder: ['zen', 'openrouter', 'cerebras'],
    defaultModel: null,
    maxWorkers: 4,
    consent: null,
    autoVerify: true,
    maxBounces: 2,
    supply: 'free-first',
    paid: { enabled: false, maxTaskUsd: 0.05, models: [] },
    local: {
      ollama: { enabled: false, baseUrl: 'http://127.0.0.1:11434', models: [] },
      lmstudio: { enabled: false, baseUrl: 'http://127.0.0.1:1234', models: [] },
    },
    watchdog: { nudgeAfterMs: 8 * 60_000, reassignAfterMs: 15 * 60_000 },
    foremanRetries: 2,
    foremanReview: false,
    workerBackend: 'opencode',
  },
  autoIndexMaxFiles: 20_000,
  uiPort: 8797,
};
export function configPath(): string { return path.join(koraHome(), 'config.json'); }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Deep merge for plain objects: nested objects merge, everything else (arrays included) is replaced. */
export function mergeConfig<T extends Record<string, any>>(base: T, patch: Record<string, unknown> | undefined | null): T {
  const out: any = { ...base };
  for (const [k, v] of Object.entries(patch || {})) out[k] = isObj(v) && isObj(out[k]) ? mergeConfig(out[k], v) : v;
  return out;
}
/** Read a dot path ("autoCompact.enabled"). */
export function getPath(obj: any, dotPath: string): unknown { return dotPath.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
/** Build a nested patch from a dot path: setPath("autoCompact.enabled", true) → { autoCompact: { enabled: true } }. */
export function patchFromPath(dotPath: string, value: unknown): Record<string, unknown> {
  const keys = dotPath.split('.').filter(Boolean); if (!keys.length) throw new Error('empty config key');
  const out: any = {}; let cur = out;
  for (let i = 0; i < keys.length - 1; i++) { cur[keys[i]] = {}; cur = cur[keys[i]]; }
  cur[keys[keys.length - 1]] = value;
  return out;
}
/** Parse a CLI value: JSON when it parses (true, 3, ["a"], {"x":1}), else the raw string. */
export function parseConfigValue(raw: string): unknown { try { return JSON.parse(raw); } catch { return raw; } }

const SWARM_PROVIDER_IDS = ['zen', 'openrouter', 'cerebras'] as const;
/**
 * Coerce a merged `swarm` block back into shape: every field falls back to its default when the file holds garbage.
 * Consent is dropped unless `noticeVersion` is a positive integer and `acceptedAt` a number (ref-reconciled journey m —
 * any agent with a shell can write config.json, so this only guards against malformed values, not a determined write).
 */
function normalizeSwarmConfig(raw: unknown): KoraSwarmConfig {
  const d = DEFAULTS.swarm;
  const s: Record<string, any> = isObj(raw) ? raw : {};
  const bool = (v: unknown, dflt: boolean) => (typeof v === 'boolean' ? v : dflt);
  const provIn: Record<string, unknown> = isObj(s.providers) ? s.providers : {};
  const order: KoraSwarmConfig['providerOrder'] = [];
  if (Array.isArray(s.providerOrder)) {
    for (const p of s.providerOrder) if ((SWARM_PROVIDER_IDS as readonly string[]).includes(p) && !order.includes(p)) order.push(p);
  }
  for (const p of d.providerOrder) if (!order.includes(p)) order.push(p);
  const c = s.consent;
  const consent = isObj(c) && Number.isInteger(c.noticeVersion) && (c.noticeVersion as number) > 0 && typeof c.acceptedAt === 'number' && Number.isFinite(c.acceptedAt)
    ? { noticeVersion: c.noticeVersion as number, acceptedAt: c.acceptedAt as number }
    : null;
  return {
    opencodePath: typeof s.opencodePath === 'string' && s.opencodePath.trim() ? s.opencodePath : null,
    providers: { zen: bool(provIn.zen, d.providers.zen), openrouter: bool(provIn.openrouter, d.providers.openrouter), cerebras: bool(provIn.cerebras, d.providers.cerebras) },
    providerOrder: order,
    defaultModel: typeof s.defaultModel === 'string' && s.defaultModel.trim() ? s.defaultModel : null,
    maxWorkers: Number.isInteger(s.maxWorkers) && s.maxWorkers >= 1 && s.maxWorkers <= 16 ? s.maxWorkers : d.maxWorkers,
    consent,
    autoVerify: bool(s.autoVerify, d.autoVerify),
    maxBounces: Number.isInteger(s.maxBounces) && s.maxBounces >= 0 && s.maxBounces <= 10 ? s.maxBounces : d.maxBounces,
    supply: ['free-first', 'paid-first', 'local-only'].includes(s.supply) ? s.supply : d.supply,
    paid: normalizePaid(s.paid, d.paid),
    local: { ollama: normalizeLocal(isObj(s.local) ? s.local.ollama : null, d.local.ollama), lmstudio: normalizeLocal(isObj(s.local) ? s.local.lmstudio : null, d.local.lmstudio) },
    watchdog: normalizeWatchdog(s.watchdog, d.watchdog),
    foremanRetries: Number.isInteger(s.foremanRetries) && s.foremanRetries >= 0 && s.foremanRetries <= 5 ? s.foremanRetries : d.foremanRetries,
    foremanReview: bool(s.foremanReview, d.foremanReview),
    // Koragent workers are Kora Pro: the free edition always runs OpenCode, whatever an older config says.
    workerBackend: isProEdition() && (s.workerBackend === 'koragent' || s.workerBackend === 'opencode') ? s.workerBackend : d.workerBackend,
  };
}
export const normalizeSwarmConfigForTests = (raw: unknown): KoraSwarmConfig => normalizeSwarmConfig(raw);
const strList = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()))] : []);
function normalizePaid(raw: unknown, d: KoraSwarmConfig['paid']): KoraSwarmConfig['paid'] {
  const p: Record<string, any> = isObj(raw) ? raw : {};
  const cap = Number(p.maxTaskUsd);
  return { enabled: typeof p.enabled === 'boolean' ? p.enabled : d.enabled, maxTaskUsd: Number.isFinite(cap) && cap > 0 && cap <= 10 ? cap : d.maxTaskUsd, models: strList(p.models) };
}
function normalizeLocal(raw: unknown, d: SwarmLocalServer): SwarmLocalServer {
  const l: Record<string, any> = isObj(raw) ? raw : {};
  let baseUrl = d.baseUrl;
  if (typeof l.baseUrl === 'string') { try { const u = new URL(l.baseUrl.trim()); if (u.protocol === 'http:' || u.protocol === 'https:') baseUrl = u.origin; } catch { /* keep default */ } }
  return { enabled: typeof l.enabled === 'boolean' ? l.enabled : d.enabled, baseUrl, models: strList(l.models) };
}
function normalizeWatchdog(raw: unknown, d: KoraSwarmConfig['watchdog']): KoraSwarmConfig['watchdog'] {
  const w: Record<string, any> = isObj(raw) ? raw : {};
  const ms = (v: unknown, dflt: number) => (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 24 * 3600_000 ? Math.round(Number(v)) : dflt);
  const nudgeAfterMs = ms(w.nudgeAfterMs, d.nudgeAfterMs);
  let reassignAfterMs = ms(w.reassignAfterMs, d.reassignAfterMs);
  if (reassignAfterMs && nudgeAfterMs && reassignAfterMs <= nudgeAfterMs) reassignAfterMs = nudgeAfterMs + 60_000; // T2 always after T1
  return { nudgeAfterMs, reassignAfterMs };
}

let cache: { at: number; value: KoraConfig } | null = null;
export function loadConfig(): KoraConfig {
  if (cache && Date.now() - cache.at < 2000) return cache.value;
  let file: Record<string, unknown> = {};
  try { file = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { /* defaults */ }
  const v: KoraConfig = mergeConfig(DEFAULTS, file);
  if (!Array.isArray(v.trustedRoots)) v.trustedRoots = DEFAULTS.trustedRoots;
  if (!['resume', 'cheap', 'fresh'].includes(v.restartMode)) v.restartMode = DEFAULTS.restartMode;
  if (!['escalate', 'allowlist', 'auto'].includes(v.workerPermission as any)) v.workerPermission = DEFAULTS.workerPermission;
  // back-compat: an older config.json (or someone) may have set worktrees to a boolean — true meant "always".
  if ((v.worktrees as any) === true) v.worktrees = 'always'; else if ((v.worktrees as any) === false) v.worktrees = 'never';
  if (!['auto', 'always', 'never'].includes(v.worktrees as any)) v.worktrees = DEFAULTS.worktrees;
  // env overrides (one run)
  if (process.env.KORA_STRICT_MCP === '0') v.strictMcp = false; if (process.env.KORA_STRICT_MCP === '1') v.strictMcp = true;
  if (process.env.KORA_MCP === '1' || process.env.KORA_MCP === 'on') v.mcp = 'on'; if (process.env.KORA_MCP === '0' || process.env.KORA_MCP === 'off') v.mcp = 'off';
  if (process.env.KORA_WORKTREES_DEFAULT === '0') v.worktrees = 'never';
  if (process.env.KORA_WORKTREE_MODE && ['auto', 'always', 'never'].includes(process.env.KORA_WORKTREE_MODE)) v.worktrees = process.env.KORA_WORKTREE_MODE as any;
  if (process.env.KORA_WAIT_INDEX === '0') v.waitIndex = false; if (process.env.KORA_WAIT_INDEX === '1') v.waitIndex = true;
  if (process.env.KORA_GREP_CAP) v.grepCap = Number(process.env.KORA_GREP_CAP) || 0;
  if (process.env.KORA_PROMPT_INJECT === '0') v.promptInject = false;
  if (process.env.KORA_MINIMAL_CODE === '0') v.minimalCode = false;
  if (process.env.KORA_UI_PORT !== undefined && process.env.KORA_UI_PORT !== '') { const n = Number(process.env.KORA_UI_PORT); v.uiPort = Number.isInteger(n) && n >= 0 && n < 65536 ? n : 0; }
  if (!Number.isInteger(v.uiPort) || v.uiPort < 0 || v.uiPort > 65535) v.uiPort = DEFAULTS.uiPort;
  if (process.env.KORA_RESTART_MODE && ['resume', 'cheap', 'fresh'].includes(process.env.KORA_RESTART_MODE)) v.restartMode = process.env.KORA_RESTART_MODE as RestartMode;
  if (process.env.KORA_WORKER_PERMISSION && ['escalate', 'allowlist', 'auto'].includes(process.env.KORA_WORKER_PERMISSION)) v.workerPermission = process.env.KORA_WORKER_PERMISSION as any;
  v.swarm = normalizeSwarmConfig(v.swarm);
  cache = { at: Date.now(), value: v };
  return v;
}
export function saveConfig(patch: Record<string, unknown>): KoraConfig {
  let file: Record<string, unknown> = {}; try { file = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { /* new */ }
  const next = mergeConfig(file, patch);
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  // atomic: the CLI, both hooks and the daemon read it at any moment (a torn read is "no config" → defaults)
  writeFileAtomic(configPath(), JSON.stringify(next, null, 2) + '\n');
  cache = null;
  return loadConfig();
}
/** Drop the 2s cache (the server calls this after config.set so the running Runtime re-reads on its next check). */
export function invalidateConfig() { cache = null; }
