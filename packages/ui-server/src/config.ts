// @effect-diagnostics globalDate:off -- plain timestamps for wire payloads and logs, produced outside any Effect fiber.
// @effect-diagnostics nodeBuiltinImport:off -- plain Node APIs: this module is the boundary to the in-process kora runtime, which is not Effect code.
import * as path from "node:path";

import { DaemonConfig } from "@kora/contracts";
import * as Schema from "effect/Schema";
import { koraHome } from "./paths.ts";

// Kora has one version: the runtime's (daemon, CLI, Kora.app). The web client builds its APP_VERSION from the same
// file (apps/web/vite.config.ts) and flags "Server update available" when serverVersion is semver-behind it.
import runtimePackageJson from "../../runtime/package.json" with { type: "json" };

/**
 * The single environment identity this daemon reports. It MUST be reported
 * identically by `subscribeDaemonConfig` (this config's `environment`) and by
 * the HTTP readiness descriptor (`GET /.well-known/kora/host`), or the
 * Kora client blocks forever on "connecting" (see RECONCILED.md §1, blueprint §5
 * risk 3). Both endpoints read `daemonConfig.environment`, so they cannot drift.
 */
export const HOST_ID = "kora-local";

/** Map Node's `process.platform` onto the Kora platform-os literal set. */
const OS_BY_PLATFORM: Readonly<Record<string, "darwin" | "linux" | "windows">> = {
  win32: "windows",
  linux: "linux",
  darwin: "darwin",
};

function detectOs(): "darwin" | "linux" | "windows" | "unknown" {
  return OS_BY_PLATFORM[process.platform] ?? "unknown";
}

/** Map Node's `process.arch` onto the Kora platform-arch literal set. */
function detectArch(): "arm64" | "x64" | "other" {
  const arch = process.arch;
  return arch === "arm64" || arch === "x64" ? arch : "other";
}

/**
 * A minimal-but-valid `DaemonConfig`. We decode it through the schema so a
 * boot-time drift (e.g. a new required settings field with no default) fails
 * loudly here instead of silently emitting an undecodable snapshot to clients
 * (blueprint §5, risk 7). `settings: {}` lets the schema fill in
 * `DEFAULT_DAEMON_PREFS`, and `providers: []` / `availableEditors: []`
 * pass their forward-compatible array schemas.
 */
/**
 * Model capabilities advertised for a Claude model: one `effort` select whose value the ChatEngine forwards
 * to the kora session (`ModelPick.effort` → the Agent SDK `effort` option) and to every worker the
 * orchestrator spawns (`claude --effort <level>`). The effort levels are per-model and discovered at boot
 * from the Claude Agent SDK's `supportedModels()` (see claudeModels.ts) — not hardcoded, since they differ
 * across models (e.g. Haiku exposes none). `ultrathink` is NOT a `--effort` value: selecting it is handled
 * entirely client-side (`promptInjectedValues`, `TraitsInlineControls`/`TraitsMenuContent`) by prefixing the
 * prompt with "Ultrathink:\n", which the SDK recognizes as an extended-thinking trigger — so it never gets
 * sent as `effort` and carries no `isDefault`/`currentValue`. It is appended here whenever a model reasons.
 */
export function claudeCapabilities(efforts: ReadonlyArray<string>, defaultEffort: string) {
  return {
    optionDescriptors: [
      {
        id: "effort",
        label: "Effort",
        description: "How hard the model reasons per turn",
        type: "select" as const,
        options: [
          ...efforts.map((id) => ({
            id,
            label: effortLabel(id),
            ...(id === defaultEffort ? { isDefault: true } : {}),
          })),
          { id: "ultrathink", label: "Ultrathink" },
        ],
        promptInjectedValues: ["ultrathink"],
        currentValue: defaultEffort,
      },
    ],
  };
}

/**
 * Human labels for Codex reasoning-effort ids. Codex's `model/list` returns the effort ids each model
 * actually supports (they vary per model — e.g. `low,medium,high,xhigh,max,ultra`), which we map to
 * display labels here. Unknown ids fall back to a capitalized form so a new Codex level still renders.
 */
const EFFORT_LABELS: Readonly<Record<string, string>> = {
  ultra: "Ultra",
  max: "Max",
  xhigh: "Extra High",
  high: "High",
  medium: "Medium",
  low: "Low",
  minimal: "Minimal",
};

function effortLabel(id: string): string {
  return EFFORT_LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * Model capabilities advertised for a Codex model. Codex exposes one knob analogous to Claude's
 * `effort`: the reasoning-effort level, which the CodexDriver forwards as `-c model_reasoning_effort=<level>`
 * to `codex exec`. The supported levels are per-model and discovered at boot from `codex app-server`'s
 * `model/list` (see codexModels.ts) — NOT hardcoded, since they differ across models. The descriptor id
 * is `effort` so it flows through the exact same plumbing as Claude: `effortOf()` (kora-chat.ts) reads
 * option id `effort` → `ModelPick.effort` → the CodexDriver's `state.model.effort`.
 */
export function codexCapabilities(efforts: ReadonlyArray<string>, defaultEffort: string) {
  return {
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning effort",
        description: "How hard Codex reasons per turn",
        type: "select" as const,
        options: efforts.map((id) => ({
          id,
          label: effortLabel(id),
          ...(id === defaultEffort ? { isDefault: true } : {}),
        })),
        currentValue: defaultEffort,
      },
    ],
  };
}

/** What both advertised providers share. The CLI's own version is filled in later by the readiness probe (agentReadinessInfo.ts); unknown until then. */
const READY_PROVIDER_STATE = {
  status: "ready",
  version: null,
  installed: true,
  enabled: true,
  reportsContextWindow: true,
  supportsTextGeneration: true,
} as const;

export const daemonConfig: DaemonConfig = Schema.decodeSync(DaemonConfig)({
  environment: {
    hostId: HOST_ID,
    label: "Kora",
    // Kora Dev's home is ~/.kora-dev and its CLI kora-dev: copy-paste commands in the app must name the right one.
    cliName: path.basename(koraHome()) === ".kora-dev" ? "kora-dev" : "kora",
    platform: { os: detectOs(), arch: detectArch() },
    serverVersion: runtimePackageJson.version,
    // `connectionProbe:true` lets the client skip the `server.getConfig` round-trip on boot.
    capabilities: {
      repositoryIdentity: false,
      connectionProbe: true,
      swarm: true,
      // Composer chips arrive as records; startTurn expands them into the prompt (kora-chat.ts).
      inlineMessageContext: true,
      // Per-project defaults (model, permissions, Actions): `daemon.prefs.update` persists `projectSettingsOverrides`
      // (prefsStore.ts) and the client resolves them for new threads (resolveProjectPrefs). Without the flag every
      // project-scope save was refused with a stale "connect the selected checkouts" toast.
      projectSettingsOverrides: true,
    },
  },
  auth: {
    // The desktop bootstraps silently from the local UI secret (`<kora home>/ui-token`,
    // localAuth.ts) — no pairing prompt; `/ws` and `/api/*` require it.
    policy: "desktop-managed-local",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "kora.sid",
  },
  // Advertise the thread-resume completion marker (Kora' real server sets this —
  // apps/server/src/ws.ts:1808). With it, the web client requests a completion
  // marker on `subscribeThread` and flips the thread to "live" the instant it
  // receives our `{ kind: "synchronized" }` frame (client `threads.ts` applyItem),
  // instead of the brittle capability-less path that infers "live" from a
  // successful HTTP snapshot load — which left a just-finished turn wedged on
  // "Syncing messages…". Our `subscribeThread` already emits `synchronized`
  // after the snapshot, so this is all that was missing. `threadSnapshotPagination`
  // stays absent: we send the full thread in one snapshot (no windowed reads).
  threadResumeCompletionMarker: true,
  // Same contract for the shell (project/thread list) stream: the client flips the
  // shell out of "synchronizing" on our `{ kind: "synchronized" }` frame, which
  // `subscribeShell` already emits (Kora sets this too — ws.ts:1801).
  shellResumeCompletionMarker: true,
  cwd: process.cwd(),
  // One ready, authenticated Claude provider. The web composer gates sending on
  // finding a provider entry whose `instanceId` matches the thread's
  // `modelSelection.instanceId` (`ChatPrompt`: `selectedProviderEntry`); with
  // an empty list it shows "Enable a provider in Settings" and disables input.
  // Our turns are driven in-process by the kora Claude Agent SDK, so the
  // provider is always present and authenticated — we advertise it as such.
  // `instanceId: "claude"` is the routing key the client stores in
  // `modelSelection`; the ChatEngine maps the chosen model slug straight to
  // kora `SessionManager.create({ model })`.
  providers: [
    {
      instanceId: "claude",
      driver: "claude",
      displayName: "Claude",
      ...READY_PROVIDER_STATE,
      auth: { status: "authenticated", type: "subscription", label: "kora" },
      checkedAt: new Date().toISOString(),
      // `/compact` goes to Claude Code as the message (the driver sends slash commands unprefixed); `/usage` is
      // answered by Kora itself (Settings → Usage).
      slashCommands: [
        { name: "compact", description: "Summarize the conversation to free up context" },
        { name: "usage", description: "Context, cost and plan limits" },
      ],
      // Fallback list only. The real catalog is discovered at daemon boot from the Claude Agent SDK's
      // `supportedModels()` and patched in by applyClaudeModels() (claudeModels.ts) — these static aliases
      // are what shows if the SDK probe fails; the SDK resolves each to the latest matching model.
      models: [
        {
          slug: "sonnet",
          name: "Claude Sonnet",
          shortName: "Sonnet",
          isCustom: false,
          isDefault: true,
          capabilities: claudeCapabilities(["low", "medium", "high", "xhigh", "max"], "high"),
        },
        {
          slug: "opus",
          name: "Claude Opus",
          shortName: "Opus",
          isCustom: false,
          capabilities: claudeCapabilities(["low", "medium", "high", "xhigh", "max"], "high"),
        },
      ],
    },
    // Codex — driven by the kora CodexDriver over `codex exec --json`. `driver: "codex"` matches
    // the Kora legacy driver-kind and the `providerName` we stamp on the session, so the composer keeps
    // codex threads on the codex provider (see kora-chat.ts routeAgent).
    {
      displayName: "Codex",
      driver: "codex",
      instanceId: "codex",
      ...READY_PROVIDER_STATE,
      auth: { status: "authenticated", type: "subscription", label: "codex" },
      checkedAt: new Date().toISOString(),
      slashCommands: [{ name: "usage", description: "Context and plan limits" }],
      // Fallback list only. The real catalog is discovered at daemon boot from `codex app-server`'s
      // `model/list` and patched in by applyCodexModels() (codexModels.ts) — this static entry is what
      // shows if Codex isn't installed / the probe fails, so it stays deliberately generic.
      models: [
        {
          slug: "gpt-5-codex",
          name: "GPT-5 Codex",
          shortName: "Codex",
          isCustom: false,
          isDefault: true,
          capabilities: codexCapabilities(["low", "medium", "high"], "medium"),
        },
      ],
    },
    // Antigravity (Google's agent, the `agy` CLI) — driven by the runtime AntigravityDriver (`agy --print … stream-json`).
    // Starts as "not installed"; antigravityModels.ts patches install state, version and the `agy models` list in at boot
    // (from its cache at once, then a live probe). `driver: "antigravity"` = the session's providerName (kora-chat routeAgent).
    {
      displayName: "Antigravity",
      driver: "antigravity",
      instanceId: "antigravity",
      status: "error",
      version: null,
      installed: false,
      enabled: true,
      reportsContextWindow: true,
      supportsTextGeneration: true,
      auth: { status: "unknown" },
      checkedAt: new Date().toISOString(),
      message: "Looking for Antigravity (the agy command)…",
      slashCommands: [],
      models: [],
    },
  ],
  availableEditors: [],
  observability: {
    logsDirectoryPath: koraHome(),
    otlpMetricsEnabled: false,
    otlpTracesEnabled: false,
    localTracingEnabled: false,
  },
  // The web composer overrides a streamed provider's `enabled` with the settings
  // view (`applyAgentProfilePrefs`): a provider absent from BOTH
  // `providerInstances` and the legacy `providers.<driver>` map is forced
  // disabled, which is why an advertised-but-unlisted provider still shows
  // "Enable a provider in Settings". We register the `claude` instance explicitly
  // (envelope `enabled: true` wins in `resolveAgentProfileEnabled`) so the
  // composer treats it as a usable, authenticated provider. Its `instanceId`
  // matches the `modelSelection.instanceId` every thread carries.
  settings: {
    providerInstances: {
      claude: { driver: "claude", enabled: true, displayName: "Claude" },
      codex: { driver: "codex", enabled: true, displayName: "Codex" },
      antigravity: { driver: "antigravity", enabled: true, displayName: "Antigravity" },
    },
  },
});

/**
 * The readiness descriptor served over HTTP. Deliberately the SAME object the
 * config snapshot carries, so the hostId can never diverge between the
 * two surfaces.
 */
export const hostDescriptor = daemonConfig.environment;
