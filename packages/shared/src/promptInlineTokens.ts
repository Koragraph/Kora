export type PromptInlineToken =
  | { type: "mention"; value: string; source: string; start: number; end: number }
  | { type: "skill"; value: string; source: string; start: number; end: number };

export interface CollectPromptInlineTokensOptions {
  /** Tokens confirmed earlier; one that sat at the very end keeps its chip while it is being edited. */
  readonly preserveTrailingFrom?: ReadonlyArray<PromptInlineToken>;
}

// A token needs whitespace (or the text start) before it and whitespace after it. The "after"
// is a lookahead, so the delimiter stays outside the token and can start the next one.
//
// The label is capped on purpose: an unbounded label body rescans the rest of the text from
// every whitespace and goes quadratic on inputs like many `[`.
const FILE_LINK = /(^|\s)(\[((?:\\.|[^\]\\\n]){0,512})\]\(([^\s)]+)\))(?=\s)/gu;
const AT_MENTION = /(^|\s)(@(?:"((?:\\.|[^"\\])*)"|([^\s@"]+)))(?=\s)/gu;
const SKILL = /(^|\s)(\$([A-Za-z0-9][A-Za-z0-9:_-]*))(?=\s)/gu;

const EXTERNAL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const SCOPED_PACKAGE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(\/\S+)*$/;
// `$20`, `$20k`, `$1_000`, `$100M`, `$1e6`: money, not skills.
const LOOKS_NUMERIC = /^\d[\d_]*(?:[kmbt]|e\d+)?$/i;

const unescapeBackslashes = (text: string): string => text.replace(/\\(.)/gu, "$1");

const percentDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const basename = (path: string): string =>
  path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);

function* matches(pattern: RegExp, text: string): Generator<RegExpExecArray> {
  for (const match of text.matchAll(pattern)) yield match;
}

const startOf = (match: RegExpExecArray): number => match.index + (match[1] ?? "").length;

export function collectPromptInlineTokens(
  text: string,
  options?: CollectPromptInlineTokensOptions,
): ReadonlyArray<PromptInlineToken> {
  const tokens: PromptInlineToken[] = [];

  for (const match of matches(FILE_LINK, text)) {
    const [, , source = "", rawLabel = "", target = ""] = match;
    const path = percentDecode(target);
    if (path.length === 0) continue;
    if (EXTERNAL_SCHEME.test(path) && !WINDOWS_DRIVE_PATH.test(path)) continue;
    if (unescapeBackslashes(rawLabel) !== basename(path)) continue;
    const start = startOf(match);
    tokens.push({ type: "mention", value: path, source, start, end: start + source.length });
  }

  for (const match of matches(AT_MENTION, text)) {
    const [, , source = "", quoted, bare] = match;
    const value = quoted !== undefined ? unescapeBackslashes(quoted) : (bare ?? "");
    if (value.length === 0) continue;
    // `@scope/package` stays prose; autocomplete writes a canonical file link for real files.
    if (quoted === undefined && SCOPED_PACKAGE.test(value)) continue;
    const start = startOf(match);
    tokens.push({ type: "mention", value, source, start, end: start + source.length });
  }

  for (const match of matches(SKILL, text)) {
    const [, , source = "", name = ""] = match;
    if (!/[A-Za-z]/.test(name) || LOOKS_NUMERIC.test(name)) continue;
    const start = startOf(match);
    tokens.push({ type: "skill", value: name, source, start, end: start + source.length });
  }

  for (const previous of options?.preserveTrailingFrom ?? []) {
    if (previous.end !== text.length) continue;
    if (text.slice(previous.start, previous.end) !== previous.source) continue;
    const rematched = tokens.some(
      (token) =>
        token.type === previous.type &&
        token.start === previous.start &&
        token.end === previous.end,
    );
    if (!rematched) tokens.push(previous);
  }

  return tokens.sort((a, b) => a.start - b.start);
}
