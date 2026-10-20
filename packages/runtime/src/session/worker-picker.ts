/**
 * Who does delegated work, and on which model — decided by the USER, per delegation.
 *
 * Kora's rule: an agent never starts its harness's own subagents. Delegation is kora_spawn only — a real CLI
 * session (Claude Code, Codex, …) in a pane the user can watch and steer. Before spawning, the lead proposes its
 * workers with kora_ask_workers (one row per task: agent, model, effort, why); Kora shows the user a picker
 * pre-filled with that proposal over every model they have; the user approves or changes it in one click; and
 * kora_spawn then only starts workers that match an approved pick. "Don't ask again in this thread" turns the
 * popup off for that thread (the lead's own picks are approved as proposed).
 *
 * The CATALOG (what is installed, which model ids + effort levels each CLI accepts) is written by the daemon's UI
 * server from its live model probes to <KORA_HOME>/worker-catalog.json. It only guards against impossible picks
 * (an uninstalled CLI, a Claude id handed to Codex, an effort the model lacks) — it is never a policy.
 */
import * as fs from 'node:fs';
import { effectiveClaudeDefault } from '../util/claude-default-model';
import * as path from 'node:path';
import { koraHome } from '../protocol/types';

export interface CatalogModel { id: string; name?: string; efforts?: string[]; isDefault?: boolean; resolved?: string }
export interface CatalogAgent { installed: boolean; models: CatalogModel[] }
export interface WorkerCatalog { updatedAt?: string; agents: Record<string, CatalogAgent> }

/** One proposed or approved worker. */
export interface WorkerPick { title: string; agent: string; model?: string; effort?: string; why?: string }
/** The user's answer to a picker: the approved rows (a removed row is absent), or cancelled. */
export interface WorkerPickerAnswer { picks: WorkerPick[]; cancelled?: boolean; autoApprove?: boolean; auto?: boolean }

export const CATALOG_FILE = 'worker-catalog.json';

export function loadWorkerCatalog(home: string = koraHome()): WorkerCatalog {
  let raw: any = null;
  try { raw = JSON.parse(fs.readFileSync(path.join(home, CATALOG_FILE), 'utf8')); } catch { /* none yet */ }
  const agents: Record<string, CatalogAgent> = {};
  if (raw && typeof raw.agents === 'object' && raw.agents) {
    for (const [id, a] of Object.entries<any>(raw.agents)) {
      const models = Array.isArray(a?.models) ? a.models.filter((m: any) => typeof m?.id === 'string' && m.id) : [];
      agents[id] = { installed: a?.installed !== false, models };
    }
  }
  return { ...(typeof raw?.updatedAt === 'string' ? { updatedAt: raw.updatedAt } : {}), agents };
}

/** Effort words a lead may use for any agent, mapped to what CLIs call them. */
const EFFORT_ALIASES: Record<string, string> = { med: 'medium', mid: 'medium', hi: 'high', lo: 'low', min: 'minimal', 'extra-high': 'xhigh', xh: 'xhigh' };
export function normalizeEffort(effort: string | undefined | null): string | undefined {
  const e = String(effort ?? '').trim().toLowerCase();
  if (!e) return undefined;
  return EFFORT_ALIASES[e] ?? e;
}

export type ResolvedWorker = { ok: true; model?: string; effort?: string } | { ok: false; error: string };

/**
 * Check one worker against the catalog. Errors name what IS valid, so the lead can correct itself in one step.
 * `lenient`: drop an effort the model lacks instead of failing (a proposal is fixed up, not refused).
 */
export function checkWorker(req: { agent: string; model?: string | null; effort?: string | null }, catalog: WorkerCatalog, lenient = false): ResolvedWorker {
  const agent = req.agent;
  const cat = catalog.agents[agent];
  // The catalog lists every worker CLI found on PATH; one it does not list would open a dead pane.
  if (Object.keys(catalog.agents).length > 0 && (!cat || !cat.installed)) {
    return { ok: false, error: `${agent} is not installed on this machine. Installed: ${installedAgents(catalog).join(', ') || 'none'}.` };
  }
  const model = String(req.model ?? '').trim() || undefined;
  if (model) {
    // Claude's catalog lists only some aliases (opus[1m], sonnet, …); its CLI also takes the bare family aliases and
    // any full claude-* id.
    const claudeId = agent === 'claude' && /^(claude-[a-z0-9.-]+|opus|sonnet|haiku|fable)(\[1m\])?$/i.test(model);
    if (cat && cat.models.length && !claudeId && !cat.models.some((m) => m.id === model)) {
      return { ok: false, error: `${agent} does not accept the model id "${model}". Valid: ${cat.models.map((m) => m.id).join(', ')} (or omit model for its default).` };
    }
  }
  const effort = normalizeEffort(req.effort);
  if (effort && cat) {
    const m = model ? cat.models.find((x) => x.id === model) : cat.models.find((x) => x.isDefault);
    // A model the catalog does not list by that id (a bare claude alias): any level this CLI has.
    const levels = m ? (m.efforts ?? []) : [...new Set(cat.models.flatMap((x) => x.efforts ?? []))];
    if (m && !levels.length) {
      if (lenient) return { ok: true, ...(model ? { model } : {}) };
      return { ok: false, error: `${agent} ${model ?? 'default'} has no effort setting — omit effort.` };
    }
    if (levels.length && !levels.includes(effort)) {
      if (lenient) return { ok: true, ...(model ? { model } : {}) };
      return { ok: false, error: `${agent}${model ? ` ${model}` : ''} has no effort "${effort}". Valid: ${levels.join(', ')}.` };
    }
  }
  return { ok: true, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

/**
 * The model id to put on a worker CLI's argv. A Claude alias (`sonnet`, `opus[1m]`) is launched as the full id the
 * catalog resolved it to, so the worker runs the model the picker showed even when the `claude` on PATH is older than
 * the SDK and maps the alias to a previous model (live: "Sonnet 5.5" picked, claude-sonnet-5 ran).
 */
export function cliModelId(agent: string, model: string | undefined, catalog: WorkerCatalog): string | undefined {
  if (!model || agent !== 'claude') return model;
  // Kora's "Default" is the user's own Claude setting (else Sonnet), never the CLI's `--model default` (Opus 5.5).
  if (model === 'default') {
    const r = catalog.agents.claude?.models.find((m) => m.id === 'default')?.resolved;
    return r && /^claude-[a-z0-9.-]+(\[1m\])?$/i.test(r) ? r : effectiveClaudeDefault();
  }
  const oneM = /\[1m\]$/i.test(model);
  const base = model.replace(/\[1m\]$/i, '');
  const resolved = catalog.agents.claude?.models.find((m) => m.id === base)?.resolved;
  return resolved && /^claude-[a-z0-9.-]+$/i.test(resolved) ? `${resolved}${oneM ? '[1m]' : ''}` : model;
}

/** Claude's full ids and its aliases name the same model: claude-haiku-4-5-… ≡ haiku, opus[1m] ≡ opus. */
function claudeFamily(id: string): string {
  return id.toLowerCase().replace(/\[1m\]$/, '').replace(/^claude-/, '').split('-')[0] ?? id;
}
export function sameModel(agent: string, a: string | undefined, b: string | undefined): boolean {
  if ((a ?? '') === (b ?? '')) return true;
  if (!a || !b) return false;
  return agent === 'claude' && a !== 'default' && b !== 'default' && claudeFamily(a) === claudeFamily(b);
}

/** The CLI's own name for an agent id Kora spells differently: a lead that writes `agy` means `antigravity`. */
export const agentAlias = (agent: string): string => (agent.trim().toLowerCase() === 'agy' ? 'antigravity' : agent.trim());

export function installedAgents(catalog: WorkerCatalog): string[] {
  return Object.entries(catalog.agents).filter(([, a]) => a.installed).map(([id]) => id);
}

/** The catalog block for the lead's tool descriptions: one line per installed CLI. */
export function workerCatalogText(catalog: WorkerCatalog): string {
  const lines: string[] = [];
  for (const id of installedAgents(catalog)) {
    const models = catalog.agents[id]!.models;
    const efforts = [...new Set(models.flatMap((m) => m.efforts ?? []))];
    lines.push(`  ${id}: ${models.length ? `models ${models.map((m) => `${m.id}${m.isDefault ? '*' : ''}`).join(', ')}` : 'models: its CLI default'}${efforts.length ? ` · effort ${efforts.join('|')}` : ''}`);
  }
  return lines.join('\n');
}

/**
 * Approved picks, used up one per spawn. A spawn matches the first unused pick with its agent (and its model when the
 * lead names one); the pick's model and effort are what launch — the user's choice wins over the lead's.
 */
export class ApprovedPicks {
  private picks: (WorkerPick & { used: boolean })[] = [];
  add(picks: WorkerPick[]): void { for (const p of picks) this.picks.push({ ...p, used: false }); }
  take(agent: string, model?: string): WorkerPick | null {
    const named = model ? this.picks.find((p) => !p.used && p.agent === agent && sameModel(agent, p.model, model)) : undefined;
    const hit = named ?? this.picks.find((p) => !p.used && p.agent === agent && (!model || !p.model));
    if (!hit) return null;
    hit.used = true;
    return hit;
  }
  /** A spawn that failed gives its pick back: the user approved the worker, a refused/failed start must not use it up. */
  release(pick: WorkerPick): void {
    const hit = this.picks.find((p) => p.used && p.title === pick.title && p.agent === pick.agent && p.model === pick.model && p.effort === pick.effort);
    if (hit) hit.used = false;
  }
  unused(): WorkerPick[] { return this.picks.filter((p) => !p.used); }
}

/**
 * Stretch (the composer's one button): the fallback tier after the free workers. Whatever the lead proposes, only the
 * cheap models run: Claude Haiku (newest in the catalog) and Codex Luna (GPT-6 Luna first). Other agents and models are
 * replaced by their agent's cheap pick, or dropped when that CLI has none; effort is capped at `low` (these are executors
 * of planned slices). The user pressed Stretch: that is the approval, so no picker.
 */
export function stretchPicks(picks: WorkerPick[], catalog: WorkerCatalog): WorkerPick[] {
  const newest = (agent: string, re: RegExp): string | undefined => {
    const hits = (catalog.agents[agent]?.installed ? catalog.agents[agent]!.models : []).map((m) => m.id).filter((id) => re.test(id));
    return hits.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  };
  const cheap: Record<string, string | undefined> = { claude: newest('claude', /^claude-haiku-/) ?? (catalog.agents.claude?.models.some((m) => m.id === 'haiku') ? 'haiku' : undefined), codex: newest('codex', /luna/i) };
  const out: WorkerPick[] = [];
  for (const p of picks) {
    const agent = agentAlias(p.agent);
    const model = cheap[agent];
    if (!model) continue;
    const efforts = catalog.agents[agent]?.models.find((m) => m.id === model)?.efforts ?? [];
    out.push({ title: p.title, agent, model, ...(efforts.includes('low') ? { effort: 'low' } : {}), ...(p.why ? { why: p.why } : {}) });
  }
  return out;
}

export function describePick(p: WorkerPick): string {
  return `${p.agent}${p.model ? ` ${p.model}` : ' (CLI default)'}${p.effort ? ` ${p.effort}` : ''}`;
}

/** Flags that keep a WORKER CLI from starting its own subagents (the same rule as the lead). */
export function noSubagentArgs(agent: string): string[] {
  if (agent === 'claude') return ['--disallowedTools=Agent,Task,Workflow'];
  // check_for_update_on_startup: Codex's "Update available! 1. Update now / 2. Skip" screen parks a fresh worker
  // before it reads its prompt (nothing auto-answers it, and a worker should never self-update mid-fleet).
  if (agent === 'codex') return ['--disable', 'multi_agent', '-c', 'check_for_update_on_startup=false'];
  return [];
}
