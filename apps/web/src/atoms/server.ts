import { AsyncResult, Atom } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import {
  type DaemonPrefs,
  type AgentStatus,
  type DaemonLifecycleWelcomePayload,
  type DaemonConfigStreamEvent,
  type DaemonConfig,
  type ExternalEditorId,
  DEFAULT_DAEMON_PREFS,
} from "@kora/contracts";
import { createHostDaemonConfigsAtom } from "@kora/client-runtime/store/shell";
import { createDaemonHostAtoms } from "@kora/client-runtime/store/server";

import { hostSession } from "./session";
import { primaryHostIdAtom } from "./primaryHost";
import { daemonAtomRuntime } from "../link/runtime";
import { hostCatalog } from "../link/catalog";

// Opted in for every environment: the subscription payload is fixed when it is
// established, so gating on "primary right now" would leave a newly promoted
// environment without usage-limit data until it reconnected.
export const daemonHost = createDaemonHostAtoms(daemonAtomRuntime, {
  initialConfigValueAtom: hostSession.initialConfigValueAtom,
  usageLimitSources: true,
  usageLimitsCommand: true,
});
export const hostDaemonConfigsAtom = createHostDaemonConfigsAtom({
  catalogEntryAtom: hostCatalog.catalogEntryAtom,
  daemonConfigValueAtom: daemonHost.configValueAtom,
});

interface PrimaryDaemonState {
  readonly config: DaemonConfig | null;
  readonly latestEvent: DaemonConfigStreamEvent | null;
  readonly welcome: DaemonLifecycleWelcomePayload | null;
}

const EMPTY_AVAILABLE_EDITORS: ReadonlyArray<ExternalEditorId> = [];
export const EMPTY_DAEMON_AGENTS: ReadonlyArray<AgentStatus> = [];
const EMPTY_PRIMARY_DAEMON_STATE: PrimaryDaemonState = {
  welcome: null,
  latestEvent: null,
  config: null,
};

const primaryDaemonStateAtom = Atom.make((get): PrimaryDaemonState => {
  const hostKey = get(primaryHostIdAtom);
  if (hostKey === null) {
    return EMPTY_PRIMARY_DAEMON_STATE;
  }

  const dest = { hostId: hostKey, input: {} };
  const configProjection = Option.getOrNull(
    AsyncResult.value(get(daemonHost.configProjection(dest))),
  );
  const welcome = Option.getOrNull(AsyncResult.value(get(daemonHost.welcome(dest))));

  return {
    config: get(daemonHost.configValueAtom(hostKey)),
    latestEvent: configProjection?.latestEvent ?? null,
    welcome,
  };
}).pipe(Atom.withLabel("web-primary-server-state"));

export const primaryDaemonConfigAtom = Atom.make(
  (get): DaemonConfig | null => get(primaryDaemonStateAtom).config,
).pipe(Atom.withLabel("web-primary-server-config"));

export const primaryDaemonWelcomeAtom = Atom.make(
  (get): DaemonLifecycleWelcomePayload | null => get(primaryDaemonStateAtom).welcome,
).pipe(Atom.withLabel("web-primary-server-welcome"));

export const primaryDaemonPrefsAtom = Atom.make(
  (get): DaemonPrefs => get(primaryDaemonConfigAtom)?.settings ?? DEFAULT_DAEMON_PREFS,
).pipe(Atom.withLabel("web-primary-server-settings"));

export const primaryDaemonAvailableEditorsAtom = Atom.make(
  (get): ReadonlyArray<ExternalEditorId> =>
    get(primaryDaemonConfigAtom)?.availableEditors ?? EMPTY_AVAILABLE_EDITORS,
).pipe(Atom.withLabel("web-primary-server-available-editors"));
