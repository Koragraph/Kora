import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ForwardCompatibleOptional,
  HostId,
  NonblankString,
  ProjectId,
  ThreadId,
} from "./primitives.ts";

export const HostPlatformOs = Schema.Literals(["darwin", "linux", "windows", "unknown"]);
export type HostPlatformOs = typeof HostPlatformOs.Type;

export const HostPlatformArch = Schema.Literals(["arm64", "x64", "other"]);
export type HostPlatformArch = typeof HostPlatformArch.Type;

/** The curated icon set for a host; detected from hardware, overridable with the `hostIcon` setting. */
export const HostMachineKind = Schema.Literals([
  "server",
  "cloud",
  "linux",
  "desktop",
  "laptop",
  "mac-mini",
  "mac-studio",
]);
export type HostMachineKind = typeof HostMachineKind.Type;

export const HostPlatform = Schema.Struct({
  os: HostPlatformOs,
  arch: HostPlatformArch,
  // Absent when there is no usable signal, the server is older, or the kind is one this build cannot draw.
  machine: ForwardCompatibleOptional(HostMachineKind),
});
export type HostPlatform = typeof HostPlatform.Type;

// Lives here (not in chat) to avoid an import cycle.
export const ThreadWorkspaceMode = Schema.Literals(["local", "worktree"]);
export type ThreadWorkspaceMode = typeof ThreadWorkspaceMode.Type;

export const DaemonSelfUpdateMethod = Schema.Literals(["boot-service", "respawn", "desktop-app"]);
export type DaemonSelfUpdateMethod = typeof DaemonSelfUpdateMethod.Type;

export const DaemonSelfUpdateCapability = Schema.Literals([
  "boot-service",
  "respawn",
  "desktop-managed",
]);
export type DaemonSelfUpdateCapability = typeof DaemonSelfUpdateCapability.Type;

const flag = Schema.optionalKey(Schema.Boolean);

/**
 * What a host advertises for version-skew gating. Every key except
 * `repositoryIdentity` is absent on older servers, and clients must read absent
 * as "unsupported" (never default these to true).
 */
export const ExecutionHostCapabilities = Schema.Struct({
  repositoryIdentity: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  connectionProbe: flag,
  attachmentUploads: flag,
  questionAttachments: flag,
  fileAttachments: Schema.optionalKey(
    Schema.Struct({ maxUploadBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) }),
  ),
  pullRequests: flag,
  inlineMessageContext: flag,
  threadSettlement: flag,
  threadAutoSettlement: flag,
  threadRestartContinuation: flag,
  projectSettingsOverrides: flag,
  threadSnooze: flag,
  hostThemes: flag,
  swarm: flag,
  usageLimitSources: flag,
  usagePriceOverrides: flag,
  threadPinning: flag,
  threadPinReorder: flag,
  threadActiveReorder: flag,
  threadTitleRegeneration: flag,
  threadPullRequestLinking: flag,
  threadPullRequests: flag,
  pullRequestStackActions: flag,
  serverSelfUpdate: Schema.optionalKey(DaemonSelfUpdateCapability),
  serverSelfUpdateProgress: flag,
  serverUpdateThreadContinuation: flag,
  agentActivityPublishing: flag,
  projectCloneTracking: flag,
  hostIcon: flag,
  desktopAppUpdate: flag,
});
export type ExecutionHostCapabilities = typeof ExecutionHostCapabilities.Type;

export const HostDescriptor = Schema.Struct({
  hostId: HostId,
  label: NonblankString,
  platform: HostPlatform,
  serverVersion: NonblankString,
  capabilities: ExecutionHostCapabilities,
  /** The terminal command for this install (`kora`, or `kora-dev` for Kora Dev). Absent on older servers. */
  cliName: Schema.optionalKey(NonblankString),
});
export type HostDescriptor = typeof HostDescriptor.Type;

export const HostLinkState = Schema.Literals(["connecting", "connected", "disconnected", "error"]);
export type HostLinkState = typeof HostLinkState.Type;

export const RepositoryIdentityLocator = Schema.Struct({
  source: Schema.Literal("git-remote"),
  remoteName: NonblankString,
  remoteUrl: NonblankString,
});
export type RepositoryIdentityLocator = typeof RepositoryIdentityLocator.Type;

export const RepositoryIdentity = Schema.Struct({
  canonicalKey: NonblankString,
  locator: RepositoryIdentityLocator,
  webUrl: Schema.optionalKey(NonblankString),
  rootPath: Schema.optionalKey(NonblankString),
  displayName: Schema.optionalKey(NonblankString),
  provider: Schema.optionalKey(NonblankString),
  owner: Schema.optionalKey(NonblankString),
  name: Schema.optionalKey(NonblankString),
});
export type RepositoryIdentity = typeof RepositoryIdentity.Type;

export const HostProjectRef = Schema.Struct({ hostId: HostId, projectId: ProjectId });
export type HostProjectRef = typeof HostProjectRef.Type;

export const HostThreadRef = Schema.Struct({ hostId: HostId, threadId: ThreadId });
export type HostThreadRef = typeof HostThreadRef.Type;

export const ScopedThreadSessionRef = Schema.Struct({ hostId: HostId, threadId: ThreadId });
export type ScopedThreadSessionRef = typeof ScopedThreadSessionRef.Type;

// ---------------------------------------------------------------------------
// Persisted documents written before "environment" became "host".
// ---------------------------------------------------------------------------

const IDENTIFIER_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const ENVIRONMENT_WORD = /environment/i;
const KEPT_FRAGMENTS = [
  "ShellEnvironment",
  "EnvironmentVariable",
  "environmentVariable",
  "ENVIRONMENT_VARIABLE",
];

const renamedKey = (key: string): string | null => {
  if (!IDENTIFIER_KEY.test(key) || !ENVIRONMENT_WORD.test(key)) return null;
  if (key === "environment" || key === "environments") return null;
  if (KEPT_FRAGMENTS.some((fragment) => key.includes(fragment))) return null;
  return key
    .replace(/ENVIRONMENT/g, "HOST")
    .replace(/Environment/g, "Host")
    .replace(/environment/g, "host");
};

/** Rename legacy `environment*` object keys (never values), keeping the identity of untouched subtrees. */
export function migrateLegacyHostKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    let changed = false;
    const mapped = value.map((item) => {
      const next = migrateLegacyHostKeys(item);
      if (next !== item) changed = true;
      return next;
    });
    return (changed ? mapped : value) as T;
  }
  if (typeof value !== "object" || value === null) return value;

  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  let changed = false;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const target = renamedKey(key);
    const migrated = migrateLegacyHostKeys(source[key]);
    if (target === null) {
      if (migrated !== source[key]) changed = true;
      result[key] = migrated;
      continue;
    }
    changed = true;
    // A key already written under the current name wins over the legacy one.
    if (!Object.hasOwn(source, target)) result[target] = migrated;
  }
  return (changed ? result : value) as T;
}

export function migrateLegacyHostKeysInJsonText(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  const migrated = migrateLegacyHostKeys(parsed);
  return migrated === parsed ? raw : JSON.stringify(migrated);
}
