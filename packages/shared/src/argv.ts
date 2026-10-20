export interface ParsedCliArgs {
  readonly positionals: string[];
  readonly flags: Record<string, string | null>;
}

export interface ParseCliArgsOptions {
  readonly booleanFlags?: readonly string[];
}

const BACKSLASH_ESCAPABLE_IN_DOUBLE = new Set(['"', "\\", "$", "`"]);

/** Splits a command line into words, honouring single quotes, double quotes and backslashes. */
export function tokenizeCliArgs(args?: string): ReadonlyArray<string> {
  const text = args?.trim();
  if (!text) return [];

  const words: string[] = [];
  let buffer = "";
  let openQuote: string | null = null;
  let sawQuotes = false;
  let pos = 0;

  const flush = () => {
    if (buffer.length > 0 || sawQuotes) words.push(buffer);
    buffer = "";
    sawQuotes = false;
  };

  while (pos < text.length) {
    const ch = text.charAt(pos);
    const following = pos + 1 < text.length ? text.charAt(pos + 1) : undefined;
    pos += 1;

    if (openQuote !== null) {
      if (ch === openQuote) {
        openQuote = null;
        sawQuotes = true;
      } else if (
        ch === "\\" &&
        openQuote === '"' &&
        following !== undefined &&
        BACKSLASH_ESCAPABLE_IN_DOUBLE.has(following)
      ) {
        buffer += following;
        pos += 1;
      } else {
        buffer += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      openQuote = ch;
      sawQuotes = true;
    } else if (/\s/.test(ch)) {
      flush();
    } else if (ch === "\\" && following !== undefined && /\s/.test(following)) {
      buffer += following;
      pos += 1;
    } else {
      buffer += ch;
    }
  }

  flush();
  return words;
}

/**
 * Parse CLI-style arguments into flags and positionals.
 *
 * Accepts a string (quote-aware tokenized) or a pre-split argv array.
 * Supports `--key value`, `--key=value`, and `--flag` (boolean) syntax.
 *
 *   parseCliArgs("")
 *     → { flags: {}, positionals: [] }
 *
 *   parseCliArgs("--chrome")
 *     → { flags: { chrome: null }, positionals: [] }
 *
 *   parseCliArgs("--chrome --effort high")
 *     → { flags: { chrome: null, effort: "high" }, positionals: [] }
 *
 *   parseCliArgs("--effort=high")
 *     → { flags: { effort: "high" }, positionals: [] }
 *
 *   parseCliArgs(["1.2.3", "--root", "/path", "--github-output"], { booleanFlags: ["github-output"] })
 *     → { flags: { root: "/path", "github-output": null }, positionals: ["1.2.3"] }
 */
export function parseCliArgs(
  args: string | readonly string[],
  { booleanFlags = [] }: ParseCliArgsOptions = {},
): ParsedCliArgs {
  const words = typeof args === "string" ? [...tokenizeCliArgs(args)] : [...args];
  const standalone = new Set(booleanFlags);

  const flags: Record<string, string | null> = {};
  const positionals: string[] = [];

  let cursor = 0;
  while (cursor < words.length) {
    const word = words[cursor++]!;
    if (!word.startsWith("--")) {
      positionals.push(word);
      continue;
    }

    const body = word.slice(2);
    if (body === "") continue;

    const split = body.indexOf("=");
    if (split >= 0) {
      flags[body.slice(0, split)] = body.slice(split + 1);
      continue;
    }

    const peek = words[cursor];
    const takesValue = !standalone.has(body) && peek !== undefined && !peek.startsWith("--");
    flags[body] = takesValue ? peek : null;
    if (takesValue) cursor += 1;
  }

  return { flags, positionals };
}
