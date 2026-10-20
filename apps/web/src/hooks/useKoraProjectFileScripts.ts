import { useMemo } from "react";
import { parseKoraProjectFile } from "@kora/shared/koraProjectFile";
import {
  type KoraProjectFileScript,
  type KoraProjectFile,
  type HostId,
  KORA_PROJECT_FILE_NAME,
} from "@kora/contracts";

import { useProjectFile } from "~/components/viewer/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<KoraProjectFileScript> = [];

export interface KoraProjectFileState {
  /**
   * - `valid`: kora.json exists and decoded.
   * - `invalid`: kora.json exists but fails to decode (the server then ignores
   *   the whole file, including `iconPath` and every script).
   * - `missing`: no readable kora.json at the workspace root.
   * - `loading`: the file query has not settled yet.
   */
  status: "loading" | "missing" | "invalid" | "valid";
  /** The decoded file when status is `valid`, null otherwise. */
  file: KoraProjectFile | null;
  scripts: ReadonlyArray<KoraProjectFileScript>;
}

/**
 * Decoded state of the project's checked-in `kora.json`, including whether the
 * file exists but is broken — which the runtime otherwise swallows silently.
 */
export function useKoraProjectFileState(
  hostKey: HostId,
  workDir: string | null,
): KoraProjectFileState {
  const needle = useProjectFile(hostKey, workDir ?? "", KORA_PROJECT_FILE_NAME, workDir !== null);
  const inner = needle.data && !needle.data.truncated ? needle.data.contents : null;
  const isPending = needle.isPending;
  return useMemo(() => {
    if (inner === null) {
      return {
        status: isPending ? "loading" : "missing",
        file: null,
        scripts: NO_SCRIPTS,
      } as const;
    }
    const fileRef = parseKoraProjectFile(inner);
    if (fileRef === null) {
      return { status: "invalid", file: null, scripts: NO_SCRIPTS } as const;
    }
    return { status: "valid", file: fileRef, scripts: fileRef.scripts ?? NO_SCRIPTS } as const;
  }, [inner, isPending]);
}
