/**
 * Browser profiles - named identities for the in-app preview browser.
 *
 * Each profile maps to its own Electron session partition, so cookies and
 * storage are isolated between them: a tab opened under "Work" cannot see
 * "Personal"'s logins. Profiles are client-local, like the other browser
 * defaults, because the Chromium guest they configure is desktop-local.
 *
 * Two profiles are built in and cannot be edited or removed:
 * - `default` keeps the partition scope the browser used before profiles
 *   existed, so upgrading does not sign anyone out.
 * - `incognito` maps to a non-persistent partition for throwaway sessions.
 *
 * @module WebProfile
 */
import * as Schema from "effect/Schema";
import { NonblankString } from "./primitives.ts";

const BROWSER_PROFILE_NAME_MAX_LENGTH = 48;

/**
 * Control characters are rejected because ids are folded into delimiter-joined
 * cache keys on the client; one carrying the delimiter would resolve to a
 * different profile's partition.
 */
export const WebProfileId = NonblankString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[^\p{Cc}]+$/u),
);
export type WebProfileId = typeof WebProfileId.Type;

export const BrowserProfileName = NonblankString.check(
  Schema.isMaxLength(BROWSER_PROFILE_NAME_MAX_LENGTH),
);

/**
 * `persistent` profiles keep cookies on disk across restarts; `incognito`
 * uses an in-memory partition that Chromium discards with the process.
 */
export const BrowserProfileKind = Schema.Literals(["persistent", "incognito"]);
export type BrowserProfileKind = (typeof BrowserProfileKind)["Type"];

export const WebProfile = Schema.Struct({
  id: WebProfileId,
  name: BrowserProfileName,
  kind: BrowserProfileKind,
});
export type WebProfile = typeof WebProfile.Type;

export const DEFAULT_WEB_PROFILE_ID: WebProfileId = "default";
export const PRIVATE_WEB_PROFILE_ID: WebProfileId = "incognito";

/**
 * Built-ins are synthesized rather than stored, so they cannot be renamed out
 * of existence or deleted by editing the settings file by hand.
 */
export const BUILT_IN_BROWSER_PROFILES: ReadonlyArray<WebProfile> = [
  { id: DEFAULT_WEB_PROFILE_ID, name: "Default", kind: "persistent" },
  { id: PRIVATE_WEB_PROFILE_ID, name: "Incognito", kind: "incognito" },
];

/**
 * The full picker list: built-ins first, then the user's own profiles.
 *
 * Three things are normalized away, because each would present a profile the
 * partition layer does not actually deliver:
 *
 * - Entries colliding with a built-in id, so a hand-edited settings file
 *   cannot shadow "Default" or "Incognito".
 * - Repeated ids, which map to one partition and would otherwise appear as
 *   two isolated identities sharing every cookie. First entry wins.
 * - `kind: "incognito"` on anything but the built-in, since persistence is
 *   keyed off that one id; such a profile is labelled ephemeral while its
 *   cookies survive restarts.
 */
export function resolveWebProfiles(
  userProfiles: ReadonlyArray<WebProfile>,
): ReadonlyArray<WebProfile> {
  const taken = new Set<string>(BUILT_IN_BROWSER_PROFILES.map(({ id }) => id));
  const extra: WebProfile[] = [];
  for (const candidate of userProfiles) {
    if (taken.has(candidate.id)) continue;
    taken.add(candidate.id);
    extra.push(candidate.kind === "persistent" ? candidate : { ...candidate, kind: "persistent" });
  }
  return [...BUILT_IN_BROWSER_PROFILES, ...extra];
}
