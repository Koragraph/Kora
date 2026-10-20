import { KORA_PROJECT_FILE_NAME, type HostId, type ThreadWorkspaceMode } from "@kora/contracts";
import { parseKoraProjectFile } from "@kora/shared/koraProjectFile";
import { executeAtomQuery } from "@kora/client-runtime/store/runtime";

import {
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/viewer/projectFilesQueryState";
import { koraAtomRegistry } from "~/wire/atomRegistry";

/**
 * Read `defaultThreadEnvMode` from the project's checked-in `kora.json`.
 *
 * Imperative counterpart to `useKoraProjectFileScripts` for the new-thread
 * path, which resolves defaults at call time rather than render time. The
 * file query atom caches per (environment, cwd), so repeat calls don't
 * re-fetch. Optimistic in-app writes overlay the query result, matching what
 * `useProjectFile` renders. Missing, truncated, or invalid files
 * resolve to null.
 */
export async function readKoraProjectFileDefaultThreadEnvMode(
  hostId: HostId,
  workspaceRoot: string,
): Promise<ThreadWorkspaceMode | null> {
  const result = await executeAtomQuery(
    koraAtomRegistry,
    getProjectFileQueryAtom(hostId, workspaceRoot, KORA_PROJECT_FILE_NAME),
    { reportDefect: false, reportFailure: false },
  );
  const data = resolveProjectFileQueryData(
    hostId,
    workspaceRoot,
    KORA_PROJECT_FILE_NAME,
    result._tag === "Success" ? result.value : null,
  );
  if (data === null || data.truncated) return null;
  return parseKoraProjectFile(data.contents)?.defaultThreadEnvMode ?? null;
}
