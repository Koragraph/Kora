import { RPC_METHODS, type HostId, type WorkspaceFileReadResult } from "@kora/contracts";
import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";

import {
  type UpdateProjectInput,
  type DeleteProjectInput,
  type CreateProjectInput,
  updateProject,
  deleteProject,
  createProject,
} from "../commands/commands.ts";
import type { HostRegistry } from "../link/registry.ts";
import {
  createHostRpcQueryAtomFamily,
  createHostRpcCommand,
  createHostCommand,
  createAtomActionScheduler,
} from "./runtime.ts";

export type { CreateProjectInput, DeleteProjectInput, UpdateProjectInput };

/** A file the user just saved, shown until the server's copy catches up. */
export interface OptimisticProjectFile {
  readonly data: WorkspaceFileReadResult;
  /** Identity of the server value this was reconciled against. */
  readonly confirmedAgainst: object | null | undefined;
}

export interface OptimisticProjectFileTarget {
  readonly hostId: HostId;
  readonly cwd: string;
  readonly relativePath: string;
}

export function createProjectHostAtoms<R, E>(
  runtime: Atom.AtomRuntime<HostRegistry | Crypto.Crypto | R, E>,
) {
  const optimisticByKey = Atom.family((key: string) =>
    Atom.make<OptimisticProjectFile | null>(null).pipe(
      Atom.withLabel(`environment-data:projects:optimistic-file:${key}`),
    ),
  );

  // Project commands for one project run in order; file writes for one file do too.
  const projectScheduler = createAtomActionScheduler();
  const fileScheduler = createAtomActionScheduler();
  const projectConcurrency = {
    mode: "serial",
    key: (target: { readonly hostId: HostId; readonly input: { readonly projectId: string } }) =>
      JSON.stringify([target.hostId, target.input.projectId]),
  } as const;

  return {
    searchEntries: createHostRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:search-entries",
      tag: RPC_METHODS.filesFind,
      staleTimeMs: 15_000,
    }),
    listEntries: createHostRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:list-entries",
      tag: RPC_METHODS.filesList,
      staleTimeMs: 30_000,
      idleTtlMs: 5 * 60_000,
    }),
    readFile: createHostRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:read-file",
      tag: RPC_METHODS.filesRead,
      idleTtlMs: 5 * 60_000,
      staleTimeMs: 30_000,
    }),
    optimisticFile: (target: OptimisticProjectFileTarget) =>
      optimisticByKey(JSON.stringify([target.hostId, target.cwd, target.relativePath])),
    create: createHostCommand(runtime, {
      label: "environment-data:commands:project:create",
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
      execute: (input: CreateProjectInput) => createProject(input),
    }),
    update: createHostCommand(runtime, {
      label: "environment-data:commands:project:update",
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
      execute: (input: UpdateProjectInput) => updateProject(input),
    }),
    delete: createHostCommand(runtime, {
      label: "environment-data:commands:project:delete",
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
      execute: (input: DeleteProjectInput) => deleteProject(input),
    }),
    writeFile: createHostRpcCommand(runtime, {
      label: "environment-data:projects:write-file",
      tag: RPC_METHODS.filesWrite,
      concurrency: {
        key: (target) =>
          JSON.stringify([target.hostId, target.input.cwd, target.input.relativePath]),
        mode: "serial",
      },
      scheduler: fileScheduler,
    }),
  };
}
