// Engine breadth (Phase 7): which engines exist, which are usable on THIS machine, and why not when they are not.
// Pure + injectable (no daemon state): the daemon feeds it the user's Settings > Engines config and renders the result.
// An unavailable engine is a row with a reason, never an exception - the fleet always starts.
import fs from 'node:fs';
import path from 'node:path';
import { resolveEngineBinary } from '../detect/engine-binary';
import type { AcpEngine } from './drivers/acp-driver';
import type { ApiEndpoint } from './drivers/api-providers';
import { thisComputer, inTerminal } from '../util/platform-copy';

/**
 * Built-in ACP engines: the documented launch lines at the time of writing, all overridable in Settings > Engines (args +
 * explicit path). Google's agent is Antigravity (`agy`), a native engine with its own driver (drivers/antigravity-driver.ts),
 * not an ACP row: the Gemini CLI row left the auto-detected list on 2026-10-12 (see LEGACY_ACP_ENGINES).
 */
export const BUILTIN_ACP_ENGINES: AcpEngine[] = [
  { agentId: 'grok', label: 'Grok CLI', command: 'grok', args: ['agent', 'stdio'], loginHint: `Run \`grok login\` ${inTerminal()}, then try again.` },
  { agentId: 'cursor', label: 'Cursor agent', command: 'cursor-agent', args: ['acp'], loginHint: `Run \`cursor-agent login\` ${inTerminal()}, then try again.` },
  { agentId: 'kimi', label: 'Kimi CLI', command: 'kimi', args: ['acp'], loginHint: `Run \`kimi\` ${inTerminal()} and use /login, then try again.` },
  { agentId: 'qwen', label: 'Qwen Code', command: 'qwen', args: ['--acp'], loginHint: `Run \`qwen\` ${inTerminal()} and sign in, then try again.` },
  { agentId: 'droid', label: 'Factory Droid', command: 'droid', args: ['exec', '--output-format', 'acp'], loginHint: `Run \`droid\` ${inTerminal()} and sign in, then try again.` },
  { agentId: 'acp-hermes', label: 'Hermes', command: 'hermes', args: ['acp'] },
  { agentId: 'acp-opencode', label: 'OpenCode over ACP', command: 'opencode', args: ['acp'] },
];

/**
 * Engines that were built in once and no longer are. They are never detected on their own; a user who configured one
 * in Settings > Engines (an override row in engines.json) keeps it, with its old defaults under their own settings.
 * `gemini --acp` was verified against Gemini CLI 0.60 (2026-10-09).
 */
export const LEGACY_ACP_ENGINES: AcpEngine[] = [
  { agentId: 'gemini', label: 'Gemini CLI', command: 'gemini', args: ['--acp'], authMethodId: 'oauth-personal', loginHint: `Run \`gemini\` ${inTerminal()} once and sign in, then try again.`, modelArgs: (m) => ['--model', m] },
];

export type EngineFamily = 'claude' | 'codex' | 'opencode' | 'antigravity' | 'acp' | 'api';
export interface EngineStatus {
  id: string;
  label: string;
  family: EngineFamily;
  available: boolean;
  /** Why not, in a sentence the Settings page can show as-is. Present whenever `available` is false. */
  reason?: string;
  /** The executable that will run (ACP / CLI engines). */
  executable?: string;
  /** True when the executable came from the user's explicit path. */
  explicitPath?: boolean;
  /** API engines: needs a key and has none. */
  needsKey?: boolean;
  /** An ACP agent that failed to start (auth timeout, unsupported client, crash): parked until the user re-checks it. */
  parked?: boolean;
}

export interface DetectDeps {
  resolve?: (name: string) => string | null;
  isExecutable?: (p: string) => boolean;
  /** Does the API endpoint have a stored key? */
  hasKey?: (endpointId: string) => boolean | Promise<boolean>;
}

function isExec(p: string): boolean { try { return fs.statSync(p).isFile() && (fs.accessSync(p, fs.constants.X_OK), true); } catch { return false; } }

/** One CLI engine (ACP or the three native ones): explicit path first, then the widened PATH. */
export function detectCliEngine(e: { id: string; label: string; family: EngineFamily; command: string; executable?: string | null }, d: DetectDeps = {}): EngineStatus {
  const base = { id: e.id, label: e.label, family: e.family };
  const explicit = e.executable?.trim();
  const exec = d.isExecutable ?? isExec;
  if (explicit) {
    if (!path.isAbsolute(explicit)) return { ...base, available: false, explicitPath: true, reason: `The path you set for ${e.label} must be absolute (${explicit}).` };
    if (!exec(explicit)) return { ...base, available: false, explicitPath: true, reason: `${explicit} does not exist or is not executable. Fix the path in Settings > Engines or clear it to search automatically.` };
    return { ...base, available: true, executable: explicit, explicitPath: true };
  }
  const found = (d.resolve ?? ((n) => resolveEngineBinary(n)))(e.command);
  return found
    ? { ...base, available: true, executable: found }
    : { ...base, available: false, reason: `\`${e.command}\` was not found on ${thisComputer()}. Install ${e.label}, or set its path in Settings > Engines.` };
}

/** Every ACP engine (built-in + custom, with the user's overrides applied). */
export function detectAcpEngines(engines: AcpEngine[] = BUILTIN_ACP_ENGINES, d: DetectDeps = {}): EngineStatus[] {
  return engines.map((e) => detectCliEngine({ id: e.agentId, label: e.label, family: 'acp', command: e.command, executable: e.executable }, d));
}

/** Every API endpoint: usable when it has a key (or needs none, like LM Studio / Ollama). Reachability is the Test button's job. */
export async function detectApiEndpoints(endpoints: ApiEndpoint[], d: DetectDeps = {}): Promise<EngineStatus[]> {
  const out: EngineStatus[] = [];
  for (const ep of endpoints) {
    const base = { id: ep.agentId, label: ep.label, family: 'api' as const };
    if (!ep.baseUrl) { out.push({ ...base, available: false, reason: 'No base URL set.' }); continue; }
    if (ep.requiresKey && !(await d.hasKey?.(ep.id))) { out.push({ ...base, available: false, needsKey: true, reason: `${ep.label} needs an API key. Add one in Settings > Engines.` }); continue; }
    out.push({ ...base, available: true });
  }
  return out;
}

/** Merge the user's overrides (Settings > Engines) over the built-in table; custom ids are `acp-<slug>`. */
export function mergeAcpEngines(overrides: Partial<AcpEngine>[] = [], builtins: AcpEngine[] = BUILTIN_ACP_ENGINES, legacy: AcpEngine[] = LEGACY_ACP_ENGINES): AcpEngine[] {
  const byId = new Map(builtins.map((e) => [e.agentId, { ...e }]));
  for (const o of overrides) {
    if (!o.agentId) continue;
    // A formerly built-in engine the user configured stays, on its old defaults under their settings.
    const old = byId.has(o.agentId) ? undefined : legacy.find((e) => e.agentId === o.agentId);
    if (old) { byId.set(o.agentId, { ...old, ...stripUndefined(o) }); continue; }
    const cur = byId.get(o.agentId);
    if (cur) byId.set(o.agentId, { ...cur, ...stripUndefined(o) });
    else if (/^acp-[a-z0-9][a-z0-9-]{0,29}$/.test(o.agentId) && o.command && o.label) byId.set(o.agentId, { agentId: o.agentId, label: o.label, command: o.command, args: o.args ?? [], ...stripUndefined(o) } as AcpEngine);
  }
  return [...byId.values()];
}
function stripUndefined<T extends object>(o: T): T { return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T; }
