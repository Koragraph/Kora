import { useAtomValue } from "@effect/atom-react";
import {
  mergeHostThread,
  type HostProject,
  type HostThread,
  type HostThreadShell,
  type HostThreadStatus,
} from "@kora/client-runtime/store/threads";
import type { DaemonConfig, HostId, HostProjectRef, HostThreadRef } from "@kora/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { isHiddenThreadShell } from "../thread/hiddenThreads";
import { koraAtomRegistry } from "../wire/atomRegistry";
import { hostProjects } from "./projects";
import { hostDaemonConfigsAtom } from "./server";
import { allHostShellsBootstrappedAtom } from "./shell";
import { hostThreadDetails, hostThreadShells } from "./threads";

// Stable placeholders: hooks must keep a constant call order, so a null ref reads these.
const NO_PROJECT = Atom.make<HostProject | null>(null).pipe(Atom.withLabel("web-project:empty"));
const NO_THREAD_REFS = Atom.make<ReadonlyArray<HostThreadRef>>(Object.freeze([])).pipe(
  Atom.withLabel("web-thread-refs:empty"),
);
const NO_SHELL = Atom.make<HostThreadShell | null>(null).pipe(
  Atom.withLabel("web-thread-shell:empty"),
);
const NO_DETAIL = Atom.make<HostThread | null>(null).pipe(
  Atom.withLabel("web-thread-detail:empty"),
);
const NO_STATUS = Atom.make<HostThreadStatus>("empty").pipe(
  Atom.withLabel("web-thread-status:empty"),
);

const activeHostIdAtom = Atom.make<HostId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-active-environment-id"),
);

export function setActiveHostId(hostId: HostId | null): void {
  koraAtomRegistry.set(activeHostIdAtom, hostId);
}

export function useThreadRefs(): ReadonlyArray<HostThreadRef> {
  return useAtomValue(hostThreadShells.threadRefsAtom);
}

export function useHostThreadRefs(hostId: HostId | null): ReadonlyArray<HostThreadRef> {
  return useAtomValue(
    hostId === null ? NO_THREAD_REFS : hostThreadShells.hostThreadRefsAtom(hostId),
  );
}

export function useProjects(): ReadonlyArray<HostProject> {
  return useAtomValue(hostProjects.projectsAtom);
}

export function useDaemonConfigs(): ReadonlyMap<HostId, DaemonConfig> {
  return useAtomValue(hostDaemonConfigsAtom);
}

/** Every sidebar/nav/search list reads this one: routine-run threads are filtered out. */
export function useThreadSummaries(): ReadonlyArray<HostThreadShell> {
  const all = useAtomValue(hostThreadShells.threadShellsAtom);
  return useMemo(() => all.filter((shell) => !isHiddenThreadShell(shell)), [all]);
}

export function useAllHostShellsBootstrapped(): boolean {
  return useAtomValue(allHostShellsBootstrappedAtom);
}

export function useProject(ref: HostProjectRef | null): HostProject | null {
  return useAtomValue(ref === null ? NO_PROJECT : hostProjects.projectAtom(ref));
}

export function useThreadSummary(ref: HostThreadRef | null): HostThreadShell | null {
  return useAtomValue(ref === null ? NO_SHELL : hostThreadShells.threadShellAtom(ref));
}

export function useThreadDetail(ref: HostThreadRef | null): HostThread | null {
  return useAtomValue(ref === null ? NO_DETAIL : hostThreadDetails.detailAtom(ref));
}

export function useThreadStatus(ref: HostThreadRef | null): HostThreadStatus {
  return useAtomValue(ref === null ? NO_STATUS : hostThreadDetails.statusAtom(ref));
}

/**
 * A client-reserved draft id does not exist on the server before its first send, so with
 * `waitForShell` the detail is not requested until the shell shows up.
 */
export function resolveThreadDetailRef(
  ref: HostThreadRef | null,
  options: { shellExists: boolean; waitForShell: boolean },
): HostThreadRef | null {
  if (ref === null) return null;
  return options.waitForShell && !options.shellExists ? null : ref;
}

export function useThread(
  ref: HostThreadRef | null,
  options?: { waitForShell?: boolean },
): HostThread | null {
  const shell = useThreadSummary(ref);
  const detail = useThreadDetail(
    resolveThreadDetailRef(ref, {
      shellExists: shell !== null,
      waitForShell: options?.waitForShell === true,
    }),
  );
  return useMemo(() => mergeHostThread(detail, shell), [detail, shell]);
}

function readProject(ref: HostProjectRef): HostProject | null {
  return koraAtomRegistry.get(hostProjects.projectAtom(ref));
}

export function readProjects(): ReadonlyArray<HostProject> {
  return koraAtomRegistry.get(hostProjects.projectsAtom);
}

export function waitForProject(ref: HostProjectRef, timeoutMs = 10_000): Promise<HostProject> {
  return new Promise<HostProject>((resolve, reject) => {
    let unsubscribe: () => void = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;

    const settle = (outcome: () => void) => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe();
      outcome();
    };
    const check = () => {
      const project = readProject(ref);
      if (project !== null) settle(() => resolve(project));
    };

    unsubscribe = koraAtomRegistry.subscribe(hostProjects.projectAtom(ref), check);
    timer = setTimeout(
      () => settle(() => reject(new Error("The project did not appear in the desktop app."))),
      timeoutMs,
    );
    check();
  });
}

export function readThreadSummary(ref: HostThreadRef): HostThreadShell | null {
  return koraAtomRegistry.get(hostThreadShells.threadShellAtom(ref));
}

type HostCapability =
  | "threadSettlement"
  | "threadSnooze"
  | "threadPinning"
  | "threadTitleRegeneration"
  | "threadPinReorder"
  | "threadActiveReorder";

// Older servers decode an unknown capability as absent, so version skew degrades to false.
function hostHasCapability(hostId: HostId, flag: HostCapability): boolean {
  const config = koraAtomRegistry.get(hostDaemonConfigsAtom).get(hostId);
  return config?.environment.capabilities[flag] === true;
}

export const readHostSupportsSettlement = (hostId: HostId) =>
  hostHasCapability(hostId, "threadSettlement");
export const readHostSupportsSnooze = (hostId: HostId) => hostHasCapability(hostId, "threadSnooze");
export const readHostSupportsPinning = (hostId: HostId) =>
  hostHasCapability(hostId, "threadPinning");
export const readHostSupportsTitleRegeneration = (hostId: HostId) =>
  hostHasCapability(hostId, "threadTitleRegeneration");
export const readHostSupportsPinReorder = (hostId: HostId) =>
  hostHasCapability(hostId, "threadPinReorder");
export const readHostSupportsActiveReorder = (hostId: HostId) =>
  hostHasCapability(hostId, "threadActiveReorder");

function readHostThreadRefs(hostId: HostId): ReadonlyArray<HostThreadRef> {
  return koraAtomRegistry.get(hostThreadShells.hostThreadRefsAtom(hostId));
}

export function readThreadSummaries(): ReadonlyArray<HostThreadShell> {
  return koraAtomRegistry.get(hostThreadShells.threadShellsAtom);
}
