/**
 * Names the program behind a shell command an agent ran, for labels like "Ran git".
 *
 * This is a conservative static reading of POSIX shell text. Nothing is evaluated; whenever the
 * real program is not clear the answer is `null` and the caller falls back to a generic word.
 */

type Context = "shell" | "exec";

const MAX_DEPTH = 8;
const MAX_SEGMENTS = 64;

// ---- Word tables -------------------------------------------------------------------------

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh", "fish"]);
const SHELL_VALUE_OPTIONS = new Set(["-o", "-O", "--rcfile", "--init-file"]);

const NON_DESCRIPTIVE = new Set(
  (
    "! # . : [ [[ alias and autoload begin bg bind bindkey break builtin caller case catch cd " +
    "command compgen complete compopt continue coproc declare dirs disown do done elif else enable " +
    "end esac eval exec exit export false fc fg fi finally for foreach function getopts history " +
    "if in jobs let local logout mapfile nocorrect noglob not or popd pushd read readarray " +
    "readonly repeat return select set setopt shift shopt source switch suspend test then time " +
    "times trap try true type typeset ulimit umask unalias until unset unsetopt wait while"
  ).split(" "),
);

// Words after which later segments only run conditionally, so a later program must not be used.
const TERMINAL = new Set(
  (
    "and begin break case catch continue coproc do done elif else end esac eval exec exit false " +
    "fi finally for foreach function if in not or repeat return select switch then try until while"
  ).split(" "),
);

const SUDO_PROBES = new Set(["[", "[[", "test", "true"]);
const PRECOMMAND_MODIFIERS = new Set(["nocorrect", "noglob", "time"]);

const PREFIX_CHARS = new Set([..."<>(){}[];|&$`#!%@:"]);
const SUFFIX_CHARS = new Set([..."){]}`"]);

interface WrapperSpec {
  readonly valueOptions: ReadonlySet<string>;
  readonly flags: ReadonlySet<string>;
}

const WRAPPERS: Record<"env" | "sudo", WrapperSpec> = {
  env: {
    valueOptions: new Set(["-C", "--chdir", "-S", "--split-string", "-u", "--unset"]),
    flags: new Set(["-0", "--null", "-i", "--ignore-environment", "--debug", "-v"]),
  },
  sudo: {
    valueOptions: new Set(["-C", "--close-from", "-D", "--chdir", "-g", "--group", "-u", "--user"]),
    flags: new Set(["-A", "--askpass", "-b", "--background", "-E", "-H", "-i", "-n", "-S"]),
  },
};

// ---- Small string helpers ----------------------------------------------------------------

const isSpace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch);
const hasSlash = (value: string): boolean => value.includes("/") || value.includes("\\");
const baseOf = (value: string): string =>
  value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

/** Quote a word so that tokenising the joined result gives the same word back. */
const singleQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const stripLeadingComments = (text: string): string | null => {
  let rest = text.trimStart();
  while (rest.startsWith("#")) {
    const newline = rest.indexOf("\n");
    if (newline < 0) return null;
    rest = rest.slice(newline + 1).trimStart();
  }
  return rest;
};

// ---- Splitting off the first top-level segment ---------------------------------------------

interface Segment {
  readonly first: string;
  readonly rest: string | null;
  readonly separator: string | null;
}

interface PendingHeredoc {
  readonly delimiter: string;
  readonly stripTabs: boolean;
}

const COMMENT_PREDECESSORS = new Set([..." \t\n;&|("]);

/** Where the text after the heredoc bodies starts, or null if a delimiter line never appears. */
function skipHeredocBodies(
  text: string,
  from: number,
  heredocs: readonly PendingHeredoc[],
): number | null {
  let at = from;
  for (const heredoc of heredocs) {
    for (;;) {
      if (at >= text.length) return null;
      const newline = text.indexOf("\n", at);
      let line = newline < 0 ? text.slice(at) : text.slice(at, newline);
      at = newline < 0 ? text.length : newline + 1;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (heredoc.stripTabs) line = line.replace(/^\t+/, "");
      if (line === heredoc.delimiter) break;
    }
  }
  return at;
}

function readHeredocDelimiter(
  text: string,
  from: number,
): { delimiter: string; end: number } | null {
  let i = from;
  while (text[i] === " " || text[i] === "\t") i += 1;
  let delimiter = "";
  while (i < text.length && !isSpace(text[i]) && !";&|<>()".includes(text[i]!)) {
    const ch = text[i]!;
    if (ch === "'" || ch === '"') {
      const close = text.indexOf(ch, i + 1);
      if (close < 0) return null;
      delimiter += text.slice(i + 1, close);
      i = close + 1;
    } else if (ch === "\\") {
      if (i + 1 >= text.length) return null;
      delimiter += text[i + 1];
      i += 2;
    } else {
      delimiter += ch;
      i += 1;
    }
  }
  return delimiter === "" ? null : { delimiter, end: i };
}

function splitFirstSegment(text: string): Segment {
  let out = "";
  let parens = 0;
  let braces = 0;
  const heredocs: PendingHeredoc[] = [];
  // First separator seen while heredocs were pending on this line.
  let held: { token: string; firstText: string; resumeAt: number } | null = null;

  const whole = (): Segment => ({ first: out.trimStart().trimEnd(), rest: null, separator: null });

  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const prev = text[i - 1];

    if (ch === "\\") {
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += ch === '"' && text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== "`") j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "#" && braces === 0 && (i === 0 || COMMENT_PREDECESSORS.has(prev!))) {
      const newline = text.indexOf("\n", i);
      i = newline < 0 ? text.length : newline;
      continue;
    }
    if (ch === "$" && text[i + 1] === "{") {
      braces += 1;
      out += "${";
      i += 2;
      continue;
    }
    if (braces > 0) {
      if (ch === "{") braces += 1;
      if (ch === "}") braces -= 1;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "(") parens += 1;
    if (ch === ")" && parens > 0) parens -= 1;

    if (ch === "<" && text[i + 1] === "<" && text[i + 2] !== "<" && prev !== "<" && parens === 0) {
      const stripTabs = text[i + 2] === "-";
      const found = readHeredocDelimiter(text, i + (stripTabs ? 3 : 2));
      if (found === null) return whole();
      heredocs.push({ delimiter: found.delimiter, stripTabs });
      out += text.slice(i, found.end);
      i = found.end;
      continue;
    }

    let separator: string | null = null;
    if (parens === 0) {
      if (ch === ";" || ch === "\n") separator = ch;
      else if (ch === "&") {
        if (prev !== "<" && prev !== ">" && text[i + 1] !== ">") {
          separator = text[i + 1] === "&" ? "&&" : "&";
        }
      } else if (ch === "|" && prev !== ">") {
        separator = text[i + 1] === "|" ? "||" : text[i + 1] === "&" ? "|&" : "|";
      }
    }
    if (separator === null) {
      out += ch;
      i += 1;
      continue;
    }

    if (heredocs.length === 0) {
      const after = text.slice(i + separator.length).trimStart();
      return { first: out.trimStart(), rest: after === "" ? null : after, separator };
    }
    if (separator !== "\n") {
      held ??= { token: separator, firstText: out, resumeAt: out.length + separator.length };
      out += separator;
      i += separator.length;
      continue;
    }

    // The newline ends the line that opened the heredocs; their bodies follow it.
    const lineAfterSeparator = held === null ? "" : out.slice(held.resumeAt);
    const bodiesEnd = skipHeredocBodies(text, i + 1, heredocs);
    const afterBodies = bodiesEnd === null ? "" : text.slice(bodiesEnd);
    const rest = [lineAfterSeparator.trim(), afterBodies.trim()]
      .filter((part) => part !== "")
      .join("\n");
    return {
      first: (held === null ? out : held.firstText).trimStart(),
      rest: rest === "" ? null : rest,
      separator: held === null ? "\n" : held.token,
    };
  }

  if (held !== null) {
    const rest = out.slice(held.resumeAt).trim();
    return {
      first: held.firstText.trimStart(),
      rest: rest === "" ? null : rest,
      separator: held.token,
    };
  }
  return whole();
}

// ---- Tokenising -----------------------------------------------------------------------------

interface Word {
  readonly value: string;
  readonly quoted: boolean;
}

/** Drop backslash-newline continuations that are not inside single quotes. */
function joinContinuedLines(text: string): string {
  // Even pieces sit outside single quotes; only those lose their continuations.
  return text
    .split("'")
    .map((piece, index) => (index % 2 === 0 ? piece.replaceAll("\\\n", "") : piece))
    .join("'");
}

const CLOSERS: Record<string, string> = { "(": ")", "{": "}" };

function tokenize(source: string): Word[] | null {
  const text = joinContinuedLines(source);
  const words: Word[] = [];
  let i = 0;
  while (i < text.length) {
    if (isSpace(text[i])) {
      i += 1;
      continue;
    }
    let value = "";
    let quoted = false;
    while (i < text.length && !isSpace(text[i])) {
      const ch = text[i]!;
      if (ch === "'") {
        const close = text.indexOf("'", i + 1);
        if (close < 0) return null;
        value += text.slice(i + 1, close);
        quoted = true;
        i = close + 1;
      } else if (ch === '"') {
        quoted = true;
        i += 1;
        for (;;) {
          if (i >= text.length) return null;
          const inner = text[i]!;
          if (inner === '"') {
            i += 1;
            break;
          }
          if (inner === "\\") {
            const next = text[i + 1];
            if (next === undefined) return null;
            if (next === "\n") value += "";
            else value += '"\\$`'.includes(next) ? next : `\\${next}`;
            i += 2;
          } else {
            value += inner;
            i += 1;
          }
        }
      } else if (ch === "\\") {
        if (i + 1 >= text.length) return null;
        value += text[i + 1];
        i += 2;
      } else if (ch === "`") {
        let j = i + 1;
        while (j < text.length && text[j] !== "`") j += text[j] === "\\" ? 2 : 1;
        if (j >= text.length) return null;
        value += text.slice(i, j + 1);
        i = j + 1;
      } else if (ch === "(" || (ch === "$" && (text[i + 1] === "(" || text[i + 1] === "{"))) {
        const opener = ch === "$" ? text[i + 1]! : ch;
        const start = i;
        i += ch === "$" ? 2 : 1;
        const expected = [CLOSERS[opener]!];
        while (expected.length > 0) {
          if (i >= text.length) return null;
          const inner = text[i]!;
          if (inner === "'" || inner === '"') {
            const close = text.indexOf(inner, i + 1);
            if (close < 0) return null;
            i = close + 1;
            continue;
          }
          if (inner === "\\") {
            i += 2;
            continue;
          }
          if (inner === "(" || inner === "{") expected.push(CLOSERS[inner]!);
          else if (inner === expected[expected.length - 1]) expected.pop();
          i += 1;
        }
        value += text.slice(start, i);
      } else {
        value += ch;
        i += 1;
      }
    }
    words.push({ value, quoted });
  }
  return words;
}

// ---- Redirections ---------------------------------------------------------------------------

const REDIRECTION = /^(?:(?:\d+|\*|\{[^}]*\})?(<<<|<<-|<<|<>|>>|>\||<&|>&|<|>)|&>>|&>)/;

/** Number of tokens a redirection occupies at `index` (0 when it is not one), or -1 if its operand is missing. */
function redirectionSpan(words: readonly Word[], index: number): number {
  const word = words[index]!.value;
  const match = REDIRECTION.exec(word);
  if (!match) return 0;
  const operator = match[0];
  const after = word.slice(operator.length);
  if ((operator.endsWith("<") || operator.endsWith(">")) && after.startsWith("(")) return 0;
  if (after !== "") return 1;
  return index + 1 < words.length ? 2 : -1;
}

// ---- Program names ---------------------------------------------------------------------------

const looksLikeFunctionHead = (text: string): boolean =>
  /^[A-Za-z_][\w.-]*\s*\(\s*\)\s*\{/.test(text);

const isProgramText = (base: string): boolean =>
  base !== "" &&
  !PREFIX_CHARS.has(base[0]!) &&
  !SUFFIX_CHARS.has(base[base.length - 1]!) &&
  !looksLikeFunctionHead(base);

/** The program a literal path or word names, or null when it is not clearly one. */
function staticProgramName(text: string): string | null {
  const value = text.trim();
  if (value === "" || /^[A-Za-z][A-Za-z0-9+.-]*:(?!\/)/.test(value)) return null;
  const base = baseOf(value);
  if (/\s/.test(base) && !hasSlash(value)) return null;
  return isProgramText(base) ? base : null;
}

const STRUCTURE_START = /^(?:catch|finally|for|foreach|function|if|param|switch|try|while)\s*[{(]/i;

function startsStructureBlock(text: string): boolean {
  return STRUCTURE_START.test(text) || looksLikeFunctionHead(text) || text.startsWith("[[");
}

// ---- Transparent launch wrappers ---------------------------------------------------------------

const DURATION = /^(?:\d+(?:\.\d*)?|\.\d+)[smhd]?$/;

/** Index of the wrapped command's first token, when the wrapper form is recognisably complete. */
function transparentTarget(name: string, words: readonly Word[], at: number): number | null {
  const value = (offset: number) => words[at + offset]?.value;
  const present = (offset: number) => at + offset < words.length;
  switch (name) {
    case "bundle":
      return value(1) === "exec" && present(2) ? at + 2 : null;
    case "nohup": {
      const next = value(1) === "--" ? 2 : 1;
      return present(next) && !value(next)!.startsWith("-") ? at + next : null;
    }
    case "script": {
      const option = value(1);
      return option !== undefined && /^-[adkpqr]+$/.test(option) && present(3) ? at + 3 : null;
    }
    case "arch": {
      const option = value(1);
      if (option === undefined) return null;
      if (["-arm64", "-arm64e", "-i386", "-x86_64"].includes(option))
        return present(2) ? at + 2 : null;
      return option === "-arch" && present(3) ? at + 3 : null;
    }
    case "timeout":
    case "gtimeout": {
      const duration = value(1);
      return duration !== undefined && DURATION.test(duration) && present(2) ? at + 2 : null;
    }
    default:
      return null;
  }
}

const serialize = (words: readonly Word[], from: number): string =>
  words
    .slice(from)
    .map((word) => singleQuote(word.value))
    .join(" ");

// ---- The resolver ------------------------------------------------------------------------------

function resolveCommand(
  command: string,
  context: Context,
  depth: number,
  segments: number,
): string | null {
  if (depth >= MAX_DEPTH || segments <= 0) return null;
  const parsed = parseCommand(command, context, depth, segments);
  if (parsed === null && context === "shell") return recoverAlias(command);
  return parsed;
}

function parseCommand(
  source: string,
  startContext: Context,
  depth: number,
  segments: number,
): string | null {
  const text = stripLeadingComments(source);
  if (text === null || text === "") return null;
  if (startsStructureBlock(text)) return null;

  const { first, rest, separator } = splitFirstSegment(text);
  const next = (ctx: Context): string | null =>
    rest === null ? null : resolveCommand(rest, ctx, depth, segments - 1);

  const words = tokenize(first);
  if (words === null) return null;

  // A lone quoted sentence is data, not a program.
  if (words.length === 1 && words[0]!.quoted) {
    const value = words[0]!.value;
    if (/[\s()=]/.test(value) && !hasSlash(value)) return next(startContext);
  }

  let context = startContext;
  let wrapper: "env" | "sudo" | null = null;
  let optionsDone = false;
  let sawSetup = false;

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    const value = word.value;

    const span = redirectionSpan(words, i);
    if (span < 0) return null;
    if (span > 0) {
      sawSetup = true;
      i += span - 1;
      continue;
    }

    if (ASSIGNMENT.test(value)) {
      sawSetup = true;
      continue;
    }

    if (context === "shell" && value === ":") return next(context);

    const dollarPath = value.startsWith("$") && value.includes("/");
    if (PREFIX_CHARS.has(value[0] ?? "") && !dollarPath) {
      return context === "shell" && value.startsWith("[") ? next(context) : null;
    }

    if (wrapper !== null && !optionsDone && value.startsWith("-")) {
      const outcome = readWrapperOption(wrapper, words, i);
      if (outcome === null) return null;
      if (outcome.split !== undefined)
        return resolveCommand(outcome.split, "exec", depth + 1, segments);
      if (outcome.done) optionsDone = true;
      i = outcome.next - 1;
      continue;
    }

    const base = baseOf(value);
    const unqualified = !hasSlash(value);

    if (base === "env" || base === "sudo") {
      wrapper = base;
      optionsDone = false;
      context = "exec";
      continue;
    }

    const shellName = base.replace(/\.exe$/i, "").toLowerCase();
    if (SHELLS.has(shellName)) {
      const script = findShellScript(words, i + 1);
      if (script === "missing") return null;
      if (script !== null) return resolveCommand(script, "shell", depth + 1, segments);
    }

    if (context === "shell" && unqualified && PRECOMMAND_MODIFIERS.has(value)) {
      let j = i + 1;
      if (value === "time" && words[j]?.value === "-p") j += 1;
      if (words[j]?.value.startsWith("-")) return null;
      i = j - 1;
      continue;
    }

    if (unqualified) {
      const target = transparentTarget(value, words, i);
      if (target !== null) {
        const inner = resolveCommand(serialize(words, target), "exec", depth + 1, segments);
        if (inner !== null) return inner;
      }

      if (value === "command" || value === "builtin" || value === "exec") {
        return resolveCommandWrapper(value, words, i, depth, segments, next);
      }
    }

    const skippableWord =
      unqualified &&
      NON_DESCRIPTIVE.has(value) &&
      (context === "shell" || (wrapper === "sudo" && SUDO_PROBES.has(value)));
    if (skippableWord) {
      const terminal = TERMINAL.has(value) && !(value === "false" && separator !== "&&");
      if (!terminal && rest !== null) return next("shell");
    }

    if (!isProgramText(base) || (unqualified && NON_DESCRIPTIVE.has(value))) return null;
    return base;
  }

  if (sawSetup && wrapper === null && rest !== null) return next(context);
  return null;
}

interface WrapperOptionOutcome {
  readonly next: number;
  readonly done: boolean;
  readonly split?: string;
}

function readWrapperOption(
  wrapper: "env" | "sudo",
  words: readonly Word[],
  at: number,
): WrapperOptionOutcome | null {
  const { valueOptions, flags } = WRAPPERS[wrapper];
  const option = words[at]!.value;

  if (option === "--") return { next: at + 1, done: true };

  if (wrapper === "env") {
    if (option === "-S" || option === "--split-string") {
      const script = words[at + 1];
      return script === undefined ? null : { next: at + 2, done: false, split: script.value };
    }
    if (option.startsWith("--split-string=")) {
      return { next: at + 1, done: false, split: option.slice("--split-string=".length) };
    }
  }

  if (valueOptions.has(option)) return at + 1 < words.length ? { next: at + 2, done: false } : null;
  if (flags.has(option)) return { next: at + 1, done: false };

  if (option.startsWith("--")) {
    const equals = option.indexOf("=");
    return equals > 0 && valueOptions.has(option.slice(0, equals))
      ? { next: at + 1, done: false }
      : null;
  }

  // Bundled short options such as `-iu NAME`: every letter known, a value letter only last.
  const letters = option.slice(1);
  if (letters === "") return null;
  const isFlagLetter = (letter: string) => flags.has(`-${letter}`);
  const isValueLetter = (letter: string) => valueOptions.has(`-${letter}`);
  for (let k = 0; k < letters.length; k += 1) {
    const letter = letters[k]!;
    const last = k === letters.length - 1;
    if (isFlagLetter(letter)) continue;
    if (isValueLetter(letter) && last) {
      return at + 1 < words.length ? { next: at + 2, done: false } : null;
    }
    return null;
  }
  return { next: at + 1, done: false };
}

/** The `-c` script of a shell launch: the string, "missing" when `-c` has none, or null for no `-c`. */
function findShellScript(words: readonly Word[], from: number): string | "missing" | null {
  for (let k = from; k < words.length; k += 1) {
    const option = words[k]!.value;
    if (option === "--" || !option.startsWith("-")) return null;
    if (SHELL_VALUE_OPTIONS.has(option)) {
      k += 1;
      continue;
    }
    if (option === "--command" || (/^-[A-Za-z]+$/.test(option) && option.includes("c"))) {
      return words[k + 1]?.value ?? "missing";
    }
  }
  return null;
}

function resolveCommandWrapper(
  name: "command" | "builtin" | "exec",
  words: readonly Word[],
  at: number,
  depth: number,
  segments: number,
  next: (ctx: Context) => string | null,
): string | null {
  let j = at + 1;
  if (name === "command") {
    for (; j < words.length; j += 1) {
      const option = words[j]!.value;
      if (option === "--") {
        j += 1;
        break;
      }
      if (option === "-p") continue;
      if (option.startsWith("-")) return null;
      break;
    }
  } else if (name === "builtin") {
    if (words[j]?.value === "--") j += 1;
    else if (words[j]?.value.startsWith("-")) return null;
  } else {
    for (; j < words.length; j += 1) {
      const option = words[j]!.value;
      if (option === "--") {
        j += 1;
        break;
      }
      if (option === "-a") {
        if (j + 1 >= words.length) return null;
        j += 1;
        continue;
      }
      if (/^-a./.test(option) || /^-[cl]+$/.test(option)) continue;
      if (option.startsWith("-")) return null;
      break;
    }
  }

  while (j < words.length) {
    const span = redirectionSpan(words, j);
    if (span < 0) return null;
    if (span === 0) break;
    j += span;
  }
  const target = words[j];
  if (target === undefined || ASSIGNMENT.test(target.value)) return null;

  const inner = resolveCommand(
    serialize(words, j),
    name === "exec" ? "exec" : "shell",
    depth + 1,
    segments,
  );
  if (inner !== null) return inner;

  const word = target.value;
  if (name !== "exec" && /^[a-z]/.test(word) && NON_DESCRIPTIVE.has(word) && !TERMINAL.has(word)) {
    return next("shell");
  }
  return null;
}

// ---- Literal alias recovery ---------------------------------------------------------------------

const CONTROL_OPENERS = new Set(["if", "for", "while", "until", "select", "case"]);
const CONTROL_CLOSERS = new Set(["fi", "done", "esac"]);

/** The program a literal assignment value names (`/opt/tool`, or the head of `(tool -x)`), if any. */
function aliasProgram(value: string): string | null {
  if (value === "" || /[$`]/.test(value)) return null;
  if (value.startsWith("(") && value.endsWith(")")) {
    const head = tokenize(value.slice(1, -1));
    const element = head?.[0];
    return element === undefined || /[$`]/.test(element.value)
      ? null
      : staticProgramName(element.value);
  }
  return staticProgramName(value);
}

function recoverAlias(source: string): string | null {
  const aliases = new Map<string, string>();
  let controlDepth = 0;
  let remaining: string | null = source;

  for (let count = 0; count < MAX_SEGMENTS && remaining !== null; count += 1) {
    const text = stripLeadingComments(remaining);
    if (text === null || text === "") return null;
    const { first, rest } = splitFirstSegment(text);
    remaining = rest;
    const words = tokenize(first);
    if (words === null) return null;
    if (words.length === 0) continue;

    let at = 0;
    while (at < words.length && (words[at]!.value === "do" || words[at]!.value === "then")) at += 1;
    const lead = words[at]?.value;

    const exported = lead === "export" ? at + 1 : at;
    const assignmentsOnly =
      exported < words.length && words.slice(exported).every((word) => ASSIGNMENT.test(word.value));
    if (assignmentsOnly) {
      if (controlDepth === 0) {
        for (const word of words.slice(exported)) {
          const equals = word.value.indexOf("=");
          const name = word.value.slice(0, equals).replace(/\+$/, "");
          const program = aliasProgram(word.value.slice(equals + 1));
          if (program === null) aliases.delete(name);
          else aliases.set(name, program);
        }
      }
    } else if (lead === "unset") {
      if (controlDepth === 0) for (const word of words.slice(at + 1)) aliases.delete(word.value);
    } else {
      let k = at;
      for (;;) {
        const span = k < words.length ? redirectionSpan(words, k) : 0;
        if (span > 0) k += span;
        else if (k < words.length && ASSIGNMENT.test(words[k]!.value)) k += 1;
        else break;
      }
      const match = /^\$(?:(\w+)|\{(\w+)(?:\[@\])?\})$/.exec(words[k]?.value ?? "");
      const alias = match ? aliases.get(match[1] ?? match[2]!) : undefined;
      if (alias !== undefined) return alias;
    }

    if (lead !== undefined && CONTROL_OPENERS.has(lead)) controlDepth += 1;
    else if (lead !== undefined && CONTROL_CLOSERS.has(lead))
      controlDepth = Math.max(0, controlDepth - 1);
  }
  return null;
}

// ---- Public entry ---------------------------------------------------------------------------------

export function commandProgramName(command: string, depth = 0): string | null {
  return resolveCommand(command, "shell", depth, MAX_SEGMENTS);
}
