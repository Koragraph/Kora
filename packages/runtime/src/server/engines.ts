// Engines (Phase 7 wiring): the daemon's one view of "what can run a blob or a chat" beyond the native Claude / Codex /
// OpenCode / Antigravity drivers - the ACP agents (Grok, Cursor, Kimi, Qwen, Droid, Hermes, any custom CLI), the API
// endpoints (OpenRouter, DeepSeek, Groq, LM Studio, Ollama, any URL) and the named Claude accounts.
//
//   <KORA_HOME>/engines.json   user config, NO secrets: ACP overrides + custom CLIs, API endpoints, explicit executables,
//                              the ACP idle-close minutes. Written 0600, atomically.
//   keys                       the daemon secret store (Keychain on macOS, 0600 file elsewhere), name `api-<endpointId>`.
//
// It answers the session manager (`acpEngine` / `apiEndpoint` build the driver for an agent id), the ui-server (routing,
// the provider list, Settings > Engines) and never throws for a missing engine: an unavailable engine is a row with a reason.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { koraHome } from '../protocol/types';
import { defaultSecretStore, type SecretStore } from '../blobs/apps/secrets';
import { ClaudeAccounts, type ClaudeAccountView } from '../session/claude-accounts';
import { BUILTIN_ACP_ENGINES, LEGACY_ACP_ENGINES, detectAcpEngines, detectApiEndpoints, detectCliEngine, mergeAcpEngines, type DetectDeps, type EngineStatus } from '../session/engine-detect-ext';
import { discoverAcpModels, type AcpEngine } from '../session/drivers/acp-driver';
import { API_PRESETS, endpointKeys, listApiModels, normalizeEndpoint, presetEndpoint, testApiEndpoint, type ApiEndpoint, type ApiModel, type ApiTestResult, type FetchFn } from '../session/drivers/api-providers';
import { ACP_IDLE_MS_DEFAULT } from '../session/drivers/acp-pool';
import { resolveEngineBinary, setEngineBinaryOverride } from '../detect/engine-binary';

export type NativeEngine = 'claude' | 'codex' | 'opencode' | 'antigravity';
const NATIVE: Array<{ id: NativeEngine; label: string; command: string }> = [
  { id: 'claude', label: 'Claude', command: 'claude' },
  { id: 'codex', label: 'Codex', command: 'codex' },
  { id: 'opencode', label: 'OpenCode', command: 'opencode' },
  // Google's agent (`agy`, Antigravity CLI): the AntigravityDriver resolves the binary by this name.
  { id: 'antigravity', label: 'Antigravity', command: 'agy' },
];

/** The serializable part of an ACP engine (no functions): what engines.json stores. */
export interface AcpOverride { agentId: string; label?: string; command?: string; executable?: string | null; args?: string[]; env?: Record<string, string> }

export interface EnginesFile {
  acp: AcpOverride[];
  endpoints: ApiEndpoint[];
  executables: Partial<Record<NativeEngine, string>>;
  acpIdleMinutes?: number;
}

export interface AcpEngineView {
  agentId: string;
  label: string;
  command: string;
  executable: string | null;
  args: string[];
  defaultArgs: string[];
  env: Record<string, string>;
  custom: boolean;
  status: EngineStatus;
}
export interface ApiEndpointView extends ApiEndpoint { hasKey: boolean; status: EngineStatus }
export interface EnginesView {
  engines: EngineStatus[];
  acp: AcpEngineView[];
  endpoints: ApiEndpointView[];
  accounts: ClaudeAccountView[];
  presets: Array<Omit<ApiEndpoint, 'agentId'>>;
  acpIdleMinutes: number;
}

export interface EnginesOptions {
  home?: string;
  secrets?: SecretStore;
  accounts?: ClaudeAccounts;
  fetch?: FetchFn;
  detect?: DetectDeps;
  /** Test seam: replaces the ACP model probe (spawns the agent). */
  discoverModels?: (e: AcpEngine) => ReturnType<typeof discoverAcpModels>;
  /** Test seam: Kora's own OpenCode resolver (swarm-install: config path, the bundled ~/.kora/tools copy, PATH). */
  resolveOpencode?: () => string | null;
  /** Where the explicit OpenCode path is kept (the daemon's config.opencodePath). Absent = engines.json only. */
  opencodePath?: { get(): string | null; set(p: string | null): void };
  log?: (m: string) => void;
}

const EMPTY: EnginesFile = { acp: [], endpoints: [], executables: {} };
const CUSTOM_ID = /^acp-[a-z0-9][a-z0-9-]{0,29}$/;

export class Engines extends EventEmitter {
  readonly accounts: ClaudeAccounts;
  readonly keys: ReturnType<typeof endpointKeys>;
  private secrets: SecretStore;
  private modelCache = new Map<string, { at: number; models: ApiModel[]; current: string | null }>();
  /** ACP engines that failed to start (auth timeout, unsupported client, crash at start). Nothing spawns them again until the user re-checks. */
  private acpFailures = new Map<string, { reason: string; at: number }>();

  constructor(private o: EnginesOptions = {}) {
    super();
    this.accounts = o.accounts ?? new ClaudeAccounts(o.home ? { home: o.home } : {});
    this.secrets = o.secrets ?? defaultSecretStore(path.join(this.home, 'engine-secrets'));
    this.keys = endpointKeys(this.secrets);
    this.applyExecutables();
    this.loadFailures();
  }

  private get home(): string { return this.o.home ?? koraHome(); }
  private get file(): string { return path.join(this.home, 'engines.json'); }

  // ── the file ────────────────────────────────────────────────────────────────────────────────────────────────
  read(): EnginesFile {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const acp = (Array.isArray(j?.acp) ? j.acp : []).filter((a: any) => a && typeof a.agentId === 'string').map((a: any): AcpOverride => ({
        agentId: String(a.agentId),
        ...(typeof a.label === 'string' ? { label: a.label.slice(0, 60) } : {}),
        ...(typeof a.command === 'string' ? { command: a.command } : {}),
        ...(a.executable === null || typeof a.executable === 'string' ? { executable: a.executable } : {}),
        ...(Array.isArray(a.args) ? { args: a.args.map(String) } : {}),
        ...(a.env && typeof a.env === 'object' ? { env: Object.fromEntries(Object.entries(a.env).filter(([, v]) => typeof v === 'string')) as Record<string, string> } : {}),
      }));
      const endpoints: ApiEndpoint[] = [];
      for (const e of Array.isArray(j?.endpoints) ? j.endpoints : []) { try { endpoints.push(normalizeEndpoint(e)); } catch { /* a hand-edited bad row is dropped */ } }
      const executables: EnginesFile['executables'] = {};
      for (const n of NATIVE) { const v = j?.executables?.[n.id]; if (typeof v === 'string' && path.isAbsolute(v)) executables[n.id] = v; }
      const idle = Number(j?.acpIdleMinutes);
      return { acp, endpoints, executables, ...(Number.isFinite(idle) && idle >= 1 && idle <= 240 ? { acpIdleMinutes: Math.round(idle) } : {}) };
    } catch { return { ...EMPTY, acp: [], endpoints: [], executables: {} }; }
  }
  private write(f: EnginesFile): void {
    fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(f, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.emit('changed');
  }
  private applyExecutables(): void {
    const f = this.read();
    setEngineBinaryOverride('claude', f.executables.claude ?? null);
    setEngineBinaryOverride('codex', f.executables.codex ?? null);
    setEngineBinaryOverride('agy', f.executables.antigravity ?? null);
    if (f.executables.opencode) this.o.opencodePath?.set(f.executables.opencode);
  }

  // ── ACP start failures ──────────────────────────────────────────────────────────────────────────────────────
  // Kept in <home>/acp-failures.json so a daemon restart does not forget (and so does not spawn a dead engine once more).
  private get failuresFile(): string { return path.join(this.home, 'acp-failures.json'); }
  private loadFailures(): void {
    try {
      const j = JSON.parse(fs.readFileSync(this.failuresFile, 'utf8'));
      for (const [id, v] of Object.entries(j ?? {})) { const r = (v as any)?.reason; if (typeof r === 'string' && r) this.acpFailures.set(id, { reason: r, at: Number((v as any).at) || 0 }); }
    } catch { /* none */ }
  }
  private saveFailures(): void {
    try {
      fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.failuresFile, JSON.stringify(Object.fromEntries(this.acpFailures)), { mode: 0o600 });
    } catch { /* advisory */ }
  }
  /** Why this ACP engine is parked (null = not parked). */
  acpBlocked(agentId: string): string | null { return this.acpFailures.get(agentId)?.reason ?? null; }
  /** An ACP agent failed to start: park it with the reason. The picker and Settings follow. */
  acpMarkFailed(agentId: string, reason: string): void {
    if (this.acpFailures.get(agentId)?.reason === reason) return;
    this.acpFailures.set(agentId, { reason: reason.slice(0, 400), at: Date.now() });
    this.saveFailures();
    this.emit('changed');
  }
  /** The user's re-check: one agent, or all of them. */
  acpRecheck(agentId?: string): void {
    const had = this.acpFailures.size;
    if (agentId) this.acpFailures.delete(agentId); else this.acpFailures.clear();
    if (this.acpFailures.size !== had) { this.saveFailures(); this.emit('changed'); }
  }

  // ── what the session manager / router ask ───────────────────────────────────────────────────────────────────
  /** Every ACP engine with the user's overrides applied (built-ins first). */
  acpEngines(): AcpEngine[] { return mergeAcpEngines(this.read().acp as Partial<AcpEngine>[]); }
  acpEngine(agent: string): AcpEngine | null {
    const e = this.acpEngines().find((x) => x.agentId === agent) ?? null;
    // OpenCode over ACP runs the same binary Swarm uses (Kora's bundled copy when there is no `opencode` on PATH).
    if (e && e.command === 'opencode' && !e.executable?.trim() && !resolveEngineBinary('opencode')) {
      const own = this.opencodeBinary();
      if (own) return { ...e, executable: own };
    }
    return e;
  }
  apiEndpoints(): ApiEndpoint[] { return this.read().endpoints; }
  apiEndpoint(agent: string): ApiEndpoint | null { return this.read().endpoints.find((e) => e.agentId === agent) ?? null; }
  idleMs(): number { const m = this.read().acpIdleMinutes; return m ? m * 60_000 : ACP_IDLE_MS_DEFAULT; }
  /** `{driver, koraAgent}` for an id that is a known ACP / API engine, else null (the router then falls back to Claude). */
  route(id: string): { driver: string; koraAgent: string } | null {
    const head = id.split(':')[0] ?? id;
    return this.acpEngine(head) || this.apiEndpoint(head) ? { driver: head, koraAgent: head } : null;
  }

  // ── detection + the Settings view ───────────────────────────────────────────────────────────────────────────
  private detectDeps(): DetectDeps {
    const base = this.o.detect ?? {};
    const resolve = base.resolve ?? ((n: string) => resolveEngineBinary(n));
    // Settings > Engines said "OpenCode is not set up" while Swarm ran on Kora's bundled copy (pl9 S2-3): ask the same
    // resolver Swarm does when the PATH search misses.
    return { ...base, resolve: (n) => resolve(n) ?? (n === 'opencode' ? this.opencodeBinary() : null), hasKey: (id) => this.keys.has(id) };
  }
  private opencodeBinary(): string | null {
    try {
      // `{}`: the same search, but outside Swarm's 60 s cache (a Settings look must not pin Swarm to a stale answer).
      return this.o.resolveOpencode ? this.o.resolveOpencode() : (require('./swarm-install') as typeof import('./swarm-install')).resolveOpencodeBinary({}).path;
    } catch { return null; }
  }

  async nativeStatus(): Promise<EngineStatus[]> {
    const f = this.read();
    return NATIVE.map((n) => {
      const st = detectCliEngine({ id: n.id, label: n.label, family: n.id, command: n.command, executable: f.executables[n.id] ?? null }, this.detectDeps());
      if (!st.available && n.id === 'claude' && !f.executables.claude) {
        // Kora ships the Agent SDK's own copy of Claude Code: a Mac without the `claude` command still runs chats.
        try { const b = (require('./health') as typeof import('./health')).findBundledClaude(); if (b) return { ...st, available: true, executable: b, reason: undefined } as EngineStatus; } catch { /* no bundled copy */ }
      }
      return st;
    });
  }

  /** The ACP + API rows (cheap: stats and keychain reads, no processes of ours). */
  private async core(): Promise<{ acp: AcpEngineView[]; endpoints: ApiEndpointView[] }> {
    const f = this.read();
    const merged = this.acpEngines();
    const acpStatus = detectAcpEngines(merged, this.detectDeps()).map((st): EngineStatus => {
      const why = this.acpBlocked(st.id);
      return st.available && why ? { ...st, available: false, parked: true, reason: `${why} Press Re-check when it is fixed.` } : st;
    });
    const apiStatus = await detectApiEndpoints(f.endpoints, this.detectDeps());
    // A legacy row the user configured (gemini) shows as theirs to edit or remove, with its old default args.
    const builtinById = new Map([...LEGACY_ACP_ENGINES, ...BUILTIN_ACP_ENGINES].map((e) => [e.agentId, e]));
    const acp: AcpEngineView[] = merged.map((e, i) => ({
      agentId: e.agentId, label: e.label, command: e.command, executable: e.executable?.trim() ? e.executable : null,
      args: e.args, defaultArgs: builtinById.get(e.agentId)?.args ?? e.args, env: e.env ?? {}, custom: !builtinById.has(e.agentId),
      status: acpStatus[i]!,
    }));
    const endpoints: ApiEndpointView[] = [];
    for (let i = 0; i < f.endpoints.length; i++) endpoints.push({ ...f.endpoints[i]!, hasKey: await this.keys.has(f.endpoints[i]!.id), status: apiStatus[i]! });
    return { acp, endpoints };
  }

  /** Everything Settings > Engines shows. The accounts section asks `claude auth status` per account (read-only). */
  async view(): Promise<EnginesView> {
    const { acp, endpoints } = await this.core();
    return {
      engines: await this.nativeStatus(), acp, endpoints, accounts: await this.accounts.view(),
      presets: API_PRESETS.map((p) => ({ ...p })), acpIdleMinutes: Math.round(this.idleMs() / 60_000),
    };
  }

  /** The usable engines (ACP + API) as the model picker needs them. Unavailable ones keep their reason. */
  async pickerEngines(): Promise<Array<{ id: string; label: string; family: 'acp' | 'api'; available: boolean; reason?: string; models: ApiModel[]; defaultModel: string | null }>> {
    const v = await this.core();
    const out: Array<{ id: string; label: string; family: 'acp' | 'api'; available: boolean; reason?: string; models: ApiModel[]; defaultModel: string | null }> = [];
    for (const a of v.acp) {
      // an ACP agent that is not installed is not offered at all (a Mac has two or three of them, not eight); a custom one always is
      if (!a.status.available && !a.custom) continue;
      const cached = this.modelCache.get(a.agentId);
      out.push({ id: a.agentId, label: a.label, family: 'acp', available: a.status.available, ...(a.status.reason ? { reason: a.status.reason } : {}), models: cached?.models ?? [], defaultModel: cached?.current ?? null });
    }
    for (const e of v.endpoints) {
      const cached = this.modelCache.get(e.agentId);
      out.push({ id: e.agentId, label: e.label, family: 'api', available: e.status.available, ...(e.status.reason ? { reason: e.status.reason } : {}), models: cached?.models ?? (e.defaultModel ? [{ id: e.defaultModel, name: e.defaultModel }] : []), defaultModel: e.defaultModel ?? null });
    }
    return out;
  }

  // ── ACP ──────────────────────────────────────────────────────────────────────────────────────────────────────
  acpSave(i: AcpOverride): void {
    const f = this.read();
    // Saving a legacy row (gemini) the user already has keeps it editable; it cannot be added fresh.
    const builtin = BUILTIN_ACP_ENGINES.some((e) => e.agentId === i.agentId) || (LEGACY_ACP_ENGINES.some((e) => e.agentId === i.agentId) && f.acp.some((a) => a.agentId === i.agentId));
    if (!builtin && !CUSTOM_ID.test(i.agentId)) throw new Error('A custom agent id looks like acp-my-agent (lowercase letters, numbers and dashes).');
    if (!builtin && !(i.command?.trim() && i.label?.trim())) throw new Error('A custom agent needs a name and a command.');
    if (i.executable && !path.isAbsolute(i.executable)) throw new Error('The path must be absolute (start with /).');
    if (i.args && i.args.length > 40) throw new Error('Too many arguments.');
    const clean: AcpOverride = {
      agentId: i.agentId,
      ...(i.label?.trim() ? { label: i.label.trim().slice(0, 60) } : {}),
      ...(i.command?.trim() ? { command: i.command.trim() } : {}),
      ...(i.executable === null ? { executable: null } : i.executable?.trim() ? { executable: i.executable.trim() } : {}),
      ...(i.args ? { args: i.args.map((a) => String(a)) } : {}),
      ...(i.env ? { env: i.env } : {}),
    };
    const rest = f.acp.filter((a) => a.agentId !== i.agentId);
    // saving again edits: keep what the new payload did not mention
    const prev = f.acp.find((a) => a.agentId === i.agentId);
    this.write({ ...f, acp: [...rest, { ...prev, ...clean }] });
    this.modelCache.delete(i.agentId);
  }
  /** A custom agent is deleted; a built-in only loses its overrides (back to the default launch line). */
  acpRemove(agentId: string): void {
    const f = this.read();
    this.write({ ...f, acp: f.acp.filter((a) => a.agentId !== agentId) });
    this.modelCache.delete(agentId);
  }
  /** Spawns the agent briefly (no chat; the process is always killed) and asks for its model list. Cached for the picker. */
  async acpModels(agentId: string): Promise<{ models: ApiModel[]; current: string | null; error?: string }> {
    const e = this.acpEngine(agentId);
    if (!e) return { models: [], current: null, error: 'That agent is not set up.' };
    // Only ever the user's own click (Settings > Engines): that is a re-check, so a parked engine gets exactly one probe.
    this.acpRecheck(agentId);
    const r = await (this.o.discoverModels ?? discoverAcpModels)(e);
    if (!r.error && r.models.length) this.modelCache.set(agentId, { at: Date.now(), models: r.models, current: r.current });
    else if (r.failed && r.error) this.acpMarkFailed(agentId, `${e.label} did not start: ${r.error}`);
    this.emit('changed');
    const { failed: _failed, ...out } = r as typeof r & { failed?: boolean };
    return out;
  }
  setIdleMinutes(minutes: number): void {
    const m = Math.round(Number(minutes));
    if (!Number.isFinite(m) || m < 1 || m > 240) throw new Error('Idle time must be between 1 and 240 minutes.');
    this.write({ ...this.read(), acpIdleMinutes: m });
  }

  // ── native executables ──────────────────────────────────────────────────────────────────────────────────────
  setExecutable(engine: NativeEngine, p: string | null): EngineStatus {
    const f = this.read();
    const next = { ...f.executables };
    if (p && p.trim()) {
      if (!path.isAbsolute(p.trim())) throw new Error('The path must be absolute (start with /).');
      next[engine] = p.trim();
    } else delete next[engine];
    this.write({ ...f, executables: next });
    setEngineBinaryOverride('claude', next.claude ?? null);
    setEngineBinaryOverride('codex', next.codex ?? null);
    setEngineBinaryOverride('agy', next.antigravity ?? null);
    if (engine === 'opencode') this.o.opencodePath?.set(next.opencode ?? null);
    const n = NATIVE.find((x) => x.id === engine)!;
    return detectCliEngine({ id: n.id, label: n.label, family: n.id, command: n.command, executable: next[engine] ?? null }, this.detectDeps());
  }

  // ── API endpoints ───────────────────────────────────────────────────────────────────────────────────────────
  apiSave(i: Partial<ApiEndpoint> & { id: string }): ApiEndpoint {
    const ep = normalizeEndpoint(i.baseUrl || !presetEndpoint(i.id) ? i : { ...presetEndpoint(i.id)!, ...i });
    const f = this.read();
    this.write({ ...f, endpoints: [...f.endpoints.filter((e) => e.id !== ep.id), ep] });
    this.modelCache.delete(ep.agentId);
    return ep;
  }
  async apiRemove(id: string): Promise<void> {
    const f = this.read();
    this.write({ ...f, endpoints: f.endpoints.filter((e) => e.id !== id) });
    await this.keys.delete(id).catch(() => undefined);
    this.modelCache.delete(`api-${id}`);
  }
  private endpoint(id: string): ApiEndpoint {
    const ep = this.read().endpoints.find((e) => e.id === id);
    if (!ep) throw new Error('That endpoint is not set up.');
    return ep;
  }
  async apiSetKey(id: string, key: string): Promise<void> { this.endpoint(id); await this.keys.set(id, key); this.emit('changed'); }
  async apiClearKey(id: string): Promise<void> { this.endpoint(id); await this.keys.delete(id); this.emit('changed'); }
  /** GET /models only (no chat message): a key typed in the form can be tested before it is saved. */
  async apiTest(id: string, transientKey?: string): Promise<ApiTestResult> {
    const ep = this.endpoint(id);
    const key = transientKey?.trim() || (await this.keys.get(id));
    const r = await testApiEndpoint(ep, key, this.o.fetch);
    if (r.ok && r.models?.length) { this.modelCache.set(ep.agentId, { at: Date.now(), models: r.models, current: null }); this.emit('changed'); }
    // models are not a secret, but the list can be long: the caller gets the count and the picker reads the cache
    return r;
  }
  async apiModels(id: string): Promise<ApiModel[]> {
    const ep = this.endpoint(id);
    const models = await listApiModels(ep, await this.keys.get(id), this.o.fetch);
    this.modelCache.set(ep.agentId, { at: Date.now(), models, current: null });
    this.emit('changed');
    return models;
  }

  /** The registered Claude accounts (no sign-in probe): the model picker lists each as `Claude · <label>`. */
  accountList(): Array<{ name: string; label: string }> { return this.accounts.list().map((a) => ({ name: a.name, label: a.label })); }

  // ── Claude accounts ─────────────────────────────────────────────────────────────────────────────────────────
  accountAdd(i: { name: string; label?: string }): ClaudeAccountView { const a = this.accounts.add(i); this.emit('changed'); return a; }
  accountRename(name: string, label: string): void { if (!this.accounts.rename(name, label)) throw new Error('No such account.'); this.emit('changed'); }
  accountRemove(name: string): void { if (!this.accounts.remove(name)) throw new Error('No such account.'); this.emit('changed'); }
  async accountCheck(name: string): Promise<ClaudeAccountView> {
    const v = (await this.accounts.view()).find((a) => a.name === name);
    if (!v) throw new Error('No such account.');
    this.emit('changed');
    return v;
  }
}
