import { createContext, type ReactNode, useContext, useMemo } from "react";

import { useHosts, usePrimaryHostId } from "../../atoms/hosts";
import { usePrefsProjectGroups } from "./usePrefsProjectGroups";
import { resolveScopedPrefsTargets, selectScopedPrefsHosts } from "./scopedPrefs";
import { resolvePrefsScope, type PrefsScopeSearch } from "./prefsScope";

function useResolvedPrefsScope(search: PrefsScopeSearch) {
  const groups = usePrefsProjectGroups();
  const { environments: availableHosts } = useHosts();
  const primaryHostId = usePrimaryHostId();
  return useMemo(() => {
    const scope = resolvePrefsScope(search, groups, availableHosts);
    const selected = selectScopedPrefsHosts(scope, availableHosts, primaryHostId);
    const targets = resolveScopedPrefsTargets(scope, selected.connectedHosts);
    // The representative target supplies display values; project scopes
    // prefer the member on the primary environment, like environments do.
    const target =
      targets.find((candidate) => candidate.hostId === selected.environment?.hostId) ??
      targets[0] ??
      null;
    return { scope, groups, ...selected, targets, target };
  }, [availableHosts, groups, primaryHostId, search]);
}

const PrefsScopeContext = createContext<
  | (ReturnType<typeof useResolvedPrefsScope> & {
      search: PrefsScopeSearch;
      selectScope: (next: PrefsScopeSearch) => void;
    })
  | null
>(null);

export function PrefsScopeProvider({
  search,
  onChange,
  children,
}: {
  search: PrefsScopeSearch;
  onChange: (next: PrefsScopeSearch) => void;
  children: ReactNode;
}) {
  const resolved = useResolvedPrefsScope(search);
  const value = useMemo(
    () => ({ ...resolved, search, selectScope: onChange }),
    [onChange, resolved, search],
  );
  return <PrefsScopeContext value={value}>{children}</PrefsScopeContext>;
}

export function useOptionalPrefsScope() {
  return useContext(PrefsScopeContext);
}

export function usePrefsScope() {
  const scope = useOptionalPrefsScope();
  if (scope === null) throw new Error("Settings scope must be read inside PrefsScopeProvider.");
  return scope;
}
