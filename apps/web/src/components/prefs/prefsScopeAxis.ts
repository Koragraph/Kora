import type { PrefsScopeSearch } from "./prefsScope";
import type { HostPresentation } from "../../atoms/hosts";

type ScopeHost = Pick<HostPresentation, "hostId" | "label" | "displayUrl">;

export function prefsScopeHostLabel(environment: ScopeHost, environments: readonly ScopeHost[]) {
  const duplicate = environments.some(
    (other) => other.hostId !== environment.hostId && other.label === environment.label,
  );
  return duplicate
    ? `${environment.label} · ${environment.displayUrl ?? environment.hostId}`
    : environment.label;
}

export const ALL_HOSTS_VALUE = "all";
export const ALL_PROJECTS_VALUE = "all";

/**
 * The environment axis: `all` or an environment id. A legacy checkout link
 * without `machine` still names one environment, which the resolver supplies.
 */
export function hostAxisValue(search: PrefsScopeSearch, resolvedHostId?: string | null): string {
  return search.machine ?? resolvedHostId ?? ALL_HOSTS_VALUE;
}

/** The project axis: `all` or a project key. */
export function projectAxisValue(search: PrefsScopeSearch): string {
  return search.project ?? ALL_PROJECTS_VALUE;
}

/** Choosing an environment keeps the project; a pre-existing checkout narrowing is dropped. */
export function selectHostAxis(search: PrefsScopeSearch, value: string): PrefsScopeSearch {
  const next: PrefsScopeSearch = {};
  if (search.project) next.project = search.project;
  if (value !== ALL_HOSTS_VALUE) next.machine = value;
  return next;
}

/** Choosing a project keeps the environment axis. */
export function selectProjectAxis(search: PrefsScopeSearch, value: string): PrefsScopeSearch {
  const next: PrefsScopeSearch = {};
  if (value !== ALL_PROJECTS_VALUE) {
    next.project = value;
  }
  if (search.machine) {
    next.machine = search.machine;
  }
  return next;
}
