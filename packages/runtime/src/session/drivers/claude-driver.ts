// The Claude SessionDriver — drives `@anthropic-ai/claude-agent-sdk` and normalizes its SDKMessage
// stream into ChatEvents (§01 §3). Plain TypeScript, no Effect.
//
// SHAPE:
//   - ONE long-lived `query()` per thread, fed by a promptQueue AsyncGenerator<SDKUserMessage>.
//     `sendTurn` pushes a user message; `stopSession` ends the generator. Turns share session state
//     (mid-thread model switch + steering).
//   - `canUseTool` → an `approval.opened` event + a parked Promise resolved by `respondToApproval`.
//   - an in-process `kora` MCP server exposing the koragraph tools (intercepted into graph.*
//     via graph-interceptor) and, for orchestrator threads, `kora_spawn` (intercepted into worker.*).
//   - SDK messages → ChatEvents via the PURE `mapSdkMessage` (heavily unit-tested; the SDK is mocked).
//
// The pure helpers below carry all the message-shape knowledge; the class is thin wiring. `queryFn`
// is injected (defaults to the real SDK `query`) so tests drive the driver without the network.
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as fsSync from 'node:fs';
import type {
  ChatEvent, UnsequencedChatEvent, ThreadId, TurnId, RequestId, ItemId,
  ApprovalAnswer, ApprovalKind, ToolKind, UserInputAnswers, UserInputQuestion,
  ModelChoice, PlanStep, TurnUsage, RuntimeMode, FileChange, PromptAttachment, UsageLimitsReport,
} from '../events';
import { newTurnId } from '../events';
import {
  claudeContextTokens, claudeContextUsageToTokenUsage, claudeRateLimitEventReport, claudeResultContextWindow, claudeResultCostUsd,
  claudeUsageReport, knownClaudeContextWindow,
} from '../usage';
import type {
  SessionDriver, DriverCapabilities, SessionStartInput, SendTurnInput, TurnHandle, DriverDeps, SessionPrep,
} from '../session-driver';
import { graphToolEvents } from '../graph-interceptor';
import { fleetToolSpecs, fleetControlFrom, toZodShape, type SwarmSpawner } from '../fleet-tools';
import { injectForPrompt } from '../../graph/prompt-inject';
import { noteTouchedFromEvents } from '../../graph/inject-carry';
import { createBashTrimHooks } from '../bash-trim';
import { createReadDedupeHooks } from '../read-dedupe-hooks';
import type { WrapSpec } from '../trim-wrap';
import { createReadBounder, type ReadBounder } from '../../graph/read-bounder';
import { CallTracker, logCost, advisorUsageOf, type CallUsage, type AdvisorUsage } from '../../util/cost-log';
import { cacheWarm } from '../../cachewarm/manager';
import { settingsGatewayReason, warmProxyArgs, withWarmProxy } from '../../cachewarm/gateway';
import { leanContextOn, bashTrimMode, cacheWarmMode } from '../../util/savings-settings';
import { sideModelEnv } from '../../util/side-model';
import { lifecycleOn } from '../../util/lifecycle-settings';
import { prepareColdResume, type ColdResume } from '../prune';
import { RunawayGuard } from '../runaway';
import { snapshotBeforeCompact } from '../compact-undo';
import { readThreadFlags, updateThreadFlags, type ThreadFlags } from '../thread-flags';
import { graphReadyNotice } from '../../graph/howto';
import { swarmLeaderSessionOptions } from '../../server/swarm-skill';
import { leadGateHooks } from '../../server/swarm-lead-gate';
import { isBlobsCwd } from '../../blobs/home';
import { blobHome } from '../../blobs/home';
import { ParkedApprovals, askVia } from '../../blobs/apps/approval';
import { engineBinaryOverride, engineSpawnEnv } from '../../detect/engine-binary';
import { blobPolicy, blobPreToolUseHooks, type BlobPolicyContext } from '../blob-policy';
import { sensitiveLinkTarget, sensitiveOverride, sensitivePreToolUseHooks, sensitiveVerdict } from '../sensitive-guard';
import { isFolderTrusted } from '../../trust/store';
import { claudeSettingSources } from '../../trust/gate';
import type { AgentId } from '../../protocol/types';
import { log } from '../../server/log';
import { claudePrivacyEnv } from '../../util/claude-privacy';
import { claudeCompactEnv, claudeCompactWindow, COMPACT_HEADROOM_TOKENS } from '../../util/claude-compaction';
import { claudeModelForLaunch } from '../../util/claude-default-model';
import { isUnderDir } from '../../util/os-roots';
import { requestCostOf } from '../../ledger/transcript';
import { isGraphQueryCommand } from '../plan-mode';

// ═══════════════════════════════════════════════════════════════════════════════
// PURE HELPERS (no SDK import, no I/O) — the message→event knowledge, unit-tested.
// ═══════════════════════════════════════════════════════════════════════════════

/** kora MCP tool blocks are rendered by the MCP-handler path, so the mapper suppresses them here. */
export function isKoraTool(name: string): boolean {
  return /^mcp__kora__/.test(name) || /^kora[_-]/.test(name) || name === 'kora_spawn';
}
/** A kora tool whose call the chat client must SEE (its input drives the UI), so the mapper lets it through:
 *  kora_open_preview — the client opens its url in the in-app browser (apps/web useAgentPreviewOpens.ts). */
export function isVisibleKoraTool(name: string): boolean {
  // browser_*: a blob's browser calls drive the Computer tab (apps/web blobBrowserAutoOpen.ts). They were suppressed with the
  // rest of the kora tools, so a real Claude blob turn carried only orphan tool results and the tab never opened (launch QA).
  return name === 'mcp__kora__kora_open_preview' || name === 'kora_open_preview' || /^mcp__kora__browser_[a-z_]+$/.test(name);
}
export function isSpawnTool(name: string): boolean {
  return name === 'kora_spawn' || name === 'mcp__kora__kora_spawn' || name === 'mcp__kora__spawn';
}

/** Classify a Claude tool_use into a ToolKind for the inline card. */
export function classifyToolKind(toolName: string): ToolKind {
  const n = toolName.replace(/^mcp__[^_]+__/, '');
  if (/^(Bash|BashOutput|KillShell)$/.test(n)) return 'command_execution';
  if (/^(Edit|MultiEdit|Write|NotebookEdit|Update)$/.test(n)) return 'file_change';
  if (/^(Read|Glob|Grep|NotebookRead|LS)$/.test(n)) return 'file_read';
  if (/^(WebSearch|WebFetch)$/.test(n)) return 'web_search';
  if (/^(explore|search_code|neighbours|blast_radius|changes_with|file_symbols|overview)$/.test(n)) return 'graph_query';
  if (/^mcp__/.test(toolName)) return 'mcp_tool_call';
  return 'dynamic_tool_call';
}

/** Classify a permission request into an ApprovalKind for the composer/transcript. */
export function classifyApprovalKind(toolName: string): ApprovalKind {
  const kind = classifyToolKind(toolName);
  if (kind === 'command_execution') return 'command_execution_approval';
  if (kind === 'file_change') return 'file_change_approval';
  if (kind === 'file_read') return 'file_read_approval';
  if (/^mcp__/.test(toolName)) return 'mcp_elicitation_approval';
  return 'unknown';
}

/** Extract PlanStep[] from a TodoWrite tool input. */
export function extractPlanSteps(input: unknown): PlanStep[] {
  const todos = (input as any)?.todos;
  if (!Array.isArray(todos)) return [];
  const map = (s: unknown): PlanStep['status'] =>
    s === 'in_progress' || s === 'inProgress' ? 'inProgress' : s === 'completed' ? 'completed' : 'pending';
  return todos
    .map((t: any) => ({ step: String(t?.content ?? t?.step ?? t?.activeForm ?? '').trim(), status: map(t?.status) }))
    .filter((p: PlanStep) => p.step.length > 0);
}

/** Normalize a Claude result/message usage into TurnUsage. */
export function normalizeTurnUsage(usage: unknown): TurnUsage | undefined {
  const u = usage as any;
  if (!u || typeof u !== 'object') return undefined;
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  const cacheRead = num(u.cache_read_input_tokens);
  const cacheCreate = num(u.cache_creation_input_tokens);
  const reasoning = num(u.reasoning_tokens ?? u.thinking_tokens);
  const any = [input, output, cacheRead, cacheCreate, reasoning].some((v) => v !== undefined);
  if (!any) return { usageStatus: 'unavailable' };
  return {
    usageStatus: 'complete',
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    ...(cacheRead !== undefined || cacheCreate !== undefined ? { cachedInputTokens: (cacheRead ?? 0) + (cacheCreate ?? 0) } : {}),
  };
}

const HALT_GRACE_MS = 3_000;

/** True when a result message represents an interrupt/abort. */
export function isInterruptedResult(msg: any): boolean {
  const reason = String(msg?.terminal_reason ?? msg?.stop_reason ?? '').toLowerCase();
  const subtype = String(msg?.subtype ?? '').toLowerCase();
  return reason.includes('interrupt') || reason.includes('abort') || reason.includes('cancel') || subtype.includes('interrupt') || subtype === 'error_during_execution';
}

/** Human-readable rate-limit line from a Claude usage-limit record. */
export function describeRateLimit(info: any): { message: string; window?: string; resetsAt?: number } {
  const window = info?.window ?? info?.type ?? info?.tier;
  const resetsAt = num(info?.resetsAt ?? info?.reset_at ?? info?.resets_at);
  const label: Record<string, string> = { five_hour: '5-hour session', seven_day: 'weekly', seven_day_opus: 'weekly Opus', seven_day_sonnet: 'weekly Sonnet', overage: 'extra usage' };
  const base = info?.message ?? (window ? `Claude usage limit reached (${label[String(window)] ?? String(window).replace(/_/g, ' ')})` : 'Claude usage limit reached');
  const when = resetsAt ? ` — resets ${new Date(resetsAt < 1e12 ? resetsAt * 1000 : resetsAt).toISOString()}` : '';
  return { message: `${base}${when}`, ...(window ? { window: String(window) } : {}), ...(resetsAt !== undefined ? { resetsAt } : {}) };
}

/**
 * One calm line for Claude Code's `system/api_retry` (a request failed and the CLI will retry on its own). Without it
 * a turn with no network sat on a silent spinner for ~3 minutes (10 retries, backoff to ~40 s) before any error.
 * `error_status` is null for a connection error / timeout (no HTTP response).
 */
export function describeApiRetry(m: { error_status?: number | null; error?: string | null; max_retries?: number }): string {
  const status = typeof m?.error_status === 'number' ? m.error_status : null;
  const err = String(m?.error ?? '');
  // Short enough for one work-log row (it is truncated there); Claude Code retries for ~3 minutes before it gives up.
  const tail = 'Still retrying; press Stop to give up.';
  if (status === null) return `Can't reach Claude — check your internet connection. ${tail}`;
  if (status === 529 || err === 'overloaded') return `Claude is overloaded right now. ${tail}`;
  if (status === 429 || err === 'rate_limit') return `Claude is rate-limiting requests. ${tail}`;
  if (status >= 500) return `Claude's servers returned an error (HTTP ${status}). ${tail}`;
  return `A request to Claude failed (HTTP ${status}). ${tail}`;
}

/** Parse an AskUserQuestion / elicitation tool input into structured UserInputQuestion[]. */
export function questionsFromAskUserInput(input: unknown): UserInputQuestion[] {
  const raw = (input as any)?.questions ?? (Array.isArray(input) ? input : [input]);
  const list = Array.isArray(raw) ? raw : [];
  return list.map((q: any, i: number): UserInputQuestion => ({
    id: String(q?.id ?? `q${i}`),
    header: String(q?.header ?? q?.title ?? 'Question'),
    question: String(q?.question ?? q?.prompt ?? q?.text ?? ''),
    options: Array.isArray(q?.options)
      ? q.options.map((o: any) => ({ label: String(o?.label ?? o?.value ?? o), description: String(o?.description ?? ''), ...(o?.value != null ? { value: String(o.value) } : {}) }))
      : [],
    ...(q?.allowCustomAnswer != null ? { allowCustomAnswer: !!q.allowCustomAnswer } : {}),
    ...(q?.multiSelect != null ? { multiSelect: !!q.multiSelect } : {}),
  }));
}

/** UI answers ({q0: …} by question id, or already by text) → the SDK's AskUserQuestion answers keyed by question text. */
export function answersByQuestionText(input: unknown, answers: UserInputAnswers): Record<string, unknown> {
  const qs = questionsFromAskUserInput(input);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(answers ?? {})) {
    const q = qs.find((x) => x.id === k) ?? qs.find((x) => x.question === k);
    out[q ? q.question : k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

/** Pull changed-file records off an Edit/Write/MultiEdit tool result (feeds §02 ChangedFilesCard, D3). */
export function changedFilesFromToolResult(toolName: string, input: unknown, result: unknown): FileChange[] | undefined {
  if (classifyToolKind(toolName) !== 'file_change') return undefined;
  const path = (input as any)?.file_path ?? (input as any)?.path ?? (result as any)?.filePath;
  if (!path) return undefined;
  const r: any = result;
  const additions = num(r?.additions ?? r?.structuredPatch?.reduce?.((a: number, h: any) => a + (h?.newLines ?? 0), 0)) ?? 0;
  const deletions = num(r?.deletions ?? r?.structuredPatch?.reduce?.((a: number, h: any) => a + (h?.oldLines ?? 0), 0)) ?? 0;
  return [{ path: String(path), additions, deletions }];
}

/** Session start never waits longer than this on the pane-equivalent preparation (brief + repo setup). */
export const PREPARE_TIMEOUT_MS = 8000;
/** getContextUsage answers in ~20 ms on a warm session; the first call waits for the `claude` process to start. */
const CONTEXT_USAGE_TIMEOUT_MS = 15_000;
/** The plan-usage control request makes one call to the claude.ai usage endpoint (~0.8 s measured). */
const PLAN_USAGE_TIMEOUT_MS = 10_000;

/** Resolve `p`, or reject after `ms` (the pending work keeps running; its result is dropped). */
export function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms); t.unref?.();
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Env a child agent must not inherit from the daemon (it may itself have been started inside an agent session:
 *  Claude Code then treats the child as a "child session" and, e.g., stops saving its transcript). Mirrors spawnPane. */
const INHERITED_SESSION_MARKERS = /^(CLAUDE_CODE_|CLAUDECODE|CODEX_SANDBOX|KORA_PANE_ID$|KORA_AGENT$)/;
export function sessionBaseEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !INHERITED_SESSION_MARKERS.test(k)) out[k] = v;
  return out;
}

/**
 * The SDK `query()` options for a session — PURE (the MCP server + permission callback are passed in).
 * `prep` is the pane-equivalent preparation (Runtime.prepareChatSession): its env carries the KORA_* identity the
 * repo's hooks dial back with, its `appendSystemPrompt` is the rulebook a pane gets as `--append-system-prompt`, and
 * `strictMcp` is `--strict-mcp-config`. `settingSources` is explicit so the project's `.claude/settings.local.json`
 * (where the kora hooks live) and CLAUDE.md (the rulebook block) always load — in a TRUSTED folder (trust/store.ts).
 * In an untrusted one only the user's own settings load (no repo hooks, project MCP servers, plugins, apiKeyHelper,
 * statusLine or permission rules), Kora's own hooks ride in as flag settings so the graph lane keeps working (one
 * injection owner), and strict MCP is forced.
 */
/** A blob tool's result as an MCP tool result. browser_screenshot's picture goes to the model as an image block next to its caption. */
export function sdkToolResult(r: { text: string; isError?: boolean; image?: { data: string; mimeType: string } }) {
  return {
    content: [{ type: 'text', text: r.text }, ...(r.image ? [{ type: 'image', data: r.image.data, mimeType: r.image.mimeType }] : [])],
    ...(r.isError ? { isError: true } : {}),
  };
}

/** Process-wide: two session starts in the same millisecond still get distinct approval-id tags. */
let approvalSessionSeq = 0;

/**
 * The blob lane (docs/bots/ARCH.md D10, R4 + the 2026-10-08 "keep the native capabilities" ruling): a blob's Claude
 * session loads NO setting sources (the user's hooks, MCP servers, CLAUDE.md never leak in), keeps every built-in tool
 * (only Agent/Task/Workflow are off - the Kora rule), gets its skills as a local plugin (Kora's document pack + its own
 * + the user's installed skills, skills only), and runs the blob permission policy as a PreToolUse hook.
 */
export interface BlobLane { pluginDir: string; skills: string[]; blobHome: string; policyHooks: Record<string, unknown> }

/**
 * Tool round trips one user message (a blob chat turn, a routine run, a delegated job step) may take before the SDK stops it
 * with `error_max_turns` (shown as a failed turn; "continue" goes on). A tool loop otherwise runs until the model stops by itself.
 * A typical blob turn needs under 15. The Code lane has none: a swarm lead legitimately loops on kora_wait for a long time.
 */
export const BLOB_MAX_TURNS = 60;

export function blobLaneOptions(lane: BlobLane): Record<string, unknown> {
  return {
    maxTurns: BLOB_MAX_TURNS,
    settingSources: [],
    strictMcpConfig: true,
    plugins: [{ type: 'local', path: lane.pluginDir }],
    skills: lane.skills,
  };
}

/** What the composer's effort control shows for a model nobody touched (ui-server claudeModels.ts pickDefaultEffort). */
export const DEFAULT_CHAT_EFFORT = 'medium';

/**
 * Tools a new code thread does not get (master cost plan 1.1): each costs schema tokens on every call and none works
 * inside Kora - cron and wake-up tools need a session that outlives the turn, RemoteTrigger a claude.ai account hook,
 * and Claude's own worktree tools would move the agent out of the checkout Kora tracks (Kora makes worktrees itself, for
 * workers, with merge gates). No Kora flow calls them (rg over src/, ui-server, apps/web: only the swarm leader's own
 * disallow list names them).
 */
export const SAFE_DISALLOWED_TOOLS = ['CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'RemoteTrigger', 'EnterWorktree', 'ExitWorktree'] as const;
/** The built-in Explore / Plan sub-agents are off (the Agent tool is already disallowed in every Kora thread; this also drops their listing). */
export const SAFE_TOOLS_ENV = { CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS: '1' } as const;
/** Last warm ping at 90% of the TTL after the horizon (2 h), plus the hour it then lives. */
const WARMED_COLD_AFTER_MS = (120 + 60) * 60_000;

/**
 * The last step of buildSessionOptions: lane options that several sources set (the swarm leader lane, the safe tool subset,
 * Lean context, Kora's flag-settings hooks for an untrusted folder) are merged instead of the last spread winning - before,
 * a Swarm leader in an untrusted folder lost Kora's own hooks to its `settings: { autoMemoryEnabled: false }`.
 */
export function mergeLaneOptions(o: any, f: { koraHooks: Record<string, unknown> | null; safeTools: boolean; lean: boolean }): any {
  const disallowed = new Set<string>([...(Array.isArray(o.disallowedTools) ? o.disallowedTools : []), ...(f.safeTools ? SAFE_DISALLOWED_TOOLS : [])]);
  const settings = { ...(f.koraHooks ? { hooks: f.koraHooks } : {}), ...(o.settings ?? {}), ...(f.lean ? { autoMemoryEnabled: false } : {}) };
  if (disallowed.size) o.disallowedTools = [...disallowed];
  if (Object.keys(settings).length) o.settings = settings; else delete o.settings;
  return o;
}

export function buildSessionOptions(
  input: SessionStartInput, prep: SessionPrep | null, orchestratorAppend: string | undefined,
  accountEnv: Record<string, string>, extra: { mcpServers: Record<string, unknown>; canUseTool: unknown; drainNotes?: () => string[]; trusted?: boolean; blob?: BlobLane; runtimeMode?: () => string | undefined; readHooks?: Record<string, unknown>; lifecycleHooks?: Record<string, unknown>; safeTools?: boolean; lean?: boolean; warmBaseUrl?: string | null },
): any {
  // Fail closed: a caller that does not say the folder is trusted gets the restricted lane.
  const trusted = extra.trusted === true;
  const koraHooks = !trusted ? untrustedKoraHooks(prep) : null;
  const env = withWarmProxy(engineSpawnEnv({ ...sessionBaseEnv(), ...claudePrivacyEnv(), ...claudeCompactEnv(claudeModelForLaunch(input.model?.model, accountEnv.CLAUDE_CONFIG_DIR)), ...sideModelEnv({ ...process.env, ...accountEnv }), ...(prep?.env ?? {}), ...accountEnv, ...(extra.blob ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } : {}), ...(extra.safeTools ? SAFE_TOOLS_ENV : {}) }), extra.warmBaseUrl);
  const append = [prep?.appendSystemPrompt, orchestratorAppend].filter((x): x is string => !!x && x.trim().length > 0).join('\n\n');
  const o: any = {
    cwd: input.cwd,
    includePartialMessages: true,
    permissionMode: toSdkPermissionMode(input.runtimeMode, !!extra.blob),
    // Composer uploads land under here (ui-server's `resolveAttachments`); without this the agent's Read on
    // an attached non-image file is denied as outside the working directory.
    additionalDirectories: [path.join((require('../../protocol/types') as typeof import('../../protocol/types')).koraHome(), 'attachments'), ...(extra.blob ? [extra.blob.blobHome] : []),
      // B16 "On": the agent may Read the full output a trim spilled here (no approval prompt for Kora's own file).
      ...(!extra.blob && bashTrimMode() === 'on' ? [path.join((require('../../protocol/types') as typeof import('../../protocol/types')).koraHome(), 'tool-out')] : [])],
    // Only PERMITS bypass; the mode above decides. Without it a live switch to Full access (query.setPermissionMode
    // from the composer) is refused and the session keeps asking for approvals behind a "Full access" pill.
    allowDangerouslySkipPermissions: true,
    // an explicit Claude path from Settings > Engines wins over the SDK's own lookup
    ...(() => { const p = engineBinaryOverride('claude'); return p ? { pathToClaudeCodeExecutable: p } : {}; })(),
    // The CLI runs under a Seatbelt profile that refuses only Kora's control token (os-sandbox.ts claudeTokenProfile): the
    // hooks' text guard alone let a glob or a variable read it (2026-10-15 audit #4). Not macOS / KORA_OS_SANDBOX=0: as before.
    ...(() => { const f = (require('../os-sandbox') as typeof import('../os-sandbox')).fencedClaudeSpawn(); return f ? { spawnClaudeCodeProcess: f } : {}; })(),
    // "default" is Kora's picker row, not a CLI alias: it follows the user's own Claude setting, else Sonnet (not the SDK's Opus).
    ...(input.model?.model ? { model: claudeModelForLaunch(input.model.model, accountEnv.CLAUDE_CONFIG_DIR) } : {}),
    // An untouched composer shows "Medium"; send it, or the CLI runs its own (higher, dearer) default behind that label
    // (aud3 S3-4). Haiku has no effort setting; a blob keeps whatever its profile says.
    ...(() => {
      // Test the model that LAUNCHES: "default" following a user's `"model": "haiku"` setting is Haiku too (A3-6).
      const launched = claudeModelForLaunch(input.model?.model, accountEnv.CLAUDE_CONFIG_DIR);
      const effort = input.model?.effort ?? (launched && !extra.blob && !/haiku/i.test(launched) ? DEFAULT_CHAT_EFFORT : undefined);
      return effort ? { effort } : {};
    })(),
    ...(typeof input.resume === 'string' ? { resume: input.resume, forkSession: false } : {}),
    // Blob lane: auto-memory off (the blob's memory is Kora's own) and the account's claude.ai connectors off (a blob
    // sees only what its profile grants) - measured on SDK 0.3.286, ARCH R4.
    // PATH widened: the daemon's own is bare (`/usr/bin:/bin:…`), and the agent's Bash tool then could not find `node`, `git`, `codex`…
    env,
    ...(() => { const a = warmProxyArgs(env, extra.warmBaseUrl, !!engineBinaryOverride('claude')); return Object.keys(a).length ? { extraArgs: a } : {}; })(),
    systemPrompt: { type: 'preset', preset: 'claude_code', ...(append ? { append } : {}) },
    settingSources: claudeSettingSources(trusted),
    ...(extra.blob ? blobLaneOptions(extra.blob) : {}),
    ...(prep?.strictMcp || !trusted ? { strictMcpConfig: true } : {}),
    // An orchestrator delegates through the FLEET or not at all. The SDK's own delegation tool
    // (`Agent`, `Task` in older builds) runs a subagent invisibly inside this turn — no pane, nothing
    // the human can watch or steer — and the model reaches for it (or for a skill that wraps it)
    // instead of kora_spawn unless it simply isn't there.
    // Every Kora thread is fleet-wired now (chat included), so this holds for all of them; `Workflow` is the SDK's
    // multi-agent runner — the same invisible delegation under another name.
    ...(input.isOrchestrator ? { disallowedTools: ['Agent', 'Task', 'Workflow'] } : {}),
    // A fleet worker (server/driver-pane.ts) has no human beside it: no questions, and no delegation of its own.
    ...(input.isWorker ? { disallowedTools: ['Agent', 'Task', 'Workflow', 'AskUserQuestion'] } : {}),
    // A NEW code thread also loses the tools that cannot work inside Kora (SAFE_DISALLOWED_TOOLS) - decided once, at the
    // thread's start, and remembered (session/thread-flags.ts): a live thread's tool list never changes (its cache).
    // "Lean context" (opt-in) also hides the skills listing and Claude's auto-memory block. Both are merged below.
    ...(extra.lean ? { skills: [] } : {}),
    // A CODE Swarm leader runs the lean lane (server/swarm-skill.ts): only the tools a leader uses, no skill
    // listing, no auto-memory block, and the delegate-first gate (a lead that explored the repo itself instead of
    // delegating). The assistant lane is a different assistant — general-purpose, no repo, no gate — so it keeps
    // the full toolset (just Agent/Task disallowed above) and only its own leader prompt (appendSystemPrompt).
    ...(input.agentMode === 'swarm' && !isBlobsCwd(input.cwd) ? swarmLeaderSessionOptions() : {}),
    ...(() => {
      // Worker news reaches a lead mid-turn: every tool result (a web search, a Read, …) carries the notes that
      // arrived meanwhile ("p2 STOPPED on a usage limit"). Before, a lead busy with its own tools heard nothing until
      // it called a kora_* tool or its turn ended — it waited minutes on a worker that had already died.
      const gate = input.agentMode === 'swarm' && !isBlobsCwd(input.cwd) ? leadGateHooks() : {};
      const notes = input.isOrchestrator && extra.drainNotes ? workerNoteHooks(extra.drainNotes) : {};
      const hooks = mergeHookMaps(mergeHookMaps({ ...gate, ...notes, ...(extra.blob ? mergeHookMaps(extra.blob.policyHooks, notes) : {}) },
        // Every lane, every mode: keys and credentials stay off limits even in Full access (session/sensitive-guard.ts).
        sensitivePreToolUseHooks(input.cwd, extra.runtimeMode ?? (() => input.runtimeMode))),
        // Bounded Read (graph/read-bounder.ts): a code thread only, in-process, fail-open.
        mergeHookMaps(extra.readHooks ?? {}, extra.lifecycleHooks ?? {}));
      return Object.keys(hooks).length ? { hooks } : {};
    })(),
    mcpServers: extra.mcpServers,
    canUseTool: extra.canUseTool,
  };
  // Auto's middle tier: Claude Code's server-side advisor tool, consulted by the session's model at hard points.
  if (input.advisorModel && !extra.blob) o.settings = { ...(o.settings ?? {}), advisorModel: input.advisorModel };
  // Kora's compaction point also rides as flag settings: a user `env` block in ~/.claude/settings.json overrides the
  // process env in the SDK entrypoint (M follow-up 5, CLI 2.1.301); flag settings apply after it.
  const compact = claudeCompactEnv(claudeModelForLaunch(input.model?.model, accountEnv.CLAUDE_CONFIG_DIR));
  if (Object.keys(compact).length) o.settings = { ...(o.settings ?? {}), env: { ...(o.settings?.env ?? {}), ...compact } };
  return mergeLaneOptions(o, { koraHooks, safeTools: extra.safeTools === true && !extra.blob, lean: extra.lean === true && !extra.blob });
}

/**
 * Kora's own command hooks for a session that does not load the repo's `.claude/settings.local.json` (an untrusted
 * folder): the same seven entries the enforcer writes there, built fresh from this install's node + bin — never read
 * back from the repo file, which the repository controls. Only when the session was prepared like a pane (the claude
 * adapter ran: rulebook present); a folder the enforcer skips (home, a system folder) gets none, as before.
 */
export function untrustedKoraHooks(prep: SessionPrep | null): Record<string, unknown> | null {
  if (!prep?.appendSystemPrompt) return null;
  try {
    const { mergeHooks } = require('../../enforce/adapters/claude') as typeof import('../../enforce/adapters/claude');
    const { KORA_BIN, NODE_BIN } = require('../../graph/embedded') as typeof import('../../graph/embedded');
    return mergeHooks({}, { binPath: prep.env?.KORA_BIN || KORA_BIN, nodeBin: NODE_BIN }).settings.hooks;
  } catch { return null; }
}

/** PostToolUse: hand the lead any pending worker notes as additional context on the tool result it just got. */
export function workerNoteHooks(drain: () => string[]): Record<string, unknown> {
  const hook = async () => {
    let notes: string[] = [];
    try { notes = drain(); } catch { /* none */ }
    if (!notes.length) return {};
    return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `Worker updates (Kora):\n${notes.join('\n\n')}` } };
  };
  return { PostToolUse: [{ hooks: [hook] }] };
}

/** Two hook maps (event -> matcher entries) merged without dropping either side's entries. */
export function mergeHookMaps(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = [...((out[k] as unknown[]) ?? []), ...(v as unknown[])];
  return out;
}

/** Map a RuntimeMode to the SDK PermissionMode. */
export function toSdkPermissionMode(mode: RuntimeMode | undefined, blob = false): 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' {
  switch (mode) {
    case 'auto-accept-edits': return 'acceptEdits';
    // A blob never uses the SDK's own `auto` mode: its classifier DENIES a call silently (Live QA #5: a browser key
    // press during a booking) with no card to answer. `default` sends every call the SDK would not allow on its own
    // to canUseTool, where the blob policy allows in-bounds work and anything else becomes the inline approval card.
    case 'auto': return blob ? 'default' : 'auto';
    case 'full-access': return 'bypassPermissions';
    default: return 'default';
  }
}

export interface MapCtx {
  turnId?: TurnId;
  /** When false, assistant-message text/thinking blocks emit content.delta (partial streaming off). */
  partials?: boolean;
}

const blockItemId = (turnId: string | undefined, index: number, kind: string): ItemId => `${turnId ?? 't'}:${kind}:${index}`;

/**
 * Map ONE SDKMessage → zero-or-more ChatEvents (no seq/envelope yet — the manager stamps those).
 * The single place SDK message shapes are read; version-guarded and fails soft.
 *
 * Policy (avoids double-emitting text):
 *   - text/thinking come from `stream_event` content_block_delta (streaming on, the default).
 *   - tool lifecycle comes from the `assistant` (tool_use) + `user` (tool_result) messages, keyed by
 *     the tool_use id — EXCEPT kora MCP tools (rendered by the MCP-handler path) and kora_spawn
 *     (→ worker.attached), which are suppressed here.
 *   - AskUserQuestion tool_use → user-input.requested.
 */
export function mapSdkMessage(msg: any, ctx: MapCtx = {}): UnsequencedChatEvent[] {
  const out: UnsequencedChatEvent[] = [];
  const turnId = ctx.turnId;
  try {
    switch (msg?.type) {
      case 'system': return mapSystem(msg);
      case 'stream_event': return mapStreamEvent(msg, turnId);
      case 'assistant': return mapAssistant(msg, ctx);
      case 'user': return mapUser(msg);
      case 'result': return mapResult(msg, turnId);
      default: return out;
    }
  } catch {
    return [{ type: 'runtime.warning', message: `unmappable SDK message: ${String(msg?.type)}` }];
  }
}

function mapSystem(msg: any): UnsequencedChatEvent[] {
  if (msg.subtype === 'init') {
    return [
      { type: 'session.started' },
      { type: 'thread.started', ...(msg.session_id ? { providerThreadId: String(msg.session_id) } : {}) },
      { type: 'session.state', state: 'ready' },
    ];
  }
  if (msg.subtype === 'session_state_changed') {
    const s = msg.state === 'running' ? 'running' : msg.state === 'requires_action' ? 'waiting' : 'ready';
    return [{ type: 'session.state', state: s }];
  }
  if (msg.subtype === 'permission_denied') {
    return [{ type: 'runtime.warning', message: `permission denied: ${msg.tool_name}${msg.message ? ` — ${msg.message}` : ''}` }];
  }
  if (msg.subtype === 'task_started' || msg.subtype === 'task_updated' || msg.subtype === 'task_progress' || msg.subtype === 'task_notification') {
    // A spawned kora worker's task surfaces as worker.status; a plain subagent as tool.progress.
    const paneId = msg.pane_id ?? msg.kora_pane_id;
    if (paneId) {
      const status = msg.subtype === 'task_started' ? 'running' : msg.state === 'blocked' ? 'blocked' : msg.state === 'done' ? 'done' : 'running';
      return [{ type: 'worker.status', paneId: String(paneId), status }];
    }
    return [{ type: 'tool.progress', summary: String(msg.summary ?? msg.description ?? 'working…') }];
  }
  return [];
}

function mapStreamEvent(msg: any, turnId: string | undefined): UnsequencedChatEvent[] {
  const ev = msg.event;
  if (!ev) return [];
  if (ev.type === 'content_block_delta') {
    const d = ev.delta;
    const index = num(ev.index) ?? 0;
    if (d?.type === 'text_delta' && d.text) return [{ type: 'content.delta', itemId: blockItemId(turnId, index, 'text'), stream: 'assistant_text', delta: String(d.text), ...(turnId ? { turnId } : {}) }];
    if (d?.type === 'thinking_delta' && d.thinking) return [{ type: 'content.delta', itemId: blockItemId(turnId, index, 'reasoning'), stream: 'reasoning_text', delta: String(d.thinking), ...(turnId ? { turnId } : {}) }];
  }
  return [];
}

function mapAssistant(msg: any, ctx: MapCtx): UnsequencedChatEvent[] {
  const out: UnsequencedChatEvent[] = [];
  const turnId = ctx.turnId;
  const content = msg?.message?.content;
  if (!Array.isArray(content)) return out;
  // Claude Code's own replies ("Not enough messages to compact.", "You've hit your limit · resets 5pm") come as a
  // `<synthetic>` assistant message with no stream events: with partials on, their text was silently dropped.
  const synthetic = msg?.message?.model === '<synthetic>';
  let index = 0;
  for (const block of content) {
    if (block?.type === 'text') {
      if ((ctx.partials === false || synthetic) && block.text) out.push({ type: 'content.delta', itemId: `${msg.message?.id ?? 'a'}:text:${index}`, stream: 'assistant_text', delta: String(block.text), ...(turnId ? { turnId } : {}) });
    } else if (block?.type === 'thinking') {
      if (ctx.partials === false && block.thinking) out.push({ type: 'content.delta', itemId: `${msg.message?.id ?? 'a'}:reasoning:${index}`, stream: 'reasoning_text', delta: String(block.thinking), ...(turnId ? { turnId } : {}) });
    } else if (block?.type === 'tool_use') {
      const name = String(block.name ?? '');
      if (isSpawnTool(name) || (isKoraTool(name) && !isVisibleKoraTool(name))) { index++; continue; } // handled by driver / MCP-handler path
      if (name === 'TodoWrite') { const plan = extractPlanSteps(block.input); if (plan.length) out.push({ type: 'turn.plan', plan, ...(turnId ? { turnId } : {}) }); index++; continue; }
      if (name === 'AskUserQuestion') { out.push({ type: 'user-input.requested', requestId: String(block.id ?? `ask_${index}`), questions: questionsFromAskUserInput(block.input), ...(turnId ? { turnId } : {}) }); index++; continue; }
      out.push({ type: 'tool.started', itemId: String(block.id ?? `${turnId}:tool:${index}`), toolKind: classifyToolKind(name), toolName: name, title: toolTitle(name, block.input), input: block.input, ...(turnId ? { turnId } : {}) });
    }
    index++;
  }
  return out;
}

function mapUser(msg: any): UnsequencedChatEvent[] {
  const out: UnsequencedChatEvent[] = [];
  const content = msg?.message?.content;
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (block?.type !== 'tool_result') continue;
    const name = String(block.tool_name ?? '');
    if (isSpawnTool(name) || (isKoraTool(name) && !isVisibleKoraTool(name))) continue; // suppressed (rendered elsewhere)
    const isError = !!block.is_error;
    const output = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.map((c: any) => c?.text ?? '').join('') : undefined;
    const changedFiles = changedFilesFromToolResult(name, block.tool_input, msg.tool_use_result);
    out.push({
      type: 'tool.result',
      itemId: String(block.tool_use_id ?? ''),
      status: isError ? 'failed' : 'completed',
      ...(output !== undefined ? { output } : {}),
      ...(msg.tool_use_result !== undefined ? { data: msg.tool_use_result } : {}),
      ...(changedFiles ? { changedFiles } : {}),
    });
  }
  return out;
}

function mapResult(msg: any, turnId: string | undefined): UnsequencedChatEvent[] {
  const out: UnsequencedChatEvent[] = [];
  const usage = normalizeTurnUsage(msg.usage);
  const state = isInterruptedResult(msg) ? 'interrupted' : msg.is_error || msg.subtype === 'error_max_turns' || msg.subtype?.startsWith?.('error') ? 'failed' : 'completed';
  out.push({
    type: 'turn.settled',
    turnId: String(turnId ?? msg.uuid ?? 'turn'),
    state,
    ...(msg.stop_reason ? { stopReason: String(msg.stop_reason) } : {}),
    ...(usage ? { usage } : {}),
    ...(msg.is_error && msg.result ? { errorMessage: String(msg.result) } : {}),
  });
  const rl = msg.rate_limit ?? msg.rateLimit ?? msg.usage_limit;
  if (rl) { const d = describeRateLimit(rl); out.push({ type: 'usage.rate-limit', message: d.message, ...(d.window ? { window: d.window } : {}), ...(d.resetsAt !== undefined ? { resetsAt: d.resetsAt } : {}) }); }
  return out;
}

/** `claude-haiku-5-5` -> `Haiku 5.5`, `claude-sonnet-4-5-20250929` -> `Sonnet 4.5`, `opus` -> `Opus`; anything else as given. */
export function friendlyModelName(model: string): string {
  const m = /^(?:claude-)?(opus|sonnet|haiku|fable)(?:-(\d+)(?:-(\d{1,2}))?)?(?:-\d{8})?(\[1m\])?$/i.exec(model.trim());
  if (!m) return model;
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase();
  const version = m[2] ? (m[3] ? `${m[2]}.${m[3]}` : m[2]) : '';
  return [family, version].filter(Boolean).join(' ');
}

function toolTitle(name: string, input: any): string {
  const n = name.replace(/^mcp__[^_]+__/, '');
  if (n === 'Bash' && input?.command) return `$ ${String(input.command).split('\n')[0].slice(0, 80)}`;
  const path = input?.file_path ?? input?.path;
  if (path) return `${n} ${String(path)}`;
  return n;
}

function num(v: unknown): number | undefined { const n = Number(v); return v != null && v !== '' && isFinite(n) ? n : undefined; }

/** Mime types the Anthropic API accepts as an inline `image` content block. */
export const CLAUDE_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** The Messages API rejects an inline image over 5 MB (the composer allows 10 MB): bigger ones go as a path. */
export const CLAUDE_MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * One attachment → one Anthropic content block. `data` is the file's base64 bytes (already read), or
 * `null` when the file wasn't read (an unsupported mime, or a read failure) — either way the agent still
 * gets the attachment as a path it can `Read` itself.
 */
export function claudeAttachmentBlock(a: PromptAttachment, data: string | null): any {
  const mime = a.mimeType ?? '';
  if (data && CLAUDE_IMAGE_MIME_TYPES.has(mime)) return { type: 'image', source: { type: 'base64', media_type: mime, data } };
  if (data && mime === 'application/pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  return { type: 'text', text: `Attached file: ${a.name ?? path.basename(a.path)} at ${a.path}${mime ? ` (${mime})` : ''}` };
}

/** The turn's `content`: the text block first, then one block per attachment (images/PDFs inline, everything
 *  else — or anything too large/unreadable — as a path reference the agent can `Read`). */
export async function buildClaudeTurnContent(text: string, attachments: PromptAttachment[]): Promise<any[]> {
  const blocks: any[] = [{ type: 'text', text }];
  for (const a of attachments) {
    const mime = a.mimeType ?? '';
    let data: string | null = null;
    if (CLAUDE_IMAGE_MIME_TYPES.has(mime) || mime === 'application/pdf') {
      try {
        const bytes = await fsPromises.readFile(a.path);
        data = CLAUDE_IMAGE_MIME_TYPES.has(mime) && bytes.length > CLAUDE_MAX_INLINE_IMAGE_BYTES ? null : bytes.toString('base64');
      } catch { data = null; }
    }
    blocks.push(claudeAttachmentBlock(a, data));
  }
  return blocks;
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE DRIVER (thin SDK wiring around the pure helpers above).
// ═══════════════════════════════════════════════════════════════════════════════

/** Minimal shape of an SDK user message the promptQueue yields. */
type SdkUserMessage = { type: 'user'; message: { role: 'user'; content: any }; parent_tool_use_id: null; session_id?: string };
/** Minimal shape of an SDK Query (the AsyncGenerator + control methods we use). */
export interface SdkQueryLike extends AsyncGenerator<any, void, unknown> {
  interrupt?(): Promise<unknown>;
  /** Ends the SDK process (no further messages). */
  close?(): void;
  setModel?(model?: string): Promise<void>;
  setPermissionMode?(mode: string): Promise<void>;
  applyFlagSettings?(settings: Record<string, unknown>): Promise<void>;
  /** Claude Code's own /context numbers (`detail:'summary'` answers locally, no token-count calls). */
  getContextUsage?(opts?: { detail?: 'summary' | 'full' }): Promise<unknown>;
  /** The /usage data: session cost + claude.ai plan windows. Experimental in the SDK — always optional here. */
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?(opts?: { skipBehaviors?: boolean }): Promise<unknown>;
}
export type QueryFn = (params: { prompt: AsyncIterable<any>; options?: any }) => SdkQueryLike;

interface PendingApproval { resolve: (r: { behavior: 'allow'; updatedInput?: any } | { behavior: 'deny'; message: string }) => void; toolName?: string; toolInput?: Record<string, unknown> }
interface PendingQuestion { resolve: (answers: UserInputAnswers) => void }

interface SessionState {
  /** loopback cache-warm base URL this session was launched with, if any (forgotten on stop) */
  warmBaseUrl?: string | null;
  threadId: ThreadId;
  /** The latest user message text (kora_spawn include_request pastes it into a worker task verbatim). */
  lastUserText?: string;
  /** When the user last sent this thread a message (not a Kora notice); kora_wait returns early on a newer one. */
  lastUserAt?: number;
  /** When the last model-switch cost line was emitted (one switch can reach the hook twice). */
  lastSwitchNoteAt?: number;
  input: SessionStartInput;
  query: SdkQueryLike | null;
  /** the promptQueue tail: resolves the pending pull with the next user message (or done). */
  push: (msg: SdkUserMessage | null) => void;
  currentTurnId: TurnId | null;
  pendingApprovals: Map<RequestId, PendingApproval>;
  pendingUserInput: Map<RequestId, PendingQuestion>;
  pump: Promise<void> | null;
  stopped: boolean;
  /** Resumed from a provider session and no result seen yet (see pump: a resumed session's leftover result). */
  resumedPending?: boolean;
  /** The current turn produced assistant/stream output (a real result can follow). */
  turnHadOutput?: boolean;
  /** The permission posture set after start (setPermissionMode); workers spawned from now on inherit THIS. */
  runtimeMode?: RuntimeMode;
  /** Plan mode (the composer's Plan toggle): the SDK runs in its own `plan` permission mode until a Build turn. */
  planMode?: boolean;
  /** Set for a blob's session (blobContext). */
  blob?: { id: string; role: 'chief' | 'member'; ctx: BlobPolicyContext; lane: BlobLane };
  /** Context-meter bookkeeping: the window of the model in use (from getContextUsage / result.modelUsage), the SDK's
   *  running cost estimate, and the last assistant message whose usage was already reported. */
  contextWindow?: number;
  autoCompactThreshold?: number;
  /** What the session was last told to run (the rewritten "default"), so an unchanged model is not set again. */
  launchModel?: string;
  /** Kora's compaction cap for this session (Settings > Defaults), in tokens; the meter never shows a bigger window. */
  compactWindow?: number;
  costUsd?: number;
  /** Cost of this turn's API calls so far at list price (Kora's table), added to `costUsd` (the SDK's figure as of the
   *  last result) so the live cost moves during a turn; the result's own number replaces it. */
  turnEstUsd?: number;
  /** The last usage the meter showed, replayed with the settled cost when a result lands. */
  lastMeterUsage?: Record<string, unknown>;
  lastUsageMessageId?: string;
  contextRefresh?: Promise<void> | null;
  /** A compaction happened: the next /context read must count afresh (the summary detail reuses the pre-compact usage). */
  compactedSince?: boolean;
  /** The user stopped the turn: tools are refused until the next turn, and a session that keeps going is torn down. */
  halted?: boolean;
  haltTimer?: ReturnType<typeof setTimeout> | null;
  /** The turn that already got its "can't reach Claude, retrying" line (one per turn, not one per retry). */
  retryNoticeTurn?: TurnId | null;
  /** Bounded Read: this thread's window state + hooks (a code thread only). */
  readBounder?: ReadBounder;
  /** Cost telemetry: the API call being assembled (the SDK repeats one message per content block), the cache-miss classifier, tool names by id. */
  pendingCall?: { id: string; usage: CallUsage; toolResults: number; at: number; adv?: AdvisorUsage } | null;
  callTracker?: CallTracker;
  /** The effort a live effort change (setEffort) put the session on; undefined = what it launched with. */
  effort?: string | null;
  /** trackCost: the streaming message in flight and the output count its message_delta reported. */
  streamMessageId?: string;
  streamOut?: { id: string; out: number };
  /** The advisor share of the streaming call (message_delta usage.iterations), by message id. */
  streamAdv?: { id: string; adv: AdvisorUsage };
  /** The Claude session id the SDK reported (it changes when a cold resume continues from a masked copy). */
  providerSessionId?: string;
  /** B8: watches the turn's tool stream for loops (session/runaway.ts). */
  runaway?: RunawayGuard;
  toolNames?: Map<string, string>;
  resultsSinceCall?: number;
  /** What this thread was started with (safe tools, lean context, a no-graph rulebook): session/thread-flags.ts. Absent = not a code thread. */
  flags?: ThreadFlags;
  /** Last time sendTurn asked whether the repo got indexed (B3), so a not-yet-indexed thread does not ask on every message. */
  indexCheckAt?: number;
}

export class ClaudeDriver implements SessionDriver {
  readonly agent: AgentId = 'claude';
  readonly capabilities: DriverCapabilities = {
    modelSwitch: 'in-session',
    promptlessContinuation: true,
    conversationRollback: false, // forkSession is v2 (§8)
    manualCompaction: true,
    canSpawnWorkers: true,
    reportsToolStart: true,
  };

  private sessions = new Map<ThreadId, SessionState>();
  private listeners = new Set<(e: ChatEvent) => void>();
  private seqCounters = new Map<ThreadId, number>();
  /** Yes/no questions a blob's connected-app tools park (outbound actions); answered through `respondToApproval`. */
  private appAsks = new ParkedApprovals();

  /**
   * `deps.swarm` — the runtime's SwarmService slice (SessionManager passes `runtime.swarm` when it has one): the
   * fleet tools' `swarm` alias spawns through it. Carried beside DriverDeps (not in it) so the shared driver seam
   * stays as frozen; only this driver leads a swarm (R10).
   */
  constructor(private deps: DriverDeps & { swarm?: SwarmSpawner }, private queryFn: QueryFn) {}

  streamEvents(onEvent: (e: ChatEvent) => void): () => void {
    this.listeners.add(onEvent);
    return () => this.listeners.delete(onEvent);
  }
  hasSession(threadId: ThreadId): boolean { const s = this.sessions.get(threadId); return !!s && !s.stopped; }

  /** Emit an UnsequencedChatEvent; a placeholder seq (0) is stamped — SessionManager re-stamps the real one. */
  private emit(threadId: ThreadId, ev: UnsequencedChatEvent): void {
    const full = { seq: 0, at: Date.now(), ...ev, threadId } as ChatEvent;
    for (const l of this.listeners) { try { l(full); } catch { /* isolate a bad listener */ } }
  }
  private emitMany(threadId: ThreadId, evs: UnsequencedChatEvent[]): void { for (const e of evs) this.emit(threadId, e); }

  async startSession(input: SessionStartInput): Promise<{ threadId: ThreadId; resume?: unknown }> {
    if (this.sessions.has(input.threadId)) return { threadId: input.threadId, resume: this.sessions.get(input.threadId)!.input.resume };
    // promptQueue: an AsyncGenerator the SDK pulls user turns from. `push` hands the next message to a
    // parked pull, or buffers it. `push(null)` ends the generator (stopSession).
    const buffer: (SdkUserMessage | null)[] = [];
    let waiting: ((v: IteratorResult<SdkUserMessage>) => void) | null = null;
    const push = (msg: SdkUserMessage | null) => {
      if (waiting) { const w = waiting; waiting = null; w(msg === null ? { value: undefined as any, done: true } : { value: msg, done: false }); }
      else buffer.push(msg);
    };
    const promptQueue: AsyncGenerator<SdkUserMessage> = (async function* () {
      while (true) {
        if (buffer.length) { const m = buffer.shift()!; if (m === null) return; yield m; continue; }
        const next = await new Promise<IteratorResult<SdkUserMessage>>((r) => { waiting = r; });
        if (next.done) return;
        yield next.value;
      }
    })();

    const state: SessionState = {
      threadId: input.threadId, input, query: null, push,
      currentTurnId: null, pendingApprovals: new Map(), pendingUserInput: new Map(), pump: null, stopped: false,
      resumedPending: typeof input.resume === 'string',
    };
    this.sessions.set(input.threadId, state);

    // The same preparation an agent pane gets (rulebook block + hooks in the repo, KORA_* env pointing at this
    // daemon, strict MCP, the rulebook system prompt). Bounded: a slow brief must never hold the session start.
    let prep: SessionPrep | null = null;
    if (this.deps.prepareSession) {
      try { prep = await withDeadline(this.deps.prepareSession(input), PREPARE_TIMEOUT_MS); }
      catch (e: any) { log(`chat ${input.threadId}: session prepare failed (starting unprepared)`, e?.message ?? e); }
      if (prep) log(`chat ${input.threadId}: prepared — ${prep.notes.join('; ')}`);
    }

    // B6: a thread coming back after the prompt cache's hour re-writes its whole context at 2x anyway, so continue from a copy
    // with the old tool outputs elided (session/prune.ts). Fails open: any doubt resumes the original.
    // Keep-warm first: trimming yields only to a session the proxy will actually warm.
    state.warmBaseUrl = await this.warmBaseUrlFor(input);
    const trimmed = await this.maskColdResume(input, !!state.warmBaseUrl);
    // Stopped (or the thread deleted) while preparing / masking - up to ~8 s: do not launch a Claude process nobody will use.
    if (state.stopped) { log(`chat ${input.threadId}: stopped while starting; not launching`); return { threadId: input.threadId, resume: input.resume }; }
    if (trimmed) { input = { ...input, resume: trimmed.sessionId }; state.input = input; }
    state.flags = this.threadFlagsFor(input, prep);
    const options = this.buildOptions(input, state, prep);
    if (typeof options.model === 'string') state.launchModel = options.model;
    // The cap Kora put in the session env, known up front so the meter and the sprite popover show the real compaction
    // point from the first message (Claude Code reports it itself after the first usage refresh).
    const cap = claudeCompactWindow(options.model);
    if (cap) {
      const own = knownClaudeContextWindow(options.model);
      const win = own ? Math.min(own, cap) : cap;
      state.compactWindow = cap; state.contextWindow = win; state.autoCompactThreshold = win - COMPACT_HEADROOM_TOKENS;
    }
    let q: SdkQueryLike;
    try { q = this.queryFn({ prompt: promptQueue, options }); }
    catch (e: any) { this.emit(input.threadId, { type: 'runtime.error', errorClass: 'provider', message: `failed to start Claude: ${e?.message ?? e}` }); this.sessions.delete(input.threadId); throw e; }
    state.query = q;
    this.emit(input.threadId, { type: 'session.state', state: 'starting' });
    if (trimmed) {
      this.emit(input.threadId, { type: 'context.trimmed', stubbed: trimmed.stubbed, tokensSaved: trimmed.tokensSaved, contextBefore: trimmed.contextBefore });
      logCost({ k: 'prune', ts: Date.now(), thread: input.threadId, stubbed: trimmed.stubbed, saved: trimmed.tokensSaved, ctx: trimmed.contextBefore });
    }
    state.pump = this.pump(state)
      .then(() => this.onSessionEnded(state, null))
      .catch((e) => this.onSessionEnded(state, e));
    // The meter from the first moment: system prompt + tools (+ a resumed conversation) before any turn.
    this.refreshContextUsage(state, null);
    return { threadId: input.threadId, resume: input.resume };
  }

  /** B6: the masked-copy decision for a resumed code thread (null = resume the original). Never throws; bounded to 8 s. */
  private async maskColdResume(input: SessionStartInput, warmed: boolean): Promise<Extract<ColdResume, { masked: true }> | null> {
    if (typeof input.resume !== 'string' || isBlobsCwd(input.cwd) || !lifecycleOn('coldResumeMasking')) return null;
    // Warmed through the proxy: a gap inside the warm chain (pings until the policy's 2 h horizon, so the entry lives to ~3 h) may
    // still hit the cache it kept alive, and a masked copy is a new prefix that would throw that away (one full re-write). Past
    // the chain the cache is certainly cold, so masking applies as usual. Mode on without a warm URL warms nothing: trim from 61 min.
    // A model switch Auto made (coldCache): the new model has no cache of this thread at any idle time.
    const coldAfterMs = input.coldCache ? 0 : warmed ? WARMED_COLD_AFTER_MS : undefined;
    try {
      const configDir = (this.deps.spawnEnv(input.threadId, input.account) as Record<string, string | undefined>).CLAUDE_CONFIG_DIR;
      const r = await prepareColdResume({ sessionId: input.resume, cwd: input.cwd, configDir: configDir ?? null, timeoutMs: 8000, ...(coldAfterMs !== undefined ? { coldAfterMs } : {}) });
      if (!r.masked) { if (r.reason !== 'cache still warm') log(`chat ${input.threadId}: cold-resume masking skipped (${r.reason})`); return null; }
      log(`chat ${input.threadId}: cold resume - ${r.stubbed} old tool outputs elided (~${r.tokensSaved} of ~${r.contextBefore} tokens), resuming ${r.sessionId} (original ${r.originalId})`);
      return r;
    } catch { return null; }
  }

  /** The pump ended (the SDK process exited) or threw. Clean up so the NEXT turn auto-restarts a fresh
   *  session (SessionManager.ensureLive resumes from the provider session id). A process exit / SIGTERM
   *  (code 143) after a turn is normal teardown, not a hard error — surface it as a recoverable
   *  session.exited, never a scary runtime.error banner. */
  private onSessionEnded(state: SessionState, err: unknown): void {
    if (state.stopped) return; // a deliberate stopSession already handled teardown
    state.stopped = true;
    if (state.warmBaseUrl) cacheWarm().forget(state.threadId);
    this.sessions.delete(state.threadId);
    const msg = err ? ((err as any)?.message ?? String(err)) : '';
    const looksLikeExit = !err || /exited with code|SIGTERM|SIGKILL|process exited|interrupt|abort|closed|EPIPE/i.test(msg);
    const midTurn = state.currentTurnId;
    log(`chat ${state.threadId}: claude session ended${midTurn ? ` MID-TURN (${midTurn})` : ''}: ${msg || 'the process exited'}`);
    if (midTurn) {
      // The child died with the reply half written (killed, crashed, out of memory): the half reply looked finished,
      // with nothing logged (pl10 S3-3). Say it stopped, on the turn, before settling it as interrupted.
      this.emit(state.threadId, { type: 'runtime.error', errorClass: 'provider', turnId: midTurn, message: `The agent stopped before finishing${msg ? ` (${msg})` : ''}. Send again to continue.` });
      this.emit(state.threadId, { type: 'turn.settled', turnId: midTurn, state: 'interrupted' });
      state.currentTurnId = null;
    } else if (!looksLikeExit) {
      this.emit(state.threadId, { type: 'runtime.error', errorClass: 'provider', message: msg });
    }
    this.emit(state.threadId, { type: 'session.exited', recoverable: true, ...(msg ? { reason: msg } : {}) });
  }

  /**
   * What a code thread is started with, decided ONCE and remembered. A new thread gets the safe tool subset and, if the user
   * turned it on, Lean context; a resumed one keeps exactly what it began with (its prompt cache is keyed on the tool list
   * and skills listing, so a live thread's never changes), and a thread from before these levers existed stays as it was.
   * A thread that began in an unindexed repo is marked: its (resume-frozen) system prompt says "no code graph".
   */
  private threadFlagsFor(input: SessionStartInput, prep: SessionPrep | null): ThreadFlags | undefined {
    if (isBlobsCwd(input.cwd)) { updateThreadFlags(input.threadId, { noKoraPrompt: true }); return undefined; } // so the savings ledger charges it no Kora prompt overhead
    try {
      if (typeof input.resume === 'string') return readThreadFlags(input.threadId);
      const flags: ThreadFlags = { safeTools: true, ...(leanContextOn() ? { lean: true } : {}), ...(prep?.appendSystemPrompt && /not indexed yet/.test(prep.appendSystemPrompt) ? { noGraphRulebook: true } : {}) };
      updateThreadFlags(input.threadId, flags);
      return flags;
    } catch { return undefined; }
  }

  /** The blob this session belongs to, with its policy context (null for every non-blob thread). */
  private blobContext(input: SessionStartInput): { id: string; role: 'chief' | 'member'; ctx: BlobPolicyContext; lane: BlobLane } | null {
    if (!this.deps.blobs) return null;
    let b: ReturnType<NonNullable<DriverDeps['blobs']>['byCwd']> = null;
    try { b = this.deps.blobs.byCwd(input.cwd); } catch { b = null; }
    if (!b) return null;
    const sk = this.deps.blobs.skills(b.id);
    const att = path.join((require('../../protocol/types') as typeof import('../../protocol/types')).koraHome(), 'attachments');
    const ctx: BlobPolicyContext = {
      workspace: b.workspace, blobHome: blobHome(b.id), extraDirs: [att, sk.dir],
      readDirs: () => { try { return this.deps.blobs?.readableDirs?.(b!.id) ?? []; } catch { return []; } },
      alwaysAllowed: (toolName, toolInput) => { try { return this.deps.blobs?.alwaysAllowed?.(b!.id, toolName, toolInput) === true; } catch { return false; } },
    };
    return { id: b.id, role: b.role, ctx, lane: { pluginDir: sk.dir, skills: sk.qualified, blobHome: blobHome(b.id), policyHooks: {} } };
  }

  /** Cache keep-warm: the loopback URL this CODE session talks through, or null (mode off, blob/assistant lane, own gateway, proxy unhealthy). Never throws. */
  private async warmBaseUrlFor(input: SessionStartInput): Promise<string | null> {
    try {
      if (isBlobsCwd(input.cwd) || cacheWarmMode() === 'off') return null;
      if (settingsGatewayReason(input.cwd)) return null;
      return await cacheWarm().baseUrl(input.threadId);
    } catch { return null; }
  }

  private buildOptions(input: SessionStartInput, state: SessionState, prep: SessionPrep | null = null): any {
    const blob = this.blobContext(input);
    if (blob) {
      state.blob = blob;
      blob.ctx.mode = () => state.runtimeMode ?? input.runtimeMode;
      blob.lane.policyHooks = blobPreToolUseHooks(blob.ctx, () => (state.runtimeMode ?? input.runtimeMode) === 'full-access', () => state.halted === true);
    }
    // Bounded Read lives on code threads only: the assistant lane has no repo and no graph.
    if (!blob && !isBlobsCwd(input.cwd)) {
      state.readBounder = createReadBounder({
        cwd: input.cwd, threadId: input.threadId,
        ...(this.deps.graphStatus ? { graphStatus: (c: string) => this.deps.graphStatus!(c) } : {}),
        graphCall: (n, a, o) => this.deps.graphCall(n, a, o),
        sensitive: (tool, toolInput, cwd) => (sensitiveOverride() ? false : sensitiveVerdict(tool, toolInput, cwd).sensitive),
      });
    }
    state.callTracker = new CallTracker(typeof input.resume === 'string');
    state.runaway = new RunawayGuard();
    return buildSessionOptions(input, prep, this.deps.appendSystemPrompt(input), this.deps.spawnEnv(input.threadId, input.account), {
      mcpServers: this.buildMcpServers(input, state),
      ...(state.readBounder ? { readHooks: state.readBounder.hooks() } : {}),
      ...(isBlobsCwd(input.cwd) ? {} : { lifecycleHooks: this.lifecycleHooks(state) }),
      ...(state.warmBaseUrl ? { warmBaseUrl: state.warmBaseUrl } : {}),
      ...(state.flags?.safeTools ? { safeTools: true } : {}),
      ...(state.flags?.lean ? { lean: true } : {}),
      canUseTool: this.makeCanUseTool(state, input),
      trusted: this.folderTrusted(input),
      runtimeMode: () => state.runtimeMode ?? input.runtimeMode,
      ...(blob ? { blob: blob.lane } : {}),
      ...(this.deps.fleet?.drainNotes ? { drainNotes: () => this.deps.fleet!.drainNotes!(proxyPaneId(state.threadId)) } : {}),
    });
  }

  /**
   * B7: the SDK asks (PreModelSwitch) before it moves a live session to another model. The switch always goes ahead (an explicit
   * allow: never a silent block), but a warm cache is forfeited, so the thread says what it cost and Diagnostics tells the same story.
   */
  private lifecycleHooks(state: SessionState): Record<string, unknown> {
    const hook = async (input: any) => {
      try {
        if (lifecycleOn('modelSwitchChip') && input?.hook_event_name === 'PreModelSwitch') {
          log(`chat ${state.threadId}: PreModelSwitch ${String(input.from_model)} -> ${String(input.to_model)} (${String(input.source)}, ${Number(input.context_tokens) || 0} tokens, warm=${String(input.prompt_cache_warm)})`);
          // One switch can reach this hook twice within the same moment (seen live 2026-10-14: two lines 2 ms apart for one picker
          // change); the thread says it once.
          const nowMs = Date.now();
          if (state.lastSwitchNoteAt && nowMs - state.lastSwitchNoteAt < 3000) return { hookSpecificOutput: { hookEventName: 'PreModelSwitch', permissionDecision: 'allow' } };
          state.lastSwitchNoteAt = nowMs;
          const tokens = Number(input.context_tokens) || 0;
          const warm = input.prompt_cache_warm === true;
          const to = String(input.to_model ?? '');
          const write = input.cache_ttl === '5m' ? 1.25 : 2;
          const read = /(opus|sonnet)-5-5/.test(to) ? 0.05 : 0.1;
          const usd = typeof input.estimated_cache_write_usd === 'number' && Number.isFinite(input.estimated_cache_write_usd) ? input.estimated_cache_write_usd : null;
          this.emit(state.threadId, { type: 'model.switch-cost', from: String(input.from_model ?? ''), to, contextTokens: tokens, cacheWarm: warm, usd, turns: write / read });
        }
      } catch { /* advisory */ }
      return { hookSpecificOutput: { hookEventName: 'PreModelSwitch', permissionDecision: 'allow' } };
    };
    // B16: PostToolUse on Bash. Shadow by default (logs what a trim would save); "On" trims big output and spills the full text.
    const trim = createBashTrimHooks({ threadId: state.threadId, wrap: () => this.trimWrapSpec(state) });
    // SAV-D: Read dedupe for this lane (settings `chatReadDedupe`, shadow by default); the log lives in the hooks' closure.
    return mergeHookMaps(mergeHookMaps({ PreModelSwitch: [{ hooks: [hook] }] }, trim), createReadDedupeHooks({ threadId: state.threadId, cwd: state.input.cwd }));
  }

  /**
   * `kora trim-run` for a failing build / test (bash-trim.ts): only in Full access, where a rewritten command raises no approval card,
   * and only where the CLI to run exists. Null = leave the command alone.
   */
  private trimWrapSpec(state: SessionState): WrapSpec | null {
    try {
      if (process.platform === 'win32' || state.blob || (state.runtimeMode ?? state.input.runtimeMode) !== 'full-access') return null;
      // This runtime's own bin/kora.js, never the KORA_BIN env override (another checkout's kora.js may predate `trim-run`).
      const { KORA_ROOT, NODE_BIN } = require('../../graph/embedded') as typeof import('../../graph/embedded');
      const kora = path.join(KORA_ROOT, 'bin', 'kora.js');
      if (!fsSync.existsSync(kora) || !fsSync.existsSync(NODE_BIN)) return null;
      return { node: NODE_BIN, kora, home: (require('../../protocol/types') as typeof import('../../protocol/types')).koraHome(), thread: state.threadId };
    } catch { return null; }
  }

  /** Folder trust for this session's cwd (Kora's own assistant-lane folders always count as trusted). */
  private folderTrusted(input: SessionStartInput): boolean {
    let trusted = false;
    try { trusted = isBlobsCwd(input.cwd) || (this.deps.isFolderTrusted ? this.deps.isFolderTrusted(input.cwd) : isFolderTrusted(input.cwd)); }
    catch { trusted = false; }
    if (!trusted) log(`chat ${input.threadId}: ${input.cwd} is not a trusted folder — restricted mode (the repo's .claude hooks, project MCP servers and plugins are not loaded)`);
    return trusted;
  }

  /** Build the in-process `kora` MCP server: koragraph tools (+ kora_spawn for orchestrators). */
  private buildMcpServers(input: SessionStartInput, state: SessionState): Record<string, unknown> {
    let sdk: any;
    try { sdk = require('@anthropic-ai/claude-agent-sdk'); } catch { return {}; }
    const { tool, createSdkMcpServer } = sdk;
    let zod: any;
    try { zod = require('zod'); } catch { return {}; }
    const z = zod.z ?? zod;

    // Explicit per-tool shapes. `z.record(z.any())` (the old shape) cannot be converted to JSON schema by the
    // SDK's MCP layer — listTools then throws and the WHOLE server's tools vanish, fleet tools included, with
    // no error surfaced (the model just says "not available"). Mirrors the CLI arg mapping in cli/commands/graph.ts.
    const graphShapes: Record<string, [string, Record<string, any>]> = {
      explore: ['koragraph explore: where a symbol or plain-English behaviour lives — ranked declarations + callers/callees + source excerpt', { query: z.string().describe('symbol name or plain-English phrase'), detail: z.enum(['brief', 'full']).optional() }],
      search_code: ['koragraph search_code: locate a declaration by name (file:line only)', { query: z.string() }],
      neighbours: ['koragraph neighbours: exact callers/callees of one symbol', { symbol: z.string(), file: z.string().optional(), direction: z.enum(['in', 'out', 'both']).optional(), depth: z.number().optional() }],
      changes_with: ['koragraph changes_with: files/symbols that historically change together with this one', { symbol: z.string(), file: z.string().optional() }],
      blast_radius: ['koragraph blast_radius: what depends on these files / this symbol (run before editing)', { files_changed: z.array(z.string()).optional(), symbol: z.string().optional(), depth: z.number().optional(), task_type: z.string().optional() }],
      file_symbols: ['koragraph file_symbols: every declaration in one file', { path: z.string() }],
      overview: ['koragraph overview: orient in the repo', { repo: z.string().optional() }],
    };
    // Graph tools over MCP are OFF by default (KORA_MCP=1 re-enables): the chat lane drives the
    // graph through per-prompt injection + the `kora graph` CLI, and across two weeks of sessions
    // the model never called these — their schemas were pure context overhead. The in-process
    // server now exists only to carry an orchestrator's fleet tools.
    // The assistant lane never gets graph tools over MCP: no graph anywhere on Chat (no repo to index).
    const graphViaMcp: boolean = isBlobsCwd(input.cwd) ? false : (() => { try { return require('../../enforce/mcpconfig').mcpEnabledFor('claude'); } catch { return false; } })();
    const tools: any[] = !graphViaMcp ? [] : Object.entries(graphShapes).map(([name, [desc, shape]]) =>
      tool(name, desc, shape, async (a: any) => {
        const args: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(a ?? {})) if (v !== undefined) args[k] = v;
        let result: { text: string; data: unknown; ms: number };
        try { result = await this.deps.graphCall(name, args, { cwd: input.cwd, fresh: false }); }
        catch (e: any) { return { content: [{ type: 'text', text: `graph ${name} failed: ${e?.message ?? e}` }], isError: true }; }
        // Intercept → graph.* (or a plain card for small results). The model still gets the text.
        const itemId: ItemId = `graph_${state.threadId}_${++graphSeq}`;
        try { this.emitMany(state.threadId, withTurn(graphToolEvents(name, args, result, itemId), state.currentTurnId)); } catch { /* advisory (D19) */ }
        return { content: [{ type: 'text', text: result.text }] };
      }),
    );
    let graphSeq = 0;

    if (input.isOrchestrator && !input.helpersOff) tools.push(...this.fleetTools(input, state, tool, z));
    if (state.blob && this.deps.blobs) tools.push(...this.blobTools(input, state, tool, z));
    // The user's extensions (Settings › Extensions), in the SDK's own server shape; Kora's `kora` server keeps its name.
    const extensions = claudeExtensionServers(input, () => this.deps.isFolderTrusted ? this.deps.isFolderTrusted(input.cwd) : isFolderTrusted(input.cwd));
    if (tools.length === 0) return extensions;
    // Orchestrators need their fleet tools in the very first prompt: server-level alwaysLoad both exempts them from
    // tool-search deferral AND makes the SDK wait for the server before building turn 1 (per-tool alwaysLoad alone
    // left turn 1 without any kora tools — the model then reported them "not available").
    return { ...extensions, kora: createSdkMcpServer({ name: 'kora', version: '1.0.0', tools, ...(input.isOrchestrator ? { alwaysLoad: true } : {}) }) };
  }

  /**
   * The orchestrator's fleet toolset as in-process SDK MCP tools. The tools themselves live in
   * session/fleet-tools.ts (shared with `kora mcp --fleet`, the stdio bridge a Codex orchestrator uses); this
   * only binds them to the SDK's `tool()` and to this thread's transcript rows.
   */
  private fleetTools(input: SessionStartInput, state: SessionState, tool: any, z: any): any[] {
    const orchestratorId = proxyPaneId(state.threadId);
    const specs = fleetToolSpecs({
      fleet: this.deps.fleet ? fleetControlFrom(this.deps.fleet) : undefined,
      orchestratorId,
      agent: input.agent, cwd: input.cwd, account: input.account,
      ...(input.model ? { model: input.model } : {}),
      // Read at spawn time: a worker gets the posture the composer shows NOW, not the one the session started with
      // (flipping Full access → Supervised mid-session used to keep launching workers with skip-permissions).
      get runtimeMode() { return state.runtimeMode ?? input.runtimeMode; },
      ...(input.agentMode ? { agentMode: input.agentMode } : {}),
      // Swarm workers only for a Claude leader in swarm mode (R10); SwarmService.spawn re-checks the persisted mode.
      ...(input.agentMode === 'swarm' && input.agent === 'claude' && this.deps.swarm ? { swarm: this.deps.swarm } : {}),
      spawnWorker: (p) => this.deps.spawnWorker(p),
      lastUserRequest: () => state.lastUserText ?? null,
      ...(state.blob ? { blobThread: { maxWorkers: 2, ...(this.deps.blobs?.scrubBrief ? { scrubBrief: (task: string) => this.deps.blobs!.scrubBrief!(state.blob!.id, task) } : {}) } } : {}),
      userMessageSince: (since: number) => (state.lastUserAt ?? 0) > since,
      ...(this.deps.askWorkers ? { askWorkers: (picks: import('../worker-picker').WorkerPick[]) => this.deps.askWorkers!(state.threadId, picks) } : {}),
      // kora_locate is a CODE-graph lookup; the assistant lane has no graph, so it never gets that tool.
      ...(isBlobsCwd(input.cwd) ? {} : { locate: (queries: string[]) => (require('../../server/swarm-context') as typeof import('../../server/swarm-context')).locate({ cwd: input.cwd, queries, graphCall: this.deps.graphCall }) }),
      ...(isBlobsCwd(input.cwd) ? {} : { planCheck: (slices: import('../../server/swarm-context').PlanSlice[]) => (require('../../server/swarm-context') as typeof import('../../server/swarm-context')).planCheck({ cwd: input.cwd, slices, graphCall: this.deps.graphCall }) }),
      onSpawned: (w) => this.emit(state.threadId, { type: 'worker.attached', paneId: w.id, workerAgent: w.agent, account: w.account, title: w.title, role: 'worker', ...(state.currentTurnId ? { turnId: state.currentTurnId } : {}) }),
      onKilled: (paneId) => this.emit(state.threadId, { type: 'worker.detached', paneId, reason: 'killed by orchestrator' }),
    });
    // Deferred MCP tools are invisible to the model until it searches for them; the fleet must not be.
    return specs.map((spec) => tool(spec.name, spec.description, toZodShape(spec.params, z), async (a: any) => {
      const r = await spec.handler(a ?? {});
      return { content: [{ type: 'text', text: r.text }], ...(r.isError ? { isError: true } : {}) };
    }, { alwaysLoad: true, searchHint: 'kora fleet: spawn, steer, wait, read, kill, merge workers; plan' }));
  }

  /** A blob's own tools (recall, remember, forget, edit_soul, set_model, attach_output) as in-process SDK tools. */
  private blobTools(input: SessionStartInput, state: SessionState, tool: any, z: any): any[] {
    const blob = state.blob!;
    const specs = this.deps.blobs!.toolSpecs({
      blobId: blob.id, threadId: state.threadId, agent: input.agent, cwd: input.cwd,
      emitCard: (card) => this.emit(state.threadId, { type: 'blob.card', card, ...(state.currentTurnId ? { turnId: state.currentTurnId } : {}) }),
      fullAccess: () => (state.runtimeMode ?? input.runtimeMode) === 'full-access',
      userMessageSince: (since: number) => (state.lastUserAt ?? 0) > since,
      askApproval: askVia(this.appAsks, state.threadId, (ev) => this.emit(state.threadId, ev as UnsequencedChatEvent), () => (state.currentTurnId ? { turnId: state.currentTurnId } : {})),
      // A finished file becomes a file-change card (the transcript lists changed files as output cards).
      attachOutput: (p, caption) => {
        const itemId: ItemId = `attach_${state.threadId}_${Date.now().toString(36)}`;
        const turn = state.currentTurnId ? { turnId: state.currentTurnId } : {};
        this.emit(state.threadId, { type: 'tool.started', itemId, toolKind: 'file_change', toolName: 'attach_output', title: caption ? `${caption} - ${path.basename(p)}` : `attach ${path.basename(p)}`, input: { file_path: p }, ...turn });
        this.emit(state.threadId, { type: 'tool.result', itemId, status: 'completed', changedFiles: [{ path: p, additions: 0, deletions: 0 }], ...turn });
      },
    });
    return specs.map((spec) => tool(spec.name, spec.description, toZodShape(spec.params, z), async (a: any) => {
      const r = await spec.handler(a ?? {});
      return sdkToolResult(r);
    }, { alwaysLoad: true, searchHint: 'blob tools: recall, remember, forget, edit_soul, set_model, attach_output, and for Kora list_team, plan_job, delegate_to, wait_for, accept_step, propose_blob, edit_blob, hire_template' }));
  }

  private makeCanUseTool(state: SessionState, input?: SessionStartInput) {
    let approvalSeq = 0;
    // Request ids must be unique for the THREAD's whole life, not this session's: the client treats a resolved id as
    // final forever (client-runtime pendingRequests), and every restart used to begin again at `_1` — so the first
    // approvals of a resumed session reused ids resolved earlier and never showed, hanging the turn on an invisible prompt.
    const sessionTag = `${Date.now().toString(36)}${(++approvalSessionSeq).toString(36)}`;
    const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
    // An ORCHESTRATOR reads its own workers' worktrees all the time (checking a slice before merging). Those live
    // under ~/.kora/worktrees, outside the thread's cwd, so every such Read raised an approval that only a
    // human in the app can answer — a fleet in auto-accept-edits mode stalled for 12 minutes on "Allow Read?".
    // Read-only tools inside a worktree this orchestrator spawned are its own work: allow them.
    const inOwnWorktree = (toolInput: Record<string, unknown>): boolean => {
      if (!input?.isOrchestrator || !this.deps.fleet) return false;
      const target = String(toolInput.file_path ?? toolInput.path ?? toolInput.notebook_path ?? '');
      if (!path.isAbsolute(target)) return false;
      try {
        return this.deps.fleet.list(proxyPaneId(state.threadId)).some((w) => w.worktree && isUnderDir(target, w.worktree.path));
      } catch { return false; }
    };
    return async (toolName: string, toolInput: Record<string, unknown>, opts: { suggestions?: unknown[]; title?: string; blockedPath?: string; toolUseID?: string; signal?: AbortSignal }) => {
      // kora MCP tools and spawn are always allowed (they are our own, rendered via other lanes).
      // A stopped turn runs no more tools (a cancelled job step must not write one more file while the SDK winds down).
      if (state.halted) return { behavior: 'deny' as const, message: 'The turn was stopped by the user.', interrupt: true };
      if (isKoraTool(toolName)) return { behavior: 'allow' as const };
      // Keys and credentials: the PreToolUse guard said "ask", and nothing below may turn that into a silent allow — not
      // a blob's Auto, not its "Always for this blob", not an orchestrator's own-worktree read (pl6 S1-1).
      let sensitive = false;
      if (!sensitiveOverride()) { try { sensitive = sensitiveVerdict(toolName, toolInput ?? {}, input?.cwd ?? process.cwd()).sensitive; } catch { sensitive = true; } }
      if (!sensitive && READ_ONLY.has(toolName) && inOwnWorktree(toolInput ?? {})) return { behavior: 'allow' as const };
      // AskUserQuestion is a QUESTION, not a permission: the SDK still routes it through
      // canUseTool, but mapAssistant already emits it as user-input.requested and
      // respondToUserInput answers it. Gating it too would put an "Allow AskUserQuestion?"
      // approval in front of every question (and strand the turn if nothing answers it).
      //
      // It must WAIT for the answer (SDK contract: the callback stays pending, then returns
      // updatedInput {questions, answers} keyed by question text). Returning allow at once made the SDK answer
      // "The user did not answer the questions" 1 s later; the real answer then arrived as a fresh message outside
      // any turn and the chat looked finished while Claude kept going (found live, swarm e2e).
      if (toolName === 'AskUserQuestion') {
        const requestId = String(opts?.toolUseID ?? '');
        if (!requestId) return { behavior: 'allow' as const, updatedInput: toolInput };
        const answers = await new Promise<UserInputAnswers | null>((resolve) => {
          state.pendingUserInput.set(requestId, { resolve: (a) => resolve(a) });
          opts?.signal?.addEventListener('abort', () => { state.pendingUserInput.delete(requestId); resolve(null); }, { once: true });
        });
        if (!answers) return { behavior: 'deny' as const, message: 'The question was cancelled (the turn was interrupted).' };
        return { behavior: 'allow' as const, updatedInput: { ...toolInput, answers: answersByQuestionText(toolInput, answers) } };
      }
      // Plan mode's hand-off: the plan becomes the thread's plan card (Implement / Implement in a new thread), and the
      // turn ends there. Allowing it would leave plan mode and start building before the user has read the plan.
      if (toolName === 'ExitPlanMode') {
        const markdown = String(toolInput?.plan ?? '').trim();
        if (markdown) this.emit(state.threadId, { type: 'plan.proposed', markdown, ...(state.currentTurnId ? { turnId: state.currentTurnId } : {}) });
        return { behavior: 'deny' as const, message: 'Kora showed this plan to the user with buttons to implement it. Stop here and wait for their reply; do not start implementing.' };
      }
      // Plan mode is for planning with the graph: a plain `kora graph …` query never needs a card.
      if (state.planMode && !sensitive && toolName === 'Bash' && isGraphQueryCommand(String(toolInput?.command ?? ''))) return { behavior: 'allow' as const, updatedInput: toolInput };
      // A blob on Auto / Auto-accept: its own folders are free, the SDK's `default` fallback models (which never reach
      // auto mode) get the same answer here; anything the policy flags (outside the folders, outbound shell) is asked.
      if (state.blob && !sensitive) {
        const mode = state.runtimeMode ?? input?.runtimeMode;
        if ((mode === 'auto' || mode === 'auto-accept-edits') && blobPolicy(toolName, toolInput ?? {}, state.blob.ctx).decision === 'allow') return { behavior: 'allow' as const, updatedInput: toolInput };
      }
      // A blob's standing "Always for this blob": answered before any card is raised.
      if (state.blob && !sensitive && this.deps.blobs?.alwaysAllowed?.(state.blob.id, toolName, toolInput ?? {})) return { behavior: 'allow' as const, updatedInput: toolInput };
      const requestId: RequestId = `appr_${state.threadId}_${sessionTag}_${++approvalSeq}`;
      // A blob's card offers Allow once / Always for this blob (when a narrow, safe rule exists) / Deny.
      const always = state.blob && !sensitive ? this.deps.blobs?.approvalRuleFor?.(toolName, toolInput ?? {}) ?? null : null;
      // A link into ~/.ssh reads as a harmless name on the card: show where it really goes (plv S3-6).
      let linkTarget: string | null = null;
      if (sensitive) { try { linkTarget = sensitiveLinkTarget(toolName, toolInput ?? {}, input?.cwd ?? process.cwd()); } catch { /* the card still asks */ } }
      this.emit(state.threadId, {
        type: 'approval.opened', requestId, requestKind: classifyApprovalKind(toolName), toolName,
        title: opts.title ?? `Allow ${toolName}?`, detail: opts.blockedPath ?? undefined, args: toolInput,
        options: state.blob
          ? [
              { decision: 'accept', label: 'Allow once' },
              ...(always ? [{ decision: 'acceptAlways' as const, label: 'Always for this blob' }] : []),
              { decision: 'decline', label: 'Deny' },
            ]
          : [
              { decision: 'accept', label: 'Allow' },
              ...(sensitive ? [] : [{ decision: 'acceptForSession' as const, label: 'Allow for session' }]),
              { decision: 'decline', label: 'Deny' },
            ],
        ...(always ? { alwaysLabel: always.label } : {}),
        ...(linkTarget ? { linkTarget } : {}),
        ...(state.currentTurnId ? { turnId: state.currentTurnId } : {}),
      });
      return new Promise<{ behavior: 'allow'; updatedInput?: any } | { behavior: 'deny'; message: string }>((resolve) => {
        state.pendingApprovals.set(requestId, { resolve, toolName, toolInput: toolInput ?? {} });
      });
    };
  }

  /** The per-session message pump: drains the SDK Query and fans normalized events out. */
  private async pump(state: SessionState): Promise<void> {
    const q = state.query!;
    for await (const msg of q) {
      if (typeof (msg as any)?.session_id === 'string' && (msg as any).session_id) state.providerSessionId = (msg as any).session_id;
      if (state.stopped) break;
      if ((msg as any)?.type === 'system' && (msg as any)?.subtype === 'init') {
        const m = msg as any; const nh = (m.tools ?? []).filter((n: string) => /kora/.test(n));
        log(`chat ${state.threadId}: sdk init — ${(m.tools ?? []).length} tools (${nh.length} kora${nh.length ? ': ' + nh.join(',') : ''}); mcp=${JSON.stringify((m.mcp_servers ?? []).map((s: any) => `${s.name}:${s.status}`))}`);
      }
      if ((msg as any)?.type === 'system' && (msg as any)?.subtype === 'api_retry') {
        // Claude Code retries a failed request by itself (no network, overloaded, 5xx). Say so ONCE per turn — the
        // user saw a silent spinner for minutes otherwise; every attempt still goes to the log.
        const m = msg as any;
        log(`chat ${state.threadId}: api retry ${m.attempt}/${m.max_retries} in ${m.retry_delay_ms} ms (${m.error_status ?? 'no response'}${m.error ? ` ${m.error}` : ''})`);
        if (state.currentTurnId && state.retryNoticeTurn !== state.currentTurnId) {
          state.retryNoticeTurn = state.currentTurnId;
          this.emit(state.threadId, { type: 'runtime.warning', message: describeApiRetry(m), turnId: state.currentTurnId });
        }
        continue;
      }
      if (msg.type === 'assistant' || msg.type === 'stream_event') {
        // Output with no open turn (a continuation after an interrupt, a late answer folded in as a message): open
        // one, so the UI shows the agent working until its result settles it — never "done" while it still streams.
        const ev = (msg as any)?.event?.type;
        const content = msg.type === 'assistant' || ev === 'message_start' || ev === 'content_block_start' || ev === 'content_block_delta';
        // The user stopped this turn and the agent is still producing output: the interrupt did not take. End the process.
        if (content && state.halted && !state.currentTurnId && !state.stopped) { this.hardStop(state, 'kept working after it was stopped'); break; }
        if (content && !state.currentTurnId && !state.stopped) {
          const turnId: TurnId = newTurnId();
          state.currentTurnId = turnId;
          this.emit(state.threadId, { type: 'turn.started', turnId });
          this.emit(state.threadId, { type: 'session.state', state: 'running' });
        }
        state.turnHadOutput = true;
      }
      // A result with no open turn belongs to a turn we already settled (interrupt): drop it rather than emit a
      // second settle under a stray id.
      if (msg.type === 'result' && state.halted) this.clearHalt(state);
      if (msg.type === 'result' && !state.currentTurnId) { state.resumedPending = false; continue; }
      // A RESUMED session first replays a result for whatever the old process left running (found live, e2e: a mode
      // flip mid-turn restarted the session while a background `sleep` ran; the resumed SDK emitted "background shell
      // didn't finish" + a zero-usage success result, which settled the NEW turn before its prompt was processed, and
      // the reply arrived outside any turn). Skip exactly that one: first result after resume, no output yet, no error,
      // no tokens. Anything else settles the turn as before.
      if (msg.type === 'result' && state.resumedPending) {
        state.resumedPending = false;
        const m = msg as any; const u = m.usage ?? {};
        const zero = !((u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0));
        if (!state.turnHadOutput && !m.is_error && zero) { log(`chat ${state.threadId}: skipped a resumed session's leftover result`); continue; }
      }
      let evs = mapSdkMessage(msg, { turnId: state.currentTurnId ?? undefined, partials: true });
      this.trackUsage(state, msg);
      try { this.trackCost(state, msg); evs = this.markBounded(state, evs); } catch { /* telemetry is advisory */ }
      try { this.trackStuck(state, msg); } catch { /* advisory */ }
      // Deictic carry-over ("that file", "the same helper"): the files this thread read or changed feed the recall memory, as on Codex / agy.
      if (!state.blob && !isBlobsCwd(state.input.cwd)) { try { noteTouchedFromEvents(state.threadId, state.input.cwd, evs); } catch { /* recall memory is best effort */ } }
      const settledTurn = msg.type === 'result' ? state.currentTurnId : null;
      this.emitMany(state.threadId, withTurn(evs, state.currentTurnId));
      if (msg.type === 'result') { state.currentTurnId = null; state.turnHadOutput = false; state.resumedPending = false; }
      // After a turn (and after a /compact), ask Claude Code itself how full the context is now.
      if (msg.type === 'result') this.refreshContextUsage(state, settledTurn);
    }
  }

  /**
   * The context meter + plan-usage feed, from the SDK's own records:
   *  - each top-level assistant message → an ESTIMATE of the context (every input token incl. cache reads + output),
   *    once per API message (the SDK repeats one message per content block);
   *  - a result → the model's context window (modelUsage) and the session's running cost estimate;
   *  - a rate_limit_event (every request, claude.ai plans) → the window's utilization; `rejected` = limit hit.
   */
  private trackUsage(state: SessionState, msg: any): void {
    if (msg?.type === 'assistant' && !msg.parent_tool_use_id) {
      const id = typeof msg.message?.id === 'string' ? msg.message.id : null;
      const used = claudeContextTokens(msg.message?.usage);
      if (used === undefined || used <= 0 || (id && id === state.lastUsageMessageId)) return;
      if (id) state.lastUsageMessageId = id;
      const max = state.contextWindow ?? knownClaudeContextWindow(state.input.model?.model);
      const u = msg.message.usage;
      // The SDK reports cost only on a result, so the meter would read the PREVIOUS turn's figure all through this one:
      // add what this turn's calls cost at list price (outputs of a streaming message are the first delta's count, so a
      // little low; the result replaces the sum with the SDK's own).
      try {
        const callCost = requestCostOf({ input: u?.input_tokens ?? 0, cacheWrite: u?.cache_creation_input_tokens ?? 0, cacheRead: u?.cache_read_input_tokens ?? 0, output: u?.output_tokens ?? 0, cacheWrite1h: u?.cache_creation?.ephemeral_1h_input_tokens }, msg.message?.model ?? state.input.model?.model ?? null);
        if (Number.isFinite(callCost)) state.turnEstUsd = (state.turnEstUsd ?? 0) + callCost;
      } catch { /* the cost line is advisory */ }
      const live = (state.costUsd ?? 0) + (state.turnEstUsd ?? 0);
      const usage = {
        usedTokens: used, source: 'estimate' as const,
        ...(max ? { maxTokens: max } : {}),
        ...(typeof u?.input_tokens === 'number' ? { inputTokens: u.input_tokens } : {}),
        ...(typeof u?.output_tokens === 'number' ? { outputTokens: u.output_tokens } : {}),
        cachedInputTokens: (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0),
        ...(state.autoCompactThreshold ? { autoCompactThreshold: state.autoCompactThreshold, compactsAutomatically: true } : {}),
      };
      state.lastMeterUsage = usage;
      this.emit(state.threadId, {
        type: 'thread.token-usage',
        ...(state.currentTurnId ? { turnId: state.currentTurnId } : {}),
        usage: { ...usage, ...(live > 0 ? { costUsd: live } : {}) },
      });
      return;
    }
    if (msg?.type === 'result') {
      const w = claudeResultContextWindow(msg.modelUsage, state.input.model?.model);
      if (w) state.contextWindow = state.compactWindow ? Math.min(w, state.compactWindow) : w;
      const cost = claudeResultCostUsd(msg.total_cost_usd, msg.modelUsage);
      if (cost !== undefined) {
        state.costUsd = cost;
        // The settled figure goes out at once, not only with the /context refresh after it (which is skipped while another
        // is in flight or when the call fails: the last turn's cost then never reached the UI).
        if (state.lastMeterUsage) this.emit(state.threadId, { type: 'thread.token-usage', ...(state.currentTurnId ? { turnId: state.currentTurnId } : {}), usage: { ...state.lastMeterUsage, costUsd: cost } as any });
      }
      state.turnEstUsd = 0;
      return;
    }
    if (msg?.type === 'system' && msg.subtype === 'compact_boundary') {
      const m = msg.compact_metadata ?? {};
      state.compactedSince = true;
      this.emit(state.threadId, {
        type: 'context.compacted', trigger: m.trigger === 'auto' ? 'auto' : 'manual',
        ...(typeof m.pre_tokens === 'number' ? { preTokens: m.pre_tokens } : {}),
        ...(typeof m.post_tokens === 'number' ? { postTokens: m.post_tokens } : {}),
        ...(state.currentTurnId ? { turnId: state.currentTurnId } : {}),
      });
      return;
    }
    if (msg?.type === 'rate_limit_event') {
      const report = claudeRateLimitEventReport(msg.rate_limit_info);
      if (!report) return;
      this.emit(state.threadId, { type: 'usage.limits', report });
      if (report.limited) {
        const d = describeRateLimit({ window: msg.rate_limit_info?.rateLimitType, resetsAt: report.resetsAt });
        this.emit(state.threadId, { type: 'usage.rate-limit', message: d.message, ...(d.window ? { window: d.window } : {}), ...(report.resetsAt ? { resetsAt: report.resetsAt } : {}) });
      }
    }
  }

  /**
   * Per-call cost telemetry (util/cost-log.ts -> <KORA_HOME>/cost.jsonl): context, cache write/read and output for every
   * API call, a cache-miss flag with its likely cause, and the size of each big tool result. The SDK repeats one message per
   * content block with a growing `output_tokens`, so a call is finalized when the next message id (or the result) arrives.
   * A row's `ts` is when the call's FIRST message arrived (not when it was finalized): a tool event between two calls then
   * sorts before the next call, which is what the savings ledger's carry pricing (ledger/savings.ts `at`) assumes.
   */
  private trackCost(state: SessionState, msg: any): void {
    const finalize = () => {
      const p = state.pendingCall; state.pendingCall = null;
      if (!p || !state.callTracker) return;
      const eff = state.effort !== undefined ? state.effort : state.input.model?.effort;
      logCost({ ...state.callTracker.record(p.usage, p.at, state.threadId, p.toolResults), ...(eff && !/haiku/i.test(p.usage.model ?? '') ? { eff } : {}) });
      if (p.adv) logCost({ k: 'advisor', ts: p.at, thread: state.threadId, ...p.adv });
    };
    // The assistant messages the SDK hands over carry the output count from the START of the call (a few tokens); the
    // real count arrives on the stream's message_delta (partial messages are on). Remember it per message id.
    if (msg?.type === 'stream_event' && !msg.parent_tool_use_id) {
      const ev = msg.event;
      if (ev?.type === 'message_start' && typeof ev.message?.id === 'string') state.streamMessageId = ev.message.id;
      else if (ev?.type === 'message_delta' && state.streamMessageId && Number(ev.usage?.output_tokens) > 0) {
        const out = Number(ev.usage.output_tokens);
        state.streamOut = { id: state.streamMessageId, out };
        if (state.pendingCall?.id === state.streamMessageId) state.pendingCall.usage.out = Math.max(state.pendingCall.usage.out, out);
      }
      if (ev?.type === 'message_delta' && state.streamMessageId) {
        const adv = advisorUsageOf(ev.usage);
        if (adv) { state.streamAdv = { id: state.streamMessageId, adv }; if (state.pendingCall?.id === state.streamMessageId) state.pendingCall.adv = adv; }
      }
      return;
    }
    if (msg?.type === 'assistant' && !msg.parent_tool_use_id) {
      const m = msg.message; const u = m?.usage; const id = typeof m?.id === 'string' ? m.id : null;
      if (!id || !u || m.model === '<synthetic>') return;
      const names = (state.toolNames ??= new Map());
      for (const b of Array.isArray(m.content) ? m.content : []) if (b?.type === 'tool_use' && b.id) { names.set(String(b.id), String(b.name ?? '')); if (names.size > 400) names.delete(names.keys().next().value as string); }
      const usage: CallUsage = {
        model: typeof m.model === 'string' ? m.model : null,
        in: Number(u.input_tokens) || 0, cr: Number(u.cache_read_input_tokens) || 0, cc: Number(u.cache_creation_input_tokens) || 0,
        out: Math.max(Number(u.output_tokens) || 0, state.streamOut && state.streamOut.id === id ? state.streamOut.out : 0),
        ...(Number(u.cache_creation?.ephemeral_1h_input_tokens) ? { cc1h: Number(u.cache_creation.ephemeral_1h_input_tokens) } : {}),
      };
      const adv = advisorUsageOf(u) ?? (state.streamAdv && state.streamAdv.id === id ? state.streamAdv.adv : null);
      if (state.pendingCall && state.pendingCall.id === id) { state.pendingCall.usage = { ...state.pendingCall.usage, ...usage, out: Math.max(state.pendingCall.usage.out, usage.out) }; if (adv) state.pendingCall.adv = adv; return; }
      finalize();
      state.pendingCall = { id, usage, toolResults: state.resultsSinceCall ?? 0, at: Date.now(), ...(adv ? { adv } : {}) };
      state.resultsSinceCall = 0;
      return;
    }
    if (msg?.type === 'user' && Array.isArray(msg.message?.content)) {
      for (const b of msg.message.content) {
        if (b?.type !== 'tool_result') continue;
        state.resultsSinceCall = (state.resultsSinceCall ?? 0) + 1;
        const bytes = typeof b.content === 'string' ? b.content.length : Array.isArray(b.content) ? b.content.reduce((a: number, c: any) => a + (typeof c?.text === 'string' ? c.text.length : typeof c?.source?.data === 'string' ? c.source.data.length : 0), 0) : 0;
        if (bytes >= 1000) logCost({ k: 'tool', ts: Date.now(), thread: state.threadId, tool: state.toolNames?.get(String(b.tool_use_id)) || String(b.tool_name ?? 'tool'), bytes });
      }
      return;
    }
    if (msg?.type === 'result') { finalize(); return; }
    // finalize the call before the boundary first: record() consumes the pending cause, and it would otherwise land on that call instead of the post-compaction one
    if (msg?.type === 'system' && msg.subtype === 'compact_boundary') { finalize(); state.callTracker?.note('compaction'); }
  }

  /** B8: tell the thread once when a turn repeats the same Read or the same failing call (a loop that burns a full-context call each time). */
  private trackStuck(state: SessionState, msg: any): void {
    const g = state.runaway;
    if (!g || !lifecycleOn('runawayGuard') || msg?.parent_tool_use_id) return;
    const say = (v: { kind: 'reread' | 'refail'; message: string } | null) => { if (v) this.emit(state.threadId, { type: 'turn.stuck', kind: v.kind, message: v.message, ...(state.currentTurnId ? { turnId: state.currentTurnId } : {}) }); };
    if (msg?.type === 'assistant' && Array.isArray(msg.message?.content)) {
      for (const b of msg.message.content) if (b?.type === 'tool_use' && b.id) say(g.onToolUse(String(b.id), String(b.name ?? ''), b.input));
    } else if (msg?.type === 'user' && Array.isArray(msg.message?.content)) {
      for (const b of msg.message.content) if (b?.type === 'tool_result' && b.tool_use_id) say(g.onToolResult(String(b.tool_use_id), b.is_error === true));
    }
  }

  /** A Read Kora bounded: its result event carries the window so the card can say "read lines a-b of N". */
  private markBounded(state: SessionState, evs: UnsequencedChatEvent[]): UnsequencedChatEvent[] {
    if (!state.readBounder) return evs;
    return evs.map((e) => {
      if (e.type !== 'tool.result') return e;
      const rec = state.readBounder!.boundedFor(e.itemId);
      return rec ? { ...e, bounded: { path: rec.path, offset: rec.offset, limit: rec.limit, total: rec.total } } : e;
    });
  }

  /** Claude Code's own context accounting (`getContextUsage`, summary detail — local, ~20 ms). One in flight. */
  private refreshContextUsage(state: SessionState, turnId: TurnId | null): void {
    const q = state.query;
    if (!q?.getContextUsage || state.contextRefresh || state.stopped) return;
    const run = async () => {
      try {
        // After a compaction the summary detail still answers from the pre-compact response: count afresh once.
        const detail = state.compactedSince ? 'full' : 'summary';
        state.compactedSince = false;
        const resp = await withDeadline(q.getContextUsage!({ detail }), CONTEXT_USAGE_TIMEOUT_MS);
        const usage = claudeContextUsageToTokenUsage(resp);
        if (!usage || state.stopped) return;
        if (usage.maxTokens) state.contextWindow = usage.maxTokens;
        if (usage.autoCompactThreshold) state.autoCompactThreshold = usage.autoCompactThreshold;
        this.emit(state.threadId, {
          type: 'thread.token-usage',
          ...(turnId ? { turnId } : {}),
          usage: { ...usage, ...(state.costUsd !== undefined ? { costUsd: state.costUsd } : {}) },
        });
      } catch { /* the meter keeps its last estimate */ }
    };
    state.contextRefresh = run().finally(() => { state.contextRefresh = null; });
  }

  /** The claude.ai plan windows, asked through a live session's control channel (no turn, no tokens). */
  async readPlanUsage(): Promise<UsageLimitsReport | null> {
    for (const state of this.sessions.values()) {
      const q = state.query;
      if (state.stopped || !q?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET) continue;
      try {
        const resp = await withDeadline(q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }), PLAN_USAGE_TIMEOUT_MS);
        const report = claudeUsageReport(resp);
        if (report) return report;
      } catch { /* try the next session */ }
    }
    return null;
  }

  async sendTurn(input: SendTurnInput): Promise<TurnHandle> {
    const state = this.sessions.get(input.threadId);
    if (!state) throw new Error(`no live session for thread ${input.threadId}`);
    // Only a real change reaches the CLI: the composer sends its model with every turn, and an unchanged one used to emit a
    // 'model.rerouted' notice each time (aud3 S3-5). "default" is rewritten the way a session start does it.
    const wantModel = claudeModelForLaunch(input.model?.model, undefined);
    if (wantModel && state.query?.setModel && wantModel !== state.launchModel) {
      try { await state.query.setModel(wantModel); state.launchModel = wantModel; state.callTracker?.note('model-switch'); this.emit(input.threadId, { type: 'model.rerouted', to: input.model!.model, reason: 'per-turn override' }); } catch (e: any) { this.emit(input.threadId, { type: 'runtime.warning', message: `per-turn model ${input.model!.model} refused: ${e?.message ?? e}` }); }
    }
    if (input.text) state.lastUserText = input.text;
    if (input.origin !== 'kora-notice') state.lastUserAt = Date.now();
    // A Kora notice / notes turn keeps whatever mode the user's last turn set.
    if (input.origin !== 'kora-notice' && !input.continuation) await this.applyPlanMode(state, input.interactionMode === 'plan');
    this.clearHalt(state);
    const turnId: TurnId = newTurnId();
    state.currentTurnId = turnId;
    state.turnHadOutput = false;
    this.emit(input.threadId, { type: 'turn.started', turnId, ...(input.model?.model ? { model: input.model.model } : {}) });
    this.emit(input.threadId, { type: 'session.state', state: 'running' });
    if (input.text || !input.continuation) {
      let text = input.text ?? '';
      // Flagship per-prompt graph injection — the same mechanism the CLI/pane lane gets from the
      // UserPromptSubmit hook, which the SDK chat lane (this driver) otherwise never runs. For a
      // code-shaped prompt on an indexed repo we resolve its declarations from the graph and prepend
      // them (file:line, already resolved) so the agent answers WITHOUT an explore round-trip or a grep.
      // Best-effort and bounded (injectForPrompt has its own ~7s timeout and never throws); a non-code
      // prompt, an un-indexed repo, or a repeat prompt returns null and costs ~nothing.
      // ONE path injects: this one. A prepared session also runs the repo's UserPromptSubmit hook (laws, hot facts,
      // correction capture), but prepareChatSession sets KORA_INJECT_OWNER=driver so the hook skips its own
      // declaration injection — this in-daemon path uses the runtime's warm, worker-threaded graph instead of a
      // cold per-hook-process one, and it is the one the canary's desktop-chat lane measures.
      // A Kora-sent notice / notes turn is not the user's prompt: nothing to resolve from the graph. The Chat
      // surface has no graph at all (no repo cwd to index) — never spend the injection lookup there.
      // A slash command (`/compact`, …) must reach Claude Code as the message's first characters: nothing goes in front.
      const slashCommand = /^\/[a-z][\w-]*(?:\s|$)/i.test(text);
      // A real prompt moves the bounded-Read window state to a new turn (a Kora notice or a slash command is not one).
      // B5: a manual /compact can be undone - keep the transcript as it is right now (an async copy, bounded).
      if (slashCommand && /^\/compact(?:\s|$)/i.test(text) && !isBlobsCwd(state.input.cwd) && lifecycleOn('taskBoundaryChip')) {
        const sid = state.providerSessionId ?? (typeof state.input.resume === 'string' ? state.input.resume : undefined);
        if (sid) {
          try {
            const configDir = (this.deps.spawnEnv(input.threadId, state.input.account) as Record<string, string | undefined>).CLAUDE_CONFIG_DIR;
            await withDeadline(snapshotBeforeCompact({ threadId: input.threadId, sessionId: sid, cwd: state.input.cwd, configDir: configDir ?? null }), 3000);
          } catch { /* undo is a convenience; the compaction goes ahead */ }
        }
      }
      if (text && !slashCommand && input.origin !== 'kora-notice') { state.readBounder?.beginTurn(text); state.runaway?.beginTurn(); }
      if (text && !slashCommand && input.origin !== 'kora-notice' && !isBlobsCwd(state.input.cwd)) {
        try {
          const inj = await injectForPrompt({
            prompt: text, cwd: state.input.cwd, sessionId: input.threadId, lane: 'desktop-chat',
            // the runtime's (worker-threaded) graph, never a fresh in-process service — see InjectOpts.graph
            ...(this.deps.graphStatus ? { graph: { status: (c: string) => this.deps.graphStatus!(c), callTool: (n: any, a: Record<string, unknown>, o: { cwd: string; fresh?: boolean }) => this.deps.graphCall(n, a, o), ...(this.deps.graphBugLocalize ? { bugLocalize: (pr: string, root: string, gen: string) => this.deps.graphBugLocalize!(pr, root, gen) } : {}) } } : {}),
          });
          if (inj) { state.readBounder?.noteInjection(inj); text = `${inj}\n\n${text}`; }
        } catch { /* injection is best-effort — never block a turn on it */ }
      }
      // A thread that began before its repo was indexed carries a frozen "no code graph" system prompt: tell it, once, in
      // the user's own message, when the index lands (a user message does not touch the cached prefix).
      let indexNotice: string | null = null;
      if (text && !slashCommand && input.origin !== 'kora-notice' && state.flags?.noGraphRulebook) indexNotice = await this.indexedNotice(state);
      // A pending mode notice rides on this turn, ahead of the prompt (injection was computed on the user's text only).
      const notices = [indexNotice, slashCommand ? null : input.koraNotice].filter((x): x is string => !!x);
      if (notices.length) text = text ? `${notices.join('\n\n')}\n\n${text}` : notices.join('\n\n');
      const content = input.attachments?.length ? await buildClaudeTurnContent(text, input.attachments) : text;
      state.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });
    }
    return { threadId: input.threadId, turnId };
  }

  /** B3: once this thread's repo shows as indexed, the notice that replaces its stale "no code graph" system prompt (one time only). */
  private async indexedNotice(state: SessionState): Promise<string | null> {
    const now = Date.now();
    if (!this.deps.graphStatus || (state.indexCheckAt && now - state.indexCheckAt < 3000)) return null;
    state.indexCheckAt = now;
    try {
      const st = await withDeadline(this.deps.graphStatus(state.input.cwd), 1500);
      if (!st?.indexed || (st as any).incomplete) return null;
      state.flags = { ...state.flags, noGraphRulebook: undefined };
      updateThreadFlags(state.threadId, { noGraphRulebook: null });
      return graphReadyNotice();
    } catch { return null; }
  }

  async interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void> {
    const state = this.sessions.get(threadId);
    // Meant for a turn that already ended: stopping now would stop the NEXT turn (a worker's queued steer) and deny its approvals.
    if (turnId && state?.currentTurnId !== turnId) return;
    this.appAsks.cancelThread(threadId); // an app action waiting for its OK is denied when the turn is stopped
    // A card still waiting for a yes/no belongs to the turn that was just stopped: close it as cancelled (it used to stay "open")
    if (state) for (const [id, p] of [...state.pendingApprovals]) { state.pendingApprovals.delete(id); p.resolve({ behavior: 'deny', message: 'The turn was stopped' }); this.emit(threadId, { type: 'approval.resolved', requestId: id, decision: 'cancel' }); }
    if (!state?.query?.interrupt) return;
    // From here no tool runs until the next turn; if the SDK has not settled within the grace period (a long tool, a
    // stuck stream) the process is ended: a stopped turn must really stop, not keep writing files.
    state.halted = true;
    if (state.haltTimer) clearTimeout(state.haltTimer);
    state.haltTimer = setTimeout(() => { this.hardStop(state, 'did not stop when asked'); }, HALT_GRACE_MS);
    state.haltTimer.unref?.();
    try { await withDeadline(state.query.interrupt(), HALT_GRACE_MS); } catch (e: any) { this.emit(threadId, { type: 'runtime.warning', message: `interrupt failed: ${e?.message ?? e}` }); }
    if (state.currentTurnId) { this.emit(threadId, { type: 'turn.settled', turnId: state.currentTurnId, state: 'interrupted' }); state.currentTurnId = null; }
  }

  private clearHalt(state: SessionState): void {
    state.halted = false;
    if (state.haltTimer) { clearTimeout(state.haltTimer); state.haltTimer = null; }
  }

  /** End a session whose interrupted turn did not stop. The thread resumes from the provider session on its next turn. */
  private hardStop(state: SessionState, why: string): void {
    if (state.stopped) return;
    log(`chat ${state.threadId}: hard stop (${why})`);
    state.stopped = true;
    this.clearHalt(state);
    this.appAsks.cancelThread(state.threadId);
    for (const [, p] of state.pendingApprovals) p.resolve({ behavior: 'deny', message: 'The turn was stopped' });
    state.pendingApprovals.clear();
    try { state.push(null); } catch { /* already ended */ }
    try { state.query?.close?.(); } catch { /* best effort */ }
    if (state.currentTurnId) { this.emit(state.threadId, { type: 'turn.settled', turnId: state.currentTurnId, state: 'interrupted' }); state.currentTurnId = null; }
    this.emit(state.threadId, { type: 'session.exited', recoverable: true, reason: 'stopped' });
    this.sessions.delete(state.threadId);
  }

  async respondToApproval(threadId: ThreadId, requestId: RequestId, decision: ApprovalAnswer): Promise<void> {
    if (this.appAsks.respond(threadId, requestId, decision)) return; // a connected-app action waiting for its OK
    const state = this.sessions.get(threadId);
    const pending = state?.pendingApprovals.get(requestId);
    if (!state || !pending) return;
    state.pendingApprovals.delete(requestId);
    const allow = decision === 'accept' || decision === 'acceptForSession' || decision === 'acceptAlways';
    // "Always for this blob": remember the narrow rule before the tool runs (the next identical call raises no card)
    if (decision === 'acceptAlways' && state.blob && pending.toolName) { try { this.deps.blobs?.rememberAlways?.(state.blob.id, pending.toolName, pending.toolInput ?? {}); } catch (e: any) { log(`chat ${threadId}: could not remember an approval rule: ${e?.message ?? e}`); } }
    // "Allow for session": hand the SDK a session rule so the same call is not asked again (it only ever saw a one-off allow).
    const sessionRule = decision === 'acceptForSession' && pending.toolName
      ? [{ type: 'addRules' as const, behavior: 'allow' as const, destination: 'session' as const,
          rules: [{ toolName: pending.toolName, ...(pending.toolName === 'Bash' && typeof (pending.toolInput as any)?.command === 'string' ? { ruleContent: String((pending.toolInput as any).command) } : {}) }] }]
      : undefined;
    pending.resolve(allow ? { behavior: 'allow', ...(sessionRule ? { updatedPermissions: sessionRule } : {}) } : { behavior: 'deny', message: 'The user said no to this exact action. Do not retry it or look for another way around; tell them in one sentence that you stopped, and ask what they would like instead.' });
    this.emit(threadId, { type: 'approval.resolved', requestId, decision });
  }

  async respondToUserInput(threadId: ThreadId, requestId: RequestId, answers: UserInputAnswers): Promise<void> {
    const state = this.sessions.get(threadId);
    if (!state) return;
    this.emit(threadId, { type: 'user-input.resolved', requestId, answers });
    const p = state.pendingUserInput.get(requestId);
    // The question is still pending in canUseTool: answer it there, inside the same turn.
    if (p) { state.pendingUserInput.delete(requestId); p.resolve(answers); return; }
    // No pending question (answered after its turn ended): fold the answer in as a fresh message (D6).
    state.push({ type: 'user', message: { role: 'user', content: JSON.stringify(answers) }, parent_tool_use_id: null });
  }

  /**
   * The bundled CLI can refuse a model its own catalog doesn't list (Kora adds some itself, e.g. Haiku 5.5). Swallowing
   * that kept the old model answering behind a picker that showed the new one: resolve false so the manager restarts
   * the session with `--model <new>` before the next turn.
   */
  async setModel(threadId: ThreadId, model: ModelChoice): Promise<boolean> {
    const state = this.sessions.get(threadId);
    if (!state?.query?.setModel) return true;
    const want = claudeModelForLaunch(model.model, undefined) ?? model.model;
    // The compaction point is fixed in the CLI's env at spawn (Haiku 5.5 compacts at 100k): a switch across it restarts, or
    // Opus would compact at Haiku's 100k for the rest of the thread (R6 review #3). The switch re-writes the context anyway.
    if (want !== state.launchModel && claudeCompactWindow(want) !== claudeCompactWindow(state.launchModel)) {
      this.emit(threadId, { type: 'runtime.warning', message: `Switching to ${friendlyModelName(model.model)} restarts the session before your next message.` });
      return false;
    }
    try { if (want !== state.launchModel) { await state.query.setModel(want); state.launchModel = want; state.callTracker?.note('model-switch'); this.emit(threadId, { type: 'model.rerouted', to: model.model, reason: 'setModel' }); } return true; }
    catch (e: any) {
      // The CLI's refusal is about its own model catalog (behavesAs, modelOverrides...): log it, show one calm line (plv S3-3).
      log(`chat ${threadId}: claude setModel(${model.model}) refused, restarting the session before the next turn: ${e?.message ?? e}`);
      this.emit(threadId, { type: 'runtime.warning', message: `Switching to ${friendlyModelName(model.model)} restarts the session before your next message.` });
      return false;
    }
  }

  /**
   * A live effort change through the CLI's flag-settings layer (`applyFlagSettings({ effortLevel })`): no restart, and on the
   * 5.5 models it keeps the prompt cache (it takes effect at the next user message, which is when the composer sends it).
   * null = the model's own default. False when the session cannot (older CLI, a blob lane, Haiku, an unknown level).
   */
  async setEffort(threadId: ThreadId, effort: string | null): Promise<boolean> {
    const state = this.sessions.get(threadId);
    if (!state?.query?.applyFlagSettings || state.blob) return false;
    if (effort !== null && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) return false;
    if (/haiku/i.test(state.launchModel ?? '')) return false;
    const now = state.effort !== undefined ? state.effort : (state.input.model?.effort ?? DEFAULT_CHAT_EFFORT);
    if (effort === now) return true;
    try { await state.query.applyFlagSettings({ effortLevel: effort }); }
    catch (e: any) { log(`chat ${threadId}: applyFlagSettings(effort ${effort}) refused, restarting before the next turn: ${e?.message ?? e}`); return false; }
    state.effort = effort;
    if (state.input.model) state.input = { ...state.input, model: { ...state.input.model, effort } };
    return true;
  }

  /**
   * Push a mode change into the running query. Without this the SDK keeps the mode it was
   * built with at startSession (buildOptions) — flipping the composer pill mid-session then
   * changed nothing, and `canUseTool` kept gating in a thread the UI showed as full-access.
   */
  async setPermissionMode(threadId: ThreadId, mode: RuntimeMode): Promise<void> {
    const state = this.sessions.get(threadId);
    if (state) state.runtimeMode = mode;
    // Plan mode holds until a Build turn (applyPlanMode), which then restores this posture.
    if (!state?.query?.setPermissionMode || state.planMode) return;
    try { await state.query.setPermissionMode(toSdkPermissionMode(mode, !!state.blob)); }
    catch (e: any) { this.emit(threadId, { type: 'runtime.warning', message: `setPermissionMode failed: ${e?.message ?? e}` }); }
  }

  /** Plan mode on/off: Claude's own `plan` permission mode, and back to the thread's posture for a Build turn. */
  private async applyPlanMode(state: SessionState, on: boolean): Promise<void> {
    if (!!state.planMode === on || !state.query?.setPermissionMode) return;
    state.planMode = on;
    try { await state.query.setPermissionMode(on ? 'plan' : toSdkPermissionMode(state.runtimeMode ?? state.input.runtimeMode, !!state.blob)); }
    catch (e: any) { this.emit(state.threadId, { type: 'runtime.warning', message: `plan mode switch failed: ${e?.message ?? e}` }); }
  }

  /** No live session (an idle reap ended it): the keep-warm proxy may still hold the thread's last request. */
  forgetThread(threadId: ThreadId): void { if (!this.sessions.has(threadId)) cacheWarm().forget(threadId); }

  async stopSession(threadId: ThreadId, opts?: { idle?: boolean }): Promise<void> {
    const state = this.sessions.get(threadId);
    if (!state) return;
    state.stopped = true;
    // An idle reap is not the end of the thread: its next turn resumes the same conversation, which is exactly the
    // request the keep-warm proxy is holding, so the warm chain runs on (it stops on its own at the policy horizon).
    if (state.warmBaseUrl && !opts?.idle) cacheWarm().forget(threadId);
    this.appAsks.cancelThread(threadId);
    // fail any parked approvals so the SDK loop doesn't hang, then end the promptQueue.
    for (const [, p] of state.pendingApprovals) p.resolve({ behavior: 'deny', message: 'session stopped' });
    state.pendingApprovals.clear();
    try { state.push(null); } catch { /* already ended */ }
    try { await state.query?.interrupt?.(); } catch { /* best effort */ }
    this.emit(threadId, { type: 'session.exited', recoverable: true });
    this.emit(threadId, { type: 'session.state', state: 'stopped' });
    this.sessions.delete(threadId);
  }
}

/** The headless proxy pane id for an orchestrator thread (D4) — workers attach via this orchestratorId. */
export function proxyPaneId(threadId: ThreadId): string { return `chat:${threadId}`; }

/** Stamp a turnId onto events that carry one but were emitted without it. */
function withTurn(evs: UnsequencedChatEvent[], turnId: TurnId | null): UnsequencedChatEvent[] {
  if (!turnId) return evs;
  return evs.map((e) => ('turnId' in e || !turnCarrying(e.type) ? e : { ...e, turnId } as UnsequencedChatEvent));
}
function turnCarrying(type: string): boolean {
  return type === 'content.delta' || type === 'tool.started' || type === 'tool.updated' || type === 'tool.result' || type === 'tool.progress' || type === 'graph.query' || type === 'graph.result' || type === 'approval.opened' || type === 'turn.plan';
}

/** Extension servers for a Claude SDK session; never throws (a broken extensions file must not stop a chat). */
function claudeExtensionServers(input: SessionStartInput, trusted: () => boolean): Record<string, unknown> {
  try {
    const ext = require('../../extensions') as typeof import('../../extensions');
    let ok = false;
    try { ok = trusted(); } catch { ok = false; }
    return ext.claudeServers(ext.sessionServers('claude', input, ok));
  } catch { return {}; }
}
