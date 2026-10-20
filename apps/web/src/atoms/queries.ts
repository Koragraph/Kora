import { useEffect, useMemo, useState } from "react";
import type { ChatThread, ProjectEntryKind } from "@kora/contracts";
import type { PromptPathSearchTarget } from "@kora/client-runtime/store/threads";

import { useHostQuery } from "./query";
import { projectHost } from "./projects";

export interface ThreadDetailView {
  readonly data: ChatThread | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly isDeleted: boolean;
}

export type ProjectPathSearchTarget = PromptPathSearchTarget & {
  readonly kind?: ProjectEntryKind | undefined;
  readonly imageOnly?: boolean | undefined;
};

const SEARCH_DEBOUNCE_MS = 120;
const PROMPT_SEARCH_LIMIT = 80;

export function areProjectPathSearchTargetsEqual(
  leftSide: ProjectPathSearchTarget,
  rightSide: ProjectPathSearchTarget,
): boolean {
  return (
    leftSide.hostId === rightSide.hostId &&
    leftSide.cwd === rightSide.cwd &&
    leftSide.query === rightSide.query &&
    leftSide.kind === rightSide.kind &&
    leftSide.imageOnly === rightSide.imageOnly
  );
}

function useDebounced<T>(val: T, delayMs: number): T {
  const [settled, setSettled] = useState(val);
  useEffect(() => {
    const tmr = setTimeout(() => setSettled(val), delayMs);
    return () => clearTimeout(tmr);
  }, [val, delayMs]);
  return settled;
}

export function useProjectPathSearch(
  dest: ProjectPathSearchTarget,
  limit: number,
  opts?: { readonly allowEmptyQuery?: boolean },
) {
  const rawQuery = dest.query == null ? null : dest.query.trim();
  // Memoised on the fields so the debounce timer only restarts on a real change.
  const live = useMemo<ProjectPathSearchTarget>(
    () => ({
      hostId: dest.hostId,
      cwd: dest.cwd,
      query: rawQuery,
      kind: dest.kind,
      imageOnly: dest.imageOnly,
    }),
    [dest.hostId, dest.cwd, rawQuery, dest.kind, dest.imageOnly],
  );
  const debounced = useDebounced(live, SEARCH_DEBOUNCE_MS);

  const { hostId, cwd, query } = debounced;
  const on =
    hostId != null && cwd != null && query != null && (opts?.allowEmptyQuery || query.length > 0);

  const outcomeVal = useHostQuery(
    on
      ? projectHost.searchEntries({
          hostId,
          input: {
            cwd,
            query,
            limit,
            ...(debounced.kind ? { kind: debounced.kind } : {}),
            ...(debounced.imageOnly ? { imageOnly: true } : {}),
          },
        })
      : null,
  );

  return {
    entries: outcomeVal.data?.entries ?? [],
    error: outcomeVal.error,
    isPending: !areProjectPathSearchTargetsEqual(live, debounced) || outcomeVal.isPending,
    searchedQuery: debounced.query ?? "",
    truncated: outcomeVal.data?.truncated ?? false,
    refresh: outcomeVal.refresh,
  };
}

export function usePromptPathSearch(dest: PromptPathSearchTarget) {
  return useProjectPathSearch(dest, PROMPT_SEARCH_LIMIT);
}
