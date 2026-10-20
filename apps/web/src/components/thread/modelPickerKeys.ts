import type { AgentProfileId } from "@kora/contracts";

const MODEL_KEY_PREFIX = "model:";
const LEGACY_SECTION_KEY_PREFIX = "legacy-models:";

export function modelPickerModelKey(instanceId: AgentProfileId, slug: string): string {
  return [MODEL_KEY_PREFIX, String(instanceId.length), ":", instanceId, slug].join("");
}

export function parseModelPickerModelKey(
  key: string,
): { instanceId: AgentProfileId; slug: string } | null {
  if (!key.startsWith(MODEL_KEY_PREFIX)) return null;
  const body = key.slice(MODEL_KEY_PREFIX.length);
  const colonAt = body.indexOf(":");
  const lengthDigits = colonAt === -1 ? "" : body.slice(0, colonAt);
  if (colonAt === -1 || !/^\d+$/.test(lengthDigits)) return null;

  const idLength = Number(lengthDigits);
  const tail = body.slice(colonAt + 1);
  if (!Number.isSafeInteger(idLength) || idLength > tail.length) return null;

  return {
    slug: tail.slice(idLength),
    instanceId: tail.slice(0, idLength) as AgentProfileId,
  };
}

export function modelPickerLegacySectionKey(instanceId: AgentProfileId): string {
  return `${LEGACY_SECTION_KEY_PREFIX}${instanceId}`;
}

export function parseModelPickerLegacySectionKey(key: string): AgentProfileId | null {
  return key.startsWith(LEGACY_SECTION_KEY_PREFIX)
    ? (key.slice(LEGACY_SECTION_KEY_PREFIX.length) as AgentProfileId)
    : null;
}
