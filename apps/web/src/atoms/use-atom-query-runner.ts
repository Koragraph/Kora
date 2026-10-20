import { useCallback, useContext } from "react";
import { AsyncResult, type Atom } from "effect/unstable/reactivity";
import {
  type AtomActionResult,
  type AtomQueryOptions,
  executeAtomQuery,
} from "@kora/client-runtime/store/runtime";
import { RegistryContext } from "@effect/atom-react";

export function useAtomQueryRunner<T, A, E>(
  fam: (dest: T) => Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  opts?: string | AtomQueryOptions,
): (dest: T) => Promise<AtomActionResult<A, E>> {
  const registry = useContext(RegistryContext);
  const explicitLabel = typeof opts === "string" ? opts : opts?.label;
  const reportFailure = typeof opts === "string" ? true : (opts?.reportFailure ?? true);
  const reportDefect = typeof opts === "string" ? true : (opts?.reportDefect ?? true);
  const refresh = typeof opts === "string" ? false : (opts?.refresh ?? false);

  return useCallback(
    (dest: T) => {
      const atom = fam(dest);
      return executeAtomQuery(registry, atom, {
        refresh,
        reportDefect,
        reportFailure,
        label: explicitLabel ?? atom.label?.[0] ?? "atom query",
      });
    },
    [explicitLabel, fam, registry, refresh, reportDefect, reportFailure],
  );
}
