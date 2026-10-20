/** Accept legacy provider links without replacing an explicit settings scope. */

import { validatePrefsScopeSearch, type PrefsScopeSearch } from "./prefsScope";
import type { SearchMiddleware } from "@tanstack/react-router";

export function validatePrefsRouteSearch(raw: Record<string, unknown>) {
  return validatePrefsScopeSearch(
    typeof raw.hostId === "string" && raw.machine === undefined && raw.project === undefined
      ? { ...raw, machine: raw.hostId }
      : raw,
  );
}

const SCOPE_KEYS = [
  "project",
  "machine",
  "checkout",
] as const satisfies readonly (keyof PrefsScopeSearch)[];
const TARGET_INPUT_KEYS = [...SCOPE_KEYS, "hostId"];

/**
 * Category links keep the target, while an explicit target replaces the entire
 * previous selection. `hostId` is the legacy provider deep-link target.
 */
export const retainPrefsScope: SearchMiddleware<PrefsScopeSearch> = ({ search, next }) => {
  const result = next(search);
  if (TARGET_INPUT_KEYS.some((key) => Object.hasOwn(result, key))) {
    return result;
  }
  const carried: Record<string, unknown> = {};
  for (const key of SCOPE_KEYS) {
    if (search[key] !== undefined) carried[key] = search[key];
  }
  return { ...carried, ...result };
};
