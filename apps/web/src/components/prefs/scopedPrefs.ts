import type { ResolvedPrefsScope } from "./prefsScope";
import {
  clearProjectPrefsOverrides,
  type ProjectSettingSource,
  resolveProjectPrefs,
} from "@kora/shared/projectPrefs";
import {
  PROJECT_SCOPED_DAEMON_SETTING_KEYS,
  type ProjectScopedDaemonSettingKey,
  ClientPrefsSchema,
  type ClientPrefsPatch,
  type DaemonPrefsPatch,
  DaemonPrefs,
  type ProjectId,
  type HostId,
} from "@kora/contracts";
import type { HostLinkPhase } from "@kora/client-runtime/link";
import * as Equal from "effect/Equal";

export type ScopedPrefsPatch = DaemonPrefsPatch & ClientPrefsPatch;

interface ScopedPrefsHost {
  readonly hostId: HostId;
  readonly label: string;
  readonly connection: { readonly phase: HostLinkPhase };
  readonly daemonConfig: null | {
    readonly settings: DaemonPrefs;
    readonly environment?: {
      readonly capabilities?: { readonly projectSettingsOverrides?: boolean };
    };
  };
}

const DAEMON_KEYS: ReadonlySet<string> = new Set(Object.keys(DaemonPrefs.fields));
const CLIENT_KEYS: ReadonlySet<string> = new Set(Object.keys(ClientPrefsSchema.fields));
const PROJECT_KEYS: ReadonlySet<string> = new Set(PROJECT_SCOPED_DAEMON_SETTING_KEYS);

export function isProjectScopedSettingKey(key: string): key is ProjectScopedDaemonSettingKey {
  return PROJECT_KEYS.has(key);
}

const isConnected = (host: ScopedPrefsHost): boolean =>
  host.connection.phase === "connected" && host.daemonConfig !== null;

export function selectScopedPrefsHosts<T extends ScopedPrefsHost>(
  scope: ResolvedPrefsScope,
  available: readonly T[],
  primaryHostId: HostId | null,
): { environments: T[]; connectedHosts: T[]; environment: T | null } {
  const environments = available.filter((host) => scope.hostIds.includes(host.hostId));
  const connectedHosts = environments.filter(isConnected);
  // The representative only supplies display values; it is never the set of write targets.
  const environment =
    connectedHosts.find((host) => host.hostId === primaryHostId) ?? connectedHosts[0] ?? null;
  return { environments, connectedHosts, environment };
}

export interface ScopedPrefsTarget {
  hostId: HostId;
  label: string;
  projectId: ProjectId | null;
  settings: DaemonPrefs;
  sources: Readonly<Record<ProjectScopedDaemonSettingKey, ProjectSettingSource>>;
}

export function resolveScopedPrefsTargets(
  scope: ResolvedPrefsScope,
  connectedHosts: readonly ScopedPrefsHost[],
): readonly ScopedPrefsTarget[] {
  const targets: ScopedPrefsTarget[] = [];
  if (scope.kind === "project" || scope.kind === "checkout") {
    for (const member of scope.members) {
      const host = connectedHosts.find((candidate) => candidate.hostId === member.hostId);
      if (!host?.daemonConfig || !isConnected(host)) continue;
      const resolved = resolveProjectPrefs(host.daemonConfig.settings, member.id);
      targets.push({
        settings: resolved.settings,
        sources: resolved.sources,
        projectId: member.id,
        hostId: host.hostId,
        label: host.label,
      });
    }
    return targets;
  }
  for (const host of connectedHosts) {
    if (!host.daemonConfig || !isConnected(host)) continue;
    const resolved = resolveProjectPrefs(host.daemonConfig.settings, null);
    targets.push({
      hostId: host.hostId,
      label: host.label,
      projectId: null,
      settings: host.daemonConfig.settings,
      sources: resolved.sources,
    });
  }
  return targets;
}

export function scopedPrefsAreMixed(
  targets: readonly Pick<ScopedPrefsTarget, "settings">[],
  keys: readonly (keyof DaemonPrefs)[],
): boolean {
  const [first, ...rest] = targets;
  if (!first) return false;
  return rest.some((target) =>
    keys.some((key) => !Equal.equals(first.settings[key], target.settings[key])),
  );
}

export type ScopedSettingSource = ProjectSettingSource | "mixed";

export function scopedPrefsSource(
  targets: readonly Pick<ScopedPrefsTarget, "sources">[],
  keys: readonly (keyof DaemonPrefs)[],
): ScopedSettingSource {
  const scoped = keys.filter((key): key is ProjectScopedDaemonSettingKey =>
    isProjectScopedSettingKey(key),
  );
  if (scoped.length === 0 || targets.length === 0) return "environment";
  const seen = new Set<ProjectSettingSource>();
  for (const target of targets) for (const key of scoped) seen.add(target.sources[key]);
  if (seen.size > 1) return "mixed";
  return seen.has("project") ? "project" : "environment";
}

export interface ScopedDaemonWrite {
  hostId: HostId;
  label: string;
  patch: DaemonPrefsPatch;
}

interface ScopedWritePlan {
  clientPatch: ClientPrefsPatch;
  hasClientWrite: boolean;
  serverWrites: ScopedDaemonWrite[];
  unavailableReason: string | null;
}

type OverridesMap = Record<string, Record<string, unknown> | null>;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Eligible override targets: the scope's members on connected hosts that understand project overrides. */
function overrideMembers(scope: ResolvedPrefsScope, environments: readonly ScopedPrefsHost[]) {
  if (scope.kind !== "project" && scope.kind !== "checkout") return [];
  const eligible: Array<{
    host: ScopedPrefsHost & { daemonConfig: NonNullable<ScopedPrefsHost["daemonConfig"]> };
    projectId: ProjectId;
  }> = [];
  for (const member of scope.members) {
    const host = environments.find((candidate) => candidate.hostId === member.hostId);
    if (!host || !host.daemonConfig || !isConnected(host)) continue;
    if (host.daemonConfig.environment?.capabilities?.projectSettingsOverrides !== true) continue;
    eligible.push({ host: host as never, projectId: member.id });
  }
  return eligible;
}

function groupOverrideWrites(
  entries: ReadonlyArray<{
    host: ScopedPrefsHost;
    projectId: ProjectId;
    entry: Record<string, unknown> | null;
  }>,
): ScopedDaemonWrite[] {
  const byHost = new Map<HostId, ScopedDaemonWrite & { overrides: OverridesMap }>();
  for (const { host, projectId, entry } of entries) {
    let write = byHost.get(host.hostId);
    if (!write) {
      const overrides: OverridesMap = {};
      write = {
        hostId: host.hostId,
        label: host.label,
        patch: { projectSettingsOverrides: overrides } as unknown as DaemonPrefsPatch,
        overrides,
      };
      byHost.set(host.hostId, write);
    }
    write.overrides[projectId] = entry;
  }
  return [...byHost.values()].map(({ hostId, label, patch }) => ({ hostId, label, patch }));
}

export function planScopedPrefsPatch(
  scope: ResolvedPrefsScope,
  environments: readonly ScopedPrefsHost[],
  patch: ScopedPrefsPatch,
): ScopedWritePlan {
  const clientPatch: Record<string, unknown> = {};
  const daemonPatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (CLIENT_KEYS.has(key)) clientPatch[key] = value;
    else if (DAEMON_KEYS.has(key)) daemonPatch[key] = value;
  }
  const daemonKeys = Object.keys(daemonPatch);
  const hasClientWrite = Object.keys(clientPatch).length > 0;
  const unscopable = daemonKeys.some((key) => !isProjectScopedSettingKey(key));

  let serverWrites: ScopedDaemonWrite[] = [];
  if (daemonKeys.length > 0 && scope.kind !== "unavailable") {
    if (scope.kind === "project" || scope.kind === "checkout") {
      if (!unscopable) {
        serverWrites = groupOverrideWrites(
          overrideMembers(scope, environments).map(({ host, projectId }) => {
            const settings = host.daemonConfig.settings;
            const effective = resolveProjectPrefs(settings, projectId)
              .settings as unknown as Record<string, unknown>;
            const existing = (settings.projectSettingsOverrides as OverridesMap | undefined)?.[
              projectId
            ];
            const entry: Record<string, unknown> = { ...existing };
            for (const [key, value] of Object.entries(daemonPatch)) {
              const base = effective[key];
              entry[key] =
                isPlainObject(value) && isPlainObject(base) ? { ...base, ...value } : value;
            }
            return { host, projectId, entry };
          }),
        );
      }
    } else {
      serverWrites = selectScopedPrefsHosts(scope, environments, null).connectedHosts.map(
        (host) => ({
          hostId: host.hostId,
          label: host.label,
          patch: daemonPatch as DaemonPrefsPatch,
        }),
      );
    }
  }

  let unavailableReason: string | null = null;
  const nothingToWrite = !hasClientWrite && serverWrites.length === 0;
  if (nothingToWrite && daemonKeys.length > 0) {
    if (scope.kind === "unavailable") unavailableReason = scope.message;
    else if (unscopable && (scope.kind === "project" || scope.kind === "checkout")) {
      unavailableReason = "This setting is environment-wide and cannot be overridden by a project.";
    } else if (scope.kind === "project" || scope.kind === "checkout") {
      unavailableReason =
        "Connect the selected checkouts, or update their environments, to save a project override.";
    } else {
      unavailableReason = `Connect ${scope.kind === "environment" ? scope.label : "an environment"} to save this setting.`;
    }
  }

  return {
    clientPatch: clientPatch as ClientPrefsPatch,
    hasClientWrite,
    serverWrites,
    unavailableReason,
  };
}

export function planScopedPrefsClear(
  scope: ResolvedPrefsScope,
  environments: readonly ScopedPrefsHost[],
  keys: readonly ProjectScopedDaemonSettingKey[],
): ScopedWritePlan {
  const serverWrites = groupOverrideWrites(
    overrideMembers(scope, environments).map(({ host, projectId }) => ({
      host,
      projectId,
      entry: clearProjectPrefsOverrides(host.daemonConfig.settings, projectId, keys) as Record<
        string,
        unknown
      > | null,
    })),
  );
  const unavailableReason =
    serverWrites.length === 0
      ? "Connect the selected checkouts, or update their environments, to reset this override."
      : null;
  return {
    unavailableReason,
    hasClientWrite: false,
    serverWrites,
    clientPatch: {},
  };
}

export interface ProjectOverrideEntry {
  readonly hostId: HostId;
  readonly projectId: ProjectId;
}

export function listProjectOverrides(
  environments: readonly ScopedPrefsHost[],
  keys: readonly (keyof DaemonPrefs)[],
): readonly ProjectOverrideEntry[] {
  const scoped = keys.filter((key) => isProjectScopedSettingKey(key));
  if (scoped.length === 0) return [];
  const entries: ProjectOverrideEntry[] = [];
  for (const host of environments) {
    const overrides = host.daemonConfig?.settings.projectSettingsOverrides as
      | OverridesMap
      | undefined;
    if (!overrides) continue;
    for (const [projectId, entry] of Object.entries(overrides)) {
      if (entry && scoped.some((key) => Object.hasOwn(entry, key))) {
        entries.push({ hostId: host.hostId, projectId: projectId as ProjectId });
      }
    }
  }
  return entries;
}

export function planProjectOverridesClear(
  environments: readonly ScopedPrefsHost[],
  entries: readonly ProjectOverrideEntry[],
  keys: readonly ProjectScopedDaemonSettingKey[],
): ScopedWritePlan {
  const prepared: Array<{
    host: ScopedPrefsHost;
    projectId: ProjectId;
    entry: Record<string, unknown> | null;
  }> = [];
  for (const entry of entries) {
    const host = environments.find((candidate) => candidate.hostId === entry.hostId);
    if (!host || !host.daemonConfig || !isConnected(host)) continue;
    prepared.push({
      host,
      projectId: entry.projectId,
      entry: clearProjectPrefsOverrides(
        host.daemonConfig.settings,
        entry.projectId,
        keys,
      ) as Record<string, unknown> | null,
    });
  }
  const serverWrites = groupOverrideWrites(prepared);
  return {
    unavailableReason:
      serverWrites.length > 0 ? null : "Connect the environments to reset these overrides.",
    hasClientWrite: false,
    clientPatch: {},
    serverWrites,
  };
}

export async function persistScopedPrefsPatch(
  plan: Pick<ScopedWritePlan, "clientPatch" | "hasClientWrite" | "serverWrites">,
  persistServer: (input: {
    hostId: HostId;
    input: { patch: DaemonPrefsPatch };
  }) => Promise<{ _tag: "Success" | "Failure" }>,
  persistClient: (patch: ClientPrefsPatch) => void,
): Promise<{ failedHosts: ScopedDaemonWrite[]; savedHostCount: number }> {
  if (plan.hasClientWrite) persistClient(plan.clientPatch);
  // allSettled: one host failing must not hide the others' results.
  const settled = await Promise.allSettled(
    plan.serverWrites.map((write) =>
      persistServer({ hostId: write.hostId, input: { patch: write.patch } }),
    ),
  );
  const failedHosts = plan.serverWrites.filter((_, index) => {
    const outcome = settled[index]!;
    return outcome.status === "rejected" || outcome.value._tag === "Failure";
  });
  return { failedHosts, savedHostCount: plan.serverWrites.length - failedHosts.length };
}
