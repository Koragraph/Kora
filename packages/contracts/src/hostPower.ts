import * as Schema from "effect/Schema";

import { AgentProfileId } from "./agentProfile.ts";
import { HostId, NonblankString, ThreadId } from "./primitives.ts";

export const BackgroundBooleanState = Schema.Literals(["true", "false", "unknown"]);
export type BackgroundBooleanState = (typeof BackgroundBooleanState)["Type"];

export const HostPowerThermalState = Schema.Literals([
  "unknown",
  "nominal",
  "fair",
  "serious",
  "critical",
]);
export type HostPowerThermalState = (typeof HostPowerThermalState)["Type"];

const NODE_POWER_SOURCES = ["node-macos-shell", "node-macos-native"] as const;
export const HostPowerSource = Schema.Literals([
  "unknown",
  ...NODE_POWER_SOURCES,
  ...(["node-linux", "node-windows"] as const),
  "electron-main",
]);
export type HostPowerSource = (typeof HostPowerSource)["Type"];

export const HostPowerSnapshot = Schema.Struct({
  updatedAt: Schema.DateTimeUtc,
  stale: Schema.Boolean,
  thermalState: HostPowerThermalState,
  lowPowerMode: BackgroundBooleanState,
  onBattery: BackgroundBooleanState,
  suspended: Schema.Boolean,
  locked: BackgroundBooleanState,
  idleSeconds: Schema.NullOr(Schema.Number),
  idle: BackgroundBooleanState,
  source: HostPowerSource,
});
export type HostPowerSnapshot = (typeof HostPowerSnapshot)["Type"];

const scopeOf = <const T extends string>(type: T) => Schema.Literal(type);
const cwdScope = <const T extends string>(type: T) =>
  Schema.Struct({ cwd: Schema.String, type: scopeOf(type) });

/** What a client is currently watching, so the daemon knows which refresh work still matters. */
export const BackgroundScope = Schema.Union([
  Schema.Struct({ type: scopeOf("server-config") }),
  Schema.Struct({
    instanceId: Schema.optionalKey(AgentProfileId),
    type: scopeOf("provider-status"),
  }),
  cwdScope("vcs-status"),
  cwdScope("git-refs"),
  Schema.Struct({ type: scopeOf("diagnostics") }),
  Schema.Struct({ threadId: ThreadId, type: scopeOf("thread") }),
]);
export type BackgroundScope = (typeof BackgroundScope)["Type"];

export const ClientKind = Schema.Literals(["web", "desktop-renderer", "mobile", "unknown"]);
export type ClientKind = (typeof ClientKind)["Type"];

export const ClientActivityClientId = NonblankString.check(Schema.isMaxLength(128));
export type ClientActivityClientId = typeof ClientActivityClientId.Type;

export const ClientActivityReportInput = Schema.Struct({
  hostId: Schema.optionalKey(HostId),
  observedAt: Schema.DateTimeUtc,
  ttlMs: Schema.optionalKey(Schema.Number),
  scopes: Schema.Array(BackgroundScope),
  networkType: Schema.optionalKey(Schema.String),
  batteryState: Schema.optionalKey(Schema.Literals(["unknown", "unplugged", "charging", "full"])),
  lowPowerMode: Schema.optionalKey(BackgroundBooleanState),
  appState: Schema.optionalKey(Schema.Literals(["active", "inactive", "background", "unknown"])),
  recentlyInteracted: Schema.Boolean,
  focused: Schema.Boolean,
  visible: Schema.Boolean,
  clientKind: ClientKind,
  clientId: ClientActivityClientId,
});
export type ClientActivityReportInput = (typeof ClientActivityReportInput)["Type"];
