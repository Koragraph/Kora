import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { AgentId, AgentProfileId } from "./agentProfile.ts";
import { QuotaSourceSnapshots, AgentUsageLimits } from "./agentUsageLimits.ts";
import { DaemonAuthDescriptor } from "./daemonAccess.ts";
import {
  IsoInstant,
  LenientArray,
  NonblankString,
  ProjectId,
  ThreadId,
  WholeNumber,
} from "./primitives.ts";
import { ExternalEditorId, RemoteOpenTarget, RevealInFinderKind } from "./externalEditors.ts";
import { HostDescriptor, HostMachineKind } from "./host.ts";
import { ModelCapabilities } from "./agentOptions.ts";
import { DaemonPrefs } from "./clientPrefs.ts";

// ---------------------------------------------------------------------------
// Agent (provider) status
// ---------------------------------------------------------------------------

export const AgentState = Schema.Literals(["ready", "warning", "error", "disabled"]);
export type AgentState = Schema.Schema.Type<typeof AgentState>;

export const AgentAuthStatus = Schema.Literals(["authenticated", "unauthenticated", "unknown"]);
export type AgentAuthStatus = Schema.Schema.Type<typeof AgentAuthStatus>;

export const AgentAuth = Schema.Struct({
  status: AgentAuthStatus,
  type: Schema.optional(NonblankString),
  label: Schema.optional(NonblankString),
  email: Schema.optional(NonblankString),
});
export type AgentAuth = Schema.Schema.Type<typeof AgentAuth>;

export const AgentModel = Schema.Struct({
  slug: NonblankString,
  name: NonblankString,
  shortName: Schema.optional(NonblankString),
  subProvider: Schema.optional(NonblankString),
  aliases: Schema.optional(Schema.Array(NonblankString)),
  capabilities: Schema.NullOr(ModelCapabilities),
  isLegacy: Schema.optional(Schema.Boolean),
  isDefault: Schema.optional(Schema.Boolean),
  isCustom: Schema.Boolean,
  badge: Schema.optional(Schema.Literal("new")),
});
export type AgentModel = Schema.Schema.Type<typeof AgentModel>;

export const AgentSlashCommandInput = Schema.Struct({ hint: NonblankString });
export type AgentSlashCommandInput = Schema.Schema.Type<typeof AgentSlashCommandInput>;

export const AgentSlashCommand = Schema.Struct({
  name: NonblankString,
  description: Schema.optional(NonblankString),
  input: Schema.optional(AgentSlashCommandInput),
});
export type AgentSlashCommand = Schema.Schema.Type<typeof AgentSlashCommand>;

export const AgentSkill = Schema.Struct({
  name: NonblankString,
  description: Schema.optional(NonblankString),
  path: NonblankString,
  scope: Schema.optional(NonblankString),
  enabled: Schema.Boolean,
  displayName: Schema.optional(NonblankString),
  shortDescription: Schema.optional(NonblankString),
  // Hidden from the agent's own skill tool; only the user can start it (Claude Code's
  // disable-model-invocation), so composers must offer it as a slash command.
  userInvocationOnly: Schema.optional(Schema.Boolean),
  // The mirror: `user-invocable: false` keeps it out of the slash commands.
  userInvocable: Schema.optional(Schema.Boolean),
});
export type AgentSkill = Schema.Schema.Type<typeof AgentSkill>;

export const AgentWorkspaceSnapshot = Schema.Struct({
  cwd: NonblankString,
  checkedAt: IsoInstant,
  slashCommands: Schema.Array(AgentSlashCommand),
  skills: Schema.Array(AgentSkill),
});
export type AgentWorkspaceSnapshot = Schema.Schema.Type<typeof AgentWorkspaceSnapshot>;

/**
 * "unavailable" means prefs or persisted bindings name a driver this build does not
 * ship (after rolling back from a fork). Such snapshots must be `installed: false` and
 * `enabled: false`; absent reads as "available".
 */
export const AgentAvailability = Schema.Literals(["available", "unavailable"]);
export type AgentAvailability = Schema.Schema.Type<typeof AgentAvailability>;

export const AgentContinuation = Schema.Struct({ groupKey: NonblankString });
export type AgentContinuation = Schema.Schema.Type<typeof AgentContinuation>;

export const AgentVersionAdvisoryStatus = Schema.Literals(["unknown", "current", "behind_latest"]);
export type AgentVersionAdvisoryStatus = Schema.Schema.Type<typeof AgentVersionAdvisoryStatus>;

export const AgentVersionAdvisory = Schema.Struct({
  status: AgentVersionAdvisoryStatus,
  currentVersion: Schema.NullOr(NonblankString),
  latestVersion: Schema.NullOr(NonblankString),
  updateCommand: Schema.NullOr(NonblankString),
  canUpdate: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  checkedAt: Schema.NullOr(IsoInstant),
  message: Schema.NullOr(NonblankString),
});
export type AgentVersionAdvisory = Schema.Schema.Type<typeof AgentVersionAdvisory>;

export const AgentUpdateStatus = Schema.Literals([
  "idle",
  "queued",
  "running",
  "succeeded",
  "failed",
  "unchanged",
]);
export type AgentUpdateStatus = Schema.Schema.Type<typeof AgentUpdateStatus>;

export const AgentUpdateState = Schema.Struct({
  status: AgentUpdateStatus,
  startedAt: Schema.NullOr(IsoInstant),
  finishedAt: Schema.NullOr(IsoInstant),
  message: Schema.NullOr(NonblankString),
  output: Schema.NullOr(Schema.String.check(Schema.isMaxLength(10_000))),
});
export type AgentUpdateState = Schema.Schema.Type<typeof AgentUpdateState>;

export const AgentStatus = Schema.Struct({
  // The only stable routing identity.
  instanceId: AgentProfileId,
  // Implementation slug; metadata, not a routing key.
  driver: AgentId,
  displayName: Schema.optional(NonblankString),
  accentColor: Schema.optional(NonblankString),
  badgeLabel: Schema.optional(NonblankString),
  continuation: Schema.optional(AgentContinuation),
  showInteractionModeToggle: Schema.optional(Schema.Boolean),
  // The driver streams context usage, so clients reserve room for the meter.
  reportsContextWindow: Schema.optional(Schema.Boolean),
  supportsTextGeneration: Schema.optional(Schema.Boolean),
  supportsConversationRollback: Schema.optional(Schema.Boolean),
  requiresNewThreadForModelChange: Schema.optional(Schema.Boolean),
  setup: Schema.optional(
    Schema.Struct({ canAuthenticate: Schema.Boolean, canInstall: Schema.Boolean }),
  ),
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  version: Schema.NullOr(NonblankString),
  status: AgentState,
  auth: AgentAuth,
  checkedAt: IsoInstant,
  message: Schema.optional(NonblankString),
  availability: Schema.optional(AgentAvailability),
  unavailableReason: Schema.optional(NonblankString),
  models: Schema.Array(AgentModel),
  slashCommands: Schema.Array(AgentSlashCommand).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  skills: Schema.Array(AgentSkill).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  workspaceSnapshots: Schema.optionalKey(Schema.Array(AgentWorkspaceSnapshot)),
  // Absent when the driver has no notion of subscription usage.
  usageLimits: Schema.optional(AgentUsageLimits),
  versionAdvisory: Schema.optionalKey(AgentVersionAdvisory),
  updateState: Schema.optionalKey(AgentUpdateState),
});
export type AgentStatus = Schema.Schema.Type<typeof AgentStatus>;

// Kinds grow; an older client must not fail the whole config over one it cannot render.
export const AgentStatuses = LenientArray(AgentStatus);
export type AgentStatuses = Schema.Schema.Type<typeof AgentStatuses>;

// ---------------------------------------------------------------------------
// Tracing and host themes
// ---------------------------------------------------------------------------

export const DaemonTracing = Schema.Struct({
  logsDirectoryPath: NonblankString,
  localTracingEnabled: Schema.Boolean,
  otlpTracesUrl: Schema.optional(NonblankString),
  otlpTracesEnabled: Schema.Boolean,
  otlpMetricsUrl: Schema.optional(NonblankString),
  otlpMetricsEnabled: Schema.Boolean,
});
export type DaemonTracing = Schema.Schema.Type<typeof DaemonTracing>;

export const HostThemeColor = Schema.String.check(
  Schema.isPattern(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/),
);
export type HostThemeColor = Schema.Schema.Type<typeof HostThemeColor>;

// The same rule as the client's theme ids. The appearance keywords are excluded so a published
// `dark.json` cannot capture every client whose stored preference is the stock "dark".
export const HostThemeId = Schema.String.check(
  Schema.isPattern(/^(?!(?:system|light|dark)$)[a-z0-9](?:[a-z0-9-]{0,47})$/),
);
export type HostThemeId = Schema.Schema.Type<typeof HostThemeId>;

// Role-shaped keys, so this is not an arbitrary payload channel. Values are any CSS colour
// the client parser accepts (oklch included); unknown roles are dropped client-side.
const HostThemeColors = Schema.Record(
  Schema.String.check(Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/)),
  NonblankString.check(Schema.isMaxLength(64)),
);

export const HostTheme = Schema.Struct({
  id: HostThemeId,
  // Exported theme files carry version 1; the seeded short form has none.
  version: Schema.optionalKey(Schema.Literal(1)),
  name: NonblankString.check(Schema.isMaxLength(48)),
  appearance: Schema.Literals(["light", "dark"]),
  // Seeds: when present, clients derive the whole palette and layer `colors` on top.
  canvas: Schema.optionalKey(HostThemeColor),
  accent: Schema.optionalKey(HostThemeColor),
  colors: Schema.optionalKey(HostThemeColors),
  variants: Schema.optionalKey(
    Schema.Struct({
      light: Schema.optionalKey(HostThemeColors),
      dark: Schema.optionalKey(HostThemeColors),
    }),
  ),
});
export type HostTheme = Schema.Schema.Type<typeof HostTheme>;

// ---------------------------------------------------------------------------
// Daemon config and its stream
// ---------------------------------------------------------------------------

export const DaemonConfig = Schema.Struct({
  // The wire key is `environment` even though the vocabulary is "host".
  environment: HostDescriptor,
  auth: DaemonAuthDescriptor,
  cwd: NonblankString,
  providers: AgentStatuses,
  availableEditors: LenientArray(ExternalEditorId),
  remoteOpenTargets: Schema.optionalKey(LenientArray(RemoteOpenTarget)),
  observability: DaemonTracing,
  settings: DaemonPrefs,
  shellResumeCompletionMarker: Schema.optional(Schema.Boolean),
  shellRevealInFileManager: Schema.optional(Schema.Boolean),
  shellRevealInFileManagerKind: Schema.optional(RevealInFinderKind),
  threadResumeCompletionMarker: Schema.optional(Schema.Boolean),
  // Thread reads accept turnLimit/beforeCursor and return page metadata. Clients must not
  // send window fields to a server that does not advertise this.
  threadSnapshotPagination: Schema.optional(Schema.Boolean),
  // Never in a snapshot: the theme stream emits the whole set before any change.
  hostThemes: Schema.optional(Schema.Array(HostTheme)),
  usageLimitSources: Schema.optional(QuotaSourceSnapshots),
});
export type DaemonConfig = Schema.Schema.Type<typeof DaemonConfig>;

/** The machine kind to draw: the user's override, else what was detected, else a plain server. */
export function resolveHostMachineKind(
  config: Pick<DaemonConfig, "environment" | "settings"> | null,
): HostMachineKind {
  return config?.settings.hostIcon ?? config?.environment.platform.machine ?? "server";
}

export const DaemonConfigAgentStatusesPayload = Schema.Struct({ providers: AgentStatuses });
export type DaemonConfigAgentStatusesPayload = Schema.Schema.Type<
  typeof DaemonConfigAgentStatusesPayload
>;

export const DaemonConfigPrefsUpdatedPayload = Schema.Struct({ settings: DaemonPrefs });
export type DaemonConfigPrefsUpdatedPayload = Schema.Schema.Type<
  typeof DaemonConfigPrefsUpdatedPayload
>;

export const DaemonConfigHostThemesUpdatedPayload = Schema.Struct({
  themes: Schema.Array(HostTheme),
});
export type DaemonConfigHostThemesUpdatedPayload = Schema.Schema.Type<
  typeof DaemonConfigHostThemesUpdatedPayload
>;

export const DaemonConfigUsageLimitSourcesUpdatedPayload = Schema.Struct({
  sources: QuotaSourceSnapshots,
});
export type DaemonConfigUsageLimitSourcesUpdatedPayload =
  typeof DaemonConfigUsageLimitSourcesUpdatedPayload.Type;

const configEvent = <T extends string, P extends Schema.Top>(type: T, payload: P) =>
  Schema.Struct({ version: Schema.Literal(1), type: Schema.Literal(type), payload });

export const DaemonConfigStreamSnapshotEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("snapshot"),
  config: DaemonConfig,
});
export type DaemonConfigStreamSnapshotEvent = Schema.Schema.Type<
  typeof DaemonConfigStreamSnapshotEvent
>;

export const DaemonConfigStreamAgentStatusesEvent = configEvent(
  "providerStatuses",
  DaemonConfigAgentStatusesPayload,
);
export type DaemonConfigStreamAgentStatusesEvent = Schema.Schema.Type<
  typeof DaemonConfigStreamAgentStatusesEvent
>;

export const DaemonConfigStreamPrefsUpdatedEvent = configEvent(
  "settingsUpdated",
  DaemonConfigPrefsUpdatedPayload,
);
export type DaemonConfigStreamPrefsUpdatedEvent = Schema.Schema.Type<
  typeof DaemonConfigStreamPrefsUpdatedEvent
>;

// The full set each time; empty when there are none.
export const DaemonConfigStreamHostThemesUpdatedEvent = configEvent(
  "hostThemesUpdated",
  DaemonConfigHostThemesUpdatedPayload,
);
export type DaemonConfigStreamHostThemesUpdatedEvent =
  typeof DaemonConfigStreamHostThemesUpdatedEvent.Type;

export const DaemonConfigStreamUsageLimitSourcesUpdatedEvent = configEvent(
  "usageLimitSourcesUpdated",
  DaemonConfigUsageLimitSourcesUpdatedPayload,
);
export type DaemonConfigStreamUsageLimitSourcesUpdatedEvent =
  typeof DaemonConfigStreamUsageLimitSourcesUpdatedEvent.Type;

export const DaemonConfigStreamEvent = Schema.Union([
  DaemonConfigStreamSnapshotEvent,
  DaemonConfigStreamAgentStatusesEvent,
  DaemonConfigStreamPrefsUpdatedEvent,
  DaemonConfigStreamHostThemesUpdatedEvent,
  DaemonConfigStreamUsageLimitSourcesUpdatedEvent,
]);
export type DaemonConfigStreamEvent = Schema.Schema.Type<typeof DaemonConfigStreamEvent>;

// ---------------------------------------------------------------------------
// Lifecycle stream
// ---------------------------------------------------------------------------

export const DaemonSelfUpdateOutcome = Schema.Struct({
  id: NonblankString,
  fromVersion: NonblankString,
  targetVersion: NonblankString,
  status: Schema.Literals(["committed", "rolled-back", "failed"]),
  reason: Schema.optionalKey(NonblankString),
});
export type DaemonSelfUpdateOutcome = Schema.Schema.Type<typeof DaemonSelfUpdateOutcome>;

export const DaemonLifecycleReadyPayload = Schema.Struct({
  at: IsoInstant,
  environment: HostDescriptor,
  updateOutcome: Schema.optionalKey(DaemonSelfUpdateOutcome),
});
export type DaemonLifecycleReadyPayload = Schema.Schema.Type<typeof DaemonLifecycleReadyPayload>;

export const DaemonLifecycleWelcomePayload = Schema.Struct({
  environment: HostDescriptor,
  cwd: NonblankString,
  projectName: NonblankString,
  bootstrapStatus: Schema.optionalKey(Schema.Literals(["pending", "complete"])),
  bootstrapProjectId: Schema.optionalKey(ProjectId),
  bootstrapThreadId: Schema.optionalKey(ThreadId),
  bootstrapProjectCreated: Schema.optionalKey(Schema.Boolean),
  bootstrapThreadCreated: Schema.optionalKey(Schema.Boolean),
});
export type DaemonLifecycleWelcomePayload = Schema.Schema.Type<
  typeof DaemonLifecycleWelcomePayload
>;

export const DaemonLifecycleStreamWelcomeEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: WholeNumber,
  type: Schema.Literal("welcome"),
  payload: DaemonLifecycleWelcomePayload,
});
export type DaemonLifecycleStreamWelcomeEvent = Schema.Schema.Type<
  typeof DaemonLifecycleStreamWelcomeEvent
>;

export const DaemonLifecycleStreamReadyEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: WholeNumber,
  type: Schema.Literal("ready"),
  payload: DaemonLifecycleReadyPayload,
});
export type DaemonLifecycleStreamReadyEvent = Schema.Schema.Type<
  typeof DaemonLifecycleStreamReadyEvent
>;

export const DaemonLifecycleStreamEvent = Schema.Union([
  DaemonLifecycleStreamWelcomeEvent,
  DaemonLifecycleStreamReadyEvent,
]);
export type DaemonLifecycleStreamEvent = Schema.Schema.Type<typeof DaemonLifecycleStreamEvent>;
