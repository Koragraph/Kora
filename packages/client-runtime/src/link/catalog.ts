import * as Schema from "effect/Schema";

import { LocalLinkTarget } from "./model.ts";

export interface LinkCatalogEntry {
  readonly target: LocalLinkTarget;
  /** False when the environment is switched off: registered, but never connects. */
  readonly enabled: boolean;
}

/** The local daemon's registration, reconciled from the desktop bootstrap (or the page origin). */
export class LocalLinkRegistration extends Schema.TaggedClass<LocalLinkRegistration>()(
  "LocalLinkRegistration",
  {
    target: LocalLinkTarget,
  },
) {}

export const PlatformLinkRegistration = LocalLinkRegistration;
export type PlatformLinkRegistration = LocalLinkRegistration;

export function linkRegistrationCatalogEntry(
  registration: LocalLinkRegistration,
): LinkCatalogEntry {
  return { target: registration.target, enabled: true };
}
