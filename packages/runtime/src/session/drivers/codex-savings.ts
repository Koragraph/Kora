// Token levers for `codex exec` turns and Codex panes (docs/overnight-2026-10-14/S4-lanes-swarm-graph.md, B11).
// Static facts only (codex-cli 0.155.1 config schema strings + `codex features list`); no Codex run backs the VALUES.
//
//   tool_output_token_limit            a tool's output is truncated to this many tokens before the model sees it. 10 000 is the
//                                      conservative end: it only bites on pathological output (a 2 MB log), and it pins the
//                                      limit so a future default change cannot raise the per-call cost silently.
//   model_auto_compact_token_limit     Codex compacts the conversation when it passes this many tokens. 150 000 keeps a long
//                                      thread from re-reading a 300k prefix on every call (reads are cheap but not free, and
//                                      the cache still has to be written once at 1x-2x).
//   --disable <feature>                features a code thread never uses add tool schemas to EVERY request: apps (connectors),
//                                      browser_use*, computer_use, image_generation. Only features this binary lists are
//                                      disabled (an unknown name is a hard error: "Unknown feature flag").
//
// A value the user set in ~/.codex/config.toml always wins: Kora never overrides the user's own choice.
// Switch: <KORA_HOME>/savings.json `{"codexSavings": false}` or KORA_CODEX_SAVINGS=0 (a Settings row is a handoff).
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { winCommand } from '../../util/win-exec';
import { koraHome } from '../../protocol/types';
import { savingsSetting } from '../../util/savings-settings';
import { codexHomeDir } from './codex-rollout';

export const CODEX_TOOL_OUTPUT_TOKEN_LIMIT = 10_000;
export const CODEX_AUTO_COMPACT_TOKEN_LIMIT = 150_000;
/** Candidates; only those the binary lists AND has enabled are passed to --disable. */
export const CODEX_DISABLE_FEATURES = ['apps', 'browser_use', 'browser_use_external', 'computer_use', 'image_generation'] as const;

export function codexSavingsOn(home: string = koraHome(), env: NodeJS.ProcessEnv = process.env): boolean {
  const e = (env.KORA_CODEX_SAVINGS ?? '').trim().toLowerCase();
  if (e === '0' || e === 'off' || e === 'false') return false;
  if (e === '1' || e === 'on' || e === 'true') return true;
  try { return savingsSetting('codexSavings', home) !== false; } catch { return true; }
}

/** Does the user's own Codex config set `key` (at any table)? Then Kora leaves it alone. */
export function userConfigSets(key: string, codexHome: string = codexHomeDir()): boolean {
  try {
    const text = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    return new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`, 'm').test(text);
  } catch { return false; }
}

/** `codex features list` -> { name -> enabled }. Lines are `name   stage   true|false`. */
export function parseFeatureList(text: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const line of (text || '').split('\n')) {
    const m = /^([a-z][a-z0-9_.]*)\s+\S+(?:\s+\S+)?\s+(true|false)\s*$/.exec(line.trim());
    if (m) out.set(m[1]!, m[2] === 'true');
  }
  return out;
}

/** A good probe is trusted for a while (Codex can update itself under a long-lived daemon, and a feature removed since would make
 *  `--disable <name>` a hard "Unknown feature flag" on every turn); a failed one is retried soon, not remembered for the daemon's life. */
export const FEATURE_CACHE_TTL_MS = 10 * 60 * 1000;
export const FEATURE_FAIL_TTL_MS = 60 * 1000;
const featureCache = new Map<string, { at: number; ttl: number; p: Promise<Map<string, boolean> | null> }>();
/** The binary's features (static: `codex features list` makes no network call). Cached per binary with a TTL; null when it cannot be read. */
export function codexFeatures(command: string, run: (cmd: string) => Promise<string> = defaultRun, now: number = Date.now()): Promise<Map<string, boolean> | null> {
  const hit = featureCache.get(command);
  if (hit && now - hit.at < hit.ttl) return hit.p;
  const entry = { at: now, ttl: FEATURE_CACHE_TTL_MS, p: null as unknown as Promise<Map<string, boolean> | null> };
  entry.p = run(command).then((t) => { const m = parseFeatureList(t); if (!m.size) entry.ttl = FEATURE_FAIL_TTL_MS; return m.size ? m : null; }).catch(() => { entry.ttl = FEATURE_FAIL_TTL_MS; return null; });
  featureCache.set(command, entry);
  return entry.p;
}
export function resetCodexFeatureCache(): void { featureCache.clear(); }
function defaultRun(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const w = winCommand(command, ['features', 'list']);
    execFile(w.command, w.args, { timeout: 4000, windowsHide: true, windowsVerbatimArguments: w.windowsVerbatimArguments, maxBuffer: 256 * 1024, env: { ...process.env, NO_COLOR: '1' } }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

/** The `-c` pair (also valid for a Codex pane). */
export function codexLimitArgs(opts: { codexHome?: string } = {}): string[] {
  const args: string[] = [];
  if (!userConfigSets('tool_output_token_limit', opts.codexHome)) args.push('-c', `tool_output_token_limit=${CODEX_TOOL_OUTPUT_TOKEN_LIMIT}`);
  if (!userConfigSets('model_auto_compact_token_limit', opts.codexHome)) args.push('-c', `model_auto_compact_token_limit=${CODEX_AUTO_COMPACT_TOKEN_LIMIT}`);
  return args;
}

/**
 * Everything the per-turn `codex exec` argv gets for token savings: the limits and the --disable list. Empty when the
 * switch is off. `probe: false` skips the feature lookup (tests with a fake binary).
 */
export async function codexSavingsArgs(command: string, opts: { probe?: boolean; codexHome?: string; run?: (cmd: string) => Promise<string>; home?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string[]> {
  if (!codexSavingsOn(opts.home, opts.env)) return [];
  const args = codexLimitArgs({ codexHome: opts.codexHome });
  if (opts.probe !== false) {
    const feats = await codexFeatures(command, opts.run);
    if (feats) for (const f of CODEX_DISABLE_FEATURES) if (feats.get(f) === true) args.push('--disable', f);
  }
  return args;
}
