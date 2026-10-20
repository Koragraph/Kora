// The token-saving switches (Settings > Context). They live in <KORA_HOME>/settings.json beside `claudeCompactAt` (the
// daemon's prefs store writes them; see util/claude-compaction.ts for the pattern), so the daemon's in-process hooks
// AND the per-call `kora hook` processes of a pane read the same answer. A change applies from the next Read / the next
// session that starts. Env vars override for one run (tests, the canary, a bisect).
import fs from 'node:fs';
import path from 'node:path';
import { koraHome } from '../protocol/types';

/** off: untouched. shadow: decide and LOG what would have been bounded, change nothing. on: rewrite the Read. */
export type BoundedReadsMode = 'off' | 'shadow' | 'on';
/**
 * Shipped default: SHADOW. The live Haiku proof showed the lever is safe (the model answers correctly from a window plus the
 * outline, Edit works, a second Read gets the whole file) but not yet a win: it costs one extra call when the task needs the
 * whole file, and on the last 14 days of real chat-lane transcripts the ceiling was near zero (the rulebook and the per-prompt
 * injection already make agents Read by range). Shadow records what it WOULD have bounded and changes nothing; it flips to
 * 'on' when a week of dogfood shows the saving (docs/overnight-2026-10-14/S2-claude-savings.md). The same default is in
 * packages/contracts/src/settings.ts (`boundedReads`) - keep the two in step.
 */
export const BOUNDED_READS_DEFAULT: BoundedReadsMode = 'shadow';

const CACHE_MS = 2000;
let cache: { home: string; at: number; value: Record<string, unknown> } | null = null;
function readSettings(home: string): Record<string, unknown> {
  const now = Date.now();
  if (cache && cache.home === home && now - cache.at < CACHE_MS) return cache.value;
  let value: Record<string, unknown> = {};
  try { const j = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')); if (j && typeof j === 'object') value = j; } catch { /* absent or damaged: defaults */ }
  // <KORA_HOME>/savings.json is the older home of injectRecall / codexSavings / swarmTokenCeiling (before they had Settings rows).
  // It is now only a fallback: a key present in settings.json wins.
  try { const j = JSON.parse(fs.readFileSync(path.join(home, 'savings.json'), 'utf8')); if (j && typeof j === 'object') value = { ...j, ...value }; } catch { /* absent: defaults */ }
  cache = { home, at: now, value };
  return value;
}
/** One lever from savings.json / settings.json (env handled by the caller). Shared by the codex lane's switch. */
export function savingsSetting(key: string, home: string = koraHome()): unknown { return readSettings(home)[key]; }
/** Tests that rewrite settings.json between calls. */
export function resetSavingsSettingsCache(): void { cache = null; }

export function boundedReadsMode(home: string = koraHome(), env: NodeJS.ProcessEnv = process.env): BoundedReadsMode {
  const e = (env.KORA_BOUNDED_READS ?? '').trim().toLowerCase();
  if (e === '0' || e === 'off' || e === 'false') return 'off';
  if (e === '1' || e === 'on' || e === 'true') return 'on';
  if (e === 'shadow') return 'shadow';
  const v = readSettings(home).boundedReads;
  return v === 'off' || v === 'shadow' || v === 'on' ? v : BOUNDED_READS_DEFAULT;
}

/**
 * Answer-in-deny (enforce/deny-answer.ts): the one-time redirect of a cold Grep / Bash rg for a code identifier carries the graph's
 * answer (declaration + top callers) in the deny text, so the agent does not spend a round trip asking for it. off: today's plain
 * redirect. shadow: look the answer up, LOG what the deny would have said (cost.jsonl `deny-answer-shadow`), send the plain redirect.
 * on: send the answer. Shipped default SHADOW: the paired check (docs/savings-2026-10-15/sava.md) found the redirect almost never fires
 * in the rulebook lane (agents ask the graph first) and no cost win at the few sites where it did. Same default is in packages/contracts/src/settings.ts (`denyAnswer`) - keep the two in step.
 */
export const DENY_ANSWER_DEFAULT: BoundedReadsMode = 'shadow';
export function denyAnswerMode(home: string = koraHome(), env: NodeJS.ProcessEnv = process.env): BoundedReadsMode {
  const e = (env.KORA_DENY_ANSWER ?? '').trim().toLowerCase();
  if (e === '0' || e === 'off' || e === 'false') return 'off';
  if (e === '1' || e === 'on' || e === 'true') return 'on';
  if (e === 'shadow') return 'shadow';
  const v = readSettings(home).denyAnswer;
  return v === 'off' || v === 'shadow' || v === 'on' ? v : DENY_ANSWER_DEFAULT;
}

/** "Lean context" (opt-in, off by default): a new thread hides the user's global skills and Claude's auto-memory. */
export function leanContextOn(home: string = koraHome(), env: NodeJS.ProcessEnv = process.env): boolean {
  const e = (env.KORA_LEAN_CONTEXT ?? '').trim().toLowerCase();
  if (e === '1' || e === 'on' || e === 'true') return true;
  if (e === '0' || e === 'off' || e === 'false') return false;
  return readSettings(home).leanContext === true;
}

/**
 * Bounded reads for Swarm (OpenCode) workers. The Settings > Context "Bounded reads" switch, when the user set it, wins;
 * otherwise the worker default applies. Workers differ from the Claude lane: they have no rulebook and no per-prompt
 * injection, so a free model opens whole files by habit (the ceiling is much higher). KORA_SWARM_BOUND_READ overrides.
 */
export const SWARM_BOUNDED_READS_DEFAULT: BoundedReadsMode = 'shadow';
export function swarmBoundedReadsMode(home: string = koraHome(), env: NodeJS.ProcessEnv = process.env): BoundedReadsMode {
  const e = (env.KORA_SWARM_BOUND_READ ?? '').trim().toLowerCase();
  if (e === '0' || e === 'off' || e === 'false') return 'off';
  if (e === '1' || e === 'on' || e === 'true') return 'on';
  if (e === 'shadow') return 'shadow';
  const v = readSettings(home).boundedReads;
  // the shipped default for the Claude lane is written to settings.json by the prefs store only when the user changed it
  return v === 'off' || v === 'shadow' || v === 'on' ? v : SWARM_BOUNDED_READS_DEFAULT;
}

/** Fresh tokens (input + output + reasoning + cache writes, never cache reads) a Swarm worker may use before it is told to stop exploring. */
export const SWARM_TOKEN_CEILING_DEFAULT = 2_500_000;
export function swarmTokenCeiling(home: string = koraHome(), env: NodeJS.ProcessEnv = process.env): number {
  const e = Number(env.KORA_SWARM_TOKEN_CEILING);
  if (Number.isFinite(e) && e >= 0 && (env.KORA_SWARM_TOKEN_CEILING ?? '') !== '') return Math.floor(e);
  const v = readSettings(home).swarmTokenCeiling;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : SWARM_TOKEN_CEILING_DEFAULT;
}

/**
 * Injection recall (B14): edit-shaped prompts with no identifier ("make the stop button red") resolve through the fuzzy
 * symbol channel, and deictic follow-ups ("add a test for that function") get the recently touched file's outline.
 * ON by default; <KORA_HOME>/savings.json `{"injectRecall": false}` or KORA_INJECT_RECALL=0 turns it off.
 */
export function injectRecallOn(home: string = koraHome(), env: NodeJS.ProcessEnv = process.env): boolean {
  const e = (env.KORA_INJECT_RECALL ?? '').trim().toLowerCase();
  if (e === '0' || e === 'off' || e === 'false') return false;
  if (e === '1' || e === 'on' || e === 'true') return true;
  return readSettings(home).injectRecall !== false;
}

/**
 * Bug-report localization (SAV-B): a bug described in plain English with no identifier ("the retry count is off by one
 * somewhere in the http client") gets the 2-3 most likely declarations from the graph (graph/bug-localize.ts), only when the
 * top candidate is clearly ahead. SHADOW by default: the prompt hook decides and logs what it WOULD inject (inject.jsonl,
 * `bug` field) and injects nothing. 'on' only after a paired live check shows a win (docs/savings-2026-10-15/savb.md).
 * KORA_INJECT_BUG_PROSE overrides. packages/contracts/src/settings.ts (`injectBugProse`) holds the same default - keep the two in step.
 */
export const INJECT_BUG_PROSE_DEFAULT: BoundedReadsMode = 'shadow';
export function injectBugProseMode(home: string = koraHome(), env: NodeJS.ProcessEnv = process.env): BoundedReadsMode {
  const e = (env.KORA_INJECT_BUG_PROSE ?? '').trim().toLowerCase();
  if (e === '0' || e === 'off' || e === 'false') return 'off';
  if (e === '1' || e === 'on' || e === 'true') return 'on';
  if (e === 'shadow') return 'shadow';
  const v = readSettings(home).injectBugProse;
  return v === 'off' || v === 'shadow' || v === 'on' ? v : INJECT_BUG_PROSE_DEFAULT;
}

/** Quick answers (B17): a pure "who calls X / where is X" question in the composer is answered from the graph with no agent turn. ON by default. */
export function quickAnswersOn(home: string = koraHome(), env: NodeJS.ProcessEnv = process.env): boolean {
  const e = (env.KORA_QUICK_ANSWERS ?? '').trim().toLowerCase();
  if (e === '0' || e === 'off' || e === 'false') return false;
  if (e === '1' || e === 'on' || e === 'true') return true;
  return readSettings(home).quickAnswers !== false;
}

/**
 * Bash output trim (B16): a Bash result over 8k chars is cut to its first lines, every error / warning line and its tail.
 * ON by default since 2026-10-15 (SAV-D, docs/savings-2026-10-15/savd.md): paired live runs, every run passed, -17..-49% $ on big-output
 * tasks and even on a ~15k-char suite. No error line is ever dropped and the full output is kept in a spill file. The `kora trim-run`
 * wrapper only applies in Full access. "shadow" logs what a trim would save (cost.jsonl `bash-trim-shadow`) and changes nothing.
 * packages/contracts/src/settings.ts (`bashTrim`) holds the same default - keep the two in step.
 */
export const BASH_TRIM_DEFAULT: BoundedReadsMode = 'on';
export function bashTrimMode(home: string = koraHome(), env: NodeJS.ProcessEnv = process.env): BoundedReadsMode {
  const e = (env.KORA_BASH_TRIM ?? '').trim().toLowerCase();
  if (e === '0' || e === 'off' || e === 'false') return 'off';
  if (e === '1' || e === 'on' || e === 'true') return 'on';
  if (e === 'shadow') return 'shadow';
  const v = readSettings(home).bashTrim;
  return v === 'off' || v === 'shadow' || v === 'on' ? v : BASH_TRIM_DEFAULT;
}

/**
 * Read dedupe in the chat lane (session/read-dedupe-hooks.ts, SAV-D 2026-10-15). A Read of a file that is already in this context
 * segment and unchanged since: shadow logs it, nudge tells the agent so (additionalContext), deny refuses the first re-read with
 * a reason and allows the second attempt. Measured (docs/savings-2026-10-15/savd.md): the SDK lane returns an identical
 * re-read in full (no stub), and deny costs +21..29% per task (the model re-issues the Read), so deny is a loss. SHADOW by default.
 * packages/contracts/src/settings.ts (`chatReadDedupe`) holds the same default - keep the two in step.
 */
export type ChatReadDedupeMode = 'off' | 'shadow' | 'nudge' | 'deny';
export const CHAT_READ_DEDUPE_DEFAULT: ChatReadDedupeMode = 'shadow';
export function chatReadDedupeMode(home: string = koraHome(), env: NodeJS.ProcessEnv = process.env): ChatReadDedupeMode {
  const e = (env.KORA_CHAT_READ_DEDUPE ?? '').trim().toLowerCase();
  if (e === '0' || e === 'off' || e === 'false') return 'off';
  if (e === 'shadow' || e === 'nudge' || e === 'deny') return e;
  if (e === '1' || e === 'on' || e === 'true') return 'nudge';
  const v = readSettings(home).chatReadDedupe;
  return v === 'off' || v === 'shadow' || v === 'nudge' || v === 'deny' ? v : CHAT_READ_DEDUPE_DEFAULT;
}

/**
 * Cache keep-warm (cachewarm/): a loopback proxy replays a thread's last request with max_tokens 0 shortly before its prompt
 * cache entry would expire, so a user who comes back after more than an hour does not pay the 2x re-write. It was ON by
 * default 2026-10-14..16 after a live A/B (3 Haiku pairs, 65 min idle, 27k context) returned at $0.061 warm vs $0.110 cold (-45%,
 * one $0.0027 ping each); the replay sim puts the net on the chat lane at ~+2.2% (returning after an hour is rare).
 * SHADOW puts the proxy in the path, decides and logs what it WOULD warm (cost.jsonl `warm-shadow`) and sends nothing.
 * KORA_CACHE_WARM overrides. packages/contracts/src/settings.ts (`cacheWarm`) holds the same default - keep the two in step.
 */
/**
 * OFF by default again since 2026-10-16: the relay carries each request, login headers included, and Anthropic's legal page
 * says "developers may not collect, store, or intermediate Claude.ai credentials or session tokens" (most Kora users are on
 * a subscription login). Its measured net on the chat lane is small (~+2.2%). Turning it on in Settings is the user's call.
 */
export const CACHE_WARM_DEFAULT: BoundedReadsMode = 'off';
export function cacheWarmMode(home: string = koraHome(), env: NodeJS.ProcessEnv = process.env): BoundedReadsMode {
  const e = (env.KORA_CACHE_WARM ?? '').trim().toLowerCase();
  if (e === '0' || e === 'off' || e === 'false') return 'off';
  if (e === '1' || e === 'on' || e === 'true') return 'on';
  if (e === 'shadow') return 'shadow';
  const v = readSettings(home).cacheWarm;
  return v === 'off' || v === 'shadow' || v === 'on' ? v : CACHE_WARM_DEFAULT;
}

/**
 * Auto model (session/auto-model.ts): a Claude thread whose model is "Auto" runs light work (questions, lookups, one-place
 * edits, chores) on Haiku 5.5 and everything else on the user's Default. OFF by default (2026-10-19: about $0 on real usage,
 * KORA-SAVER.md); off makes "Auto" run the Default.
 * KORA_AUTO_MODEL overrides. packages/contracts/src/settings.ts (`autoModel`) holds the same default - keep the two in step.
 */
/**
 * Auto's middle tier (session/auto-model.ts): when the user's Default is Opus or Fable, an Auto thread doing ordinary work
 * runs on Sonnet 5.5 at high effort, about half the price per token. A quality trade, not a free saving (Anthropic's own
 * table: Sonnet 5.5 high 87.6% vs Opus 5.5 medium 92.8% on a SWE-bench Pro subset), so OFF by default. Needs Auto on.
 * KORA_AUTO_SONNET overrides; contracts `autoSonnet` holds the same default - keep the two in step.
 */
export const AUTO_SONNET_DEFAULT = false;
export function autoSonnetOn(home: string = koraHome(), env: NodeJS.ProcessEnv = process.env): boolean {
  const e = (env.KORA_AUTO_SONNET ?? '').trim().toLowerCase();
  if (e === '0' || e === 'off' || e === 'false') return false;
  if (e === '1' || e === 'on' || e === 'true') return true;
  const v = readSettings(home).autoSonnet;
  return typeof v === 'boolean' ? v : AUTO_SONNET_DEFAULT;
}
/**
 * Lead hand-off (server/orchestrator-skill.ts chatDelegationPrompt): a chat thread is told that a run of five or more of its
 * own commands costs far less in a fresh worker on a cheap model. M's replay of the user's leads (kora-wt-sav-route
 * docs/research/ROUTING-2026-10-16.md §5): handing every such run to a Sonnet 5.5 worker would save ~50% of a Kora lead's
 * dollars (Haiku 5.5: ~76%), break-even at 3 calls. A behaviour change that adds worker pickers for the user, so OFF until
 * benched on whole lead runs. KORA_LEAD_HANDOFF overrides; contracts `leadHandoff` holds the same default.
 */
export const LEAD_HANDOFF_DEFAULT = false;
export function leadHandoffOn(home: string = koraHome(), env: NodeJS.ProcessEnv = process.env): boolean {
  const e = (env.KORA_LEAD_HANDOFF ?? '').trim().toLowerCase();
  if (e === '0' || e === 'off' || e === 'false') return false;
  if (e === '1' || e === 'on' || e === 'true') return true;
  const v = readSettings(home).leadHandoff;
  return typeof v === 'boolean' ? v : LEAD_HANDOFF_DEFAULT;
}
/**
 * Auto effort (session/auto-model.ts turnEffort): with Auto on, a turn that is only a chore (commit, push, run the tests) runs at
 * low effort and a turn that says the last answer was wrong at high; every other turn keeps the thread's own effort. A quality
 * trade on the chore turns, so OFF until measured. KORA_AUTO_EFFORT overrides; contracts `autoEffort` holds the same default.
 */
export const AUTO_EFFORT_DEFAULT = false;
export function autoEffortOn(home: string = koraHome(), env: NodeJS.ProcessEnv = process.env): boolean {
  const e = (env.KORA_AUTO_EFFORT ?? '').trim().toLowerCase();
  if (e === '0' || e === 'off' || e === 'false') return false;
  if (e === '1' || e === 'on' || e === 'true') return true;
  const v = readSettings(home).autoEffort;
  return typeof v === 'boolean' ? v : AUTO_EFFORT_DEFAULT;
}
/**
 * Plan headroom (session/plan-headroom.ts): with Auto on and an Opus or Fable Default, a NEW thread doing ordinary work starts
 * on Sonnet 5.5 at high effort while a Claude plan window is at 85% or more, even with the middle tier off: about half the
 * plan use, so the user keeps working. ON by default; KORA_AUTO_HEADROOM overrides; contracts `autoHeadroom` holds the default.
 */
export function autoHeadroomOn(home: string = koraHome(), env: NodeJS.ProcessEnv = process.env): boolean {
  const e = (env.KORA_AUTO_HEADROOM ?? '').trim().toLowerCase();
  if (e === '0' || e === 'off' || e === 'false') return false;
  if (e === '1' || e === 'on' || e === 'true') return true;
  return readSettings(home).autoHeadroom !== false;
}
/**
 * Experiment only (KORA_AUTO_ADVISOR=1): the middle tier's Sonnet gets the Default as Claude Code's server-side advisor.
 * Measured 2026-10-16: each consult reads the whole transcript uncached at the advisor's input price, and Anthropic saw
 * Sonnet 5.5 consult 0 times in 20 coding tasks, so it is not a default.
 */
export function autoAdvisorOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const e = (env.KORA_AUTO_ADVISOR ?? '').trim().toLowerCase();
  return e === '1' || e === 'on' || e === 'true';
}

export function autoModelOn(home: string = koraHome(), env: NodeJS.ProcessEnv = process.env): boolean {
  const e = (env.KORA_AUTO_MODEL ?? '').trim().toLowerCase();
  if (e === '0' || e === 'off' || e === 'false') return false;
  if (e === '1' || e === 'on' || e === 'true') return true;
  return readSettings(home).autoModel === true;
}
