// Pure helpers for the Memory tab: ordering, search, dates and the extraction disclosure line.
import type { BlobEngineAvailability, BlobFact } from "@kora/contracts";

/** Important first, then newest first; the order a person scans a list in. */
export function sortFacts(facts: ReadonlyArray<BlobFact>): BlobFact[] {
  return [...facts].sort(
    (a, b) =>
      Number(b.important) - Number(a.important) || b.since - a.since || a.id.localeCompare(b.id),
  );
}

/** Facts still true (retired ones are never listed, but a stale optimistic copy must not show). */
export function isCurrent(fact: BlobFact): boolean {
  return fact.until === null;
}

export function filterFacts(facts: ReadonlyArray<BlobFact>, query: string): BlobFact[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...facts];
  const terms = needle.split(/\s+/);
  return facts.filter((fact) => {
    const text = fact.text.toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** "Oct 2026" for an old fact, "Oct 3" this year, "today" / "yesterday" for fresh ones. */
export function sinceLabel(since: number, now: number = Date.now()): string {
  const date = new Date(since);
  const today = new Date(now);
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(today) - startOfDay(date)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  const month = MONTHS[date.getMonth()]!;
  return date.getFullYear() === today.getFullYear()
    ? `${month} ${date.getDate()}`
    : `${month} ${date.getFullYear()}`;
}

/**
 * The disclosure line (docs/bots/ARCH.md ruling 2): memory is learned by a model the user already has, and the chat
 * text goes to it. The wire carries which engines are ready, not the exact model, so this names the kind of model;
 * `model` (when the snapshot ever carries it) names it precisely.
 */
export function describeExtractor(
  engines: BlobEngineAvailability | null,
  model?: string | null,
  claudeFallback = false,
): { readonly learns: boolean; readonly text: string } {
  if (engines === null)
    return {
      learns: true,
      text: "Memory is learned from your chats with a model you already use.",
    };
  // A free model learns first; Claude (Haiku 5.5) only when the user allowed it in Settings > Blobs. Signing in alone never does.
  if (engines.opencode.ready && engines.opencode.freeModels > 0) {
    const shown = model?.replace(/ · free$/, "");
    const name = shown ? `the free model ${shown}` : "a free OpenCode model";
    return {
      learns: true,
      text: `Memory is learned with ${name}. The text of your chats is sent to that model to pick out what is worth remembering.`,
    };
  }
  if (claudeFallback && engines.claude.ready) {
    return {
      learns: true,
      text: `Memory is learned with ${model ?? "Claude Haiku"}, because you allowed Claude for memory and no free model is available. The text of your chats is sent to it to pick out what is worth remembering.`,
    };
  }
  if (engines.claude.ready || engines.codex.ready) {
    return {
      learns: false,
      text: "Memory recalls what it knows, but it learns new things only with a free model. Set one up in Settings, or allow Claude for memory.",
    };
  }
  return {
    learns: false,
    text: "No model is set up to learn from your chats yet, so memory only recalls what it already knows.",
  };
}

export function scopeTitle(scope: "you" | "blob" | "team", blobName: string): string {
  if (scope === "you") return "About you";
  if (scope === "team") return "Team notes";
  return `${blobName}'s notes`;
}

export function scopeCaption(scope: "you" | "blob" | "team"): string {
  if (scope === "you") return "Shared by all blobs";
  if (scope === "team") return "Kora uses these to run the team";
  return "Only this blob uses these";
}
