import { koraAtomRegistry } from "~/wire/atomRegistry";
import { projectHost } from "~/atoms/projects";
import { isWorkspaceVideoPreviewPath, isWorkspaceImageViewPath } from "@kora/shared/fileViewer";
import type { WorkspaceFileReadResult, WorkspaceListResult, HostId } from "@kora/contracts";
import { executeAtomQuery } from "@kora/client-runtime/store/runtime";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";

interface ProjectQueryState<A> {
  data: A | null;
  error: string | null;
  isPending: boolean;
  refresh: () => void;
}

const IDLE_FILE_ATOM = Atom.make(AsyncResult.initial<WorkspaceFileReadResult, never>(false)).pipe(
  Atom.withLabel("project-file:idle"),
);

const utf8ByteLength = (text: string): number => new TextEncoder().encode(text).length;

function readAtomFor(hostId: HostId, cwd: string, relativePath: string | null) {
  return projectHost.readFile({ hostId, input: { cwd, relativePath: relativePath ?? "" } });
}

function optimisticAtomFor(hostId: HostId, cwd: string, relativePath: string) {
  return projectHost.optimisticFile({ hostId, cwd, relativePath });
}

export function getProjectFileQueryAtom(hostId: HostId, cwd: string, relativePath: string | null) {
  return readAtomFor(hostId, cwd, relativePath);
}

/** Show just-saved contents straight away; the server read catches up afterwards. */
export function setProjectFileQueryData(
  hostId: HostId,
  cwd: string,
  relativePath: string,
  savedContents: string,
): void {
  koraAtomRegistry.set(optimisticAtomFor(hostId, cwd, relativePath), {
    confirmedAgainst: undefined,
    data: {
      relativePath,
      contents: savedContents,
      byteLength: utf8ByteLength(savedContents),
      truncated: false,
    },
  });
}

export function getOptimisticProjectFileQueryData(
  hostId: HostId,
  cwd: string,
  relativePath: string,
): WorkspaceFileReadResult | null {
  return koraAtomRegistry.get(optimisticAtomFor(hostId, cwd, relativePath))?.data ?? null;
}

export function confirmProjectFileQueryData(
  hostId: HostId,
  cwd: string,
  relativePath: string,
  expectedContents: string,
): boolean {
  const optimisticAtom = optimisticAtomFor(hostId, cwd, relativePath);
  const optimistic = koraAtomRegistry.get(optimisticAtom);
  if (!optimistic || optimistic.data.contents !== expectedContents) return false;

  const readAtom = readAtomFor(hostId, cwd, relativePath);
  const confirmed = { ...optimistic, confirmedAgainst: koraAtomRegistry.get(readAtom) as object };
  koraAtomRegistry.set(optimisticAtom, confirmed);
  koraAtomRegistry.refresh(readAtom);

  // Drop the optimistic copy only once the server read has caught up.
  void executeAtomQuery(koraAtomRegistry, readAtom, {
    reportFailure: false,
    reportDefect: false,
    refresh: true,
  }).then((result) => {
    if (result._tag === "Success" && koraAtomRegistry.get(optimisticAtom) === confirmed) {
      koraAtomRegistry.set(optimisticAtom, null);
    }
  });
  return true;
}

export function resolveProjectFileQueryData(
  hostId: HostId,
  cwd: string,
  relativePath: string | null,
  data: WorkspaceFileReadResult | null,
): WorkspaceFileReadResult | null {
  if (relativePath === null) return data;
  return getOptimisticProjectFileQueryData(hostId, cwd, relativePath) ?? data;
}

function describeFailure<E>(result: AsyncResult.AsyncResult<unknown, E>): string | null {
  if (result._tag !== "Failure") return null;
  const failure = Cause.squash(result.cause);
  return failure instanceof Error ? failure.message : "Workspace query failed.";
}

export function useProjectEntriesQuery(
  hostId: HostId,
  cwd: string,
  directoryPath?: string,
): ProjectQueryState<WorkspaceListResult> {
  const atom = projectHost.listEntries({
    hostId,
    input: { cwd, ...(directoryPath !== undefined ? { directoryPath } : {}) },
  });
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: describeFailure(result),
    isPending: result.waiting,
    refresh,
  };
}

export function useProjectFile(
  hostId: HostId,
  cwd: string,
  relativePath: string | null,
  active = true,
): ProjectQueryState<WorkspaceFileReadResult> {
  const readsServer =
    active &&
    relativePath !== null &&
    !isWorkspaceImageViewPath(relativePath) &&
    !isWorkspaceVideoPreviewPath(relativePath);
  const atom = readsServer ? readAtomFor(hostId, cwd, relativePath) : IDLE_FILE_ATOM;
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);

  const optimisticAtom =
    relativePath !== null ? optimisticAtomFor(hostId, cwd, relativePath) : null;
  const optimistic = useAtomValue(optimisticAtom ?? NO_OPTIMISTIC_ATOM);

  return {
    data: optimistic?.data ?? Option.getOrNull(AsyncResult.value(result)),
    error: describeFailure(result),
    isPending: readsServer && result.waiting,
    refresh,
  };
}

const NO_OPTIMISTIC_ATOM = Atom.make(
  null as { data: WorkspaceFileReadResult; confirmedAgainst: object | null | undefined } | null,
).pipe(Atom.withLabel("project-file:no-optimistic"));
