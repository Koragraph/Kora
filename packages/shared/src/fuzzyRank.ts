export type RankedSearchResult<T> = { item: T; score: number; tieBreaker: string };

const DEFAULT_BOUNDARY_MARKERS: readonly string[] = [" ", "-", "_", "/"];
const MAX_LENGTH_PENALTY = 64;

export function normalizeSearchQuery(
  input: string,
  options?: { readonly trimLeadingPattern?: RegExp },
): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) return "";
  // The pattern sees the text before lowercasing.
  return (
    options?.trimLeadingPattern ? trimmed.replace(options.trimLeadingPattern, "") : trimmed
  ).toLowerCase();
}

/** Lower is better. Both arguments must already be normalized. */
export function scoreSubsequenceMatch(value: string, query: string): number | null {
  if (query.length === 0) return 0;

  let first = -1;
  let last = -1;
  let gaps = 0;
  let position = 0;
  for (let i = 0; i < value.length && position < query.length; i++) {
    if (value[i] !== query[position]) continue;
    if (first === -1) first = i;
    else gaps += i - last - 1;
    last = i;
    position += 1;
  }
  if (position < query.length) return null;

  const span = last - first + 1 - query.length;
  const lengthPenalty = Math.min(MAX_LENGTH_PENALTY, value.length - query.length);
  return first * 2 + gaps * 3 + span + lengthPenalty;
}

/** Base score per match tier; a tier left undefined is not tried. */
type MatchTierBases = Readonly<
  { exactBase: number } & Partial<
    Record<"prefixBase" | "boundaryBase" | "includesBase" | "fuzzyBase", number>
  >
>;

export function scoreQueryMatch(
  input: MatchTierBases & {
    readonly value: string;
    readonly query: string;
    readonly boundaryMarkers?: readonly string[];
  },
): number | null {
  const { value, query } = input;
  if (value.length === 0 || query.length === 0) return null;
  const lengthPenalty = Math.min(MAX_LENGTH_PENALTY, Math.max(0, value.length - query.length));

  if (value === query) return input.exactBase;
  if (input.prefixBase !== undefined && value.startsWith(query)) {
    return input.prefixBase + lengthPenalty;
  }

  if (input.boundaryBase !== undefined) {
    let earliest = -1;
    for (const marker of input.boundaryMarkers ?? DEFAULT_BOUNDARY_MARKERS) {
      const at = value.indexOf(`${marker}${query}`);
      if (at !== -1 && (earliest === -1 || at + marker.length < earliest)) {
        earliest = at + marker.length;
      }
    }
    if (earliest !== -1) return input.boundaryBase + earliest * 2 + lengthPenalty;
  }

  if (input.includesBase !== undefined) {
    const at = value.indexOf(query);
    if (at !== -1) return input.includesBase + at * 2 + lengthPenalty;
  }

  if (input.fuzzyBase !== undefined) {
    const fuzzy = scoreSubsequenceMatch(value, query);
    if (fuzzy !== null) return input.fuzzyBase + fuzzy;
  }
  return null;
}

/** Keep `ranked` sorted by (score, tieBreaker) and at most `limit` long. */
export function insertRanked<T>(
  ranked: RankedSearchResult<T>[],
  candidate: RankedSearchResult<T>,
  limit: number,
): void {
  if (limit <= 0) return;

  const comesBefore = (other: RankedSearchResult<T>) =>
    candidate.score !== other.score
      ? candidate.score < other.score
      : candidate.tieBreaker.localeCompare(other.tieBreaker) < 0;

  // Binary search for the first entry the candidate must precede (after equals).
  let low = 0;
  let high = ranked.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (comesBefore(ranked[middle]!)) high = middle;
    else low = middle + 1;
  }
  if (low >= limit) return;
  ranked.splice(low, 0, candidate);
  if (ranked.length > limit) ranked.pop();
}
