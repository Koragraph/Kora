/** Reading loosely typed activity payloads: everything a provider sends is `unknown` until checked. */

export type Fields = Record<string, unknown>;

/** `value` as an object to read fields from, or null. */
export const fields = (value: unknown): Fields | null =>
  value !== null && typeof value === "object" ? (value as Fields) : null;

/** `value` trimmed, when it is a string with something in it; null otherwise. */
export function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export const finiteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
