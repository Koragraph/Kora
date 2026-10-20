/**
 * How a configured provider instance presents itself in a client: its label,
 * its accent color, and whether its icon carries the account badge. Shared by
 * web and mobile so both clients name and badge the same instance identically.
 *
 * @module providerInstanceDisplay
 */
import {
  type AgentStatus,
  type AgentId,
  AGENT_DISPLAY_NAMES,
  defaultProfileIdForDriver,
} from "@kora/contracts";

/**
 * Title-case a slug: splits on `_` / `-` and camelCase boundaries, so
 * `codex_personal` becomes "Codex Personal" and `myCustomInstance` becomes
 * "My Custom Instance".
 */
const humanizeSlug = (slug: string): string => {
  const words = slug.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
  return words.trim().replace(/(?<!\w)\w/g, (head) => head.toUpperCase());
};

/**
 * Resolve an instance's label with a tiered priority:
 *
 *   1. A snapshot `displayName` that differs from the driver's brand label —
 *      the server has explicitly named this instance, trust it.
 *   2. For non-default instances, a humanized `instanceId` — the server fell
 *      back to the driver-level label (the same for every instance of that
 *      kind), so the slug is what keeps "Codex" and "Codex Personal" apart.
 *   3. The snapshot's `displayName`, or the brand label from contracts.
 */
export function resolveAgentProfileDisplayName(
  snapshot: Pick<AgentStatus, "instanceId" | "driver" | "displayName">,
): string {
  const { driver, instanceId } = snapshot;
  const brand = AGENT_DISPLAY_NAMES[driver] ?? humanizeSlug(driver);
  const given = snapshot.displayName?.trim() || undefined;
  if (given !== undefined && given !== brand) return given;
  const isDefault = instanceId === defaultProfileIdForDriver(driver);
  const slugName = isDefault ? "" : humanizeSlug(instanceId);
  return slugName || given || brand;
}

/**
 * Turn a display name into up to two initials for the badge: the first two
 * characters of a single word, or the first character of each of the first
 * two words. Iterates by code point so an emoji never splits into surrogates.
 */
export function agentProfileInitials(label: string): string {
  const [first, second] = label
    .replace(/[\p{P}]+/gu, " ")
    .split(/\s+/u)
    .filter(Boolean);
  if (first === undefined) return "";
  if (second === undefined) return Array.from(first).slice(0, 2).join("").toUpperCase();
  return [first, second].map((word) => (Array.from(word)[0] ?? "").toUpperCase()).join("");
}

/** Only `#rrggbb` accent colors render; anything else is treated as unset. */
const HEX_ACCENT = /^#[0-9a-fA-F]{6}$/u;

export function normalizeAgentAccentColor(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate && HEX_ACCENT.test(candidate) ? candidate : undefined;
}

/**
 * Whether an instance's icon carries the account badge: accent color set, or
 * several instances sharing a driver so the brand glyph alone is ambiguous.
 * Shared by the composer trigger, the picker rail, and sidebar/thread rows.
 */
type BadgeCandidate = { readonly driverKind: AgentId };

export function shouldShowInstanceBadge(
  entry: BadgeCandidate & { readonly accentColor?: string | undefined },
  entries: Iterable<BadgeCandidate>,
): boolean {
  if (entry.accentColor) return true;
  let sharing = 0;
  for (const candidate of entries) {
    if (candidate.driverKind !== entry.driverKind) continue;
    sharing += 1;
    if (sharing > 1) return true;
  }
  return false;
}
