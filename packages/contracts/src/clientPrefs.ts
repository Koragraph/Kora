import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";

import { AgentProfileConfig, AgentProfileId } from "./agentProfile.ts";
import {
  TrimmedString,
  ProjectId,
  NonblankString,
  ForwardCompatibleNullable,
} from "./primitives.ts";
import { WebProfile, WebProfileId, DEFAULT_WEB_PROFILE_ID } from "./webProfile.ts";
import { AccessMode, DEFAULT_ACCESS_MODE, ModelPick, ProjectAction } from "./chat.ts";
import { HostMachineKind, ThreadWorkspaceMode } from "./host.ts";
import { MergeRequestMergeMethod } from "./mergeRequest.ts";
import {
  DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
  DEFAULT_TEXT_GENERATION_MODEL,
  CustomModelSpec,
  AgentOptionSelections,
} from "./agentOptions.ts";
import {
  FILL_WEB_VIEWPORT,
  WebZoomFactor,
  WebViewportSetting,
  WebAppearancePreference,
  DEFAULT_WEB_ZOOM_FACTOR,
  DEFAULT_WEB_APPEARANCE,
} from "./webPreview.ts";
import { QuotaSourceId } from "./quotaSource.ts";

// ---------------------------------------------------------------------------
// Helpers that build a "with defaults" struct and its all-optional patch from one
// table of value schemas, so the two can never drift apart.
// ---------------------------------------------------------------------------

type Fields = Schema.Struct.Fields;

type DefaultedFields<F extends Fields> = {
  readonly [K in keyof F]: Schema.withDecodingDefault<F[K] & Schema.Constraint>;
};
type OptionalKeyFields<F extends Fields> = {
  readonly [K in keyof F]: Schema.optionalKey<F[K] & Schema.Constraint>;
};
type EncodedDefaults<F extends Fields> = { readonly [K in keyof F]: F[K]["Encoded"] };

const withDefaults = <const F extends Fields>(
  fields: F,
  defaults: EncodedDefaults<F>,
): DefaultedFields<F> => {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(fields)) {
    out[key] = (fields[key] as Schema.Constraint & { pipe: (...fns: never[]) => unknown }).pipe(
      Schema.withDecodingDefault(
        Effect.succeed((defaults as Record<string, unknown>)[key]),
      ) as never,
    );
  }
  return out as DefaultedFields<F>;
};

const optionalKeys = <const F extends Fields>(fields: F): OptionalKeyFields<F> => {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(fields)) out[key] = Schema.optionalKey(fields[key] as never);
  return out as OptionalKeyFields<F>;
};

const bounded = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }));

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

export const ClockFormat = Schema.Literals(["locale", "12-hour", "24-hour"]);
export type ClockFormat = typeof ClockFormat.Type;

export const DiffLayout = Schema.Literals(["stacked", "split"]);
export type DiffLayout = typeof DiffLayout.Type;

export const NavProjectSortOrder = Schema.Literals(["updated_at", "created_at", "manual"]);
export type NavProjectSortOrder = typeof NavProjectSortOrder.Type;

export const NavThreadSortOrder = Schema.Literals(["updated_at", "created_at"]);
export type NavThreadSortOrder = typeof NavThreadSortOrder.Type;
// How a sidebar thread card shows a running turn (Kora's working sprite plays in every style): a light travelling
// round its outline, a rail down its left edge, a line sliding along its bottom, a sheen sweeping across, a breathing
// outline, marching dashes, blinking corner brackets, a scan line, or nothing but the sprite.
export const NAV_WORKING_STYLES = [
  "outline",
  "rail",
  "line",
  "sweep",
  "pulse",
  "dash",
  "corners",
  "scan",
  "off",
] as const;
export const NavWorkingStyle = Schema.Literals(NAV_WORKING_STYLES);
export type NavWorkingStyle = typeof NavWorkingStyle.Type;

export const NavProjectGroupingMode = Schema.Literals([
  "repository",
  "repository_path",
  "separate",
]);
export type NavProjectGroupingMode = typeof NavProjectGroupingMode.Type;

export const NavThreadPeekCount = bounded(1, 15);
export type NavThreadPeekCount = typeof NavThreadPeekCount.Type;

export const NavAutoSettleAfterDays = Schema.Number.check(
  Schema.isBetween({ minimum: 1, maximum: 90 }),
);
export type NavAutoSettleAfterDays = typeof NavAutoSettleAfterDays.Type;

export const GlassOpacity = bounded(40, 100);
export type GlassOpacity = typeof GlassOpacity.Type;

export const AppearanceContrast = bounded(50, 200);
export type AppearanceContrast = typeof AppearanceContrast.Type;

// Width/height transitions cost layout work on every frame, so motion defaults off.
export const PanelAnimationDurationMs = bounded(0, 400);
export type PanelAnimationDurationMs = typeof PanelAnimationDurationMs.Type;

// CSS px. Ranges are narrow because the interface size scales every rem dimension.
export const MIN_INTERFACE_FONT_SIZE = 12;
export const MAX_INTERFACE_FONT_SIZE = 20;
export const InterfaceFontSize = bounded(MIN_INTERFACE_FONT_SIZE, MAX_INTERFACE_FONT_SIZE);
export type InterfaceFontSize = typeof InterfaceFontSize.Type;
export const DEFAULT_INTERFACE_FONT_SIZE = 16;

export const MIN_PROMPT_FONT_SIZE = 12;
export const MAX_PROMPT_FONT_SIZE = 20;
export const PromptFontSize = bounded(MIN_PROMPT_FONT_SIZE, MAX_PROMPT_FONT_SIZE);
export type PromptFontSize = typeof PromptFontSize.Type;
export const DEFAULT_PROMPT_FONT_SIZE = 14;

export const MIN_CODE_FONT_SIZE = 10;
export const MAX_CODE_FONT_SIZE = 18;
export const CodeFontSize = bounded(MIN_CODE_FONT_SIZE, MAX_CODE_FONT_SIZE);
export type CodeFontSize = typeof CodeFontSize.Type;
export const DEFAULT_CODE_FONT_SIZE = 13;

export const TerminalFontSize = bounded(8, 20);
export type TerminalFontSize = typeof TerminalFontSize.Type;

export const HostIdentificationMode = Schema.Literals(["artwork", "pill", "none"]);
export type HostIdentificationMode = typeof HostIdentificationMode.Type;

export const CaptureSound = Schema.Literals(["soft-pop", "camera-shutter"]);
export type CaptureSound = typeof CaptureSound.Type;

const NOTIFICATION_SURFACES = ["notifications", "sound"] as const;
export const NotificationMode = Schema.Literals([
  "off",
  ...NOTIFICATION_SURFACES,
  "notifications-and-sound",
]);
export type NotificationMode = (typeof NotificationMode)["Type"];

/** Empty means the app default. */
const boundedText = (max: number) => Schema.String.check(Schema.isMaxLength(max));
export const FontFamilyPreference = boundedText(200);
export type FontFamilyPreference = (typeof FontFamilyPreference)["Type"];

/**
 * The environment theme chosen with `kora theme set <id>`. Each client applies it once per
 * value; empty clears it. Not patchable through DaemonPrefsPatch: the CLI validates the id.
 */
export const DefaultThemePreference = boundedText(64);
export type DefaultThemePreference = (typeof DefaultThemePreference)["Type"];

export const BrowserScreencastFrameRate = Schema.Literals([30, 60]);
export type BrowserScreencastFrameRate = typeof BrowserScreencastFrameRate.Type;

export const LinkOpenTarget = Schema.Literals(["system", "app"]);
export type LinkOpenTarget = typeof LinkOpenTarget.Type;

export const LoadBalancingWeights = Schema.Record(NonblankString, bounded(0, 100));

export const DiffColorScheme = Schema.Literals(["red-green", "blue-orange"]);
export type DiffColorScheme = typeof DiffColorScheme.Type;

/** turn: hold the whole message; paragraph: each finished paragraph or code block; token: every delta. */
export const ResponseStreamingMode = Schema.Literals(["turn", "paragraph", "token"]);
export type ResponseStreamingMode = typeof ResponseStreamingMode.Type;

const BACKGROUND_PROFILE_NAMES = ["balanced", "performance", "battery-saver"] as const;
export const BackgroundActivityProfile = Schema.Literals(BACKGROUND_PROFILE_NAMES);
export type BackgroundActivityProfile = (typeof BackgroundActivityProfile)["Type"];

export const BackgroundActivityProfileSelection = Schema.Literals([
  ...BACKGROUND_PROFILE_NAMES,
  "custom",
]);
export type BackgroundActivityProfileSelection =
  (typeof BackgroundActivityProfileSelection)["Type"];

const WRITING_STYLE_PRESETS = ["repo_conventions", "conventional_commits"] as const;
export const SourceControlWritingStyleMode = Schema.Literals([...WRITING_STYLE_PRESETS, "custom"]);
export type SourceControlWritingStyleMode = (typeof SourceControlWritingStyleMode)["Type"];

export const DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL = Duration.seconds(30);
export const DEFAULT_AGENT_HEALTH_REFRESH_INTERVAL = Duration.minutes(5);
export const DEFAULT_BACKGROUND_ACTIVITY_PROFILE: BackgroundActivityProfile = "balanced";

// ---------------------------------------------------------------------------
// Renamed client keys
// ---------------------------------------------------------------------------

const LEGACY_CLIENT_PREFS_KEYS: Readonly<Record<string, string>> = {
  snapShotEnabled: "captureEnabled",
  snapShotIncludeAccessibility: "captureIncludeAccessibility",
  snapShotPlaySound: "capturePlaySound",
  snapShotSound: "captureSound",
  snapShotFlash: "captureFlash",
  snapShotAnimations: "captureAnimations",
  environmentIdentificationMode: "hostIdentificationMode",
};

/** Rename legacy keys of a stored document; the current key wins if both exist. */
export function migrateLegacyClientPrefsKeys(document: unknown): unknown {
  if (typeof document !== "object" || document === null || Array.isArray(document)) return document;
  const source = document as Record<string, unknown>;
  if (!Object.keys(source).some((key) => Object.hasOwn(LEGACY_CLIENT_PREFS_KEYS, key))) {
    return document;
  }
  const migrated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    const target = LEGACY_CLIENT_PREFS_KEYS[key];
    if (target === undefined) {
      migrated[key] = value;
    } else if (!Object.hasOwn(source, target)) {
      migrated[target] = value;
    }
  }
  return migrated;
}

// ---------------------------------------------------------------------------
// Client (local-only) preferences
// ---------------------------------------------------------------------------

const ProviderModelPreference = Schema.Struct({
  hiddenModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  modelOrder: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});

const clientPrefsValues = {
  notificationMode: NotificationMode,
  inAppNotificationsEnabled: Schema.Boolean,
  diffColorScheme: DiffColorScheme,
  loadBalancingEnabled: Schema.Boolean,
  loadBalancingWeights: LoadBalancingWeights,
  appearanceContrast: AppearanceContrast,
  panelAnimationDurationMs: PanelAnimationDurationMs,
  browserDefaultViewport: WebViewportSetting,
  browserDefaultZoomFactor: WebZoomFactor,
  browserDefaultAppearance: WebAppearancePreference,
  browserRecordingFrameRate: BrowserScreencastFrameRate,
  // Only the desktop app has an in-app browser; other clients ignore "app".
  browserLinkTarget: LinkOpenTarget,
  // User-made profiles only; the built-in Default and Incognito are synthesized elsewhere.
  browserProfiles: Schema.Array(WebProfile),
  browserDefaultProfileId: WebProfileId,
  confirmThreadArchive: Schema.Boolean,
  confirmThreadDelete: Schema.Boolean,
  confirmThreadUnpin: Schema.Boolean,
  diffFilesCollapsed: Schema.Boolean,
  diffIgnoreWhitespace: Schema.Boolean,
  diffLayout: DiffLayout,
  hostIdentificationMode: HostIdentificationMode,
  glassOpacity: GlassOpacity,
  fontSizeInterface: InterfaceFontSize,
  fontSizePrompt: PromptFontSize,
  fontSizeCode: CodeFontSize,
  fontSizeTerminal: TerminalFontSize,
  fontFamilyCode: FontFamilyPreference,
  fontFamilyComposer: FontFamilyPreference,
  fontFamilySans: FontFamilyPreference,
  fontFamilyTerminal: FontFamilyPreference,
  // Grayscale antialiasing; no effect outside macOS.
  fontSmoothing: Schema.Boolean,
  // Null alone does not mean "show the wizard": installs that predate the field decode to null.
  onboardingCompletedAt: Schema.NullOr(Schema.String),
  // `provider` is an instance id; the name stays for storage stability.
  favorites: Schema.Array(Schema.Struct({ provider: AgentProfileId, model: NonblankString })),
  providerModelPreferences: Schema.Record(AgentProfileId, ProviderModelPreference),
  pullRequestMergeMethodOverrides: Schema.Record(NonblankString, MergeRequestMergeMethod),
  planModeEnabled: Schema.Boolean,
  composerCollapseOnScroll: Schema.Boolean,
  proactivePanelsEnabled: Schema.Boolean,
  showSkillsInSlashMenu: Schema.Boolean,
  legacySidebarEnabled: Schema.Boolean,
  sidebarProjectGroupingMode: NavProjectGroupingMode,
  sidebarProjectGroupingOverrides: Schema.Record(NonblankString, NavProjectGroupingMode),
  sidebarProjectSortOrder: NavProjectSortOrder,
  sidebarThreadSortOrder: NavThreadSortOrder,
  sidebarThreadPreviewCount: NavThreadPeekCount,
  sidebarWorkingStyle: NavWorkingStyle,
  timestampFormat: ClockFormat,
  captureEnabled: Schema.Boolean,
  captureIncludeAccessibility: Schema.Boolean,
  capturePlaySound: Schema.Boolean,
  captureSound: CaptureSound,
  captureFlash: Schema.Boolean,
  captureAnimations: Schema.Boolean,
  wordWrap: Schema.Boolean,
  // "Kora saved you $X" at the top of the usage sign's popover (API-price estimates; Settings › Usage).
  showKoraSavings: Schema.Boolean,
} satisfies Fields;

const withDismissedKeys = {
  ...clientPrefsValues,
  dismissedProviderUpdateNotificationKeys: Schema.Array(NonblankString),
} satisfies Fields;

export const ClientPrefsSchema = Schema.Struct(
  withDefaults(withDismissedKeys, {
    notificationMode: "off",
    inAppNotificationsEnabled: false,
    diffColorScheme: "red-green",
    loadBalancingEnabled: false,
    loadBalancingWeights: {},
    appearanceContrast: 100,
    panelAnimationDurationMs: 0,
    browserDefaultViewport: FILL_WEB_VIEWPORT,
    browserDefaultZoomFactor: DEFAULT_WEB_ZOOM_FACTOR,
    browserDefaultAppearance: DEFAULT_WEB_APPEARANCE,
    browserRecordingFrameRate: 30,
    browserLinkTarget: "app",
    browserProfiles: [],
    browserDefaultProfileId: DEFAULT_WEB_PROFILE_ID,
    confirmThreadArchive: false,
    confirmThreadDelete: true,
    confirmThreadUnpin: false,
    dismissedProviderUpdateNotificationKeys: [],
    diffFilesCollapsed: false,
    diffIgnoreWhitespace: true,
    diffLayout: "stacked",
    hostIdentificationMode: "artwork",
    glassOpacity: 80,
    fontSizeInterface: DEFAULT_INTERFACE_FONT_SIZE,
    fontSizePrompt: DEFAULT_PROMPT_FONT_SIZE,
    fontSizeCode: DEFAULT_CODE_FONT_SIZE,
    fontSizeTerminal: 12,
    ...{ fontFamilyTerminal: "", fontFamilySans: "", fontFamilyComposer: "", fontFamilyCode: "" },
    fontSmoothing: true,
    onboardingCompletedAt: null,
    favorites: [],
    providerModelPreferences: {},
    pullRequestMergeMethodOverrides: {},
    planModeEnabled: true,
    composerCollapseOnScroll: false,
    proactivePanelsEnabled: false,
    showSkillsInSlashMenu: true,
    legacySidebarEnabled: false,
    sidebarProjectGroupingMode: "repository",
    sidebarProjectGroupingOverrides: {},
    sidebarProjectSortOrder: "updated_at",
    sidebarThreadSortOrder: "updated_at",
    sidebarThreadPreviewCount: 6,
    sidebarWorkingStyle: "outline",
    timestampFormat: "locale",
    captureEnabled: false,
    captureIncludeAccessibility: true,
    capturePlaySound: true,
    captureSound: "soft-pop",
    captureFlash: true,
    captureAnimations: true,
    wordWrap: true,
    showKoraSavings: true,
  }),
);
export type ClientPrefs = typeof ClientPrefsSchema.Type;

export const DEFAULT_CLIENT_PREFS: ClientPrefs = Schema.decodeSync(ClientPrefsSchema)({});

export const ClientPrefsPatch = Schema.Struct(optionalKeys(clientPrefsValues));
export type ClientPrefsPatch = typeof ClientPrefsPatch.Type;

// ---------------------------------------------------------------------------
// Daemon helper types
// ---------------------------------------------------------------------------

const costRate = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/** USD per million tokens; omitted cache rates use the input rate. */
export const UsageModelPriceOverride = Schema.Struct({
  inputCostPerMillionTokens: costRate,
  outputCostPerMillionTokens: costRate,
  cacheReadCostPerMillionTokens: Schema.optionalKey(costRate),
  cacheWriteCostPerMillionTokens: Schema.optionalKey(costRate),
});
export type UsageModelPriceOverride = typeof UsageModelPriceOverride.Type;

// How the web client builds a settings form for an agent from its prefs schema.
export type AgentPrefsFormControl = "text" | "password" | "textarea" | "switch" | "select";

export interface AgentPrefsFormOption {
  readonly value: string;
  readonly label: string;
}

export interface AgentPrefsFormAnnotation {
  readonly control?: AgentPrefsFormControl;
  readonly placeholder?: string;
  readonly hidden?: boolean;
  readonly clearWhenEmpty?: "omit" | "persist";
  /** The first option is the default. */
  readonly options?: ReadonlyArray<AgentPrefsFormOption>;
}

export interface AgentPrefsFormSchemaAnnotation {
  readonly order?: ReadonlyArray<string>;
}

export type AgentPrefsOrder<F extends Fields> = ReadonlyArray<Extract<keyof F, string>>;

interface FieldSpec<S extends Schema.Constraint> {
  readonly base: S;
  readonly value: S["Encoded"];
  readonly form?: AgentPrefsFormAnnotation | undefined;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
}

const field = <S extends Schema.Constraint>(
  base: S,
  value: S["Encoded"],
  meta: {
    readonly title?: string;
    readonly description?: string;
    readonly form?: AgentPrefsFormAnnotation;
  } = {},
): FieldSpec<S> => ({
  base,
  value,
  form: meta.form,
  title: meta.title,
  description: meta.description,
});

type SpecMap = Record<string, FieldSpec<Schema.Constraint>>;
type SpecDefaulted<T extends SpecMap> = {
  readonly [K in keyof T]: T[K] extends FieldSpec<infer S> ? Schema.withDecodingDefault<S> : never;
};
type SpecOptional<T extends SpecMap> = {
  readonly [K in keyof T]: T[K] extends FieldSpec<infer S> ? Schema.optionalKey<S> : never;
};

/** One agent's prefs: the struct with defaults and form annotations, plus its patch struct. */
const prefsStruct = <const T extends SpecMap>(specs: T, order: ReadonlyArray<string>) => {
  const defaulted: Record<string, unknown> = {};
  const optional: Record<string, unknown> = {};
  for (const key of Object.keys(specs)) {
    const spec = specs[key]!;
    const annotations: Record<string, unknown> = {};
    if (spec.title !== undefined) annotations.title = spec.title;
    if (spec.description !== undefined) annotations.description = spec.description;
    if (spec.form !== undefined) annotations.providerSettingsForm = spec.form;
    const withDefault = (spec.base as never as { pipe: (f: unknown) => Schema.Top }).pipe(
      Schema.withDecodingDefault(Effect.succeed(spec.value)),
    );
    defaulted[key] =
      Object.keys(annotations).length > 0 ? withDefault.annotateKey(annotations) : withDefault;
    optional[key] = Schema.optionalKey(spec.base);
  }
  const formSchema: AgentPrefsFormSchemaAnnotation = { order };
  return {
    schema: Schema.Struct(defaulted as SpecDefaulted<T>).annotate({
      providerSettingsFormSchema: formSchema,
    }),
    patch: Schema.Struct(optional as SpecOptional<T>),
  };
};

const hidden: AgentPrefsFormAnnotation = { hidden: true };

/** A path that decodes trimmed, with an empty value meaning the named binary. */
const binaryPath = (fallback: string) => {
  const trimming = SchemaTransformation.transform({
    encode: (value: string) => value.trim(),
    decode: (value: string) => value.trim() || fallback,
  });
  return Schema.String.pipe(Schema.decodeTo(Schema.String, trimming));
};

const trimmedText = TrimmedString;
const modelList = Schema.Array(CustomModelSpec);

// ---------------------------------------------------------------------------
// Per-agent prefs (the legacy single-instance-per-driver settings)
// ---------------------------------------------------------------------------

// Per-agent connection fields (binary path, home dir, launch arguments, auto-compact window, API endpoint) were once
// editable on each Agents card. Nothing reads them: Kora finds each CLI itself (an explicit path lives in Settings >
// Engines) and drives it with its own flags, and the compaction size is Settings > Defaults. They stay in the schema,
// hidden, so a settings file that holds them still decodes.
const codexPrefs = prefsStruct(
  {
    enabled: field(Schema.Boolean, true, { form: hidden }),
    binaryPath: field(binaryPath("codex"), "codex", { form: hidden }),
    homePath: field(trimmedText, "", { form: hidden }),
    shadowHomePath: field(trimmedText, "", { form: hidden }),
    launchArgs: field(trimmedText, "", { form: hidden }),
    customModels: field(modelList, [], { form: hidden }),
  },
  [],
);
export const CodexPrefs = codexPrefs.schema;
export type CodexPrefs = typeof CodexPrefs.Type;

const claudePrefs = prefsStruct(
  {
    enabled: field(Schema.Boolean, true, { form: hidden }),
    binaryPath: field(binaryPath("claude"), "claude", { form: hidden }),
    homePath: field(trimmedText, "", { form: hidden }),
    customModels: field(modelList, [], { form: hidden }),
    launchArgs: field(trimmedText, "", { form: hidden }),
    // Empty (Claude's own default) or 100000..1000000 tokens.
    autoCompactWindow: field(
      TrimmedString.check(Schema.isPattern(/^(?:|[1-9]\d{5}|1000000)$/)),
      "",
      { form: hidden },
    ),
  },
  [],
);
export const ClaudePrefs = claudePrefs.schema;
export type ClaudePrefs = typeof ClaudePrefs.Type;

const cursorPrefs = prefsStruct(
  {
    // Off until the user opts in from Settings.
    enabled: field(Schema.Boolean, false, { form: hidden }),
    binaryPath: field(binaryPath("cursor-agent"), "cursor-agent", { form: hidden }),
    apiEndpoint: field(trimmedText, "", { form: hidden }),
    customModels: field(modelList, [], { form: hidden }),
  },
  [],
);
export const CursorPrefs = cursorPrefs.schema;
export type CursorPrefs = typeof CursorPrefs.Type;

const grokPrefs = prefsStruct(
  {
    // The binding is not yet stable enough to probe on every install.
    enabled: field(Schema.Boolean, false, { form: hidden }),
    binaryPath: field(binaryPath("grok"), "grok", { form: hidden }),
    customModels: field(modelList, [], { form: hidden }),
  },
  [],
);
export const GrokPrefs = grokPrefs.schema;
export type GrokPrefs = typeof GrokPrefs.Type;

// Antigravity (`agy`) signs in with its own Google login (`agy` in Terminal) and is found automatically; an explicit
// path lives in Settings > Engines. Nothing to configure here (the old ACP-era sign-in / API-key / GCP fields were never
// read by the AntigravityDriver and are gone).
const antigravityPrefs = prefsStruct(
  {
    enabled: field(Schema.Boolean, true, { form: hidden }),
    customModels: field(modelList, [], { form: hidden }),
  },
  [],
);
export const AntigravityPrefs = antigravityPrefs.schema;
export type AntigravityPrefs = typeof AntigravityPrefs.Type;

const openCodePrefs = prefsStruct(
  {
    enabled: field(Schema.Boolean, false, { form: hidden }),
    binaryPath: field(binaryPath("opencode"), "opencode", { form: hidden }),
    // Kora drives OpenCode with `opencode run`, never a server: these two have no effect.
    serverUrl: field(trimmedText, "", { form: hidden }),
    serverPassword: field(trimmedText, "", { form: hidden }),
    customModels: field(modelList, [], { form: hidden }),
  },
  [],
);
export const OpenCodePrefs = openCodePrefs.schema;
export type OpenCodePrefs = typeof OpenCodePrefs.Type;

// ---------------------------------------------------------------------------
// Other daemon pref structs
// ---------------------------------------------------------------------------

/** An external quota source. The key travels in settings and is redacted before it reaches a client. */
export const UsageLimitSourceConfig = Schema.Struct({
  kind: Schema.Literal("cliproxy"),
  label: Schema.optionalKey(NonblankString),
  url: NonblankString,
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  managementKey: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type UsageLimitSourceConfig = (typeof UsageLimitSourceConfig)["Type"];

const tracingValues = { otlpTracesUrl: TrimmedString, otlpMetricsUrl: TrimmedString };
export const TracingPrefs = Schema.Struct(
  withDefaults(tracingValues, { otlpTracesUrl: "", otlpMetricsUrl: "" }),
);
export type TracingPrefs = typeof TracingPrefs.Type;

const writingStyleValues = {
  mode: SourceControlWritingStyleMode,
  customInstructions: TrimmedString,
  followChangeRequestTemplates: Schema.Boolean,
};
export const SourceControlWritingStylePrefs = Schema.Struct(
  withDefaults(writingStyleValues, {
    followChangeRequestTemplates: true,
    customInstructions: "",
    mode: "repo_conventions",
  }),
);
export type SourceControlWritingStylePrefs = typeof SourceControlWritingStylePrefs.Type;

// ---------------------------------------------------------------------------
// Background activity
// ---------------------------------------------------------------------------

const durationFromMillis = Schema.DurationFromMillis;
const optionalPauseFlag = Schema.optionalKey(Schema.Boolean);

export const BackgroundActivityOverrides = Schema.Struct({
  automaticGitFetchInterval: Schema.optionalKey(durationFromMillis),
  providerHealthRefreshInterval: Schema.optionalKey(durationFromMillis),
  hostPowerMonitorActiveInterval: Schema.optionalKey(durationFromMillis),
  hostPowerMonitorIdleInterval: Schema.optionalKey(durationFromMillis),
  idleClientTtl: Schema.optionalKey(durationFromMillis),
  pauseWhenOnBattery: optionalPauseFlag,
  pauseWhenClientLowPower: optionalPauseFlag,
  pauseWhenHostLowPower: optionalPauseFlag,
  pauseWhenHostLocked: optionalPauseFlag,
});
export type BackgroundActivityOverrides = (typeof BackgroundActivityOverrides)["Type"];

export const BackgroundActivityPrefs = Schema.Struct({
  overrides: BackgroundActivityOverrides.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  baseProfile: Schema.optionalKey(BackgroundActivityProfile),
  profile: BackgroundActivityProfileSelection.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BACKGROUND_ACTIVITY_PROFILE)),
  ),
  schemaVersion: Schema.Literal(1).pipe(Schema.withDecodingDefault(Effect.succeed(1 as const))),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type BackgroundActivityPrefs = (typeof BackgroundActivityPrefs)["Type"];

// ---------------------------------------------------------------------------
// Per-project overrides
// ---------------------------------------------------------------------------

// Everything not listed here is environment-wide.
const PROJECT_DEFAULT_KEYS = [
  "defaultThreadEnvMode",
  "defaultRuntimeMode",
  "defaultModelSelection",
] as const;
const PROJECT_WORKTREE_KEYS = [
  "defaultProjectScripts",
  "defaultAutoPull",
  "newWorktreesStartFromOrigin",
] as const;
const PROJECT_AGENT_ACCESS_KEYS = ["enableAgentBrowserAccess", "enableAgentDeviceAccess"] as const;
const PROJECT_WRITER_MODEL_KEYS = [
  "textGenerationModelSelection",
  "sourceControlWriterModelSelection",
] as const;
const PROJECT_WRITER_KEYS = [...PROJECT_WRITER_MODEL_KEYS, "sourceControlWritingStyle"] as const;
const PROJECT_FOLLOW_UP_KEYS = [
  "pullRequestMergeMethod",
  ...(["sidebarAutoSettleOnMerge", "sidebarAutoSettleAfterDays"] as const),
] as const;
export const PROJECT_SCOPED_DAEMON_SETTING_KEYS = [
  ...PROJECT_DEFAULT_KEYS,
  ...PROJECT_WORKTREE_KEYS,
  ...PROJECT_AGENT_ACCESS_KEYS,
  ...PROJECT_WRITER_KEYS,
  ...PROJECT_FOLLOW_UP_KEYS,
  "continueThreadsAfterServerUpdate",
  "responseStreamingMode",
] as const;
export type ProjectScopedDaemonSettingKey = (typeof PROJECT_SCOPED_DAEMON_SETTING_KEYS)[number];

// An absent key inherits the environment value; null is a real value where the type is nullable.
export const ProjectPrefsOverrides = Schema.Struct({
  defaultModelSelection: Schema.optionalKey(Schema.NullOr(ModelPick)),
  defaultRuntimeMode: Schema.optionalKey(AccessMode),
  defaultThreadEnvMode: Schema.optionalKey(ThreadWorkspaceMode),
  newWorktreesStartFromOrigin: Schema.optionalKey(Schema.Boolean),
  defaultAutoPull: Schema.optionalKey(Schema.Boolean),
  defaultProjectScripts: Schema.optionalKey(Schema.Array(ProjectAction)),
  enableAgentBrowserAccess: Schema.optionalKey(Schema.Boolean),
  enableAgentDeviceAccess: Schema.optionalKey(Schema.Boolean),
  textGenerationModelSelection: Schema.optionalKey(ModelPick),
  sourceControlWriterModelSelection: Schema.optionalKey(Schema.NullOr(ModelPick)),
  sourceControlWritingStyle: Schema.optionalKey(SourceControlWritingStylePrefs),
  pullRequestMergeMethod: Schema.optionalKey(Schema.NullOr(MergeRequestMergeMethod)),
  sidebarAutoSettleOnMerge: Schema.optionalKey(Schema.Boolean),
  sidebarAutoSettleAfterDays: Schema.optionalKey(Schema.NullOr(NavAutoSettleAfterDays)),
  continueThreadsAfterServerUpdate: Schema.optionalKey(Schema.Boolean),
  responseStreamingMode: Schema.optionalKey(ResponseStreamingMode),
});
export type ProjectPrefsOverrides = typeof ProjectPrefsOverrides.Type;

// ---------------------------------------------------------------------------
// DaemonPrefs
// ---------------------------------------------------------------------------

const textGenerationDefault = {
  instanceId: "codex",
  model: DEFAULT_TEXT_GENERATION_MODEL,
  options: [{ id: "reasoningEffort", value: DEFAULT_TEXT_GENERATION_REASONING_EFFORT }],
};

const daemonPrefsValues = {
  responseStreamingMode: ResponseStreamingMode,
  enableProviderUpdateChecks: Schema.Boolean,
  continueThreadsAfterServerUpdate: Schema.Boolean,
  // Off withholds the MCP credential, so the preview tools and their prompt text are not attached.
  enableAgentBrowserAccess: Schema.Boolean,
  projectAgentBrowserAccessOverrides: Schema.Record(ProjectId, Schema.Boolean),
  defaultAutoPull: Schema.Boolean,
  defaultProjectScripts: Schema.Array(ProjectAction),
  projectScriptOverrides: Schema.Record(ProjectId, Schema.NullOr(Schema.Array(ProjectAction))),
  projectAutoPullOverrides: Schema.Record(ProjectId, Schema.Boolean),
  defaultModelSelection: Schema.NullOr(ModelPick),
  defaultRuntimeMode: AccessMode,
  // Days a slept worker keeps its unmerged branch; 0 keeps it until deleted by hand.
  workerBranchRetentionDays: Schema.Int,
  // Privacy: Claude processes Kora starts get DISABLE_TELEMETRY + CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC (off by default).
  limitClaudeTelemetry: Schema.Boolean,
  // Where Claude sessions Kora starts compact (CLAUDE_CODE_AUTO_COMPACT_WINDOW): 200k default, 400k, or the model's full window.
  claudeCompactAt: Schema.Literals(["200k", "400k", "full"]),
  // Token savings (Settings > Context). Bounded reads: a whole-file Read of a long code file in an indexed repo becomes a
  // window plus the file's outline; "shadow" only logs what it would have done. Lean context: new threads hide skills and
  // Claude's auto-memory. The daemon and every pane hook read these from <KORA_HOME>/settings.json (runtime
  // util/savings-settings.ts holds the same default for boundedReads - keep the two in step).
  boundedReads: Schema.Literals(["off", "shadow", "on"]),
  // denyAnswer: the one-time identifier-search redirect carries the graph's answer ("shadow" only logs it; runtime util/savings-settings.ts holds the same default).
  denyAnswer: Schema.Literals(["off", "shadow", "on"]),
  leanContext: Schema.Boolean,
  // Context lifecycle (Settings > Context; runtime util/lifecycle-settings.ts holds the same defaults - keep the two in step).
  // coldResumeMasking: a thread resumed after its prompt cache expired (1 h) continues from a copy with old tool outputs elided.
  // taskBoundaryChip: offer "compact first" / "fresh thread with a brief" when a prompt starts a new task in a long thread.
  // modelSwitchChip: a line saying what a mid-thread model switch re-cached. runawayGuard: a "looks stuck" line when a turn
  // repeats the same Read / failing call.
  coldResumeMasking: Schema.Boolean,
  taskBoundaryChip: Schema.Boolean,
  modelSwitchChip: Schema.Boolean,
  runawayGuard: Schema.Boolean,
  // More token savings (Settings > Token savings; runtime util/savings-settings.ts holds the same defaults - keep the two in step).
  // injectRecall: edit-shaped prompts and "that file" follow-ups get a graph declaration / outline. codexSavings: Codex turns carry
  // tool-output and auto-compact limits. swarmTokenCeiling: fresh tokens one Swarm worker may use before it is told to stop
  // exploring (0 = no ceiling). quickAnswers: "who calls X" in the composer is answered from the graph with no agent turn.
  // bashTrim: a big Bash result (over 8k chars) is trimmed to its head, error lines and tail (default "on"; "shadow" only logs what it would save).
  injectRecall: Schema.Boolean,
  codexSavings: Schema.Boolean,
  swarmTokenCeiling: Schema.Int,
  quickAnswers: Schema.Boolean,
  // autoModel: a Claude thread whose model is "Auto" runs light work (a question, a lookup, a one-place edit, a chore) on Haiku 5.5 and
  // everything else on the Default; off makes "Auto" run the Default (runtime util/savings-settings.ts holds the same default).
  autoModel: Schema.Boolean,
  // autoSonnet: with Auto on and an Opus or Fable Default, ordinary work runs on Sonnet 5.5 at high effort (about half the price per
  // token, a few points lower on hard coding benchmarks). Off by default (runtime util/savings-settings.ts holds the same default).
  autoSonnet: Schema.Boolean,
  // autoHeadroom: with Auto on and an Opus or Fable Default, NEW ordinary work starts on Sonnet 5.5 at high effort while a Claude plan
  // window is at 85%+ (runtime session/plan-headroom.ts; util/savings-settings.ts holds the same default, on).
  autoHeadroom: Schema.Boolean,
  // autoEffort: with Auto on, a turn that is only a chore (commit, push, run the tests) runs at low effort and one that says the last
  // answer was wrong at high (runtime session/auto-model.ts turnEffort; util/savings-settings.ts holds the same default, off).
  autoEffort: Schema.Boolean,
  // leadHandoff: a chat thread is told that a run of five or more of its own commands is cheaper in a fresh worker on a cheap
  // model (runtime server/orchestrator-skill.ts; util/savings-settings.ts holds the same default, off).
  leadHandoff: Schema.Boolean,
  bashTrim: Schema.Literals(["off", "shadow", "on"]),
  // chatReadDedupe: a Read of a file already read in this context segment, unchanged since ("shadow" only logs it, "nudge" tells the
  // agent, "deny" refuses the first re-read and allows the second; runtime util/savings-settings.ts holds the same default).
  chatReadDedupe: Schema.Literals(["off", "shadow", "nudge", "deny"]),
  // injectBugProse: a bug described in plain English with no identifier gets the 2-3 likeliest declarations from the graph when one is
  // clearly ahead ("shadow" only logs what it would hand over; runtime util/savings-settings.ts holds the same default - keep the two in step).
  injectBugProse: Schema.Literals(["off", "shadow", "on"]),
  // Cache keep-warm: a loopback proxy replays a thread's last request (max_tokens 0, billed as a cache read) just before its prompt
  // cache entry expires, so coming back after an hour does not re-write the context. Off by default (the relay carries the login headers,
  // and Anthropic does not allow third parties to intermediate Claude.ai credentials); "shadow" only logs what it would
  // send (runtime util/savings-settings.ts holds the same default - keep the two in step).
  cacheWarm: Schema.Literals(["off", "shadow", "on"]),
  // The source of truth. The three legacy per-project records above are derived views kept for older clients.
  projectSettingsOverrides: Schema.Record(ProjectId, ProjectPrefsOverrides),
  // Legacy fields fold into the overrides once, so a later reset is not undone at the next start.
  projectSettingsFolded: Schema.Boolean,
  enableAgentDeviceAccess: Schema.Boolean,
  enableDeviceSupport: Schema.Boolean,
  deviceOnboardingCompleted: Schema.Boolean,
  sidebarAutoSettleAfterDays: Schema.NullOr(NavAutoSettleAfterDays),
  sidebarAutoSettleOnMerge: Schema.Boolean,
  defaultTheme: DefaultThemePreference,
  // Lets a client tell "the same theme set again" from "already applied".
  defaultThemeSetAt: Schema.String.check(Schema.isMaxLength(64)),
  defaultThreadEnvMode: ThreadWorkspaceMode,
  newWorktreesStartFromOrigin: Schema.Boolean,
  addProjectBaseDirectory: TrimmedString,
  textGenerationModelSelection: ModelPick,
  sourceControlWritingStyle: SourceControlWritingStylePrefs,
  sourceControlWriterModelSelection: Schema.NullOr(ModelPick),
  // Null reuses the method last chosen on the device.
  pullRequestMergeMethod: Schema.NullOr(MergeRequestMergeMethod),
  observability: TracingPrefs,
  usageLimitSources: Schema.Record(QuotaSourceId, UsageLimitSourceConfig),
  usagePriceOverrides: Schema.Record(NonblankString, UsageModelPriceOverride),
  providerInstances: Schema.Record(AgentProfileId, AgentProfileConfig),
} satisfies Fields;

const legacyProvidersValues = {
  codex: CodexPrefs,
  claude: ClaudePrefs,
  cursor: CursorPrefs,
  grok: GrokPrefs,
  opencode: OpenCodePrefs,
  antigravity: AntigravityPrefs,
} satisfies Fields;

export const DaemonPrefs = Schema.Struct({
  ...withDefaults(daemonPrefsValues, {
    responseStreamingMode: "paragraph",
    enableProviderUpdateChecks: true,
    continueThreadsAfterServerUpdate: false,
    enableAgentBrowserAccess: true,
    projectAgentBrowserAccessOverrides: {},
    defaultAutoPull: false,
    defaultProjectScripts: [],
    projectScriptOverrides: {},
    projectAutoPullOverrides: {},
    defaultModelSelection: null,
    defaultRuntimeMode: DEFAULT_ACCESS_MODE,
    workerBranchRetentionDays: 30,
    limitClaudeTelemetry: false,
    claudeCompactAt: "200k",
    boundedReads: "shadow",
    denyAnswer: "shadow",
    leanContext: false,
    coldResumeMasking: true,
    taskBoundaryChip: true,
    modelSwitchChip: true,
    runawayGuard: true,
    injectRecall: true,
    codexSavings: true,
    swarmTokenCeiling: 2500000,
    quickAnswers: true,
    autoModel: false,
    autoSonnet: false,
    autoHeadroom: true,
    autoEffort: false,
    leadHandoff: false,
    bashTrim: "on",
    chatReadDedupe: "shadow",
    injectBugProse: "shadow",
    cacheWarm: "off",
    projectSettingsOverrides: {},
    projectSettingsFolded: false,
    enableAgentDeviceAccess: false,
    enableDeviceSupport: false,
    deviceOnboardingCompleted: false,
    sidebarAutoSettleAfterDays: 3,
    sidebarAutoSettleOnMerge: true,
    defaultTheme: "",
    defaultThemeSetAt: "",
    defaultThreadEnvMode: "local",
    newWorktreesStartFromOrigin: true,
    addProjectBaseDirectory: "",
    textGenerationModelSelection: textGenerationDefault,
    sourceControlWritingStyle: {},
    sourceControlWriterModelSelection: null,
    pullRequestMergeMethod: null,
    observability: {},
    usageLimitSources: {},
    usagePriceOverrides: {},
    providerInstances: {},
  }),
  backgroundActivity: BackgroundActivityPrefs,
  // Legacy flat fields, kept for old files and old clients.
  automaticGitFetchInterval: durationFromMillis.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(Duration.toMillis(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL)),
    ),
  ),
  providerHealthRefreshInterval: durationFromMillis.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(Duration.toMillis(DEFAULT_AGENT_HEALTH_REFRESH_INTERVAL)),
    ),
  ),
  backgroundActivityProfile: BackgroundActivityProfile.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BACKGROUND_ACTIVITY_PROFILE)),
  ),
  hostIcon: ForwardCompatibleNullable(HostMachineKind),
  // The per-agent settings stay authoritative until providerInstances is hydrated.
  providers: Schema.Struct(
    withDefaults(legacyProvidersValues, {
      codex: {},
      claude: {},
      cursor: {},
      grok: {},
      opencode: {},
      antigravity: {},
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
export type DaemonPrefs = typeof DaemonPrefs.Type;

export const DEFAULT_DAEMON_PREFS: DaemonPrefs = Schema.decodeSync(DaemonPrefs)({});

export type UnifiedPrefs = DaemonPrefs & ClientPrefs;
export const DEFAULT_UNIFIED_PREFS: UnifiedPrefs = {
  ...DEFAULT_DAEMON_PREFS,
  ...DEFAULT_CLIENT_PREFS,
};

/**
 * Whether an agent instance is on. An explicit false anywhere wins; otherwise the
 * envelope flag, then the config blob's own flag, then the driver's default
 * (unknown drivers are enabled).
 */
export function resolveAgentProfileEnabled(
  instance: Pick<AgentProfileConfig, "driver" | "enabled" | "config">,
): boolean {
  const configFlag =
    typeof instance.config === "object" && instance.config !== null
      ? (instance.config as { enabled?: unknown }).enabled
      : undefined;
  if (instance.enabled === false || configFlag === false) return false;
  if (typeof instance.enabled === "boolean") return instance.enabled;
  if (typeof configFlag === "boolean") return configFlag;
  const defaults = DEFAULT_DAEMON_PREFS.providers as Record<
    string,
    { enabled?: boolean } | undefined
  >;
  return defaults[instance.driver]?.enabled ?? true;
}

export const DaemonPrefsOperation = Schema.Literals([
  "normalize",
  "check-exists",
  ...(["read-file", "read-provider-history", "read-project-settings"] as const),
  ...(["read-secret", "remove-secret", "remove-stale-secret"] as const),
  ...(["write-secret", "write-file", "prepare-directory"] as const),
]);
export type DaemonPrefsOperation = typeof DaemonPrefsOperation.Type;

export class DaemonPrefsError extends Schema.TaggedError<DaemonPrefsError>()("DaemonPrefsError", {
  settingsPath: Schema.String,
  operation: DaemonPrefsOperation,
  cause: Schema.Defect(),
  environmentVariable: Schema.optional(Schema.String),
  providerInstanceId: Schema.optional(Schema.String),
}) {
  override get message() {
    const forProvider =
      this.providerInstanceId === undefined ? "" : " for provider " + this.providerInstanceId;
    const withEnv =
      this.environmentVariable === undefined
        ? ""
        : " and environment variable " + this.environmentVariable;
    return (
      "Server settings " +
      this.operation +
      " failed" +
      forProvider +
      withEnv +
      " at " +
      this.settingsPath +
      "."
    );
  }
}

// ---------------------------------------------------------------------------
// DaemonPrefsPatch
// ---------------------------------------------------------------------------

const nullablePerProject = <S extends Schema.Constraint>(value: S) =>
  Schema.Record(ProjectId, Schema.NullOr(value));

export const DaemonPrefsPatch = Schema.Struct({
  ...optionalKeys({
    responseStreamingMode: ResponseStreamingMode,
    enableProviderUpdateChecks: Schema.Boolean,
    continueThreadsAfterServerUpdate: Schema.Boolean,
    enableAgentBrowserAccess: Schema.Boolean,
    projectAgentBrowserAccessOverrides: nullablePerProject(Schema.Boolean),
    defaultAutoPull: Schema.Boolean,
    defaultProjectScripts: Schema.Array(ProjectAction),
    projectScriptOverrides: nullablePerProject(Schema.Array(ProjectAction)),
    projectAutoPullOverrides: nullablePerProject(Schema.Boolean),
    defaultModelSelection: Schema.NullOr(ModelPick),
    defaultRuntimeMode: AccessMode,
    workerBranchRetentionDays: Schema.Int,
    limitClaudeTelemetry: Schema.Boolean,
    claudeCompactAt: Schema.Literals(["200k", "400k", "full"]),
    boundedReads: Schema.Literals(["off", "shadow", "on"]),
    denyAnswer: Schema.Literals(["off", "shadow", "on"]),
    leanContext: Schema.Boolean,
    coldResumeMasking: Schema.Boolean,
    taskBoundaryChip: Schema.Boolean,
    modelSwitchChip: Schema.Boolean,
    runawayGuard: Schema.Boolean,
    injectRecall: Schema.Boolean,
    codexSavings: Schema.Boolean,
    swarmTokenCeiling: Schema.Int,
    quickAnswers: Schema.Boolean,
    autoModel: Schema.Boolean,
    autoSonnet: Schema.Boolean,
    autoHeadroom: Schema.Boolean,
    autoEffort: Schema.Boolean,
    leadHandoff: Schema.Boolean,
    bashTrim: Schema.Literals(["off", "shadow", "on"]),
    chatReadDedupe: Schema.Literals(["off", "shadow", "nudge", "deny"]),
    injectBugProse: Schema.Literals(["off", "shadow", "on"]),
    cacheWarm: Schema.Literals(["off", "shadow", "on"]),
    // Each entry replaces that project's whole override set; null removes it. To clear one
    // override, resend the entry without the key (a per-key null cannot say "clear").
    projectSettingsOverrides: nullablePerProject(ProjectPrefsOverrides),
    enableAgentDeviceAccess: Schema.Boolean,
    enableDeviceSupport: Schema.Boolean,
    deviceOnboardingCompleted: Schema.Boolean,
    sidebarAutoSettleAfterDays: Schema.NullOr(NavAutoSettleAfterDays),
    sidebarAutoSettleOnMerge: Schema.Boolean,
    backgroundActivity: Schema.Struct({
      overrides: Schema.optionalKey(BackgroundActivityOverrides),
      baseProfile: Schema.optionalKey(BackgroundActivityProfile),
      profile: Schema.optionalKey(BackgroundActivityProfileSelection),
      schemaVersion: Schema.optionalKey(Schema.Literal(1)),
    }),
    automaticGitFetchInterval: durationFromMillis,
    providerHealthRefreshInterval: durationFromMillis,
    backgroundActivityProfile: BackgroundActivityProfile,
    hostIcon: Schema.NullOr(HostMachineKind),
    defaultThreadEnvMode: ThreadWorkspaceMode,
    newWorktreesStartFromOrigin: Schema.Boolean,
    addProjectBaseDirectory: TrimmedString,
    // A partial ModelPick.
    textGenerationModelSelection: Schema.Struct({
      instanceId: Schema.optionalKey(AgentProfileId),
      model: Schema.optionalKey(NonblankString),
      options: Schema.optionalKey(AgentOptionSelections),
    }),
    sourceControlWritingStyle: Schema.Struct(optionalKeys(writingStyleValues)),
    sourceControlWriterModelSelection: Schema.NullOr(ModelPick),
    pullRequestMergeMethod: Schema.NullOr(MergeRequestMergeMethod),
    observability: Schema.Struct(optionalKeys(tracingValues)),
    providers: Schema.Struct({
      codex: Schema.optionalKey(codexPrefs.patch),
      claude: Schema.optionalKey(claudePrefs.patch),
      cursor: Schema.optionalKey(cursorPrefs.patch),
      grok: Schema.optionalKey(grokPrefs.patch),
      opencode: Schema.optionalKey(openCodePrefs.patch),
      antigravity: Schema.optionalKey(antigravityPrefs.patch),
    }),
    // Whole-map replacement; the web UI always sends a fully formed map.
    providerInstances: Schema.Record(AgentProfileId, AgentProfileConfig),
    // Per-entry; null removes. The server merges into its current map to avoid races.
    usageLimitSources: Schema.Record(QuotaSourceId, Schema.NullOr(UsageLimitSourceConfig)),
    // Null restores automatic pricing.
    usagePriceOverrides: Schema.Record(NonblankString, Schema.NullOr(UsageModelPriceOverride)),
  }),
});
export type DaemonPrefsPatch = typeof DaemonPrefsPatch.Type;
