import { normalizeSearchQuery, scoreQueryMatch } from "@kora/shared/fuzzyRank";

type ModelPickerSearchableModel = {
  name: string;
  shortName?: string;
  isFavorite?: boolean;
  subProvider?: string;
  /** Driver kind — indexed so "codex" still matches a Codex Personal instance. */
  driverKind: string;
  /**
   * Instance display name (e.g. "Codex Personal"). Indexed as a search
   * field so typing the custom instance's user-authored name matches its
   * models directly instead of just the driver kind.
   */
  providerDisplayName: string;
};

const FAVORITE_BOOST = 24;
/** Fields are ranked in the order they are listed: each later field starts 10 points behind. */
const FIELD_SPACING = 10;

function searchFieldsOf(model: ModelPickerSearchableModel): string[] {
  const optional = [model.shortName, model.subProvider]
    .filter((value): value is string => Boolean(value))
    .map((value) => normalizeSearchQuery(value));
  return [
    normalizeSearchQuery(model.name),
    ...optional,
    ...[model.driverKind, model.providerDisplayName].map((value) => normalizeSearchQuery(value)),
    buildModelPickerSearchText(model),
  ];
}

function scoreTokenAgainstField(token: string, field: string, base: number): number | null {
  const fuzzy = token.length >= 3 ? { fuzzyBase: base + 100 } : {};
  return scoreQueryMatch({
    query: token,
    value: field,
    exactBase: base,
    prefixBase: base + 2,
    boundaryBase: base + 4,
    includesBase: base + 6,
    ...fuzzy,
  });
}

export function buildModelPickerSearchText(model: ModelPickerSearchableModel): string {
  const parts = [
    model.name,
    model.shortName,
    model.subProvider,
    model.driverKind,
    model.providerDisplayName,
  ];
  const present = parts.filter(
    (value): value is string => typeof value === "string" && value !== "",
  );
  return normalizeSearchQuery(present.join(" "));
}

export function scoreModelPickerSearch(
  model: ModelPickerSearchableModel,
  rawQuery: string,
): number | null {
  const words = normalizeSearchQuery(rawQuery).split(/\s+/u);
  const tokens = words.filter((token) => token !== "");
  if (!tokens.length) {
    return 0;
  }

  const fields = searchFieldsOf(model);
  let total = 0;
  for (const token of tokens) {
    const matches = fields
      .map((field, position) => scoreTokenAgainstField(token, field, position * FIELD_SPACING))
      .filter((score): score is number => score !== null);
    if (!matches.length) {
      return null;
    }
    total += Math.min(...matches);
  }

  return model.isFavorite ? total - FAVORITE_BOOST : total;
}
