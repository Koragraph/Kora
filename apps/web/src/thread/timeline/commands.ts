/** What a tool row says it ran and what came out: the command line, the output, and a one-line summary. */
import { extractCommandOutputText } from "@kora/client-runtime/worklog/presentation";

import { fields, finiteNumber, text, type Fields } from "./read";

/** Splits `<exited with exit code N>` off the end of a tool's output. */
export function splitExitCode(output: string): { output: string | null; exitCode?: number } {
  const trimmed = output.trim();
  const tail = /\s*<exited with exit code (\d+)>\s*$/i.exec(trimmed);
  if (!tail) return { output: trimmed || null };
  const body = trimmed.slice(0, tail.index).trim();
  return { output: body || null, exitCode: Number(tail[1]) };
}

/** `s` without one pair of matching outer quotes (kept as is when nothing would be left inside). */
function unquote(s: string): string {
  const t = s.trim();
  const quoted = t.length >= 2 && (t[0] === "'" || t[0] === '"') && t.at(-1) === t[0];
  const inner = quoted ? t.slice(1, -1).trim() : "";
  return inner || t;
}

/** The program a command line starts with (possibly quoted) and the arguments after it. */
function programAndArgs(line: string): { program: string; args: string } | null {
  const t = line.trim();
  if (t === "") return null;
  const quote = t[0] === '"' || t[0] === "'" ? t[0] : null;
  const end = quote ? t.indexOf(quote, 1) + 1 : t.search(/\s|$/);
  if (end <= 0) return null; // an opening quote that never closes
  return { program: t.slice(0, end), args: t.slice(end).trim() };
}

/** Shells that run a command string given after a flag: `bash -lc "..."`, `cmd /c ...`, `pwsh -Command ...`. */
const SHELLS: ReadonlyArray<[program: RegExp, flag: RegExp]> = [
  [/^(?:ba|z)?sh$/, /(?:^|\s)-l?c\s+/i],
  [/^cmd(?:\.exe)?$/, /(?:^|\s)\/c\s+/i],
  [/^(?:pwsh|powershell)(?:\.exe)?$/, /(?:^|\s)-command\s+/i],
];

/** The command a shell wrapper runs (`bash -lc 'pnpm test'` reads as `pnpm test`); anything else unchanged. */
export function unwrapShell(line: string): string {
  const parts = programAndArgs(line);
  if (!parts || parts.args === "") return line;
  const program =
    unquote(parts.program).replaceAll("\\", "/").split("/").at(-1)?.trim().toLowerCase() ?? "";
  const flag = SHELLS.find(([name]) => name.test(program))?.[1];
  const at = flag?.exec(parts.args);
  if (!at) return line;
  const inner = parts.args.slice(at.index + at[0].length).trim();
  // A quoted command must close where the line ends, or this is not a simple wrapper.
  if (inner === "" || ((inner[0] === "'" || inner[0] === '"') && !inner.endsWith(inner[0])))
    return line;
  return unquote(inner) || line;
}

/** A command as one line: a string as given, or an argv array joined with the arguments that need it quoted. */
function commandLine(value: unknown): string | null {
  if (!Array.isArray(value)) return text(value);
  const argv = value.map(text).filter((arg): arg is string => arg !== null);
  if (argv.length === 0) return null;
  return argv
    .map((arg) => (/[\s"'`]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg))
    .join(" ");
}

/**
 * The command a tool row ran, unwrapped from its shell; `rawCommand` is the line as given when unwrapping changed
 * it. Looked for in the item, its input and result, the data, and (for a plain command row) the detail.
 */
export function toolCommand(payload: Fields | null): {
  command: string | null;
  rawCommand: string | null;
} {
  const data = fields(payload?.data);
  const item = fields(data?.item);
  const detail = text(payload?.detail);
  const places = [
    item?.command,
    fields(item?.input)?.command,
    fields(item?.result)?.command,
    data?.command,
    text(payload?.itemType) === "command_execution" && detail ? splitExitCode(detail).output : null,
  ];
  for (const place of places) {
    const asGiven = commandLine(place);
    if (!asGiven) continue;
    const command = unwrapShell(asGiven);
    return { command, rawCommand: asGiven === command ? null : asGiven };
  }
  return { command: null, rawCommand: null };
}

/** A command tool's output, exit-code marker removed. */
export function toolOutput(payload: Fields | null): string | null {
  const output = extractCommandOutputText(payload?.data);
  return output ? splitExitCode(output).output : null;
}

const ELLIPSIS_AT = 84;

/** The first meaningful line of some output, shortened; or a line count when every line is a code fence. */
function firstLineOf(output: string): string | null {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const first = lines.find((line) => line !== "```");
  if (first)
    return first.length <= ELLIPSIS_AT ? first : `${first.slice(0, ELLIPSIS_AT - 1).trimEnd()}…`;
  return lines.length > 1 ? `${lines.length.toLocaleString()} lines` : null;
}

/** A short summary of a tool's raw output: a file count for searches, else the first line of what it printed. */
export function rawOutputSummary(payload: Fields | null): string | null {
  const raw = fields(fields(payload?.data)?.rawOutput);
  if (!raw) return null;
  const files = finiteNumber(raw.totalFiles);
  if (files !== null) {
    return `${files.toLocaleString()} ${files === 1 ? "file" : "files"}${raw.truncated === true ? "+" : ""}`;
  }
  const printed = text(raw.content) ?? text(raw.stdout);
  return printed ? firstLineOf(printed) : null;
}
