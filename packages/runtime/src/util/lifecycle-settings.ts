// The context-lifecycle switches (overnight S3: cold-resume masking, task-boundary chip, model-switch chip, runaway guard). Same home as util/savings-settings.ts: <KORA_HOME>/settings.json written by the
// daemon's prefs store; an env var overrides for one run (tests, a bisect). Each answers "on" unless the user turned it off.
import fs from 'node:fs';
import path from 'node:path';
import { koraHome } from '../protocol/types';

export type LifecycleSwitch = 'coldResumeMasking' | 'taskBoundaryChip' | 'modelSwitchChip' | 'runawayGuard';
const ENV: Record<LifecycleSwitch, string> = {
  coldResumeMasking: 'KORA_COLD_RESUME_MASK', taskBoundaryChip: 'KORA_TASK_BOUNDARY_CHIP', modelSwitchChip: 'KORA_MODEL_SWITCH_CHIP',
  runawayGuard: 'KORA_RUNAWAY_GUARD',
};
/** Shipped defaults (packages/contracts/src/settings.ts holds the same table - keep the two in step). */
export const LIFECYCLE_DEFAULTS: Record<LifecycleSwitch, boolean> = {
  coldResumeMasking: true, taskBoundaryChip: true, modelSwitchChip: true, runawayGuard: true,
};

const CACHE_MS = 2000;
let cache: { home: string; at: number; value: Record<string, unknown> } | null = null;
function readSettings(home: string): Record<string, unknown> {
  const now = Date.now();
  if (cache && cache.home === home && now - cache.at < CACHE_MS) return cache.value;
  let value: Record<string, unknown> = {};
  try { const j = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')); if (j && typeof j === 'object') value = j; } catch { /* absent or damaged: defaults */ }
  cache = { home, at: now, value };
  return value;
}
export function resetLifecycleSettingsCache(): void { cache = null; }

export function lifecycleOn(name: LifecycleSwitch, home: string = koraHome(), env: NodeJS.ProcessEnv = process.env): boolean {
  const e = (env[ENV[name]] ?? '').trim().toLowerCase();
  if (e === '1' || e === 'on' || e === 'true') return true;
  if (e === '0' || e === 'off' || e === 'false') return false;
  const v = readSettings(home)[name];
  return typeof v === 'boolean' ? v : LIFECYCLE_DEFAULTS[name];
}
